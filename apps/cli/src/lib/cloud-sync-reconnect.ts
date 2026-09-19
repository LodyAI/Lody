import type { Logger } from '@/utils/logger';

/**
 * Reconnect pacing for the cloud subscription WebSocket (`ConvexClient`).
 *
 * The Convex client owns its own reconnect loop, and its backoff constants are
 * hardcoded: `defaultInitialBackoff = 1s`, `maxBackoff = 16s`, jitter `±50%`.
 * So a sustained outage settles at one connection attempt every 8-24s FOREVER:
 * a two-hour proxy failure produced ~450 attempts (`[loro:websocket] Creating
 * WebSocket`, 2026-09-16 04:50-06:50), roughly 40 per 10 minutes for two hours,
 * with no further growth. That is a reconnect storm, not a backoff.
 *
 * The client exposes no knob for those constants, but it does accept a
 * `webSocketConstructor`. This gate sits in that seam: the socket it hands to
 * the client defers the REAL connection until the gate's own, much longer
 * backoff allows it. The Convex loop keeps running underneath unchanged, so
 * short blips still recover at its fast base delay; only sustained failure
 * escalates to the minute-scale ceiling here.
 *
 * Recovery latency is the risk this creates, and the ceiling must never be the
 * only way back: {@link CloudSyncReconnectGate.notifyOnline} releases a waiting
 * connection immediately when something else proves the network is usable again
 * (the Streams data plane coming back online is that signal today, wired in
 * `lody-fleet.ts`).
 */

/**
 * Consecutive failures that stay on the Convex client's own curve.
 *
 * Its first six retries span ~1+2+4+8+16+16s ≈ 45s of unavailability, which is
 * the range where a transient blip belongs. Adding delay below that would make
 * ordinary recovery slower for no benefit.
 */
const DEFAULT_GRACE_ATTEMPTS = 6;
/** First delay imposed after the grace attempts are spent. */
const DEFAULT_BASE_DELAY_MS = 15_000;
/**
 * Ceiling for a sustained outage: 5 minutes.
 *
 * It turns a two-hour outage into ~30 attempts instead of ~450 (a 93% cut)
 * while bounding the worst case — no online signal at all — at one wasted
 * five-minute window before the client is back. Anything shorter keeps the
 * attempt count in the hundreds; anything longer buys little, because the
 * remaining cost is dominated by that single worst-case window rather than by
 * the attempts.
 */
const DEFAULT_MAX_DELAY_MS = 300_000;
/** Matches `computeLoroReconnectDelayMs`, so both planes jitter alike. */
const RECONNECT_JITTER_FRACTION = 0.2;
/**
 * How long a connection must survive before it counts as a real recovery.
 *
 * A socket that opens and dies immediately is a failed recovery, not a healthy
 * connection; resetting the streak on the rising edge alone is exactly how the
 * Loro plane once defeated its own backoff (see
 * `LODY_LORO_HEALTH_STABILITY_WINDOW_MS` in `loro/connection-recovery.ts`).
 */
const DEFAULT_STABILITY_WINDOW_MS = 5_000;
/**
 * Floor between two online-signal-FORCED attempts.
 *
 * The online signal is deliberately cheap and unthrottled at its source, so a
 * flapping transport could otherwise re-create the storm through this door. The
 * floor counts forced releases only, never ordinary attempts, and it is charged
 * when a signal actually releases a connection — a signal it turns away stays
 * latched for the next connect request. So the first signal of an outage, the
 * one that carries the recovery, is never the one that gets dropped, while
 * pathological flapping degrades to one extra attempt per minute.
 */
const DEFAULT_FORCED_RECONNECT_MIN_INTERVAL_MS = 60_000;

export type CloudSyncReconnectDelayOptions = {
  graceAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
};

/**
 * Extra delay the gate imposes on top of the Convex client's own backoff after
 * `consecutiveFailures` failed connection attempts. Zero while the client's own
 * curve is still young; exponential with jitter afterwards, capped.
 */
export const computeCloudSyncReconnectDelayMs = (
  consecutiveFailures: number,
  options: CloudSyncReconnectDelayOptions = {}
): number => {
  const failures = Number.isFinite(consecutiveFailures)
    ? Math.max(0, Math.floor(consecutiveFailures))
    : 0;
  const graceAttempts = Math.max(0, options.graceAttempts ?? DEFAULT_GRACE_ATTEMPTS);
  if (failures <= graceAttempts) {
    return 0;
  }
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** (failures - graceAttempts - 1));
  const random = options.random ?? Math.random;
  const jitter =
    exponentialDelay * RECONNECT_JITTER_FRACTION * (Math.min(1, Math.max(0, random())) * 2 - 1);
  return Math.min(maxDelayMs, Math.max(0, Math.round(exponentialDelay + jitter)));
};

/** The part of the `WebSocket` surface the Convex client actually drives. */
type WebSocketLike = {
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send: (data: unknown) => void;
  close: (code?: number, reason?: string) => void;
};

export type CloudSyncReconnectGateOptions = CloudSyncReconnectDelayOptions & {
  logger?: Logger;
  stabilityWindowMs?: number;
  forcedReconnectMinIntervalMs?: number;
  /** Test seam; production resolves the (proxy-aware) global `WebSocket`. */
  createSocket?: (url: string) => WebSocketLike;
};

type PendingConnect = {
  timer: ReturnType<typeof setTimeout> | null;
  start: () => void;
  /** `emitClose` resolves a waiting `close()`; silence is for a superseded socket. */
  cancel: (emitClose: boolean) => void;
};

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export class CloudSyncReconnectGate {
  private readonly logger: Logger | null;
  private readonly delayOptions: CloudSyncReconnectDelayOptions;
  private readonly stabilityWindowMs: number;
  private readonly forcedReconnectMinIntervalMs: number;
  private readonly createSocket: (url: string) => WebSocketLike;

  private consecutiveFailures = 0;
  private nextAllowedConnectAtMs = 0;
  private lastForcedReleaseAtMs = Number.NEGATIVE_INFINITY;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * An online signal that could not start a connection yet.
   *
   * Most signals arrive when there is nothing to release: the Convex client is
   * asleep in its own backoff, or an attempt is already in flight. Spending the
   * signal there would lose it — the in-flight attempt fails, a fresh hold of up
   * to the ceiling is installed, and the online edge does not fire again while
   * the transport stays healthy. So the signal is LATCHED until the next connect
   * request can act on it, and cleared once any real attempt has started (an
   * attempt that has already run is the signal's answer, whether it needed the
   * shortcut or not).
   */
  private onlineSignal: { reason: string } | null = null;
  /**
   * At most one deferred connection exists at a time. The Convex client keeps a
   * single socket and abandons the previous one (without closing it) before
   * constructing the next, so a superseded deferral must never be allowed to
   * open a socket of its own — otherwise every abandoned deferral would fire at
   * the same deadline and reconnect in a burst.
   */
  private pending: PendingConnect | null = null;
  private disposed = false;

  constructor(options: CloudSyncReconnectGateOptions = {}) {
    this.logger = options.logger ?? null;
    this.delayOptions = {
      graceAttempts: options.graceAttempts,
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
      random: options.random,
    };
    this.stabilityWindowMs = Math.max(0, options.stabilityWindowMs ?? DEFAULT_STABILITY_WINDOW_MS);
    this.forcedReconnectMinIntervalMs = Math.max(
      0,
      options.forcedReconnectMinIntervalMs ?? DEFAULT_FORCED_RECONNECT_MIN_INTERVAL_MS
    );
    this.createSocket =
      options.createSocket ??
      ((url: string) => {
        // Resolved per connection, never captured at import time: the CLI
        // installs a proxy-aware `WebSocket` as a side effect of loading the
        // Loro runtime, which may happen after this gate is constructed.
        const Ctor = globalThis.WebSocket as unknown as new (url: string) => WebSocketLike;
        return new Ctor(url);
      });
  }

  /** Diagnostics for tests and log lines; never a control input. */
  get state(): { consecutiveFailures: number; nextAllowedConnectAtMs: number } {
    return {
      consecutiveFailures: this.consecutiveFailures,
      nextAllowedConnectAtMs: this.nextAllowedConnectAtMs,
    };
  }

  /**
   * Something else proved the network is usable again: connect now instead of
   * serving out the remaining wait. The failure streak is deliberately NOT
   * cleared — if this attempt fails too, backoff resumes where it left off
   * instead of restarting the storm from the base delay.
   *
   * @returns whether a held connection started right away. `false` also covers
   * the common case where the signal was latched for the next connect request
   * (nothing was waiting yet, or the forced-reconnect floor has not passed);
   * a latched signal is not lost.
   */
  notifyOnline(reason: string): boolean {
    if (this.disposed) {
      return false;
    }
    if (this.consecutiveFailures === 0 && this.nextAllowedConnectAtMs === 0 && !this.pending) {
      return false;
    }
    this.onlineSignal = { reason };
    const pending = this.pending;
    if (!pending) {
      this.logger?.debug(
        `[cloud-sync-reconnect] Online signal held for the next connect: reason=${reason}`
      );
      return false;
    }
    const consumed = this.tryConsumeOnlineSignal();
    if (!consumed) {
      return false;
    }
    this.logger?.debug(
      `[cloud-sync-reconnect] Online signal, reconnecting now: reason=${consumed}`
    );
    this.nextAllowedConnectAtMs = 0;
    this.clearPendingTimer(pending);
    this.pending = null;
    pending.start();
    return true;
  }

  /**
   * The `webSocketConstructor` to hand to `ConvexClient`. The returned class
   * behaves like a `WebSocket` whose connection may start later than its
   * construction.
   */
  createWebSocketConstructor(): typeof WebSocket {
    const gate = this;

    class GatedCloudSyncWebSocket {
      static readonly CONNECTING = CONNECTING;
      static readonly OPEN = OPEN;
      static readonly CLOSING = CLOSING;
      static readonly CLOSED = CLOSED;
      readonly CONNECTING = CONNECTING;
      readonly OPEN = OPEN;
      readonly CLOSING = CLOSING;
      readonly CLOSED = CLOSED;

      readonly url: string;
      readyState: number = CONNECTING;
      onopen: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onmessage: ((event: unknown) => void) | null = null;
      onclose: ((event: unknown) => void) | null = null;

      private inner: WebSocketLike | null = null;
      private settled = false;
      private closeRequested = false;

      constructor(url: string | URL) {
        this.url = typeof url === 'string' ? url : url.toString();
        gate.requestConnect({
          start: () => this.startConnection(),
          cancel: (emitClose) => this.cancelBeforeConnect(emitClose),
        });
      }

      send(data: unknown): void {
        if (!this.inner || this.readyState !== OPEN) {
          throw new Error('Cloud sync WebSocket is not open');
        }
        this.inner.send(data);
      }

      close(code?: number, reason?: string): void {
        this.closeRequested = true;
        if (this.readyState === CLOSED) {
          // Convex waits for `onclose` after calling `close()`, including on a
          // socket it already abandoned; resolving it keeps shutdown prompt.
          this.emitClose({ code: code ?? 1000, reason: reason ?? '', wasClean: true });
          return;
        }
        if (!this.inner) {
          gate.cancelPending();
          this.readyState = CLOSED;
          this.emitClose({ code: code ?? 1000, reason: reason ?? '', wasClean: true });
          return;
        }
        this.readyState = CLOSING;
        this.inner.close(code, reason);
      }

      /**
       * Cancelled before the real connection started. A superseded socket stays
       * silent (the client already moved on to a newer one); a gate shutdown
       * emits the close event a pending `close()` is waiting for.
       */
      private cancelBeforeConnect(emitClose: boolean): void {
        if (this.inner || this.readyState === CLOSED) {
          return;
        }
        this.readyState = CLOSED;
        if (emitClose) {
          this.emitClose({ code: 1000, reason: 'cloud sync client disposed', wasClean: true });
        }
      }

      private startConnection(): void {
        if (this.readyState === CLOSED || this.closeRequested) {
          return;
        }
        let socket: WebSocketLike;
        gate.reportAttemptStarted();
        try {
          socket = gate.createSocket(this.url);
        } catch (error) {
          this.readyState = CLOSED;
          gate.reportAttemptFailed('construct-failed');
          // The first connection starts inside this constructor, before the
          // client has assigned its handlers, so a synchronous failure must be
          // delivered on a later tick or it would be dropped.
          const deliver = setTimeout(() => {
            this.onerror?.(error);
            this.emitClose({ code: 1006, reason: 'connect failed', wasClean: false });
          }, 0);
          deliver.unref?.();
          return;
        }
        this.inner = socket;
        socket.onopen = (event) => {
          this.readyState = OPEN;
          gate.reportAttemptOpened();
          this.onopen?.(event);
        };
        socket.onmessage = (event) => {
          this.onmessage?.(event);
        };
        socket.onerror = (event) => {
          this.onerror?.(event);
        };
        socket.onclose = (event) => {
          this.readyState = CLOSED;
          gate.reportAttemptFailed('closed');
          this.emitClose(event);
        };
      }

      private emitClose(event: unknown): void {
        if (this.settled) {
          return;
        }
        this.settled = true;
        this.readyState = CLOSED;
        this.onclose?.(event);
      }
    }

    // The Convex option is typed as the full DOM `WebSocket` constructor. The
    // client drives only the members implemented above (verified against
    // `convex/browser/sync/web_socket_manager`), so the unused remainder of that
    // interface is intentionally absent rather than stubbed.
    return GatedCloudSyncWebSocket as unknown as typeof WebSocket;
  }

  dispose(): void {
    this.disposed = true;
    this.onlineSignal = null;
    this.cancelPending({ emitClose: true });
    this.clearStabilityTimer();
  }

  private requestConnect(handlers: {
    start: () => void;
    cancel: (emitClose: boolean) => void;
  }): void {
    const previous = this.pending;
    if (previous) {
      this.clearPendingTimer(previous);
      this.pending = null;
      previous.cancel(false);
    }
    if (this.disposed) {
      return;
    }
    let waitMs = Math.max(0, this.nextAllowedConnectAtMs - Date.now());
    if (waitMs > 0) {
      const consumed = this.tryConsumeOnlineSignal();
      if (consumed) {
        this.logger?.debug(
          `[cloud-sync-reconnect] Online signal released a ${Math.round(waitMs / 1000)}s hold: ` +
            `reason=${consumed}`
        );
        this.nextAllowedConnectAtMs = 0;
        waitMs = 0;
      }
    }
    if (waitMs === 0) {
      handlers.start();
      return;
    }
    const pending: PendingConnect = {
      timer: null,
      start: handlers.start,
      cancel: handlers.cancel,
    };
    this.logger?.debug(
      `[cloud-sync-reconnect] Holding cloud sync connect for ${Math.round(waitMs / 1000)}s ` +
        `after ${this.consecutiveFailures} consecutive failures`
    );
    const timer = setTimeout(() => {
      if (this.pending !== pending) {
        return;
      }
      this.pending = null;
      pending.start();
    }, waitMs);
    timer.unref?.();
    pending.timer = timer;
    this.pending = pending;
  }

  private cancelPending(options: { emitClose: boolean } = { emitClose: false }): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.clearPendingTimer(pending);
    this.pending = null;
    pending.cancel(options.emitClose);
  }

  private clearPendingTimer(pending: PendingConnect): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
  }

  /**
   * Takes the latched online signal if the forced-reconnect floor allows it.
   * A throttled signal STAYS latched: the next connect request retries it, so
   * flapping is bounded to one forced attempt per minute without any single
   * genuine recovery being thrown away.
   */
  private tryConsumeOnlineSignal(): string | null {
    const signal = this.onlineSignal;
    if (!signal) {
      return null;
    }
    const now = Date.now();
    if (now - this.lastForcedReleaseAtMs < this.forcedReconnectMinIntervalMs) {
      this.logger?.debug(
        `[cloud-sync-reconnect] Online signal still held (forced reconnect ${Math.round(
          (now - this.lastForcedReleaseAtMs) / 1000
        )}s ago): reason=${signal.reason}`
      );
      return null;
    }
    this.onlineSignal = null;
    this.lastForcedReleaseAtMs = now;
    return signal.reason;
  }

  /**
   * A new attempt supersedes the previous connection's stability window, which
   * would otherwise reset the streak on behalf of a connection that is gone. It
   * also answers any latched online signal: the attempt this signal was waiting
   * for has now run.
   */
  private reportAttemptStarted(): void {
    this.clearStabilityTimer();
    this.onlineSignal = null;
  }

  private reportAttemptOpened(): void {
    this.clearStabilityTimer();
    if (this.consecutiveFailures === 0) {
      return;
    }
    const timer = setTimeout(() => {
      this.stabilityTimer = null;
      this.logger?.debug(
        `[cloud-sync-reconnect] Cloud sync connection stable; backoff reset after ` +
          `${this.consecutiveFailures} consecutive failures`
      );
      this.consecutiveFailures = 0;
      this.nextAllowedConnectAtMs = 0;
      // A connection that holds ends the outage: the next one starts from a
      // clean slate, including the forced-reconnect floor.
      this.lastForcedReleaseAtMs = Number.NEGATIVE_INFINITY;
    }, this.stabilityWindowMs);
    timer.unref?.();
    this.stabilityTimer = timer;
  }

  private reportAttemptFailed(reason: string): void {
    this.clearStabilityTimer();
    this.consecutiveFailures += 1;
    const delayMs = computeCloudSyncReconnectDelayMs(this.consecutiveFailures, this.delayOptions);
    this.nextAllowedConnectAtMs = delayMs > 0 ? Date.now() + delayMs : 0;
    if (delayMs > 0) {
      this.logger?.debug(
        `[cloud-sync-reconnect] Cloud sync connection ${reason} ` +
          `(${this.consecutiveFailures} consecutive); next attempt held ${Math.round(
            delayMs / 1000
          )}s`
      );
    }
  }

  private clearStabilityTimer(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }
}

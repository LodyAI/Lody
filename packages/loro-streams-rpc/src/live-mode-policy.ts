/**
 * SSE-first live transport policy with a bounded long-poll fallback.
 *
 * Machine RPC responses are an always-on live read. Long-poll pays a GET plus a
 * CORS preflight per cycle (the `cursor`/`offset` change every poll, so the
 * preflight cache cannot collapse them), which a healthy SSE connection avoids
 * entirely. But `@loro-dev/streams-client` `auto` mode only downgrades to
 * long-poll on an explicit 400 "SSE unsupported" response: an SSE connection
 * that fails after startup — or that connects and then silently stops
 * delivering — ends the live iterator with an error instead of falling back,
 * which strands every pending RPC call.
 *
 * This policy sits above the streams client and owns that decision:
 *
 * - Start on SSE (requested as `auto`, so a server that rejects SSE outright is
 *   downgraded inside the same read with no gap).
 * - Fall back to long-poll when SSE is unsupported, when consecutive SSE reads
 *   fail, or when pending RPC responses keep timing out while SSE looks healthy
 *   (the silent-loss case that has no transport-level signal).
 * - Renew earlier for an appended interactive history input that still needs
 *   a reply, without failing or replaying that input.
 * - Re-probe SSE after a cooldown, except when the server said it does not
 *   support SSE at all.
 *
 * One instance tracks one live stream. Offsets/cursors live in the caller's
 * `LoroJsonStreamState` and are untouched by transport switches.
 */

export type LoroStreamsLiveTransport = 'sse' | 'long-poll';

export type LoroStreamsLiveRequestMode = 'auto' | 'sse' | 'long-poll';

export type LoroStreamsLiveModeReason =
  /** Initial SSE-first selection. */
  | 'initial'
  /** Server answered the SSE read with an explicit "SSE unsupported" 400. */
  | 'sse-unsupported'
  /** Consecutive SSE live reads failed or delivered nothing. */
  | 'sse-read-failures'
  /** Pending RPC calls timed out while the SSE read itself looked healthy. */
  | 'sse-response-starvation'
  /** An appended foreground history write still needs its response. */
  | 'pending-write-recovery'
  /** Cooldown elapsed; probing SSE again. */
  | 'sse-retry-probe';

export type LoroStreamsLiveModeDiagnostics = {
  /** Transport the next live read will request. */
  readonly transport: LoroStreamsLiveTransport;
  /** Transport the server actually served the last read with, when known. */
  readonly observedTransport?: LoroStreamsLiveTransport;
  /** Why the current transport was selected. */
  readonly reason: LoroStreamsLiveModeReason;
  /** How many times the policy has switched transports. */
  readonly transportSwitches: number;
  readonly consecutiveSseReadFailures: number;
  readonly sseResponseTimeouts: number;
  /** When SSE will be probed again, or `undefined` when it will not. */
  readonly nextSseProbeAtMs?: number;
  /** Set when the transport is pinned by configuration; no fallback runs. */
  readonly pinned?: LoroStreamsLiveTransport;
};

export type LoroStreamsLiveReadOutcome = {
  /** Mode that was requested for this read. */
  readonly requestedMode: LoroStreamsLiveRequestMode;
  /** Transport the streams client reported on its live events, when any arrived. */
  readonly observedTransport?: LoroStreamsLiveTransport;
  /** Whether the read delivered at least one `data`/`up_to_date`/`eof` batch. */
  readonly deliveredBatch: boolean;
  /** Error the read threw, if it failed. */
  readonly error?: unknown;
};

/** Consecutive failed SSE reads before falling back to long-poll. */
export const DEFAULT_SSE_READ_FAILURE_LIMIT = 3;
/**
 * Pending-response timeouts (with no response received in between) tolerated on
 * a seemingly healthy SSE read before falling back. Interactive history inputs
 * also have an earlier response-read recovery trigger.
 */
export const DEFAULT_SSE_RESPONSE_TIMEOUT_LIMIT = 3;
/** How long to stay on long-poll before probing SSE again. */
export const DEFAULT_SSE_RETRY_COOLDOWN_MS = 5 * 60_000;

export type LoroStreamsLiveModePolicyOptions = {
  /**
   * Force a transport and disable all fallback/probe logic. Used by the
   * `VITE_LORO_STREAMS_RPC_LIVE_MODE` escape hatch.
   */
  pin?: LoroStreamsLiveTransport;
  sseReadFailureLimit?: number;
  sseResponseTimeoutLimit?: number;
  sseRetryCooldownMs?: number;
  now?: () => number;
  /** Called whenever the selected transport changes. */
  onChange?: (diagnostics: LoroStreamsLiveModeDiagnostics) => void;
};

export class LoroStreamsLiveModePolicy {
  private transport: LoroStreamsLiveTransport;
  private observedTransport: LoroStreamsLiveTransport | undefined;
  private reason: LoroStreamsLiveModeReason = 'initial';
  private transportSwitches = 0;
  private consecutiveSseReadFailures = 0;
  private sseResponseTimeouts = 0;
  private nextSseProbeAtMs: number | undefined;
  private hasFallenBack = false;

  private readonly pin: LoroStreamsLiveTransport | undefined;
  private readonly sseReadFailureLimit: number;
  private readonly sseResponseTimeoutLimit: number;
  private readonly sseRetryCooldownMs: number;
  private readonly now: () => number;
  private readonly onChange: ((diagnostics: LoroStreamsLiveModeDiagnostics) => void) | undefined;

  constructor(options: LoroStreamsLiveModePolicyOptions = {}) {
    this.pin = options.pin;
    this.transport = options.pin ?? 'sse';
    this.sseReadFailureLimit = Math.max(
      1,
      options.sseReadFailureLimit ?? DEFAULT_SSE_READ_FAILURE_LIMIT
    );
    this.sseResponseTimeoutLimit = Math.max(
      1,
      options.sseResponseTimeoutLimit ?? DEFAULT_SSE_RESPONSE_TIMEOUT_LIMIT
    );
    this.sseRetryCooldownMs = Math.max(
      0,
      options.sseRetryCooldownMs ?? DEFAULT_SSE_RETRY_COOLDOWN_MS
    );
    this.now = options.now ?? (() => Date.now());
    this.onChange = options.onChange;
  }

  /**
   * Mode to pass to the streams client for the next live read. SSE is requested
   * as `auto` so an "SSE unsupported" server downgrades inside the same read
   * instead of ending it with an error.
   */
  selectRequestMode(): LoroStreamsLiveRequestMode {
    if (this.pin) {
      return this.pin;
    }
    if (this.transport === 'long-poll') {
      if (this.nextSseProbeAtMs === undefined || this.now() < this.nextSseProbeAtMs) {
        return 'long-poll';
      }
      this.setTransport('sse', 'sse-retry-probe');
    }
    return 'auto';
  }

  noteReadOutcome(outcome: LoroStreamsLiveReadOutcome): void {
    if (outcome.observedTransport) {
      this.observedTransport = outcome.observedTransport;
    }
    if (this.pin || outcome.requestedMode === 'long-poll') {
      return;
    }

    // The streams client reports the transport it actually used. Seeing
    // long-poll from an `auto` request means the server rejected SSE.
    if (outcome.observedTransport === 'long-poll') {
      this.consecutiveSseReadFailures = 0;
      this.fallback('sse-unsupported', { probeAgain: false });
      return;
    }

    // A healthy SSE read always delivers at least the `up_to_date` emitted on
    // connect, and a compliant server closes it every ~60s. A read that throws
    // or that returns without delivering anything did not work.
    if (outcome.error !== undefined || !outcome.deliveredBatch) {
      this.consecutiveSseReadFailures += 1;
      // A probe after a previous fallback gets one attempt: SSE already proved
      // broken here, so pending calls should not wait out the full budget again.
      const limit = this.hasFallenBack ? 1 : this.sseReadFailureLimit;
      if (this.consecutiveSseReadFailures >= limit) {
        this.fallback('sse-read-failures', { probeAgain: true });
      }
      return;
    }

    this.consecutiveSseReadFailures = 0;
  }

  /** A response arrived on the live stream: SSE is delivering. */
  noteResponseReceived(): void {
    this.sseResponseTimeouts = 0;
  }

  /**
   * A pending RPC call timed out with no response. On SSE this is the only
   * evidence of a connection that stays open but never delivers.
   */
  noteResponseTimeout(): void {
    if (this.pin || this.transport !== 'sse') {
      return;
    }
    this.sseResponseTimeouts += 1;
    if (this.sseResponseTimeouts >= this.sseResponseTimeoutLimit) {
      this.fallback('sse-response-starvation', { probeAgain: true });
    }
  }

  /** Recover the response read without expiring or replaying an input write. */
  recoverPendingWrite(): void {
    if (this.pin) return;
    if (this.transport === 'sse') {
      this.fallback('pending-write-recovery', { probeAgain: true });
    } else if (this.nextSseProbeAtMs !== undefined) {
      // Do not use the foreground recovery read as an SSE retry probe.
      this.nextSseProbeAtMs = this.now() + this.sseRetryCooldownMs;
    }
  }

  getDiagnostics(): LoroStreamsLiveModeDiagnostics {
    return {
      transport: this.transport,
      observedTransport: this.observedTransport,
      reason: this.reason,
      transportSwitches: this.transportSwitches,
      consecutiveSseReadFailures: this.consecutiveSseReadFailures,
      sseResponseTimeouts: this.sseResponseTimeouts,
      nextSseProbeAtMs: this.nextSseProbeAtMs,
      pinned: this.pin,
    };
  }

  private fallback(reason: LoroStreamsLiveModeReason, options: { probeAgain: boolean }): void {
    this.hasFallenBack = true;
    this.nextSseProbeAtMs = options.probeAgain ? this.now() + this.sseRetryCooldownMs : undefined;
    this.setTransport('long-poll', reason);
  }

  private setTransport(
    transport: LoroStreamsLiveTransport,
    reason: LoroStreamsLiveModeReason
  ): void {
    const changed = this.transport !== transport;
    this.transport = transport;
    this.reason = reason;
    if (transport === 'sse') {
      this.nextSseProbeAtMs = undefined;
      this.sseResponseTimeouts = 0;
      this.consecutiveSseReadFailures = 0;
    }
    if (!changed) {
      return;
    }
    this.transportSwitches += 1;
    this.onChange?.(this.getDiagnostics());
  }
}

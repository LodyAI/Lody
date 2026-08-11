import type { WorkspaceId } from '@lody/shared';
import { Effect, Fiber, Queue } from 'effect';
import type {
  LoroRepo,
  RepoTransportRoomEntry,
  RepoTransportRoomStatus,
  TransportConnectionStatus,
} from 'loro-repo';
import type { RepoRoomSubscription } from 'loro-repo';

import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';

import {
  STREAMS_TRANSPORT_ID,
  streamsRoomBinding,
  type StreamsRoomBinding,
} from './streams-room-binding';
import { readTimeoutEnv, withTimeout } from './timeout-utils';

export type MetaRoomSyncedListener = (reason: string) => void | Promise<void>;
export type StreamsOnlineListener = (reason: string) => void | Promise<void>;

type ReconnectOptions = {
  force?: boolean;
  logWhenHealthy: boolean;
};

const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_JITTER_FRACTION = 0.2;
// Fan-out cap for the errored-binding rejoin sweep (O(rooms) work).
const REJOIN_SWEEP_CONCURRENCY = 4;
// Total-time cap, expressed in per-batch timeouts: the sweep must not hold the
// recovery fiber (or cleanUp) for longer than a few batches, however many
// rooms are errored. Leftovers wait for the next watchdog pass.
const REJOIN_SWEEP_MAX_BATCHES = 3;
/**
 * Floor on how often the EXPENSIVE `meta-room-synced` fan-out may run.
 *
 * Its listeners do O(rooms) rescans, so the trigger rate is what decides
 * whether a degraded transport costs a few scans or thousands. Per
 * `src/session/AGENTS.md`, coalescing bounds the work per trigger and keeping
 * that rate sane "is the connection recovery boundary's job" — so the throttle
 * lives here rather than in each listener. A throttled emit is always
 * DEFERRED, never dropped: the dispatch bootstrap scan is the only retry path
 * for a session whose reconcile threw, so dropping one can strand it.
 */
const DEFAULT_META_SYNCED_MIN_INTERVAL_MS = 30_000;
/**
 * How long health must HOLD before the reconnect backoff is trusted again.
 *
 * The aggregate transport status covers every joined room, so a single stuck
 * room can flip it `disconnected -> connecting -> disconnected` about once a
 * second. Each transient healthy blip used to zero `reconnectAttempt`, so the
 * 1s->30s exponential backoff never engaged and the recovery loop ran at its
 * base delay indefinitely. Health that does not survive this window counts as
 * a failed recovery and backs off instead.
 */
const DEFAULT_HEALTH_STABILITY_WINDOW_MS = 5_000;
/** Keeps the backoff exponent (and its log lines) in a sane range. */
const MAX_RECONNECT_ATTEMPT = 30;

export const computeLoroReconnectDelayMs = (
  attempt: number,
  options: { baseDelayMs?: number; maxDelayMs?: number; random?: () => number } = {}
): number => {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS);
  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** safeAttempt);
  const random = options.random ?? Math.random;
  const jitter =
    exponentialDelay * RECONNECT_JITTER_FRACTION * (Math.min(1, Math.max(0, random())) * 2 - 1);
  return Math.min(maxDelayMs, Math.max(0, Math.round(exponentialDelay + jitter)));
};

type ReconnectCompletion = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

type RecoveryEvent =
  | {
      type: 'reconnect';
      reason: string;
      options: ReconnectOptions;
      completion?: ReconnectCompletion;
    }
  | {
      type: 'meta-room-ready';
      metaSub: RepoRoomSubscription;
      generation: number;
      reason: string;
    };

type LoroConnectionRecoveryControllerOptions = {
  repo: LoroRepo;
  workspaceId: WorkspaceId;
  logger: Logger;
  initialMetaSub: RepoRoomSubscription | null;
  initialTransportStatus: TransportConnectionStatus;
  initialMetaSyncPromise: Promise<boolean>;
  initialMetaSyncCompleted: boolean;
  onMetaRoomReady: () => void;
};

// 'detached' is deliberately NOT recoverable: it means the 'streams' transport
// is not attached to the room at all (offline / pre-attach), and reconnecting
// cannot change that — only `repo.addTransport` can. Recovery must not spin on
// it. Statuses MUST be read from the 'streams' binding (streamsRoomBinding):
// the classic surface reports a detached binding as 'disconnected', which this
// predicate would wrongly treat as recoverable.
const isRecoverableMetaRoomStatus = (status: RepoTransportRoomStatus | null): boolean =>
  status === 'disconnected' || status === 'error';

/**
 * What the CLI believes about the Streams plane, as a first-class state.
 *
 * `TransportConnectionStatus` is an AGGREGATE over every room this repo has
 * joined (`getConnectionStatusFromSessions()` in loro-repo's streams adapter):
 * `connected` only when EVERY room is connected, `connecting` when any room is
 * joining or reconnecting, `disconnected` when any room is disconnected or
 * errored. A workspace with thousands of session rooms joins rooms lazily and
 * keeps doing so forever, so the aggregate sits at `connecting` a large part of
 * the time while the transport is perfectly healthy. `joining-rooms` names that
 * state so it can never be mistaken for a stuck transport needing recovery.
 */
export type LoroStreamsHealth =
  /** Meta room joined and every joined room connected. */
  | 'connected'
  /** Meta room joined; at least one other room is mid-join. Not a failure. */
  | 'joining-rooms'
  /** Meta room degraded, or at least one room is disconnected/errored. */
  | 'recovering';

export class LoroConnectionRecoveryController {
  private readonly recoveryEvents = Effect.runSync(Queue.unbounded<RecoveryEvent>());
  private readonly metaRoomSyncedListeners = new Set<MetaRoomSyncedListener>();
  private readonly streamsOnlineListeners = new Set<StreamsOnlineListener>();
  private readonly pendingReconnectCompletions = new Set<ReconnectCompletion>();
  private readonly eventFiber: Fiber.RuntimeFiber<never, never>;
  private readonly repo: LoroRepo;
  private readonly workspaceId: WorkspaceId;
  private readonly logger: Logger;
  private readonly onMetaRoomReady: () => void;

  private transportStatus: TransportConnectionStatus;
  private metaRoomStatus: RepoTransportRoomStatus | null = null;
  private metaSub: RepoRoomSubscription | null = null;
  // Detached-aware 'streams' binding view of `metaSub` (see streamsRoomBinding);
  // all status reads and sync waits go through it, never the classic surface.
  private metaSource: StreamsRoomBinding | null = null;
  private detachMetaRoomStatusLogger: (() => void) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectInterval: NodeJS.Timeout | null = null;
  private activeOperation: Promise<void> | null = null;
  private streamsRecoveryGeneration = 0;
  private emittedStreamsRecoveryGeneration = 0;
  private reconnectAttempt = 0;
  private initialMetaSyncCompleted: boolean;
  private isCleanedUp = false;
  /** When the current healthy stretch began; null while unhealthy. */
  private healthySinceMs: number | null = null;
  /** Set once this episode has actually attempted recovery. */
  private isRecoveryEpisode = false;
  /**
   * Whether the current healthy stretch was reached BY a recovery. Only such a
   * stretch can be a flap: the first fault of an episode is the outage itself,
   * not a recovery that failed to stick, and must not be charged to the backoff.
   */
  private healthRoseFromRecovery = false;
  private backoffResetTimer: NodeJS.Timeout | null = null;
  private lastMetaSyncedEmitMs = 0;
  private pendingMetaSyncedEmit: { reason: string } | null = null;
  private metaSyncedThrottleTimer: NodeJS.Timeout | null = null;
  /**
   * Whether the meta room actually degraded since the last fan-out. A recovery
   * episode that took the meta room down may have missed remote metadata, so it
   * rescans immediately; a transport-only flap (meta stayed 'joined') cannot
   * have missed a meta event and takes the throttled path.
   */
  private metaRoomDegradedSinceEmit = true;

  constructor(options: LoroConnectionRecoveryControllerOptions) {
    this.repo = options.repo;
    this.workspaceId = options.workspaceId;
    this.logger = options.logger;
    this.onMetaRoomReady = options.onMetaRoomReady;
    this.transportStatus = options.initialTransportStatus;
    this.initialMetaSyncCompleted = options.initialMetaSyncCompleted;
    this.eventFiber = Effect.runFork(this.createEventLoop());

    void options.initialMetaSyncPromise
      .then((completed) => {
        if (completed) {
          this.initialMetaSyncCompleted = true;
        }
      })
      .catch(() => {});

    this.attachMetaRoomStatusLogger(options.initialMetaSub, {
      emitReadyIfJoined: !this.initialMetaSyncCompleted,
    });
    this.startAutoReconnectWatchdog();
    if (!options.initialMetaSub || this.transportStatus === 'disconnected') {
      this.scheduleReconnect('startup-unhealthy');
    }
  }

  isTransportConnected(): boolean {
    return this.transportStatus === 'connected';
  }

  isRecovering(): boolean {
    return !this.isCleanedUp && !this.isStreamsHealthy();
  }

  /** First-class Streams state; see {@link LoroStreamsHealth}. */
  getStreamsHealth(): LoroStreamsHealth {
    if (!this.isStreamsHealthy()) {
      return 'recovering';
    }
    return this.transportStatus === 'connected' ? 'connected' : 'joining-rooms';
  }

  setTransportStatus(status: TransportConnectionStatus): void {
    const wasHealthy = this.isStreamsHealthy();
    this.transportStatus = status;
    const isHealthy = this.isStreamsHealthy();
    // Edges are taken on HEALTH, not on the raw aggregate status. Lazy room
    // joins flip the aggregate between `connected` and `connecting` constantly;
    // treating that as a recovery episode used to start a new generation and
    // re-emit `meta-room-synced` every few seconds, which re-ran every
    // listener's O(rooms) recovery work and joined more rooms — a self-
    // sustaining loop that burned daemon CPU.
    if (wasHealthy && !isHealthy) {
      this.streamsRecoveryGeneration += 1;
      this.handleHealthFell('transport-disconnected');
    }
    if (isHealthy) {
      if (!wasHealthy) {
        this.handleHealthRose();
        this.offerStreamsReady(this.metaSub, 'transport-connected');
      }
      this.resetReconnectBackoff('transport-connected');
      return;
    }
    if (status === 'disconnected') {
      this.scheduleReconnect('transport-disconnected');
    }
  }

  /**
   * Health just came back. Start the stability clock; the backoff counter is
   * only trusted once health survives {@link DEFAULT_HEALTH_STABILITY_WINDOW_MS}.
   */
  private handleHealthRose(): void {
    this.healthySinceMs = Date.now();
    this.healthRoseFromRecovery = this.isRecoveryEpisode;
    this.isRecoveryEpisode = false;
  }

  /**
   * Health just dropped. A healthy stretch shorter than the stability window
   * was not a real recovery — it is a flap, so charge it to the backoff instead
   * of letting the next attempt start from the base delay again.
   */
  private handleHealthFell(reason: string): void {
    this.cancelBackoffReset();
    const heldMs =
      this.healthySinceMs === null ? Number.POSITIVE_INFINITY : Date.now() - this.healthySinceMs;
    const cameFromRecovery = this.healthRoseFromRecovery;
    this.healthySinceMs = null;
    this.healthRoseFromRecovery = false;
    if (!cameFromRecovery || heldMs >= this.readHealthStabilityWindowMs()) {
      return;
    }
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPT) {
      return;
    }
    this.reconnectAttempt += 1;
    this.logger.debug(
      `[${this.workspaceId}] Streams health did not hold (${Math.round(heldMs)}ms, reason=${reason}); backing off (attempt=${this.reconnectAttempt})`
    );
  }

  async reconnect(reason: string): Promise<void> {
    if (this.isCleanedUp) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const completion = { resolve, reject };
      this.pendingReconnectCompletions.add(completion);
      const queued = this.offer({
        type: 'reconnect',
        reason,
        options: { force: true, logWhenHealthy: true },
        completion,
      });
      if (!queued) {
        this.resolveReconnectCompletion(completion);
      }
    });
  }

  /**
   * The EXPENSIVE recovery signal: "the workspace index may have missed events,
   * rescan it". Listeners here do O(rooms) work, so this is rate-limited (see
   * {@link DEFAULT_META_SYNCED_MIN_INTERVAL_MS}) and only fires after the meta
   * room confirms catch-up.
   *
   * If your listener just needs to release work that was held while offline,
   * use {@link onStreamsOnline} instead — it is unconditional and immediate.
   */
  onMetaRoomSynced(listener: MetaRoomSyncedListener): () => void {
    this.metaRoomSyncedListeners.add(listener);
    return () => {
      this.metaRoomSyncedListeners.delete(listener);
    };
  }

  /**
   * The CHEAP recovery signal: "the Streams plane is usable again".
   *
   * Fires on every health rising edge, with no sync wait and no throttle, so
   * work that was parked while offline resumes promptly. This exists because
   * `onMetaRoomSynced` used to carry both meanings: throttling it alone would
   * have stalled the parked-work consumers (a dirty Machine Flock doc arms no
   * timer of its own — this signal is its only wake-up — and the task/review
   * automation queues wait for an unrelated index change otherwise).
   *
   * Listeners MUST be cheap and idempotent: there is no rate limit here.
   */
  onStreamsOnline(listener: StreamsOnlineListener): () => void {
    this.streamsOnlineListeners.add(listener);
    return () => {
      this.streamsOnlineListeners.delete(listener);
    };
  }

  async waitUntilMetaSynced(
    options: { timeoutMs?: number; reason?: string } = {}
  ): Promise<boolean> {
    if (this.isCleanedUp) {
      return false;
    }

    const reason = options.reason ?? 'explicit-wait';
    try {
      await this.ensureMetaRoomJoined(`wait-until-synced:${reason}`);
    } catch (error) {
      this.logger.debug(
        `[${this.workspaceId}] Failed to join Loro meta room before sync wait (reason=${reason}): ${formatErrorMessage(
          error
        )}`
      );
      return false;
    }

    const metaSub = this.metaSub;
    const metaSource = this.metaSource;
    if (!metaSub || !metaSource) {
      this.logger.debug(
        `[${this.workspaceId}] Cannot wait for Loro meta sync; meta room is not joined (reason=${reason})`
      );
      return false;
    }

    // A disconnected transport cannot confirm pending writes within any
    // bounded wait — recovery runs on its own schedule. Answer "not
    // confirmed" immediately instead of burning the timeout on every call
    // while offline.
    if (this.transportStatus === 'disconnected') {
      this.logger.debug(
        `[${this.workspaceId}] Skipping Loro meta sync wait: transport is disconnected (reason=${reason})`
      );
      return false;
    }

    // No transport attached at all (deliberately offline): pending writes
    // cannot be confirmed and `firstSyncedWithRemote` cannot settle. Answer
    // immediately instead of burning the timeout.
    if (this.metaRoomStatus === 'detached') {
      this.logger.debug(
        `[${this.workspaceId}] Skipping Loro meta sync wait: meta room is detached (reason=${reason})`
      );
      return false;
    }

    const timeoutMs =
      options.timeoutMs ?? readTimeoutEnv('LODY_LORO_WAIT_META_SYNC_TIMEOUT_MS', 4_000);
    const timeoutMessage = `Timeout waiting for Loro meta pending writes (workspace=${this.workspaceId})`;
    const startedAt = Date.now();
    const waitWithRemainingTimeout = async <T>(promise: Promise<T>, phase: string): Promise<T> => {
      if (timeoutMs <= 0) {
        return await promise;
      }
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(1, timeoutMs - elapsedMs);
      return await withTimeout(promise, remainingMs, `${timeoutMessage}, phase=${phase}`);
    };

    try {
      if (!this.initialMetaSyncCompleted) {
        await waitWithRemainingTimeout(metaSource.firstSyncedWithRemote, 'initial');
        if (this.metaSub !== metaSub || this.isCleanedUp) {
          return false;
        }
        this.initialMetaSyncCompleted = true;
        this.onMetaRoomReady();
      }

      await waitWithRemainingTimeout(metaSource.waitUntilSynced(), 'pending');
      if (this.metaSub !== metaSub || this.isCleanedUp) {
        return false;
      }
      this.logger.debug(
        `[${this.workspaceId}] Loro meta pending writes synced in ${Date.now() - startedAt}ms (reason=${reason})`
      );
      return true;
    } catch (error) {
      this.logger.debug(
        `[${this.workspaceId}] Loro meta pending writes were not confirmed before continuing (reason=${reason}): ${formatErrorMessage(
          error
        )}`
      );
      return false;
    }
  }

  async cleanUp(): Promise<void> {
    this.isCleanedUp = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }
    this.cancelBackoffReset();
    if (this.metaSyncedThrottleTimer) {
      clearTimeout(this.metaSyncedThrottleTimer);
      this.metaSyncedThrottleTimer = null;
    }
    this.pendingMetaSyncedEmit = null;
    this.metaRoomSyncedListeners.clear();
    this.streamsOnlineListeners.clear();
    this.resolvePendingReconnectCompletions();

    await Promise.allSettled([this.activeOperation ?? Promise.resolve()]);

    this.detachMetaRoomStatusLogger?.();
    this.detachMetaRoomStatusLogger = null;
    this.metaSub?.unsubscribe();
    this.metaSub = null;
    this.metaSource = null;

    await Effect.runPromise(Queue.shutdown(this.recoveryEvents)).catch(() => {});
    await Effect.runPromise(Fiber.interrupt(this.eventFiber)).catch(() => {});
  }

  private createEventLoop(): Effect.Effect<never, never> {
    return Effect.forever(
      Effect.flatMap(Queue.take(this.recoveryEvents), (event) =>
        Effect.tryPromise(() =>
          this.trackActiveOperation(() => this.handleRecoveryEvent(event))
        ).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              this.logger.debug(
                `[${this.workspaceId}] Loro recovery controller event failed: ${formatErrorMessage(
                  error
                )}`
              );
            })
          )
        )
      )
    );
  }

  private async trackActiveOperation(operation: () => Promise<void>): Promise<void> {
    const promise = operation();
    this.activeOperation = promise;
    try {
      await promise;
    } finally {
      if (this.activeOperation === promise) {
        this.activeOperation = null;
      }
    }
  }

  private async handleRecoveryEvent(event: RecoveryEvent): Promise<void> {
    switch (event.type) {
      case 'reconnect':
        if (this.isCleanedUp) {
          this.resolveReconnectCompletion(event.completion);
          return;
        }
        this.markReconnectCompletionActive(event.completion);
        try {
          await this.runReconnect(event.reason, event.options);
          this.updateBackoffAfterReconnect(event.reason, event.options);
          this.resolveReconnectCompletion(event.completion);
        } catch (error) {
          this.rejectReconnectCompletion(event.completion, error);
          throw error;
        }
        return;
      case 'meta-room-ready':
        if (this.isCleanedUp) {
          return;
        }
        await this.waitForMetaRoomReady(event.metaSub, event.generation, event.reason);
        return;
    }
  }

  private markReconnectCompletionActive(completion: ReconnectCompletion | undefined): void {
    if (!completion) {
      return;
    }
    this.pendingReconnectCompletions.delete(completion);
  }

  private resolveReconnectCompletion(completion: ReconnectCompletion | undefined): void {
    if (!completion) {
      return;
    }
    this.pendingReconnectCompletions.delete(completion);
    completion.resolve();
  }

  private rejectReconnectCompletion(
    completion: ReconnectCompletion | undefined,
    error: unknown
  ): void {
    if (!completion) {
      return;
    }
    this.pendingReconnectCompletions.delete(completion);
    completion.reject(error);
  }

  private resolvePendingReconnectCompletions(): void {
    for (const completion of this.pendingReconnectCompletions) {
      completion.resolve();
    }
    this.pendingReconnectCompletions.clear();
  }

  private offer(event: RecoveryEvent): boolean {
    if (this.isCleanedUp) {
      return false;
    }
    return Queue.unsafeOffer(this.recoveryEvents, event);
  }

  private attachMetaRoomStatusLogger(
    metaSub: RepoRoomSubscription | null,
    options: { readonly emitReadyIfJoined?: boolean } = {}
  ): void {
    this.detachMetaRoomStatusLogger?.();
    this.detachMetaRoomStatusLogger = null;
    this.metaRoomStatus = null;
    this.metaSub = metaSub;
    this.metaSource = metaSub ? streamsRoomBinding(metaSub) : null;
    this.streamsRecoveryGeneration += 1;
    // A replacement meta room starts from nothing known, so the next fan-out
    // must not be throttled away.
    this.metaRoomDegradedSinceEmit = true;

    if (!metaSub) {
      this.logger.debug(`[${this.workspaceId}] Loro meta room status: not_joined`);
      return;
    }

    const currentMetaSub = metaSub;
    // Status flows from the 'streams' binding, not the classic surface: the
    // binding reports 'detached' truthfully (classic maps it to 'disconnected',
    // which would spin recovery while deliberately offline) and stays valid
    // across removeTransport/addTransport cycles.
    const currentMetaSource = streamsRoomBinding(currentMetaSub);
    this.handleMetaRoomStatusChange(currentMetaSource.status, currentMetaSub, {
      emitReady: options.emitReadyIfJoined ?? true,
    });
    this.detachMetaRoomStatusLogger = currentMetaSource.onStatusChange((status) => {
      if (this.metaSub !== currentMetaSub || this.isCleanedUp) {
        return;
      }
      this.handleMetaRoomStatusChange(status, currentMetaSub);
    });
  }

  private handleMetaRoomStatusChange(
    // Runtime statuses come from a RepoRoomSubscription and include 'detached'
    // even though the classic listener type does not name it.
    status: RepoTransportRoomStatus,
    metaSub: RepoRoomSubscription,
    options: { emitReady?: boolean } = {}
  ): void {
    const previous = this.metaRoomStatus;
    const didChange = previous !== status;
    const wasHealthy = this.isStreamsHealthy();
    this.metaRoomStatus = status;
    const isHealthy = this.isStreamsHealthy();
    if (previous === 'joined' && status !== 'joined') {
      // Invalidate a queued ready event as soon as this recovery episode
      // leaves joined. A later fully healthy state will queue the new generation.
      this.streamsRecoveryGeneration += 1;
      // The meta room really went down, so remote metadata may have been missed
      // while it was away: the next fan-out skips the throttle.
      this.metaRoomDegradedSinceEmit = true;
    }
    if (wasHealthy && !isHealthy) {
      this.handleHealthFell(`meta-room-${status}`);
    } else if (!wasHealthy && isHealthy) {
      this.handleHealthRose();
    }

    if (didChange) {
      const suffix = previous ? ` (was ${previous})` : '';
      this.logger.debug(`[${this.workspaceId}] Loro meta room status: ${status}${suffix}`);
    }

    if (!didChange) {
      return;
    }

    if (isRecoverableMetaRoomStatus(status)) {
      this.scheduleReconnect(`meta-room-${status}`);
      return;
    }

    if (status === 'joined' && (options.emitReady ?? true)) {
      this.offerStreamsReady(metaSub, 'meta-room-joined');
    }

    if (this.isStreamsHealthy()) {
      this.resetReconnectBackoff('meta-room-joined');
    }
  }

  private startAutoReconnectWatchdog(): void {
    const intervalMs = readTimeoutEnv('LODY_LORO_AUTO_RECONNECT_INTERVAL_MS', 30_000);
    if (intervalMs <= 0 || this.reconnectInterval) {
      return;
    }

    this.reconnectInterval = setInterval(() => {
      this.offer({
        type: 'reconnect',
        reason: 'watchdog',
        options: { logWhenHealthy: false },
      });
    }, intervalMs);
    this.reconnectInterval.unref?.();
    this.logger.debug(
      `[${this.workspaceId}] Loro streams auto-reconnect watchdog enabled (interval=${intervalMs}ms)`
    );
  }

  private scheduleReconnect(reason: string): void {
    if (this.isCleanedUp || this.isStreamsHealthy() || this.reconnectTimer) {
      return;
    }
    // From here on, any health we regain was reached BY a recovery, so losing
    // it again is a flap rather than a fresh outage.
    this.isRecoveryEpisode = true;

    const baseDelayMs = readTimeoutEnv(
      'LODY_LORO_AUTO_RECONNECT_DELAY_MS',
      DEFAULT_RECONNECT_BASE_DELAY_MS
    );
    const maxDelayMs = readTimeoutEnv(
      'LODY_LORO_AUTO_RECONNECT_MAX_DELAY_MS',
      DEFAULT_RECONNECT_MAX_DELAY_MS
    );
    const delayMs = computeLoroReconnectDelayMs(this.reconnectAttempt, {
      baseDelayMs,
      maxDelayMs,
    });
    this.logger.debug(
      `[${this.workspaceId}] Scheduling Loro streams reconnect in ${delayMs}ms (attempt=${this.reconnectAttempt + 1}, reason=${reason}, health=${this.getStreamsHealth()}, transport=${this.transportStatus}, metaRoom=${this.metaRoomStatus ?? 'unknown'})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.offer({
        type: 'reconnect',
        reason,
        options: { logWhenHealthy: true },
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  /**
   * True when nothing needs recovering. `connecting` is deliberately included:
   * it only means some room is mid-join (see {@link LoroStreamsHealth}), and a
   * lazily-joining room must not be reported as a broken transport. A room that
   * really failed makes the aggregate `disconnected`, and a broken meta room
   * shows up in `metaRoomStatus` — both of those still count as unhealthy.
   *
   * A 'detached' meta room is healthy-idle: no transport is attached at all
   * (deliberately offline / pre-attach), so there is nothing to recover and
   * the CLI must not report a local-only workspace as degraded. This preserves
   * the pre-refactor "local-only = healthy" placeholder semantics.
   */
  private isStreamsHealthy(): boolean {
    return (
      this.transportStatus !== 'disconnected' &&
      (this.metaRoomStatus === 'joined' || this.metaRoomStatus === 'detached')
    );
  }

  private offerStreamsReady(metaSub: RepoRoomSubscription | null, reason: string): void {
    if (!metaSub || !this.isStreamsHealthy()) {
      return;
    }
    // Cheap consumers are told immediately; only the O(rooms) rescan waits for
    // the meta catch-up ceremony below.
    this.emitStreamsOnline(reason);
    this.offer({
      type: 'meta-room-ready',
      metaSub,
      generation: this.streamsRecoveryGeneration,
      reason,
    });
  }

  private emitStreamsOnline(reason: string): void {
    for (const listener of this.streamsOnlineListeners) {
      void Promise.resolve(listener(reason)).catch((error: unknown) => {
        this.logger.debug(
          `[${this.workspaceId}] Streams online listener failed: ${formatErrorMessage(error)}`
        );
      });
    }
  }

  private readHealthStabilityWindowMs(): number {
    return readTimeoutEnv(
      'LODY_LORO_HEALTH_STABILITY_WINDOW_MS',
      DEFAULT_HEALTH_STABILITY_WINDOW_MS
    );
  }

  /**
   * Clear the backoff only once health has HELD for the stability window.
   *
   * Called on every healthy landing, so it must not reset eagerly: under a
   * flapping aggregate the healthy stretches are ~1s long, and resetting on
   * each of them is what pinned the recovery loop at its 1s base delay.
   */
  private resetReconnectBackoff(reason: string): void {
    if (this.reconnectAttempt === 0 || this.backoffResetTimer || this.isCleanedUp) {
      return;
    }
    const windowMs = this.readHealthStabilityWindowMs();
    if (windowMs <= 0) {
      this.applyReconnectBackoffReset(reason);
      return;
    }
    // Healthy without a recorded rising edge (e.g. a status path that did not
    // cross one): start the clock now rather than trusting health immediately.
    const healthySinceMs = this.healthySinceMs ?? Date.now();
    this.healthySinceMs = healthySinceMs;
    const remainingMs = windowMs - (Date.now() - healthySinceMs);
    if (remainingMs <= 0) {
      this.applyReconnectBackoffReset(reason);
      return;
    }
    this.backoffResetTimer = setTimeout(() => {
      this.backoffResetTimer = null;
      if (this.isCleanedUp || !this.isStreamsHealthy() || this.healthySinceMs === null) {
        return;
      }
      this.applyReconnectBackoffReset(reason);
    }, remainingMs);
    this.backoffResetTimer.unref?.();
  }

  private applyReconnectBackoffReset(reason: string): void {
    if (this.reconnectAttempt === 0) {
      return;
    }
    this.logger.debug(
      `[${this.workspaceId}] Resetting Loro streams reconnect backoff (reason=${reason}, attempts=${this.reconnectAttempt})`
    );
    this.reconnectAttempt = 0;
  }

  private cancelBackoffReset(): void {
    if (this.backoffResetTimer) {
      clearTimeout(this.backoffResetTimer);
      this.backoffResetTimer = null;
    }
  }

  private updateBackoffAfterReconnect(reason: string, options: ReconnectOptions): void {
    if (this.isCleanedUp) {
      return;
    }

    if (this.isStreamsHealthy()) {
      this.resetReconnectBackoff(`reconnect:${reason}`);
      return;
    }

    if (options.force) {
      // `force` already passes `resetBackoff: true` down to repo.reconnect();
      // it must NOT additionally erase this controller's flap history, or a
      // caller-triggered reconnect would hand the loop its base delay back.
      return;
    }

    this.reconnectAttempt += 1;
    this.scheduleReconnect(reason);
  }

  private async runReconnect(reason: string, options: ReconnectOptions): Promise<void> {
    if (this.isCleanedUp) {
      return;
    }

    if (!options.force && this.isStreamsHealthy()) {
      // Healthy transport + meta says nothing about per-doc/flock rooms: a
      // room whose stream session hit a non-retriable failure (e.g. a token
      // refresh hiccup answered with a 4xx) sits in 'error' forever —
      // streams-crdt exits that room's loops permanently and nothing else
      // supervises it, so CLI-authored ops for the room never reach the cloud
      // until a daemon restart. Sweep instead of returning early.
      await this.sweepRooms(reason);
      return;
    }

    const shouldLog =
      options.logWhenHealthy ||
      this.transportStatus !== 'connected' ||
      this.metaRoomStatus !== 'joined';
    const startedAt = Date.now();
    const timeoutMs = readTimeoutEnv('LODY_LORO_RECONNECT_TIMEOUT_MS', 10_000);

    try {
      if (shouldLog) {
        this.logger.debug(
          `[${this.workspaceId}] Triggering Loro streams reconnect (reason=${reason}, health=${this.getStreamsHealth()}, transport=${this.transportStatus}, metaRoom=${this.metaRoomStatus ?? 'unknown'})`
        );
      }

      await this.ensureMetaRoomJoined(reason);
      await withTimeout(
        this.repo.reconnect({ resetBackoff: options.force === true, timeout: timeoutMs }),
        timeoutMs,
        `Timeout waiting for Loro streams reconnect (workspace=${this.workspaceId})`
      );
      await this.rejoinFailedStreamsBindings(reason);

      if (shouldLog) {
        this.logger.debug(
          `[${this.workspaceId}] Loro streams reconnect completed in ${Date.now() - startedAt}ms (reason=${reason})`
        );
      }
    } catch (error) {
      this.logger.debug(
        `[${this.workspaceId}] Loro streams reconnect failed (reason=${reason}): ${formatErrorMessage(
          error
        )}`
      );
    }
  }

  /**
   * Healthy-path room sweep. `repo.reconnect()` rejoins exactly the rooms in a
   * recoverable bad state (`error`/`disconnected`/incomplete join) and is a
   * pure per-room status read — no network — when everything is healthy, so
   * the 30s watchdog can afford to run it unconditionally. Deliberately skips
   * the meta-ready ceremony (`ensureMetaRoomJoined`/`waitForMetaRoomReady`) so
   * a healthy sweep never re-fires meta-synced listeners.
   */
  private async sweepRooms(reason: string): Promise<void> {
    const timeoutMs = readTimeoutEnv('LODY_LORO_RECONNECT_TIMEOUT_MS', 10_000);
    try {
      await withTimeout(
        this.repo.reconnect({ resetBackoff: false, timeout: timeoutMs }),
        timeoutMs,
        `Timeout waiting for Loro streams room sweep (workspace=${this.workspaceId})`
      );
      await this.rejoinFailedStreamsBindings(reason);
    } catch (error) {
      this.logger.debug(
        `[${this.workspaceId}] Loro streams room sweep failed (reason=${reason}): ${formatErrorMessage(
          error
        )}`
      );
    }
  }

  /**
   * Repair owner for loro-repo-level failed attaches. `repo.addTransport`
   * resolves even when some rooms fail to attach (their 'streams' bindings sit
   * in 'error'), and `repo.reconnect()` only drives transport-level recovery —
   * a binding whose attach failed at the repo level is only retried by its own
   * `rejoin()`. Sweep those here so a failed attach has a supervised retry
   * path. 'detached' bindings are skipped: they mean the transport is absent
   * (deliberately offline), and rejoin cannot change that.
   */
  private async rejoinFailedStreamsBindings(reason: string): Promise<void> {
    let entries: RepoTransportRoomEntry[];
    try {
      entries = this.repo.transportRooms(STREAMS_TRANSPORT_ID);
    } catch (error) {
      this.logger.debug(
        `[${this.workspaceId}] Failed to enumerate Streams transport rooms (reason=${reason}): ${formatErrorMessage(
          error
        )}`
      );
      return;
    }

    const failed = entries.filter((entry) => entry.subscription.status === 'error');
    if (failed.length === 0) {
      return;
    }

    this.logger.debug(
      `[${this.workspaceId}] Rejoining ${failed.length} errored Streams room binding(s) (reason=${reason})`
    );
    // Bounded on all three axes — per rejoin, per batch width, and in total.
    // A rejoin awaits doc/monitor setup inside loro-repo, so one that never
    // settles would otherwise stall every later reconnect event on this fiber
    // (and hang cleanUp); the errored set is O(rooms), so without a total cap
    // a large one would serialize into minutes of batches. Rooms left over
    // are simply picked up by the next watchdog pass.
    const timeoutMs = readTimeoutEnv('LODY_LORO_RECONNECT_TIMEOUT_MS', 10_000);
    const rejoinOne = (entry: RepoTransportRoomEntry): Promise<void> =>
      withTimeout(
        entry.subscription.rejoin(),
        timeoutMs,
        `Timeout rejoining Streams room binding (room=${entry.room.kind}:${entry.room.id})`
      ).catch((error: unknown) => {
        this.logger.debug(
          `[${this.workspaceId}] Streams room binding rejoin failed (room=${entry.room.kind}:${entry.room.id} reason=${reason}): ${formatErrorMessage(
            error
          )}`
        );
      });

    const sweepDeadline = Date.now() + timeoutMs * REJOIN_SWEEP_MAX_BATCHES;
    for (let index = 0; index < failed.length; index += REJOIN_SWEEP_CONCURRENCY) {
      if (Date.now() >= sweepDeadline) {
        this.logger.debug(
          `[${this.workspaceId}] Streams rejoin sweep hit its time budget with ${failed.length - index} room(s) left (reason=${reason}); the next pass resumes`
        );
        break;
      }
      await Promise.all(failed.slice(index, index + REJOIN_SWEEP_CONCURRENCY).map(rejoinOne));
    }
  }

  private async ensureMetaRoomJoined(reason: string): Promise<void> {
    if (this.metaSub) {
      return;
    }

    const joinMetaTimeoutMs = readTimeoutEnv('LODY_LORO_JOIN_META_TIMEOUT_MS', 30_000);
    const startedAt = Date.now();
    this.logger.debug(`[${this.workspaceId}] Joining Loro meta room (reason=${reason})`);
    const metaSub = await withTimeout(
      this.repo.joinMetaRoom(),
      joinMetaTimeoutMs,
      `Timeout waiting for repo.joinMetaRoom during reconnect (workspace=${this.workspaceId})`
    );
    this.attachMetaRoomStatusLogger(metaSub);
    this.logger.debug(
      `[${this.workspaceId}] Meta room join returned in ${Date.now() - startedAt}ms (reason=${reason})`
    );
  }

  private async waitForMetaRoomReady(
    metaSub: RepoRoomSubscription,
    generation: number,
    reason: string
  ): Promise<void> {
    if (
      this.isCleanedUp ||
      this.metaSub !== metaSub ||
      !this.isStreamsHealthy() ||
      this.streamsRecoveryGeneration !== generation ||
      this.emittedStreamsRecoveryGeneration >= generation
    ) {
      return;
    }

    const syncMetaTimeoutMs = readTimeoutEnv('LODY_LORO_SYNC_META_TIMEOUT_MS', 20_000);
    const startedAt = Date.now();
    const metaSource = streamsRoomBinding(metaSub);

    try {
      const syncPromise = this.initialMetaSyncCompleted
        ? metaSource.waitUntilSynced()
        : metaSource.firstSyncedWithRemote;
      await withTimeout(
        syncPromise,
        syncMetaTimeoutMs,
        `Timeout waiting for Loro meta room sync (workspace=${this.workspaceId})`
      );
      if (
        this.metaSub !== metaSub ||
        this.isCleanedUp ||
        !this.isStreamsHealthy() ||
        this.streamsRecoveryGeneration !== generation ||
        this.emittedStreamsRecoveryGeneration >= generation
      ) {
        return;
      }
      this.initialMetaSyncCompleted = true;
      this.onMetaRoomReady();
      if (this.isStreamsHealthy()) {
        this.resetReconnectBackoff(`meta-room-ready:${reason}`);
      }
      this.logger.debug(
        `[${this.workspaceId}] Loro meta room ready in ${Date.now() - startedAt}ms (reason=${reason})`
      );
      this.emitMetaRoomSynced(reason, generation);
    } catch (error) {
      if (this.metaSub !== metaSub || this.isCleanedUp) {
        return;
      }
      this.logger.debug(
        `[${this.workspaceId}] Loro meta room sync failed (reason=${reason}): ${formatErrorMessage(
          error
        )}`
      );
    }
  }

  private emitMetaRoomSynced(reason: string, generation: number): void {
    if (this.emittedStreamsRecoveryGeneration >= generation) {
      return;
    }
    this.emittedStreamsRecoveryGeneration = generation;

    const minIntervalMs = readTimeoutEnv(
      'LODY_LORO_META_SYNCED_MIN_INTERVAL_MS',
      DEFAULT_META_SYNCED_MIN_INTERVAL_MS
    );
    const nowMs = Date.now();
    const elapsedMs = nowMs - this.lastMetaSyncedEmitMs;
    // A real meta-room outage rescans right away; a transport-only flap waits
    // out the floor. Either way the emit happens — never dropped.
    if (this.metaRoomDegradedSinceEmit || minIntervalMs <= 0 || elapsedMs >= minIntervalMs) {
      this.deliverMetaRoomSynced(reason, nowMs);
      return;
    }

    this.pendingMetaSyncedEmit = { reason };
    if (this.metaSyncedThrottleTimer) {
      return;
    }
    const delayMs = Math.max(1, minIntervalMs - elapsedMs);
    this.logger.debug(
      `[${this.workspaceId}] Deferring meta-room-synced fan-out by ${delayMs}ms (reason=${reason}); the meta room never left 'joined'`
    );
    this.metaSyncedThrottleTimer = setTimeout(() => {
      this.metaSyncedThrottleTimer = null;
      const pending = this.pendingMetaSyncedEmit;
      this.pendingMetaSyncedEmit = null;
      if (!pending || this.isCleanedUp) {
        return;
      }
      this.deliverMetaRoomSynced(pending.reason, Date.now());
    }, delayMs);
    this.metaSyncedThrottleTimer.unref?.();
  }

  private deliverMetaRoomSynced(reason: string, atMs: number): void {
    this.lastMetaSyncedEmitMs = atMs;
    this.metaRoomDegradedSinceEmit = false;
    for (const listener of this.metaRoomSyncedListeners) {
      void Promise.resolve(listener(reason)).catch((error: unknown) => {
        this.logger.debug(
          `[${this.workspaceId}] Meta room synced listener failed: ${formatErrorMessage(error)}`
        );
      });
    }
  }
}

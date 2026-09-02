import { getSessionRoomId, type SessionId, type SessionStatus } from '@lody/shared';

/**
 * Background progressive eager-sync of session docs.
 *
 * When a session receives new activity (a new message arrives in its metadata),
 * the user is likely to open it soon. This coordinator proactively catches the
 * session's Loro doc up to remote ahead of navigation, so opening a session is a
 * near-instant local read instead of a bootstrap/catch-up round-trip.
 *
 * Design notes:
 * - The coordinator is PURE and dependency-injected. It imports no loro-repo, no
 *   React, and never touches real timers — every external effect is an injected
 *   port. This makes it fully unit-testable with in-memory fakes and a fake
 *   clock/scheduler, and sidesteps the loro-repo fake-timer hang.
 * - Sync is always ONE-SHOT catch-up: the prefetcher opens the store, holds a
 *   sync lease until caught up, then releases. We never hold a long-lived live
 *   join for a session the user is not viewing.
 * - Candidate scope depends on the surface: native/electron can eventually
 *   warm all candidates, while web stays bounded to the highest-priority set.
 *   All surfaces use bounded concurrency plus batch cooldowns.
 * - A surface may widen that scope PROGRESSIVELY instead of all at once
 *   (`policy.stages`): the coordinator starts on the smallest, highest-priority
 *   set and only steps outward once the queue has drained and stayed idle. On a
 *   phone this is the difference between "the app is usable while it syncs" and
 *   "the app is busy deserializing every doc it has ever seen".
 * - Prefetching yields to the user (`deps.interaction`). Opening a doc
 *   deserializes it on the main thread, so while the user is scrolling or
 *   typing the coordinator starts nothing new. It does not abort in-flight
 *   work for interaction: that would cost a fresh room join later without
 *   making the main thread any quieter now.
 */

/** Minimal view of a session's metadata the coordinator reasons about. */
export interface SessionActivitySnapshot {
  sessionId: SessionId;
  lastMessageAt?: number;
  lastReadAt?: number;
  status?: SessionStatus;
  isArchived?: boolean;
  isPinned?: boolean;
  parentSessionId?: SessionId;
}

export type PrefetchOutcome = 'synced' | 'skipped' | 'failed';

/** The subset of the room-sync registry the coordinator depends on. */
export interface CoordinatorRegistryView {
  isJoined(roomId: string): boolean;
  getRecentlySynced(now: number, ttlMs: number): ReadonlySet<string>;
  subscribe(onChange: () => void): () => void;
}

export interface EagerSyncHighWaterStore {
  get(sessionId: SessionId): number | undefined;
  set(sessionId: SessionId, lastMessageAt: number): void;
}

export interface BackgroundSyncCoordinatorDeps {
  activitySource: {
    /** Current snapshot of all known sessions (used to seed candidates). */
    list(): SessionActivitySnapshot[];
    /** Subscribe to per-session activity changes. Returns an unsubscribe fn. */
    subscribe(onChange: (snapshot: SessionActivitySnapshot) => void): () => void;
  };
  registry: CoordinatorRegistryView;
  prefetcher: {
    /**
     * One-shot catch-up: open the store, hold a sync lease until caught up (or
     * the signal aborts / a timeout fires), then release. Resolves with the
     * outcome; never rejects.
     */
    prefetch(sessionId: SessionId, signal: AbortSignal): Promise<PrefetchOutcome>;
    /**
     * Hard-evict a coordinator-warmed doc to bound memory. The coordinator only
     * calls this for non-joined rooms it warmed itself.
     */
    evict(sessionId: SessionId): void;
  };
  env: {
    isOnline(): boolean;
    isAppVisible(): boolean;
    /** Fires on online/offline + visibilitychange. Returns an unsubscribe fn. */
    subscribe(onChange: () => void): () => void;
  };
  visibility?: {
    isVisible(sessionId: SessionId): boolean;
    /** Fires when the UI-visible session set changes. Returns an unsubscribe fn. */
    subscribe(onChange: () => void): () => void;
  };
  /**
   * Optional "the user is busy right now" signal (scrolling, typing, dragging).
   * While it reports true the coordinator starts no new prefetches.
   */
  interaction?: {
    isInteracting(): boolean;
    /** Fires when the interacting/idle state flips. Returns an unsubscribe fn. */
    subscribe(onChange: () => void): () => void;
  };
  clock: { now(): number };
  scheduler: {
    setTimeout(handler: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  policy: EagerSyncPolicy;
  highWaterStore?: EagerSyncHighWaterStore;
  logger?: { debug(...args: unknown[]): void };
}

export interface EagerSyncPolicy {
  /** Max concurrent prefetches. */
  concurrency: number;
  /** Max prefetches to start before yielding to a cooldown. */
  batchSize: number;
  /** Delay before starting the next prefetch batch. */
  batchCooldownMs: number;
  /** Burst-coalesce window: skip re-syncing a room synced within this window. */
  freshnessTtlMs: number;
  /** Max coordinator-warmed docs kept before LRU eviction. */
  maxWarmDocs: number;
  /** Only eager-sync the top-N candidates; Infinity means all candidates. */
  candidateWindow: number;
  /** Abort a prefetch that has not settled within this window. */
  prefetchTimeoutMs: number;
  /**
   * Optional progressive ladder over the candidate scope. While present, the
   * ACTIVE stage supplies the candidate window and priority floor in place of
   * `candidateWindow`; absent means a single static stage of `candidateWindow`
   * with no floor, which is the historical behavior.
   */
  stages?: readonly EagerSyncStage[];
}

/** One rung of a progressive candidate-scope ladder. */
export interface EagerSyncStage {
  /**
   * Minimum `priorityOf()` a candidate must reach in this stage. `0` admits
   * every non-archived session; `EAGER_SYNC_PRIORITY_RUNNING` narrows to the
   * pinned / UI-visible / running set.
   */
  minPriority: number;
  /** Candidate cap for this stage; `Infinity` means all candidates. */
  candidateWindow: number;
  /**
   * How long the queue must stay drained AND idle before stepping to the next
   * stage. Unused on the last stage.
   */
  holdMs: number;
}

export type EagerSyncSurface = 'web' | 'desktop' | 'mobile';

/**
 * Candidate priority weights. Exported so a stage's `minPriority` names the set
 * it admits instead of hard-coding a magic number.
 */
export const EAGER_SYNC_PRIORITY_PINNED = 100;
export const EAGER_SYNC_PRIORITY_VISIBLE = 10;
export const EAGER_SYNC_PRIORITY_RUNNING = 2;
export const EAGER_SYNC_PRIORITY_UNREAD = 1;

export const WEB_EAGER_SYNC_CANDIDATE_WINDOW = 20;
export const FULL_EAGER_SYNC_CANDIDATE_WINDOW = Number.POSITIVE_INFINITY;
export const MOBILE_EAGER_SYNC_CANDIDATE_WINDOW = 12;

export const WEB_EAGER_SYNC_POLICY: EagerSyncPolicy = {
  concurrency: 2,
  batchSize: 4,
  batchCooldownMs: 1_500,
  freshnessTtlMs: 15_000,
  maxWarmDocs: 20,
  candidateWindow: WEB_EAGER_SYNC_CANDIDATE_WINDOW,
  prefetchTimeoutMs: 20_000,
};

export const FULL_EAGER_SYNC_POLICY: EagerSyncPolicy = {
  concurrency: 3,
  batchSize: 8,
  batchCooldownMs: 750,
  freshnessTtlMs: 15_000,
  maxWarmDocs: 96,
  candidateWindow: FULL_EAGER_SYNC_CANDIDATE_WINDOW,
  prefetchTimeoutMs: 20_000,
};

/**
 * Mobile ladder. A phone reaches the same eventual coverage as desktop, but it
 * gets there one rung at a time so the first seconds after launch belong to the
 * user: only what is on screen, pinned, or actively running is warmed up front.
 */
export const MOBILE_EAGER_SYNC_STAGES: readonly EagerSyncStage[] = [
  // On screen / pinned / running only — the sessions a user opens next.
  { minPriority: EAGER_SYNC_PRIORITY_RUNNING, candidateWindow: 6, holdMs: 5_000 },
  // The recent list the user actually scrolls.
  { minPriority: 0, candidateWindow: MOBILE_EAGER_SYNC_CANDIDATE_WINDOW, holdMs: 15_000 },
  { minPriority: 0, candidateWindow: 30, holdMs: 30_000 },
  // Eventually everything, at one prefetch at a time. `holdMs` is unused here.
  { minPriority: 0, candidateWindow: FULL_EAGER_SYNC_CANDIDATE_WINDOW, holdMs: 0 },
];

/**
 * Mobile is NOT desktop with a smaller screen: every prefetch deserializes a
 * Loro doc on the one main thread a phone has, so the desktop policy's wide,
 * fast, deeply-resident warm-up is felt as the app being frozen until sync
 * finishes. Hence concurrency 1 (never two deserializations racing a frame),
 * long batch cooldowns (breathing room for rendering), a small resident cap
 * (catch-up is durable in IndexedDB; the in-memory doc is not worth holding),
 * and a staged candidate scope.
 */
export const MOBILE_EAGER_SYNC_POLICY: EagerSyncPolicy = {
  concurrency: 1,
  batchSize: 3,
  batchCooldownMs: 3_000,
  freshnessTtlMs: 15_000,
  maxWarmDocs: 12,
  // Superseded by `stages` while they are set; kept as the stage-less fallback.
  candidateWindow: MOBILE_EAGER_SYNC_CANDIDATE_WINDOW,
  prefetchTimeoutMs: 20_000,
  stages: MOBILE_EAGER_SYNC_STAGES,
};

export const DEFAULT_EAGER_SYNC_POLICY = WEB_EAGER_SYNC_POLICY;

export const resolveEagerSyncPolicy = (surface: EagerSyncSurface): EagerSyncPolicy => {
  switch (surface) {
    case 'web':
      return WEB_EAGER_SYNC_POLICY;
    case 'mobile':
      return MOBILE_EAGER_SYNC_POLICY;
    default:
      return FULL_EAGER_SYNC_POLICY;
  }
};

export interface BackgroundSyncCoordinator {
  start(): void;
  stop(): void;
  getState(): {
    queued: SessionId[];
    inFlight: SessionId[];
    warmed: SessionId[];
    /** Index into `policy.stages`; always 0 when the policy has no ladder. */
    stage: number;
  };
  /** Manual nudge (e.g. sidebar hover): prefetch now, bypassing the burst window. */
  requestPrefetch(sessionId: SessionId): void;
}

const isRunningStatus = (status: SessionStatus | undefined): boolean =>
  status?.type === 'running' || status?.type === 'requestPermission';

export function createBackgroundSyncCoordinator(
  deps: BackgroundSyncCoordinatorDeps
): BackgroundSyncCoordinator {
  const {
    activitySource,
    registry,
    prefetcher,
    env,
    visibility,
    interaction,
    clock,
    scheduler,
    policy,
    highWaterStore,
    logger,
  } = deps;

  let started = false;
  let paused = false;
  let drainScheduled = false;
  let startedInCurrentBatch = 0;
  let batchCooldownHandle: unknown | null = null;
  // Progressive candidate scope: index into `policy.stages` (0 when there are none).
  let stageIndex = 0;
  let stageAdvanceHandle: unknown | null = null;

  // Most recent snapshot per session — the trailing re-evaluation re-runs against
  // this so we don't miss the tail of a burst.
  const latest = new Map<SessionId, SessionActivitySnapshot>();
  // lastMessageAt value we have already caught up through (Linear's lastSyncId analog).
  const syncedThrough = new Map<SessionId, number>();
  // Sessions waiting to be prefetched, with the snapshot that qualified them.
  const queued = new Map<SessionId, SessionActivitySnapshot>();
  const inFlight = new Set<SessionId>();
  const controllers = new Map<SessionId, AbortController>();
  // Coordinator-warmed docs, oldest first (LRU).
  const warmed: SessionId[] = [];
  // Trailing re-eval timers (burst coalescing tail).
  const trailingTimers = new Map<SessionId, unknown>();

  const unsubscribers: Array<() => void> = [];

  const roomOf = (sessionId: SessionId): string => getSessionRoomId(sessionId);

  const getSyncedThrough = (sessionId: SessionId): number | undefined => {
    const memoryValue = syncedThrough.get(sessionId);
    let storedValue: number | undefined;
    try {
      storedValue = highWaterStore?.get(sessionId);
    } catch {
      storedValue = undefined;
    }
    if (memoryValue === undefined) {
      return storedValue;
    }
    if (storedValue === undefined) {
      return memoryValue;
    }
    return Math.max(memoryValue, storedValue);
  };

  const recordSyncedThrough = (sessionId: SessionId, lastMessageAt: number | undefined) => {
    if (lastMessageAt == null) {
      return;
    }
    const previous = getSyncedThrough(sessionId) ?? 0;
    const next = Math.max(previous, lastMessageAt);
    syncedThrough.set(sessionId, next);
    try {
      highWaterStore?.set(sessionId, next);
    } catch {
      // Local high-water cache is an optimization; never let it break sync.
    }
  };

  const priorityOf = (snap: SessionActivitySnapshot): number => {
    const pinnedBoost = snap.isPinned ? EAGER_SYNC_PRIORITY_PINNED : 0;
    const visibleBoost = visibility?.isVisible(snap.sessionId) ? EAGER_SYNC_PRIORITY_VISIBLE : 0;
    const activityBoost = (() => {
      if (isRunningStatus(snap.status)) {
        return EAGER_SYNC_PRIORITY_RUNNING;
      }
      if (
        snap.lastMessageAt != null &&
        (snap.lastReadAt == null || snap.lastMessageAt > snap.lastReadAt)
      ) {
        return EAGER_SYNC_PRIORITY_UNREAD;
      }
      return 0;
    })();
    return pinnedBoost + visibleBoost + activityBoost;
  };

  const isInteracting = (): boolean => interaction?.isInteracting() === true;

  const stages =
    policy.stages && policy.stages.length > 0 ? (policy.stages as readonly EagerSyncStage[]) : null;

  const getActiveStage = (): EagerSyncStage | undefined =>
    stages ? stages[Math.min(stageIndex, stages.length - 1)] : undefined;

  const comparePrefetchPriority = (
    left: SessionActivitySnapshot,
    right: SessionActivitySnapshot
  ): number => {
    const priorityDelta = priorityOf(right) - priorityOf(left);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    const activityDelta = (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0);
    if (activityDelta !== 0) {
      return activityDelta;
    }
    return String(left.sessionId).localeCompare(String(right.sessionId));
  };

  const getBatchSize = (): number => Math.max(1, Math.floor(policy.batchSize));

  const getCandidateLimit = (): number | null => {
    const window = getActiveStage()?.candidateWindow ?? policy.candidateWindow;
    if (!Number.isFinite(window)) {
      return null;
    }
    return Math.max(0, Math.floor(window));
  };

  const getMinPriority = (): number => Math.max(0, getActiveStage()?.minPriority ?? 0);

  /**
   * Is the current scope narrower than "every known session"? A bounded scope
   * has to be recomputed as a whole (activity reorders it), so callers re-seed
   * instead of evaluating one session in isolation.
   */
  const isCandidateScopeBounded = (): boolean =>
    getCandidateLimit() != null || getMinPriority() > 0;

  const listCandidateSnapshots = (): SessionActivitySnapshot[] => {
    const snapshots = new Map<SessionId, SessionActivitySnapshot>();
    for (const snap of activitySource.list()) {
      snapshots.set(snap.sessionId, snap);
    }
    for (const snap of latest.values()) {
      snapshots.set(snap.sessionId, snap);
    }
    const minPriority = getMinPriority();
    const candidates = Array.from(snapshots.values())
      .filter(
        (snap) =>
          !snap.isArchived && snap.lastMessageAt != null && priorityOf(snap) >= minPriority
      )
      .sort(comparePrefetchPriority);
    const limit = getCandidateLimit();
    return limit == null ? candidates : candidates.slice(0, limit);
  };

  const clearStageAdvance = () => {
    if (stageAdvanceHandle !== null) {
      scheduler.clearTimeout(stageAdvanceHandle);
      stageAdvanceHandle = null;
    }
  };

  /** No queued work, nothing in flight, and not inside a batch cooldown. */
  const isDrainIdle = (): boolean =>
    queued.size === 0 && inFlight.size === 0 && batchCooldownHandle === null;

  const canAdvanceStage = (): boolean =>
    started && !paused && !isInteracting() && stages != null && stageIndex < stages.length - 1;

  /**
   * Widen the candidate scope one rung, but only after the current rung has
   * fully drained and the app has then stayed idle for the stage's hold. A
   * stage never advances on a wall-clock schedule alone: if work is still
   * queued, in flight, or the user is interacting, the ladder waits.
   */
  const armStageAdvance = () => {
    if (stageAdvanceHandle !== null || !canAdvanceStage() || !isDrainIdle()) {
      return;
    }
    const holdMs = Math.max(0, getActiveStage()?.holdMs ?? 0);
    stageAdvanceHandle = scheduler.setTimeout(() => {
      stageAdvanceHandle = null;
      if (!canAdvanceStage() || !isDrainIdle()) {
        // Busy again — the next drain-to-idle re-arms from the same stage.
        return;
      }
      stageIndex += 1;
      logger?.debug('[eager-sync] widened candidate scope to stage', stageIndex);
      seedFromList();
      scheduleDrain();
    }, holdMs);
  };

  const clearBatchCooldown = () => {
    if (batchCooldownHandle !== null) {
      scheduler.clearTimeout(batchCooldownHandle);
      batchCooldownHandle = null;
    }
  };

  const resetBatchWindow = () => {
    startedInCurrentBatch = 0;
    clearBatchCooldown();
  };

  const scheduleNextBatch = () => {
    if (batchCooldownHandle !== null) {
      return;
    }
    const cooldownMs = Math.max(0, policy.batchCooldownMs);
    if (cooldownMs === 0) {
      startedInCurrentBatch = 0;
      scheduleDrain();
      return;
    }
    batchCooldownHandle = scheduler.setTimeout(() => {
      batchCooldownHandle = null;
      startedInCurrentBatch = 0;
      scheduleDrain();
    }, cooldownMs);
  };

  const onVisibilityChange = () => {
    if (!started || paused) {
      return;
    }
    seedFromList();
    scheduleDrain();
  };

  const clearTrailing = (sessionId: SessionId) => {
    const handle = trailingTimers.get(sessionId);
    if (handle !== undefined) {
      scheduler.clearTimeout(handle);
      trailingTimers.delete(sessionId);
    }
  };

  const scheduleTrailing = (sessionId: SessionId, delayMs: number) => {
    if (trailingTimers.has(sessionId)) {
      return;
    }
    const handle = scheduler.setTimeout(
      () => {
        trailingTimers.delete(sessionId);
        evaluate(sessionId);
      },
      Math.max(0, delayMs)
    );
    trailingTimers.set(sessionId, handle);
  };

  /** Does this session have unsynced activity and pass the static gates? */
  const baseEligible = (snap: SessionActivitySnapshot): boolean => {
    if (snap.isArchived) {
      return false;
    }
    if (snap.lastMessageAt == null) {
      return false;
    }
    const synced = getSyncedThrough(snap.sessionId);
    if (synced != null && snap.lastMessageAt <= synced) {
      return false;
    }
    if (inFlight.has(snap.sessionId)) {
      return false;
    }
    if (registry.isJoined(roomOf(snap.sessionId))) {
      // A UI surface is already live on this room — nothing to eager-sync.
      return false;
    }
    return true;
  };

  const evaluate = (sessionId: SessionId) => {
    if (!started || paused) {
      return;
    }
    const snap = latest.get(sessionId);
    if (!snap) {
      return;
    }
    if (!baseEligible(snap)) {
      clearTrailing(sessionId);
      return;
    }
    const now = clock.now();
    const recentlySynced = registry.getRecentlySynced(now, policy.freshnessTtlMs);
    if (recentlySynced.has(roomOf(sessionId))) {
      // Synced very recently; coalesce. Re-check after the window so we don't
      // miss the tail of a streaming burst.
      scheduleTrailing(sessionId, policy.freshnessTtlMs);
      return;
    }
    clearTrailing(sessionId);
    queued.set(sessionId, snap);
    scheduleDrain();
  };

  const dequeueHighestPriority = (): SessionActivitySnapshot | undefined => {
    let best: SessionActivitySnapshot | undefined;
    for (const snap of queued.values()) {
      if (best === undefined || comparePrefetchPriority(snap, best) < 0) {
        best = snap;
      }
    }
    if (best) {
      queued.delete(best.sessionId);
    }
    return best;
  };

  const recordWarm = (sessionId: SessionId) => {
    const idx = warmed.indexOf(sessionId);
    if (idx >= 0) {
      warmed.splice(idx, 1);
    }
    warmed.push(sessionId);
    // Evict oldest non-joined warmed docs beyond the cap.
    while (warmed.length > policy.maxWarmDocs) {
      let evictedIndex = -1;
      for (let i = 0; i < warmed.length; i++) {
        const candidate = warmed[i];
        if (!registry.isJoined(roomOf(candidate))) {
          evictedIndex = i;
          break;
        }
      }
      if (evictedIndex < 0) {
        // All warmed docs are currently joined (user viewing) — never evict those.
        break;
      }
      const [evicted] = warmed.splice(evictedIndex, 1);
      prefetcher.evict(evicted);
    }
  };

  const runPrefetch = (snap: SessionActivitySnapshot) => {
    const sessionId = snap.sessionId;
    inFlight.add(sessionId);
    startedInCurrentBatch += 1;
    const controller = new AbortController();
    controllers.set(sessionId, controller);

    const timeoutHandle = scheduler.setTimeout(() => {
      controller.abort();
    }, policy.prefetchTimeoutMs);

    void prefetcher
      .prefetch(sessionId, controller.signal)
      .then((outcome) => {
        if (outcome === 'synced') {
          // Record the activity high-water mark we caught up through.
          recordSyncedThrough(sessionId, snap.lastMessageAt);
          recordWarm(sessionId);
        }
        logger?.debug('[eager-sync] prefetch', sessionId, outcome);
      })
      .catch((error: unknown) => {
        logger?.debug('[eager-sync] prefetch error', sessionId, error);
      })
      .finally(() => {
        scheduler.clearTimeout(timeoutHandle);
        inFlight.delete(sessionId);
        controllers.delete(sessionId);
        scheduleDrain();
        // Re-evaluate only if strictly newer activity arrived during the
        // prefetch. We intentionally do NOT retry a failed/aborted attempt with
        // no new activity — that would spin on a persistently failing room. Such
        // a room is retried on the next genuine activity, seed, or resume.
        const newer = latest.get(sessionId);
        if (newer && (newer.lastMessageAt ?? 0) > (snap.lastMessageAt ?? 0)) {
          evaluate(sessionId);
        }
      });
  };

  const drain = () => {
    if (!started || paused) {
      return;
    }
    if (isInteracting()) {
      // Every prefetch deserializes a Loro doc on the main thread, so starting
      // one under the user's finger is exactly the stall this coordinator
      // exists to avoid. In-flight work is deliberately left running: aborting
      // it only buys a fresh room join later, not a quieter frame now.
      return;
    }
    if (batchCooldownHandle !== null) {
      return;
    }
    const batchSize = getBatchSize();
    const concurrency = Math.max(1, Math.floor(policy.concurrency));
    let remainingBatchStarts = batchSize - startedInCurrentBatch;
    while (inFlight.size < concurrency && queued.size > 0 && remainingBatchStarts > 0) {
      const next = dequeueHighestPriority();
      if (!next) {
        break;
      }
      runPrefetch(next);
      remainingBatchStarts -= 1;
    }
    if (queued.size === 0) {
      resetBatchWindow();
      armStageAdvance();
      return;
    }
    if (startedInCurrentBatch >= batchSize) {
      scheduleNextBatch();
    }
  };

  // Coalesce drains onto a microtask so a synchronous batch of enqueues (e.g.
  // seeding) is prioritized together rather than each enqueue starting work in
  // arrival order.
  const scheduleDrain = () => {
    if (drainScheduled) {
      return;
    }
    drainScheduled = true;
    queueMicrotask(() => {
      drainScheduled = false;
      drain();
    });
  };

  const handleActivity = (snap: SessionActivitySnapshot) => {
    latest.set(snap.sessionId, snap);
    if (isCandidateScopeBounded()) {
      seedFromList();
      scheduleDrain();
      return;
    }
    evaluate(snap.sessionId);
  };

  const seedFromList = () => {
    const candidates = listCandidateSnapshots();
    const allowed = isCandidateScopeBounded()
      ? new Set(candidates.map((snap) => snap.sessionId))
      : null;
    if (allowed) {
      for (const sessionId of Array.from(queued.keys())) {
        if (!allowed.has(sessionId)) {
          queued.delete(sessionId);
          clearTrailing(sessionId);
        }
      }
      if (queued.size === 0) {
        resetBatchWindow();
      }
    }
    for (const snap of candidates) {
      latest.set(snap.sessionId, snap);
      evaluate(snap.sessionId);
    }
  };

  const abortAllInFlight = () => {
    for (const controller of controllers.values()) {
      controller.abort();
    }
  };

  const onEnvChange = () => {
    const active = env.isOnline() && env.isAppVisible();
    if (!active && !paused) {
      paused = true;
      resetBatchWindow();
      clearStageAdvance();
      abortAllInFlight();
      logger?.debug('[eager-sync] paused (offline/hidden)');
    } else if (active && paused) {
      paused = false;
      // Coming back from offline/background is a fresh cold start as far as the
      // user is concerned, so the ladder restarts too: what is on screen,
      // pinned, or running is warmed before anything else widens again.
      // Already-synced sessions are skipped by the high-water mark, so this
      // costs a re-sort, not re-work.
      stageIndex = 0;
      logger?.debug('[eager-sync] resumed');
      seedFromList();
      scheduleDrain();
    }
  };

  const onInteractionChange = () => {
    if (!started || paused) {
      return;
    }
    if (isInteracting()) {
      // Hold the ladder where it is; idle time under the user's finger is not
      // idle time.
      clearStageAdvance();
      return;
    }
    scheduleDrain();
  };

  const onRegistryChange = () => {
    // Capacity may have freed (a room left the joined set) — try to drain.
    scheduleDrain();
  };

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      paused = !(env.isOnline() && env.isAppVisible());
      unsubscribers.push(activitySource.subscribe(handleActivity));
      unsubscribers.push(env.subscribe(onEnvChange));
      if (visibility) {
        unsubscribers.push(visibility.subscribe(onVisibilityChange));
      }
      if (interaction) {
        unsubscribers.push(interaction.subscribe(onInteractionChange));
      }
      unsubscribers.push(registry.subscribe(onRegistryChange));
      seedFromList();
      scheduleDrain();
    },
    stop() {
      if (!started) {
        return;
      }
      started = false;
      for (const unsub of unsubscribers.splice(0)) {
        unsub();
      }
      abortAllInFlight();
      for (const handle of trailingTimers.values()) {
        scheduler.clearTimeout(handle);
      }
      resetBatchWindow();
      clearStageAdvance();
      trailingTimers.clear();
      queued.clear();
    },
    getState() {
      return {
        queued: Array.from(queued.keys()),
        inFlight: Array.from(inFlight),
        warmed: Array.from(warmed),
        stage: stageIndex,
      };
    },
    requestPrefetch(sessionId: SessionId) {
      if (!started || paused) {
        return;
      }
      if (inFlight.has(sessionId) || registry.isJoined(roomOf(sessionId))) {
        return;
      }
      const snap = latest.get(sessionId) ?? { sessionId };
      clearTrailing(sessionId);
      queued.set(sessionId, snap);
      scheduleDrain();
    },
  };
}

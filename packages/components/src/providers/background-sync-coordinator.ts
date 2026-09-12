import { getSessionRoomId, type SessionId, type SessionStatus } from '@lody/shared';
import type { EagerSyncPolicy } from './eager-sync-policy';

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
 * - Sync is always ONE-SHOT catch-up: the runtime prefetcher uses a disposable
 *   worker and a raw-document snapshot cache, never a UI store or Mirror.
 *   It releases the document and room after catch-up.
 * - Candidate scope depends on the surface: native/electron can eventually
 *   warm all candidates, while web stays bounded to the highest-priority set.
 *   All surfaces use bounded concurrency plus batch cooldowns.
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
     * One-shot catch-up: hold a replica until caught up (or the signal aborts /
     * a timeout fires), persist and release. Resolves with the
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
  clock: { now(): number };
  scheduler: {
    setTimeout(handler: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  policy: EagerSyncPolicy;
  highWaterStore?: EagerSyncHighWaterStore;
  logger?: { debug(...args: unknown[]): void };
}

export type { EagerSyncPolicy, EagerSyncSurface } from './eager-sync-policy';
export {
  DEFAULT_EAGER_SYNC_POLICY,
  FULL_EAGER_SYNC_CANDIDATE_WINDOW,
  FULL_EAGER_SYNC_POLICY,
  MOBILE_EAGER_SYNC_POLICY,
  WEB_EAGER_SYNC_CANDIDATE_WINDOW,
  WEB_EAGER_SYNC_POLICY,
  resolveEagerSyncPolicy,
} from './eager-sync-policy';

export interface BackgroundSyncCoordinator {
  start(): void;
  stop(): void;
  getState(): { queued: SessionId[]; inFlight: SessionId[]; warmed: SessionId[] };
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
    const pinnedBoost = snap.isPinned ? 100 : 0;
    const visibleBoost = visibility?.isVisible(snap.sessionId) ? 10 : 0;
    const activityBoost = (() => {
      if (isRunningStatus(snap.status)) {
        return 2;
      }
      if (
        snap.lastMessageAt != null &&
        (snap.lastReadAt == null || snap.lastMessageAt > snap.lastReadAt)
      ) {
        return 1;
      }
      return 0;
    })();
    return pinnedBoost + visibleBoost + activityBoost;
  };

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
    if (!Number.isFinite(policy.candidateWindow)) {
      return null;
    }
    return Math.max(0, Math.floor(policy.candidateWindow));
  };

  const listCandidateSnapshots = (): SessionActivitySnapshot[] => {
    const snapshots = new Map<SessionId, SessionActivitySnapshot>();
    for (const snap of activitySource.list()) {
      snapshots.set(snap.sessionId, snap);
    }
    for (const snap of latest.values()) {
      snapshots.set(snap.sessionId, snap);
    }
    const candidates = Array.from(snapshots.values())
      .filter((snap) => !snap.isArchived && snap.lastMessageAt != null)
      .sort(comparePrefetchPriority);
    const limit = getCandidateLimit();
    return limit == null ? candidates : candidates.slice(0, limit);
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
    if (getCandidateLimit() != null) {
      seedFromList();
      scheduleDrain();
      return;
    }
    evaluate(snap.sessionId);
  };

  const seedFromList = () => {
    const candidates = listCandidateSnapshots();
    const allowed =
      getCandidateLimit() == null ? null : new Set(candidates.map((snap) => snap.sessionId));
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
      abortAllInFlight();
      logger?.debug('[eager-sync] paused (offline/hidden)');
    } else if (active && paused) {
      paused = false;
      logger?.debug('[eager-sync] resumed');
      seedFromList();
      scheduleDrain();
    }
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
      trailingTimers.clear();
      queued.clear();
    },
    getState() {
      return {
        queued: Array.from(queued.keys()),
        inFlight: Array.from(inFlight),
        warmed: Array.from(warmed),
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

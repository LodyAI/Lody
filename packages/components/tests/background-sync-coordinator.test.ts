import { describe, it, expect } from 'vitest';
import { getSessionRoomId, type SessionId, type SessionStatus } from '@lody/shared';
import {
  createBackgroundSyncCoordinator,
  resolveEagerSyncPolicy,
  EAGER_SYNC_PRIORITY_RUNNING,
  MOBILE_EAGER_SYNC_STAGES,
  type BackgroundSyncCoordinatorDeps,
  type EagerSyncHighWaterStore,
  type EagerSyncPolicy,
  type EagerSyncStage,
  type PrefetchOutcome,
  type SessionActivitySnapshot,
} from '../src/providers/background-sync-coordinator';

const sid = (id: string) => id as SessionId;
const room = (id: string) => getSessionRoomId(sid(id));

// Flush microtask queue using a real macrotask. The coordinator itself uses the
// injected fake scheduler, so this never fires coordinator timers.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function createFakeTime() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { fire: () => void; due: number }>();
  return {
    clock: { now: () => now },
    scheduler: {
      setTimeout: (handler: () => void, ms: number) => {
        const id = nextId++;
        timers.set(id, { fire: handler, due: now + ms });
        return id;
      },
      clearTimeout: (handle: unknown) => {
        timers.delete(handle as number);
      },
    },
    advance: (ms: number) => {
      now += ms;
      for (const [id, timer] of Array.from(timers)) {
        if (timer.due <= now) {
          timers.delete(id);
          timer.fire();
        }
      }
    },
  };
}

function createFakeRegistry() {
  const joined = new Set<string>();
  const recentlySynced = new Set<string>();
  const subscribers = new Set<() => void>();
  return {
    joined,
    recentlySynced,
    notify: () => {
      for (const s of Array.from(subscribers)) {
        s();
      }
    },
    view: {
      isJoined: (roomId: string) => joined.has(roomId),
      getRecentlySynced: () => recentlySynced as ReadonlySet<string>,
      subscribe: (onChange: () => void) => {
        subscribers.add(onChange);
        return () => subscribers.delete(onChange);
      },
    },
  };
}

function createFakeEnv() {
  let online = true;
  let visible = true;
  const subscribers = new Set<() => void>();
  const notify = () => {
    for (const s of Array.from(subscribers)) {
      s();
    }
  };
  return {
    set: (next: { online?: boolean; visible?: boolean }) => {
      if (next.online !== undefined) online = next.online;
      if (next.visible !== undefined) visible = next.visible;
      notify();
    },
    view: {
      isOnline: () => online,
      isAppVisible: () => visible,
      subscribe: (onChange: () => void) => {
        subscribers.add(onChange);
        return () => subscribers.delete(onChange);
      },
    },
  };
}

function createFakeActivitySource(initial: SessionActivitySnapshot[] = []) {
  const snapshots = new Map<SessionId, SessionActivitySnapshot>();
  for (const snap of initial) {
    snapshots.set(snap.sessionId, snap);
  }
  let listener: ((snap: SessionActivitySnapshot) => void) | null = null;
  return {
    emit: (snap: SessionActivitySnapshot) => {
      snapshots.set(snap.sessionId, snap);
      listener?.(snap);
    },
    view: {
      list: () => Array.from(snapshots.values()),
      subscribe: (onChange: (snap: SessionActivitySnapshot) => void) => {
        listener = onChange;
        return () => {
          if (listener === onChange) listener = null;
        };
      },
    },
  };
}

function createFakePrefetcher() {
  const calls: SessionId[] = [];
  const evicted: SessionId[] = [];
  const pending = new Map<SessionId, (outcome: PrefetchOutcome) => void>();
  return {
    calls,
    evicted,
    isPending: (id: SessionId) => pending.has(id),
    resolve: (id: SessionId, outcome: PrefetchOutcome = 'synced') => {
      const resolver = pending.get(id);
      pending.delete(id);
      resolver?.(outcome);
    },
    port: {
      prefetch: (sessionId: SessionId, signal: AbortSignal) => {
        calls.push(sessionId);
        return new Promise<PrefetchOutcome>((resolve) => {
          pending.set(sessionId, resolve);
          if (signal.aborted) {
            pending.delete(sessionId);
            resolve('skipped');
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              pending.delete(sessionId);
              resolve('skipped');
            },
            { once: true }
          );
        });
      },
      evict: (sessionId: SessionId) => {
        evicted.push(sessionId);
      },
    },
  };
}

function createFakeHighWaterStore(initial: Array<[SessionId, number]> = []) {
  const values = new Map<SessionId, number>(initial);
  const writes: Array<{ sessionId: SessionId; lastMessageAt: number }> = [];
  const port: EagerSyncHighWaterStore = {
    get: (sessionId) => values.get(sessionId),
    set: (sessionId, lastMessageAt) => {
      writes.push({ sessionId, lastMessageAt });
      values.set(sessionId, lastMessageAt);
    },
  };
  return { values, writes, port };
}

function createFakeVisibilitySource(initial: SessionId[] = []) {
  let visible = new Set(initial);
  const subscribers = new Set<() => void>();
  return {
    set: (ids: SessionId[]) => {
      visible = new Set(ids);
      for (const subscriber of Array.from(subscribers)) {
        subscriber();
      }
    },
    view: {
      isVisible: (sessionId: SessionId) => visible.has(sessionId),
      subscribe: (onChange: () => void) => {
        subscribers.add(onChange);
        return () => subscribers.delete(onChange);
      },
    },
  };
}

function createFakeInteractionSource() {
  let interacting = false;
  const subscribers = new Set<() => void>();
  return {
    set: (next: boolean) => {
      if (interacting === next) {
        return;
      }
      interacting = next;
      for (const subscriber of Array.from(subscribers)) {
        subscriber();
      }
    },
    view: {
      isInteracting: () => interacting,
      subscribe: (onChange: () => void) => {
        subscribers.add(onChange);
        return () => subscribers.delete(onChange);
      },
    },
  };
}

const RUNNING: SessionStatus = { type: 'running' };

function setup(
  options: {
    activity?: SessionActivitySnapshot[];
    policy?: Partial<EagerSyncPolicy>;
    highWaterStore?: EagerSyncHighWaterStore;
    visibility?: BackgroundSyncCoordinatorDeps['visibility'];
    interaction?: BackgroundSyncCoordinatorDeps['interaction'];
  } = {}
) {
  const time = createFakeTime();
  const registry = createFakeRegistry();
  const env = createFakeEnv();
  const activity = createFakeActivitySource(options.activity ?? []);
  const prefetcher = createFakePrefetcher();
  const policy: EagerSyncPolicy = {
    concurrency: 4,
    batchSize: Number.POSITIVE_INFINITY,
    batchCooldownMs: 0,
    freshnessTtlMs: 15_000,
    maxWarmDocs: 24,
    candidateWindow: 50,
    prefetchTimeoutMs: 20_000,
    ...options.policy,
  };
  const deps: BackgroundSyncCoordinatorDeps = {
    activitySource: activity.view,
    registry: registry.view,
    prefetcher: prefetcher.port,
    env: env.view,
    clock: time.clock,
    scheduler: time.scheduler,
    policy,
    highWaterStore: options.highWaterStore,
    visibility: options.visibility,
    interaction: options.interaction,
  };
  const coordinator = createBackgroundSyncCoordinator(deps);
  return { coordinator, time, registry, env, activity, prefetcher, policy };
}

describe('createBackgroundSyncCoordinator', () => {
  it('uses a bounded web policy and a full desktop policy', () => {
    expect(resolveEagerSyncPolicy('web')).toMatchObject({
      concurrency: 2,
      batchSize: 4,
      batchCooldownMs: 1_500,
      candidateWindow: 20,
      maxWarmDocs: 20,
    });
    expect(resolveEagerSyncPolicy('desktop')).toMatchObject({
      concurrency: 3,
      batchSize: 8,
      batchCooldownMs: 750,
      candidateWindow: Number.POSITIVE_INFINITY,
      maxWarmDocs: 96,
    });
    expect(resolveEagerSyncPolicy('desktop').stages).toBeUndefined();
  });

  it('gives mobile its own gentler, progressively widening policy', () => {
    const mobile = resolveEagerSyncPolicy('mobile');
    const desktop = resolveEagerSyncPolicy('desktop');

    // A phone has one main thread and every prefetch deserializes a doc on it.
    expect(mobile).toMatchObject({
      concurrency: 1,
      batchSize: 3,
      batchCooldownMs: 3_000,
      maxWarmDocs: 12,
    });
    expect(mobile.concurrency).toBeLessThan(desktop.concurrency);
    expect(mobile.batchCooldownMs).toBeGreaterThan(desktop.batchCooldownMs);
    expect(mobile.maxWarmDocs).toBeLessThan(desktop.maxWarmDocs);

    // It starts on the on-screen/pinned/running set, widens monotonically, and
    // still reaches full coverage at the top of the ladder.
    const stages = mobile.stages ?? [];
    expect(stages.length).toBeGreaterThan(1);
    expect(stages[0]?.minPriority).toBe(EAGER_SYNC_PRIORITY_RUNNING);
    expect(stages[0]?.candidateWindow).toBeLessThan(desktop.candidateWindow);
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i].candidateWindow).toBeGreaterThan(stages[i - 1].candidateWindow);
      expect(stages[i].minPriority).toBeLessThanOrEqual(stages[i - 1].minPriority);
    }
    expect(stages[stages.length - 1]?.minPriority).toBe(0);
    expect(stages[stages.length - 1]?.candidateWindow).toBe(Number.POSITIVE_INFINITY);
    expect(MOBILE_EAGER_SYNC_STAGES).toBe(stages);
  });

  it('prefetches a recently-active session on start', async () => {
    const { coordinator, prefetcher } = setup({
      activity: [{ sessionId: sid('a'), lastMessageAt: 100 }],
    });
    coordinator.start();
    await tick();
    expect(prefetcher.calls).toEqual([sid('a')]);
  });

  it('skips archived sessions and sessions with no activity', async () => {
    const { coordinator, prefetcher } = setup({
      activity: [
        { sessionId: sid('a'), lastMessageAt: 100, isArchived: true },
        { sessionId: sid('b') },
      ],
    });
    coordinator.start();
    await tick();
    expect(prefetcher.calls).toEqual([]);
  });

  it('skips sessions already joined (a UI surface is live on them)', async () => {
    const { coordinator, prefetcher, registry } = setup({
      activity: [{ sessionId: sid('a'), lastMessageAt: 100 }],
    });
    registry.joined.add(room('a'));
    coordinator.start();
    await tick();
    expect(prefetcher.calls).toEqual([]);
  });

  it('dedupes by activity high-water mark (syncedThrough)', async () => {
    const { coordinator, prefetcher, activity } = setup({
      activity: [{ sessionId: sid('a'), lastMessageAt: 100 }],
    });
    coordinator.start();
    await tick();
    prefetcher.resolve(sid('a'), 'synced');
    await tick();
    expect(prefetcher.calls).toEqual([sid('a')]);

    // Same lastMessageAt → already synced through → not re-prefetched.
    activity.emit({ sessionId: sid('a'), lastMessageAt: 100 });
    await tick();
    expect(prefetcher.calls).toEqual([sid('a')]);

    // Newer message → re-qualifies.
    activity.emit({ sessionId: sid('a'), lastMessageAt: 200 });
    await tick();
    expect(prefetcher.calls).toEqual([sid('a'), sid('a')]);
  });

  it('prioritizes visible sessions over more recently updated invisible sessions', async () => {
    const visibility = createFakeVisibilitySource([sid('visible-old')]);
    const { coordinator, prefetcher } = setup({
      activity: [
        { sessionId: sid('visible-old'), lastMessageAt: 100 },
        { sessionId: sid('invisible-new'), lastMessageAt: 300 },
      ],
      policy: { candidateWindow: 1, concurrency: 1 },
      visibility: visibility.view,
    });

    coordinator.start();
    await tick();

    expect(prefetcher.calls).toEqual([sid('visible-old')]);
  });

  it('prioritizes pinned sessions above visible sessions', async () => {
    const visibility = createFakeVisibilitySource([sid('visible-new')]);
    const { coordinator, prefetcher } = setup({
      activity: [
        { sessionId: sid('pinned-old'), lastMessageAt: 100, isPinned: true },
        { sessionId: sid('visible-new'), lastMessageAt: 300 },
      ],
      policy: { candidateWindow: 1, concurrency: 1 },
      visibility: visibility.view,
    });

    coordinator.start();
    await tick();

    expect(prefetcher.calls).toEqual([sid('pinned-old')]);
  });

  it('re-seeds candidates when UI visibility changes', async () => {
    const visibility = createFakeVisibilitySource();
    const { coordinator, prefetcher } = setup({
      activity: [
        { sessionId: sid('visible-old'), lastMessageAt: 100 },
        { sessionId: sid('invisible-new'), lastMessageAt: 300 },
      ],
      policy: { candidateWindow: 1, concurrency: 1 },
      visibility: visibility.view,
    });

    coordinator.start();
    await tick();
    expect(prefetcher.calls).toEqual([sid('invisible-new')]);

    prefetcher.resolve(sid('invisible-new'), 'synced');
    await tick();
    visibility.set([sid('visible-old')]);
    await tick();

    expect(prefetcher.calls).toEqual([sid('invisible-new'), sid('visible-old')]);
  });

  it('keeps ongoing activity bounded to the finite candidate window', async () => {
    const { coordinator, prefetcher, activity } = setup({
      activity: [
        { sessionId: sid('top'), lastMessageAt: 300 },
        { sessionId: sid('tail'), lastMessageAt: 100 },
      ],
      policy: { candidateWindow: 1, concurrency: 1 },
    });

    coordinator.start();
    await tick();
    expect(prefetcher.calls).toEqual([sid('top')]);

    prefetcher.resolve(sid('top'), 'synced');
    await tick();

    activity.emit({ sessionId: sid('tail'), lastMessageAt: 200 });
    await tick();
    expect(prefetcher.calls).toEqual([sid('top')]);

    activity.emit({ sessionId: sid('new-top'), lastMessageAt: 400 });
    await tick();
    expect(prefetcher.calls).toEqual([sid('top'), sid('new-top')]);
  });

  it('skips sessions already synced through the persisted high-water mark', async () => {
    const highWater = createFakeHighWaterStore([[sid('a'), 100]]);
    const { coordinator, prefetcher } = setup({
      activity: [{ sessionId: sid('a'), lastMessageAt: 100 }],
      highWaterStore: highWater.port,
    });

    coordinator.start();
    await tick();

    expect(prefetcher.calls).toEqual([]);
  });

  it('prefetches again when activity is newer than the persisted high-water mark', async () => {
    const highWater = createFakeHighWaterStore([[sid('a'), 100]]);
    const { coordinator, prefetcher } = setup({
      activity: [{ sessionId: sid('a'), lastMessageAt: 200 }],
      highWaterStore: highWater.port,
    });

    coordinator.start();
    await tick();

    expect(prefetcher.calls).toEqual([sid('a')]);
  });

  it('persists high-water marks after successful prefetches for later coordinators', async () => {
    const highWater = createFakeHighWaterStore();
    const first = setup({
      activity: [{ sessionId: sid('a'), lastMessageAt: 100 }],
      highWaterStore: highWater.port,
    });
    first.coordinator.start();
    await tick();
    first.prefetcher.resolve(sid('a'), 'synced');
    await tick();
    expect(highWater.writes).toEqual([{ sessionId: sid('a'), lastMessageAt: 100 }]);

    const second = setup({
      activity: [{ sessionId: sid('a'), lastMessageAt: 100 }],
      highWaterStore: highWater.port,
    });
    second.coordinator.start();
    await tick();
    expect(second.prefetcher.calls).toEqual([]);
  });

  it('does not advance syncedThrough on a failed prefetch (retry stays possible)', async () => {
    const { coordinator, prefetcher, activity } = setup({
      activity: [{ sessionId: sid('a'), lastMessageAt: 100 }],
    });
    coordinator.start();
    await tick();
    prefetcher.resolve(sid('a'), 'failed');
    await tick();
    expect(prefetcher.calls).toEqual([sid('a')]);

    // Same lastMessageAt re-emitted: because the failed attempt did NOT record a
    // synced high-water mark, the session is still eligible and is retried.
    activity.emit({ sessionId: sid('a'), lastMessageAt: 100 });
    await tick();
    expect(prefetcher.calls).toEqual([sid('a'), sid('a')]);
  });

  it('does not persist high-water marks for failed prefetches', async () => {
    const highWater = createFakeHighWaterStore();
    const { coordinator, prefetcher } = setup({
      activity: [{ sessionId: sid('a'), lastMessageAt: 100 }],
      highWaterStore: highWater.port,
    });

    coordinator.start();
    await tick();
    prefetcher.resolve(sid('a'), 'failed');
    await tick();

    expect(highWater.writes).toEqual([]);
  });

  it('honors the concurrency cap and drains as prefetches settle', async () => {
    const { coordinator, prefetcher } = setup({
      activity: [
        { sessionId: sid('a'), lastMessageAt: 1 },
        { sessionId: sid('b'), lastMessageAt: 2 },
        { sessionId: sid('c'), lastMessageAt: 3 },
      ],
      policy: { concurrency: 2 },
    });
    coordinator.start();
    await tick();
    expect(coordinator.getState().inFlight.length).toBe(2);
    expect(prefetcher.calls.length).toBe(2);

    prefetcher.resolve(prefetcher.calls[0], 'synced');
    await tick();
    expect(prefetcher.calls.length).toBe(3);
  });

  it('starts prefetches in batches separated by cooldowns', async () => {
    const { coordinator, prefetcher, time } = setup({
      activity: [
        { sessionId: sid('a'), lastMessageAt: 1 },
        { sessionId: sid('b'), lastMessageAt: 2 },
        { sessionId: sid('c'), lastMessageAt: 3 },
        { sessionId: sid('d'), lastMessageAt: 4 },
        { sessionId: sid('e'), lastMessageAt: 5 },
      ],
      policy: {
        concurrency: 4,
        batchSize: 2,
        batchCooldownMs: 1_000,
      },
    });

    coordinator.start();
    await tick();
    expect(prefetcher.calls).toEqual([sid('e'), sid('d')]);

    time.advance(999);
    await tick();
    expect(prefetcher.calls).toEqual([sid('e'), sid('d')]);

    time.advance(1);
    await tick();
    expect(prefetcher.calls).toEqual([sid('e'), sid('d'), sid('c'), sid('b')]);

    prefetcher.resolve(sid('e'), 'synced');
    await tick();
    expect(prefetcher.calls).toEqual([sid('e'), sid('d'), sid('c'), sid('b')]);

    time.advance(1_000);
    await tick();
    expect(prefetcher.calls).toEqual([sid('e'), sid('d'), sid('c'), sid('b'), sid('a')]);
  });

  it('prioritizes running sessions', async () => {
    const { coordinator, prefetcher } = setup({
      activity: [
        { sessionId: sid('idle'), lastMessageAt: 100 },
        { sessionId: sid('run'), lastMessageAt: 50, status: RUNNING },
      ],
      policy: { concurrency: 1 },
    });
    coordinator.start();
    await tick();
    expect(prefetcher.calls).toEqual([sid('run')]);
  });

  it('evicts the oldest non-joined warmed doc beyond maxWarmDocs', async () => {
    const { coordinator, prefetcher, activity } = setup({ policy: { maxWarmDocs: 2 } });
    coordinator.start();

    for (const id of ['a', 'b', 'c']) {
      activity.emit({ sessionId: sid(id), lastMessageAt: 1 });
      await tick();
      prefetcher.resolve(sid(id), 'synced');
      await tick();
    }
    // a, b, c warmed → cap 2 → oldest (a) evicted.
    expect(prefetcher.evicted).toEqual([sid('a')]);
  });

  it('never evicts a warmed doc that is currently joined', async () => {
    const { coordinator, prefetcher, activity, registry } = setup({ policy: { maxWarmDocs: 2 } });
    coordinator.start();

    for (const id of ['a', 'b']) {
      activity.emit({ sessionId: sid(id), lastMessageAt: 1 });
      await tick();
      prefetcher.resolve(sid(id), 'synced');
      await tick();
    }
    // 'a' is the oldest, but the user is now viewing it (joined) → skip it,
    // evict 'b' instead when 'c' warms.
    registry.joined.add(room('a'));
    activity.emit({ sessionId: sid('c'), lastMessageAt: 1 });
    await tick();
    prefetcher.resolve(sid('c'), 'synced');
    await tick();
    expect(prefetcher.evicted).toEqual([sid('b')]);
  });

  it('pauses and aborts in-flight prefetches when offline, resumes when back', async () => {
    const { coordinator, prefetcher, env, activity } = setup({
      activity: [{ sessionId: sid('a'), lastMessageAt: 100 }],
    });
    coordinator.start();
    await tick();
    expect(coordinator.getState().inFlight).toEqual([sid('a')]);

    env.set({ online: false });
    await tick();
    expect(coordinator.getState().inFlight).toEqual([]);

    // New activity while offline is not prefetched.
    activity.emit({ sessionId: sid('b'), lastMessageAt: 100 });
    await tick();
    expect(prefetcher.calls).toEqual([sid('a')]);

    // Back online → re-seed and prefetch.
    env.set({ online: true });
    await tick();
    expect(prefetcher.calls.includes(sid('b'))).toBe(true);
  });

  it('coalesces a burst-synced room then re-evaluates after the freshness window', async () => {
    const { coordinator, prefetcher, registry, activity, time, policy } = setup({});
    coordinator.start();

    registry.recentlySynced.add(room('a'));
    activity.emit({ sessionId: sid('a'), lastMessageAt: 100 });
    await tick();
    // Within freshness window → coalesced (not prefetched yet).
    expect(prefetcher.calls).toEqual([]);

    // Window passes and the room is no longer recently synced → trailing re-eval fires.
    registry.recentlySynced.delete(room('a'));
    time.advance(policy.freshnessTtlMs);
    await tick();
    expect(prefetcher.calls).toEqual([sid('a')]);
  });

  it('aborts a prefetch that exceeds prefetchTimeoutMs', async () => {
    const { coordinator, time, policy } = setup({
      activity: [{ sessionId: sid('a'), lastMessageAt: 100 }],
    });
    coordinator.start();
    await tick();
    expect(coordinator.getState().inFlight).toEqual([sid('a')]);

    time.advance(policy.prefetchTimeoutMs);
    await tick();
    expect(coordinator.getState().inFlight).toEqual([]);
  });

  it('starts on the first stage and only widens after the queue drains and idles', async () => {
    const visibility = createFakeVisibilitySource([sid('visible')]);
    const stages: EagerSyncStage[] = [
      { minPriority: EAGER_SYNC_PRIORITY_RUNNING, candidateWindow: 4, holdMs: 5_000 },
      { minPriority: 0, candidateWindow: 3, holdMs: 10_000 },
      { minPriority: 0, candidateWindow: Number.POSITIVE_INFINITY, holdMs: 0 },
    ];
    const { coordinator, prefetcher, time } = setup({
      activity: [
        { sessionId: sid('visible'), lastMessageAt: 10 },
        { sessionId: sid('unread'), lastMessageAt: 400, lastReadAt: 1 },
        { sessionId: sid('quiet-new'), lastMessageAt: 300, lastReadAt: 300 },
        { sessionId: sid('quiet-old'), lastMessageAt: 200, lastReadAt: 200 },
      ],
      policy: { concurrency: 1, stages },
      visibility: visibility.view,
    });

    coordinator.start();
    await tick();
    // Stage 0: only the on-screen session qualifies, despite three sessions
    // having strictly newer activity.
    expect(prefetcher.calls).toEqual([sid('visible')]);
    expect(coordinator.getState().stage).toBe(0);

    // Still in flight → the hold has not even started.
    time.advance(5_000);
    await tick();
    expect(coordinator.getState().stage).toBe(0);

    prefetcher.resolve(sid('visible'), 'synced');
    await tick();
    expect(coordinator.getState().stage).toBe(0);

    time.advance(4_999);
    await tick();
    expect(coordinator.getState().stage).toBe(0);
    expect(prefetcher.calls).toEqual([sid('visible')]);

    time.advance(1);
    await tick();
    // Stage 1: the priority floor drops, so unread/quiet sessions inside the
    // window qualify — but the window still excludes the tail.
    expect(coordinator.getState().stage).toBe(1);
    expect(prefetcher.calls).toEqual([sid('visible'), sid('unread')]);

    prefetcher.resolve(sid('unread'), 'synced');
    await tick();
    expect(prefetcher.calls).toEqual([sid('visible'), sid('unread'), sid('quiet-new')]);

    prefetcher.resolve(sid('quiet-new'), 'synced');
    await tick();
    time.advance(10_000);
    await tick();
    // Stage 2: unbounded window picks up the tail.
    expect(coordinator.getState().stage).toBe(2);
    expect(prefetcher.calls).toEqual([
      sid('visible'),
      sid('unread'),
      sid('quiet-new'),
      sid('quiet-old'),
    ]);
  });

  it('holds the ladder while work keeps arriving on the current stage', async () => {
    const stages: EagerSyncStage[] = [
      { minPriority: 0, candidateWindow: 1, holdMs: 1_000 },
      { minPriority: 0, candidateWindow: Number.POSITIVE_INFINITY, holdMs: 0 },
    ];
    const { coordinator, prefetcher, activity, time } = setup({
      activity: [{ sessionId: sid('a'), lastMessageAt: 100 }],
      policy: { concurrency: 1, stages },
    });

    coordinator.start();
    await tick();
    prefetcher.resolve(sid('a'), 'synced');
    await tick();

    // Hold armed, but new top-of-window activity re-fills the queue before it
    // elapses → the stage must not advance on the wall clock alone.
    time.advance(999);
    activity.emit({ sessionId: sid('a'), lastMessageAt: 200 });
    await tick();
    time.advance(1);
    await tick();
    expect(coordinator.getState().stage).toBe(0);

    prefetcher.resolve(sid('a'), 'synced');
    await tick();
    time.advance(1_000);
    await tick();
    expect(coordinator.getState().stage).toBe(1);
  });

  it('restarts the ladder after a background/offline pause', async () => {
    const visibility = createFakeVisibilitySource([sid('visible')]);
    const stages: EagerSyncStage[] = [
      { minPriority: EAGER_SYNC_PRIORITY_RUNNING, candidateWindow: 4, holdMs: 1_000 },
      { minPriority: 0, candidateWindow: Number.POSITIVE_INFINITY, holdMs: 0 },
    ];
    const { coordinator, prefetcher, env, activity, time } = setup({
      activity: [{ sessionId: sid('visible'), lastMessageAt: 10 }],
      policy: { concurrency: 1, stages },
      visibility: visibility.view,
    });

    coordinator.start();
    await tick();
    prefetcher.resolve(sid('visible'), 'synced');
    await tick();
    time.advance(1_000);
    await tick();
    expect(coordinator.getState().stage).toBe(1);

    env.set({ visible: false });
    await tick();
    activity.emit({ sessionId: sid('quiet'), lastMessageAt: 500, lastReadAt: 500 });
    await tick();

    env.set({ visible: true });
    await tick();
    // Coming back is a fresh cold start: the quiet session does not clear the
    // stage-0 floor, so nothing new is prefetched until the ladder climbs again.
    expect(coordinator.getState().stage).toBe(0);
    expect(prefetcher.calls).toEqual([sid('visible')]);

    time.advance(1_000);
    await tick();
    expect(coordinator.getState().stage).toBe(1);
    expect(prefetcher.calls).toEqual([sid('visible'), sid('quiet')]);
  });

  it('starts no prefetch while the user is interacting, and resumes when they stop', async () => {
    const interaction = createFakeInteractionSource();
    const { coordinator, prefetcher, activity } = setup({
      activity: [{ sessionId: sid('a'), lastMessageAt: 100 }],
      interaction: interaction.view,
    });

    interaction.set(true);
    coordinator.start();
    await tick();
    expect(prefetcher.calls).toEqual([]);
    expect(coordinator.getState().queued).toEqual([sid('a')]);

    activity.emit({ sessionId: sid('b'), lastMessageAt: 200 });
    await tick();
    expect(prefetcher.calls).toEqual([]);

    interaction.set(false);
    await tick();
    expect(prefetcher.calls).toEqual([sid('b'), sid('a')]);
  });

  it('leaves an in-flight prefetch running when interaction starts', async () => {
    const interaction = createFakeInteractionSource();
    const { coordinator, prefetcher } = setup({
      activity: [
        { sessionId: sid('a'), lastMessageAt: 200 },
        { sessionId: sid('b'), lastMessageAt: 100 },
      ],
      policy: { concurrency: 1 },
      interaction: interaction.view,
    });

    coordinator.start();
    await tick();
    expect(coordinator.getState().inFlight).toEqual([sid('a')]);

    // Aborting here would only cost a fresh room join later; it buys no frame back.
    interaction.set(true);
    await tick();
    expect(coordinator.getState().inFlight).toEqual([sid('a')]);

    prefetcher.resolve(sid('a'), 'synced');
    await tick();
    expect(prefetcher.calls).toEqual([sid('a')]);
  });

  it('does not widen the candidate scope while the user is interacting', async () => {
    const interaction = createFakeInteractionSource();
    const stages: EagerSyncStage[] = [
      { minPriority: 0, candidateWindow: 1, holdMs: 1_000 },
      { minPriority: 0, candidateWindow: Number.POSITIVE_INFINITY, holdMs: 0 },
    ];
    const { coordinator, prefetcher, time } = setup({
      activity: [
        { sessionId: sid('a'), lastMessageAt: 200 },
        { sessionId: sid('b'), lastMessageAt: 100 },
      ],
      policy: { concurrency: 1, stages },
      interaction: interaction.view,
    });

    coordinator.start();
    await tick();
    prefetcher.resolve(sid('a'), 'synced');
    await tick();

    interaction.set(true);
    time.advance(10_000);
    await tick();
    expect(coordinator.getState().stage).toBe(0);
    expect(prefetcher.calls).toEqual([sid('a')]);

    interaction.set(false);
    await tick();
    time.advance(1_000);
    await tick();
    expect(coordinator.getState().stage).toBe(1);
    expect(prefetcher.calls).toEqual([sid('a'), sid('b')]);
  });

  it('stop() clears the queue and aborts in-flight work', async () => {
    const { coordinator, activity } = setup({
      activity: [
        { sessionId: sid('a'), lastMessageAt: 1 },
        { sessionId: sid('b'), lastMessageAt: 2 },
      ],
      policy: { concurrency: 1 },
    });
    coordinator.start();
    await tick();
    expect(coordinator.getState().inFlight.length).toBe(1);

    coordinator.stop();
    await tick();
    expect(coordinator.getState().inFlight).toEqual([]);
    expect(coordinator.getState().queued).toEqual([]);

    // After stop, new activity is ignored.
    activity.emit({ sessionId: sid('c'), lastMessageAt: 3 });
    await tick();
    expect(coordinator.getState().queued).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { getSessionRoomId, type SessionId, type SessionStatus } from '@lody/shared';
import {
  createBackgroundSyncCoordinator,
  resolveEagerSyncPolicy,
  type BackgroundSyncCoordinatorDeps,
  type EagerSyncHighWaterStore,
  type EagerSyncPolicy,
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
    pending: () => timers.size,
    // A backgrounded phone is suspended: wall-clock time passes but timers do
    // not run. They all come due at once when the OS resumes the process.
    advanceSuspended: (ms: number) => {
      now += ms;
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
    expect(resolveEagerSyncPolicy('desktop').warmupCandidateWindow).toBeUndefined();
  });

  it('paces mobile more gently than desktop and warms up before widening', () => {
    const mobile = resolveEagerSyncPolicy('mobile');
    const desktop = resolveEagerSyncPolicy('desktop');

    // The bug this guards: mobile falling back to the desktop policy. A phone
    // has one main thread and every prefetch deserializes a doc on it, so it
    // must start less work at once, pause longer between batches, and hold
    // fewer docs resident — whatever the exact numbers are.
    expect(mobile.concurrency).toBeLessThan(desktop.concurrency);
    expect(mobile.batchSize).toBeLessThan(desktop.batchSize);
    expect(mobile.batchCooldownMs).toBeGreaterThan(desktop.batchCooldownMs);
    expect(mobile.maxWarmDocs).toBeLessThan(desktop.maxWarmDocs);

    // It warms up on a strictly narrower slice, and still ends up with the same
    // eventual coverage as desktop — the pacing is what protects the phone.
    expect(mobile.warmupCandidateWindow).toBeLessThan(mobile.candidateWindow);
    expect(mobile.warmupHoldMs).toBeGreaterThan(0);
    expect(mobile.candidateWindow).toBe(desktop.candidateWindow);
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

  it('warms up on the top candidates and widens only once drained and then idle', async () => {
    const { coordinator, prefetcher, time } = setup({
      activity: [
        { sessionId: sid('top'), lastMessageAt: 400 },
        { sessionId: sid('second'), lastMessageAt: 300 },
        { sessionId: sid('tail'), lastMessageAt: 200 },
      ],
      policy: { concurrency: 1, warmupCandidateWindow: 2, warmupHoldMs: 5_000 },
    });

    coordinator.start();
    await tick();
    prefetcher.resolve(sid('top'), 'synced');
    await tick();
    // Still inside the warm-up window: the tail is out of scope entirely.
    expect(prefetcher.calls).toEqual([sid('top'), sid('second')]);

    // A prefetch is still in flight, so the idle hold has not begun.
    time.advance(5_000);
    await tick();
    expect(prefetcher.calls).toEqual([sid('top'), sid('second')]);

    prefetcher.resolve(sid('second'), 'synced');
    await tick();
    time.advance(4_999);
    await tick();
    expect(prefetcher.calls).toEqual([sid('top'), sid('second')]);

    time.advance(1);
    await tick();
    expect(prefetcher.calls).toEqual([sid('top'), sid('second'), sid('tail')]);
  });

  it('holds the warm-up while work keeps arriving', async () => {
    const { coordinator, prefetcher, activity, time } = setup({
      activity: [
        { sessionId: sid('a'), lastMessageAt: 100 },
        { sessionId: sid('b'), lastMessageAt: 50 },
      ],
      policy: { concurrency: 1, warmupCandidateWindow: 1, warmupHoldMs: 1_000 },
    });

    coordinator.start();
    await tick();
    prefetcher.resolve(sid('a'), 'synced');
    await tick();

    // Hold armed, then the queue re-fills before it elapses → the scope must
    // not widen on the wall clock alone.
    time.advance(999);
    activity.emit({ sessionId: sid('a'), lastMessageAt: 200 });
    await tick();
    time.advance(1);
    await tick();
    expect(prefetcher.calls).toEqual([sid('a'), sid('a')]);

    // The hold elapsed while busy, so it must have been discarded rather than
    // applied late: 'b' is still out of scope once the queue drains.
    prefetcher.resolve(sid('a'), 'synced');
    await tick();
    expect(prefetcher.calls).toEqual([sid('a'), sid('a')]);

    time.advance(1_000);
    await tick();
    expect(prefetcher.calls).toEqual([sid('a'), sid('a'), sid('b')]);
  });

  it('does not widen while a batch cooldown still has work queued', async () => {
    const { coordinator, prefetcher, activity, time } = setup({
      activity: [{ sessionId: sid('a'), lastMessageAt: 400 }],
      policy: {
        concurrency: 1,
        batchSize: 1,
        batchCooldownMs: 5_000,
        warmupCandidateWindow: 3,
        warmupHoldMs: 1_000,
      },
    });

    coordinator.start();
    await tick();
    prefetcher.resolve(sid('a'), 'synced');
    await tick();

    // Hold armed. Now two more warm-up candidates arrive: one starts, the other
    // waits behind a batch cooldown — so nothing is in flight, but the warm-up
    // set is demonstrably not finished.
    activity.emit({ sessionId: sid('b'), lastMessageAt: 300 });
    activity.emit({ sessionId: sid('c'), lastMessageAt: 200 });
    await tick();
    prefetcher.resolve(sid('b'), 'synced');
    await tick();
    expect(coordinator.getState().inFlight).toEqual([]);
    expect(coordinator.getState().queued).toEqual([sid('c')]);

    time.advance(1_000);
    await tick();
    expect(prefetcher.calls).toEqual([sid('a'), sid('b')]);

    // Cooldown ends, 'c' finishes the warm-up set, and only then does the tail
    // come into scope.
    time.advance(4_000);
    await tick();
    prefetcher.resolve(sid('c'), 'synced');
    await tick();
    activity.emit({ sessionId: sid('tail'), lastMessageAt: 100 });
    await tick();
    expect(prefetcher.calls).toEqual([sid('a'), sid('b'), sid('c')]);

    time.advance(1_000);
    await tick();
    expect(prefetcher.calls).toEqual([sid('a'), sid('b'), sid('c'), sid('tail')]);
  });

  it('warms up again, for a full hold, after a suspended background stretch', async () => {
    const { coordinator, prefetcher, env, activity, time } = setup({
      activity: [
        { sessionId: sid('top'), lastMessageAt: 400 },
        { sessionId: sid('second'), lastMessageAt: 300 },
      ],
      policy: { concurrency: 1, warmupCandidateWindow: 1, warmupHoldMs: 1_000 },
    });

    // Warm up and widen once, so the coordinator is past its warm-up.
    coordinator.start();
    await tick();
    prefetcher.resolve(sid('top'), 'synced');
    await tick();
    time.advance(1_000);
    await tick();
    expect(prefetcher.calls).toEqual([sid('top'), sid('second')]);
    prefetcher.resolve(sid('second'), 'synced');
    await tick();

    // Background the app. A suspended phone does not run timers, so an armed
    // hold comes due the moment the OS resumes the process.
    env.set({ visible: false });
    await tick();
    time.advanceSuspended(60_000);
    activity.emit({ sessionId: sid('late'), lastMessageAt: 100 });
    await tick();

    env.set({ visible: true });
    await tick();
    time.advance(1);
    await tick();
    // Resuming is a fresh cold start: back inside the warm-up window, and no
    // stale hold from before the pause may widen it on the spot.
    expect(prefetcher.calls).toEqual([sid('top'), sid('second')]);

    time.advance(999);
    await tick();
    expect(prefetcher.calls).toEqual([sid('top'), sid('second'), sid('late')]);
  });

  it('yields to interaction: no new prefetch, no widening, in-flight work left alone', async () => {
    const interaction = createFakeInteractionSource();
    const { coordinator, prefetcher, time } = setup({
      activity: [
        { sessionId: sid('a'), lastMessageAt: 300 },
        { sessionId: sid('b'), lastMessageAt: 200 },
        { sessionId: sid('tail'), lastMessageAt: 100 },
      ],
      policy: { concurrency: 1, warmupCandidateWindow: 2, warmupHoldMs: 1_000 },
      interaction: interaction.view,
    });

    coordinator.start();
    await tick();
    expect(coordinator.getState().inFlight).toEqual([sid('a')]);

    interaction.set(true);
    await tick();
    // Aborting would only cost a fresh room join later; it buys back no frame now.
    expect(coordinator.getState().inFlight).toEqual([sid('a')]);

    // Settling it must not start the next warm-up candidate under the finger.
    prefetcher.resolve(sid('a'), 'synced');
    await tick();
    expect(prefetcher.calls).toEqual([sid('a')]);

    interaction.set(false);
    await tick();
    expect(prefetcher.calls).toEqual([sid('a'), sid('b')]);
    prefetcher.resolve(sid('b'), 'synced');
    await tick();

    // The warm-up set is now fully drained — but the user picks the phone back
    // up, and time under their finger is not idle time, so it must not widen.
    interaction.set(true);
    await tick();
    time.advance(10_000);
    await tick();
    expect(prefetcher.calls).toEqual([sid('a'), sid('b')]);

    interaction.set(false);
    await tick();
    expect(prefetcher.calls).toEqual([sid('a'), sid('b')]);

    time.advance(1_000);
    await tick();
    expect(prefetcher.calls).toEqual([sid('a'), sid('b'), sid('tail')]);
  });

  it('does not let a hold armed before backgrounding widen the scope on resume', async () => {
    const { coordinator, prefetcher, env, time } = setup({
      activity: [
        { sessionId: sid('top'), lastMessageAt: 400 },
        { sessionId: sid('tail'), lastMessageAt: 200 },
      ],
      policy: { concurrency: 1, warmupCandidateWindow: 1, warmupHoldMs: 1_000 },
    });

    coordinator.start();
    await tick();
    prefetcher.resolve(sid('top'), 'synced');
    await tick();

    // A hold is now armed. The phone is backgrounded and suspended for far
    // longer than the hold, so that timer is overdue the instant it resumes —
    // and firing it would widen to the full workspace with no warm-up at all,
    // which is the stall this whole policy exists to avoid.
    env.set({ visible: false });
    await tick();
    time.advanceSuspended(60_000);
    env.set({ visible: true });
    await tick();
    time.advance(1);
    await tick();
    expect(prefetcher.calls).toEqual([sid('top')]);

    time.advance(999);
    await tick();
    expect(prefetcher.calls).toEqual([sid('top'), sid('tail')]);
  });

  it('stop() clears the queue, aborts in-flight work, and leaves no timers', async () => {
    const { coordinator, activity, prefetcher, time } = setup({
      activity: [
        { sessionId: sid('a'), lastMessageAt: 1 },
        { sessionId: sid('b'), lastMessageAt: 2 },
      ],
      policy: { concurrency: 1, warmupCandidateWindow: 1, warmupHoldMs: 1_000 },
    });
    coordinator.start();
    await tick();
    expect(coordinator.getState().inFlight.length).toBe(1);

    // Drain to idle so a warm-up hold is armed alongside the prefetch timers.
    prefetcher.resolve(prefetcher.calls[0], 'synced');
    await tick();
    expect(time.pending()).toBeGreaterThan(0);

    coordinator.stop();
    await tick();
    expect(coordinator.getState().inFlight).toEqual([]);
    expect(coordinator.getState().queued).toEqual([]);
    expect(time.pending()).toBe(0);

    // After stop, new activity is ignored.
    activity.emit({ sessionId: sid('c'), lastMessageAt: 3 });
    await tick();
    expect(coordinator.getState().queued).toEqual([]);
  });
});

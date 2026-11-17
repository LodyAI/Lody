import { describe, it, expect } from 'vitest';
import { getSessionRoomId, type SessionId, type SessionStatus } from '@lody/shared';
import {
  createBackgroundSyncCoordinator,
  type BackgroundSyncCoordinatorDeps,
  type EagerSyncHighWaterStore,
  type EagerSyncPolicy,
  type EagerSyncSurface,
  type PrefetchOutcome,
  type SessionActivitySnapshot,
} from '../src/providers/background-sync-coordinator';
import { resolveEagerSyncPolicy } from '../src/providers/eager-sync-policy';

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
  const pending = new Map<SessionId, (outcome: PrefetchOutcome) => void>();
  return {
    calls,
    isPending: (id: SessionId) => pending.has(id),
    resolve: (id: SessionId, outcome: PrefetchOutcome = 'synced') => {
      const resolver = pending.get(id);
      pending.delete(id);
      resolver?.(outcome);
    },
    port: {
      prefetch: (sessionId: SessionId, _lastMessageAt: number, signal: AbortSignal) => {
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

const RUNNING: SessionStatus = { type: 'running' };

function setup(
  options: {
    activity?: SessionActivitySnapshot[];
    policy?: Partial<EagerSyncPolicy>;
    highWaterStore?: EagerSyncHighWaterStore;
    visibility?: BackgroundSyncCoordinatorDeps['visibility'];
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
  };
  const coordinator = createBackgroundSyncCoordinator(deps);
  return { coordinator, time, registry, env, activity, prefetcher, policy };
}

describe('createBackgroundSyncCoordinator', () => {
  it.each<EagerSyncSurface>(['web', 'desktop', 'mobile'])(
    'queues at most the 20 highest-priority sessions on %s',
    async (surface) => {
      const activity = Array.from({ length: 1_000 }, (_, index) => ({
        sessionId: sid(`session-${index}`),
        lastMessageAt: index + 1,
      }));
      const { coordinator } = setup({
        activity,
        policy: resolveEagerSyncPolicy(surface),
      });

      coordinator.start();
      await tick();

      const state = coordinator.getState();
      expect(state.inFlight).toEqual([sid('session-999')]);
      expect(state.queued).toHaveLength(19);
      expect(new Set([...state.inFlight, ...state.queued])).toEqual(
        new Set(Array.from({ length: 20 }, (_, index) => sid(`session-${999 - index}`)))
      );
      coordinator.stop();
    }
  );

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

  it('allows a manual nudge to rebuild a snapshot hidden by the high-water mark', async () => {
    const highWater = createFakeHighWaterStore([[sid('a'), 100]]);
    const { coordinator, prefetcher } = setup({
      activity: [{ sessionId: sid('a'), lastMessageAt: 100 }],
      highWaterStore: highWater.port,
    });
    coordinator.start();
    await tick();

    coordinator.requestPrefetch(sid('a'));
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
    const { coordinator, prefetcher, activity, time } = setup({
      activity: [{ sessionId: sid('a'), lastMessageAt: 100 }],
    });
    coordinator.start();
    await tick();
    prefetcher.resolve(sid('a'), 'failed');
    await tick();
    expect(prefetcher.calls).toEqual([sid('a')]);

    activity.emit({ sessionId: sid('a'), lastMessageAt: 101 });
    await tick();
    expect(prefetcher.calls).toEqual([sid('a')]);
    // Failure is not sync success: a later scheduling edge can retry after backoff.
    time.advance(60 * 1000);
    activity.emit({ sessionId: sid('a'), lastMessageAt: 101 });
    await tick();
    expect(prefetcher.calls).toEqual([sid('a'), sid('a')]);
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
});

it('does not turn cache rejection into sync success or re-download on unrelated reseeds', async () => {
  const highWater = createFakeHighWaterStore();
  const h = setup({
    activity: [{ sessionId: sid('large'), lastMessageAt: 1 }],
    highWaterStore: highWater.port,
  });
  h.coordinator.start();
  await tick();
  h.prefetcher.resolve(sid('large'), 'cache_rejected');
  await tick();
  expect(highWater.values.get(sid('large'))).toBeUndefined();
  h.activity.emit({ sessionId: sid('other'), lastMessageAt: 2 });
  h.env.set({ visible: false });
  h.env.set({ visible: true });
  await tick();
  expect(h.prefetcher.isPending(sid('large'))).toBe(false);
  expect(h.coordinator.getState().queued).not.toContain(sid('large'));
  for (let activity = 3; activity < 20; activity++)
    h.activity.emit({ sessionId: sid('large'), lastMessageAt: activity });
  await tick();
  expect(h.prefetcher.isPending(sid('large'))).toBe(false);
  h.time.advance(30 * 60 * 1000);
  // Expiry does not install a polling loop. A later genuine scheduling edge retries.
  expect(h.prefetcher.isPending(sid('large'))).toBe(false);
  h.activity.emit({ sessionId: sid('other'), lastMessageAt: 4 });
  await tick();
  expect(h.prefetcher.isPending(sid('large'))).toBe(true);
  h.coordinator.stop();
  await tick();
});

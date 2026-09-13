import { describe, it, expect } from 'vitest';
import { getSessionRoomId, type SessionId, type SessionStatus } from '@lody/shared';
import {
  createBackgroundSyncCoordinator,
  type BackgroundSyncCoordinatorDeps,
  type EagerSyncHighWaterStore,
  type EagerSyncPolicy,
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
  it('uses a bounded web policy, full desktop policy, and paced mobile policy', () => {
    expect(resolveEagerSyncPolicy('web')).toMatchObject({
      concurrency: 1,
      batchSize: 1,
      batchCooldownMs: 1_500,
      candidateWindow: 20,
    });
    expect(resolveEagerSyncPolicy('desktop')).toMatchObject({
      concurrency: 1,
      batchSize: 1,
      batchCooldownMs: 1_500,
      candidateWindow: Number.POSITIVE_INFINITY,
    });
    expect(resolveEagerSyncPolicy('mobile')).toMatchObject({
      concurrency: 1,
      batchSize: 1,
      batchCooldownMs: 3_000,
      candidateWindow: Number.POSITIVE_INFINITY,
    });
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

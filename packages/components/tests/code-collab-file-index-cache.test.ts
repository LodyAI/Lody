import { afterEach, describe, expect, it, vi } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import type { RepoRoomSubscription } from 'loro-repo';

import {
  createCodeCollabFileIndexCache,
  type CodeCollabFileIndexCache,
} from '../src/lib/code-collab-file-index-cache';

const caches: CodeCollabFileIndexCache[] = [];

afterEach(async () => {
  await Promise.all(caches.splice(0).map((cache) => cache.dispose()));
});

function syncedRoom(
  unsubscribe = vi.fn(),
  firstSyncedWithRemote: Promise<void> = Promise.resolve()
): RepoRoomSubscription {
  const binding = {
    transportId: 'cloud',
    status: 'joined' as const,
    onStatusChange: vi.fn(() => vi.fn()),
    firstSyncedWithRemote,
    waitUntilSynced: vi.fn(async () => undefined),
    rejoin: vi.fn(async () => undefined),
  };
  return {
    unsubscribe,
    firstSyncedWithRemote,
    waitUntilSynced: vi.fn(async () => undefined),
    transportIds: () => ['cloud'],
    subscription: () => binding,
    subscriptions: () => [binding],
  } as RepoRoomSubscription;
}

function versionedFlock(scan: () => unknown[], unsubscribe = vi.fn()): Flock {
  return {
    scan: vi.fn(scan),
    version: vi.fn(() => ({
      'test-peer': { physicalTime: 1, logicalCounter: 0 },
    })),
    subscribe: vi.fn(() => unsubscribe),
  } as unknown as Flock;
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('createCodeCollabFileIndexCache', () => {
  it('shares one cold scan and room across concurrent scoped borrowers', async () => {
    const flock = new Flock('file-index-cache-test');
    flock.set(['README.md'], { kind: 'text', change: { diff: [1, 0] } });
    flock.commit();
    const scan = vi.spyOn(flock, 'scan');
    const releaseRepoLease = vi.fn(async () => undefined);
    const acquireFlockDoc = vi.fn(async () => ({ flock, release: releaseRepoLease }));
    const joinFlockDocRoom = vi.fn(async () => syncedRoom());
    const unloadFlockDoc = vi.fn(async () => undefined);
    const cache = createCodeCollabFileIndexCache({
      acquireFlockDoc,
      joinFlockDocRoom,
      unloadFlockDoc,
    });
    caches.push(cache);

    const [first, second] = await Promise.all([
      cache.acquire('workspace:fi:session'),
      cache.acquire('workspace:fi:session'),
    ]);

    expect(acquireFlockDoc).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(joinFlockDocRoom).toHaveBeenCalledTimes(1);
    expect(first.resource).toBe(second.resource);
    expect(first.resource.getSnapshot()).toMatchObject({ status: 'ready' });

    await first.release();
    await second.release();

    const warm = await cache.acquire('workspace:fi:session');
    expect(acquireFlockDoc).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(1);
    await warm.release();

    await cache.dispose();
    expect(releaseRepoLease).toHaveBeenCalledTimes(1);
    expect(unloadFlockDoc).toHaveBeenCalledWith('workspace:fi:session');
  });

  it('evicts the least recently used inactive resource at capacity', async () => {
    const unloadedDocIds: string[] = [];
    const acquireFlockDoc = vi.fn(async (_flockDocId: string) => ({
      flock: versionedFlock(() => [], vi.fn()),
      release: async () => undefined,
    }));
    const cache = createCodeCollabFileIndexCache({
      acquireFlockDoc,
      joinFlockDocRoom: async () => syncedRoom(),
      unloadFlockDoc: async (flockDocId) => {
        unloadedDocIds.push(flockDocId);
      },
    });
    caches.push(cache);

    for (let index = 0; index < 9; index += 1) {
      const lease = await cache.acquire(`workspace:fi:session-${index}`);
      await lease.release();
    }

    expect(acquireFlockDoc).toHaveBeenCalledTimes(9);
    expect(unloadedDocIds).toContain('workspace:fi:session-0');
    expect(unloadedDocIds).not.toContain('workspace:fi:session-8');
  });

  it('keeps an active resource addressable while evicting inactive entries', async () => {
    const unloadedDocIds: string[] = [];
    const acquireFlockDoc = vi.fn(async (_flockDocId: string) => ({
      flock: versionedFlock(() => [], vi.fn()),
      release: async () => undefined,
    }));
    const cache = createCodeCollabFileIndexCache({
      acquireFlockDoc,
      joinFlockDocRoom: async () => syncedRoom(),
      unloadFlockDoc: async (flockDocId) => {
        unloadedDocIds.push(flockDocId);
      },
    });
    caches.push(cache);

    const pinned = await cache.acquire('workspace:fi:pinned');
    for (let index = 0; index < 8; index += 1) {
      const lease = await cache.acquire(`workspace:fi:other-${index}`);
      await lease.release();
    }

    expect(unloadedDocIds).not.toContain('workspace:fi:pinned');
    const samePinned = await cache.acquire('workspace:fi:pinned');
    expect(samePinned.resource).toBe(pinned.resource);
    expect(acquireFlockDoc).toHaveBeenCalledTimes(9);
    await samePinned.release();
    await pinned.release();
    expect(unloadedDocIds).not.toContain('workspace:fi:pinned');

    await cache.dispose();
    expect(unloadedDocIds).toContain('workspace:fi:pinned');
  });

  it('invalidates a failed Effect lookup so the next acquire can retry', async () => {
    const flock = versionedFlock(() => []);
    const acquireFlockDoc = vi
      .fn()
      .mockRejectedValueOnce(new Error('IndexedDB unavailable'))
      .mockResolvedValue({ flock, release: async () => undefined });
    const cache = createCodeCollabFileIndexCache({
      acquireFlockDoc,
      joinFlockDocRoom: async () => syncedRoom(),
      unloadFlockDoc: async () => undefined,
    });
    caches.push(cache);

    await expect(cache.acquire('workspace:fi:retry')).rejects.toThrow('IndexedDB unavailable');
    const retry = await cache.acquire('workspace:fi:retry');

    expect(acquireFlockDoc).toHaveBeenCalledTimes(2);
    await retry.release();
  });

  it('releases and unloads a partially initialized resource when its scan fails', async () => {
    const unsubscribe = vi.fn();
    const releaseRepoLease = vi.fn(async () => undefined);
    const unloadFlockDoc = vi.fn(async () => undefined);
    const flock = versionedFlock(() => {
      throw new Error('scan failed');
    }, unsubscribe);
    const cache = createCodeCollabFileIndexCache({
      acquireFlockDoc: async () => ({ flock, release: releaseRepoLease }),
      joinFlockDocRoom: async () => syncedRoom(),
      unloadFlockDoc,
    });
    caches.push(cache);

    await expect(cache.acquire('workspace:fi:broken-scan')).rejects.toThrow('scan failed');

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(releaseRepoLease).toHaveBeenCalledTimes(1);
    expect(unloadFlockDoc).toHaveBeenCalledWith('workspace:fi:broken-scan');
  });

  it('rebuilds an inactive resource after its room catchup fails', async () => {
    const firstSync = deferred();
    const acquireFlockDoc = vi.fn(async () => ({
      flock: versionedFlock(() => []),
      release: async () => undefined,
    }));
    const joinFlockDocRoom = vi
      .fn()
      .mockResolvedValueOnce(syncedRoom(vi.fn(), firstSync.promise))
      .mockResolvedValueOnce(syncedRoom());
    const unloadFlockDoc = vi.fn(async () => undefined);
    const cache = createCodeCollabFileIndexCache({
      acquireFlockDoc,
      joinFlockDocRoom,
      unloadFlockDoc,
    });
    caches.push(cache);

    const first = await cache.acquire('workspace:fi:remote-retry');
    const errorPublished = new Promise<void>((resolve) => {
      const unsubscribe = first.resource.subscribe(() => {
        if (first.resource.getSnapshot().status !== 'error') return;
        unsubscribe();
        resolve();
      });
    });
    firstSync.reject(new Error('remote unavailable'));
    await errorPublished;
    await first.release();

    const retry = await cache.acquire('workspace:fi:remote-retry');
    expect(acquireFlockDoc).toHaveBeenCalledTimes(2);
    expect(joinFlockDocRoom).toHaveBeenCalledTimes(2);
    expect(unloadFlockDoc).toHaveBeenCalledWith('workspace:fi:remote-retry');
    await retry.release();
  });

  it('unsubscribes and unloads a room that finishes joining after release', async () => {
    const roomReady = deferred<RepoRoomSubscription>();
    const lateUnsubscribe = vi.fn();
    const releaseRepoLease = vi.fn(async () => undefined);
    const unloadFlockDoc = vi.fn(async () => undefined);
    const cache = createCodeCollabFileIndexCache({
      acquireFlockDoc: async () => ({
        flock: versionedFlock(() => []),
        release: releaseRepoLease,
      }),
      joinFlockDocRoom: async () => await roomReady.promise,
      unloadFlockDoc,
    });
    caches.push(cache);

    const lease = await cache.acquire('workspace:fi:late-room');
    await lease.release();
    await cache.dispose();
    expect(unloadFlockDoc).toHaveBeenCalledTimes(1);

    roomReady.resolve(syncedRoom(lateUnsubscribe));
    await Promise.resolve();
    await Promise.resolve();

    expect(lateUnsubscribe).toHaveBeenCalledTimes(1);
    expect(releaseRepoLease).toHaveBeenCalledTimes(1);
    expect(unloadFlockDoc).toHaveBeenCalledTimes(2);
  });

  it('continues repo cleanup when a subscription finalizer throws', async () => {
    const releaseRepoLease = vi.fn(async () => undefined);
    const unloadFlockDoc = vi.fn(async () => undefined);
    const roomUnsubscribe = vi.fn();
    const cache = createCodeCollabFileIndexCache({
      acquireFlockDoc: async () => ({
        flock: versionedFlock(
          () => [],
          () => {
            throw new Error('flock unsubscribe failed');
          }
        ),
        release: releaseRepoLease,
      }),
      joinFlockDocRoom: async () => syncedRoom(roomUnsubscribe),
      unloadFlockDoc,
    });
    const lease = await cache.acquire('workspace:fi:cleanup-error');
    await lease.release();
    await expect(cache.dispose()).rejects.toThrow('flock unsubscribe failed');

    expect(roomUnsubscribe).toHaveBeenCalledTimes(1);
    expect(releaseRepoLease).toHaveBeenCalledTimes(1);
    expect(unloadFlockDoc).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight dispose completion across concurrent callers', async () => {
    const unloadStarted = deferred();
    const finishUnload = deferred();
    const cache = createCodeCollabFileIndexCache({
      acquireFlockDoc: async () => ({
        flock: versionedFlock(() => []),
        release: async () => undefined,
      }),
      joinFlockDocRoom: async () => syncedRoom(),
      unloadFlockDoc: async () => {
        unloadStarted.resolve();
        await finishUnload.promise;
      },
    });
    caches.push(cache);
    const lease = await cache.acquire('workspace:fi:concurrent-dispose');
    await lease.release();

    const firstDispose = cache.dispose();
    const secondDispose = cache.dispose();
    expect(secondDispose).toBe(firstDispose);
    await unloadStarted.promise;
    let secondSettled = false;
    void secondDispose.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    finishUnload.resolve();
    await Promise.all([firstDispose, secondDispose]);
  });
});

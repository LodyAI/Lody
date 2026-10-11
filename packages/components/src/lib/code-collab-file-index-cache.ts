import { Cause, Duration, Effect, Exit, Scope, ScopedCache } from 'effect';
import type { Flock } from '@loro-dev/flock-wasm';
import { ResourceBusyError, type RepoRoomSubscription } from 'loro-repo';
import {
  applyCodeCollabFileIndexFlockEvents,
  getServerNow,
  readCodeCollabFileIndexFromFlock,
  type CodeCollabV2FileIndexState,
} from '@lody/shared';
import {
  describeCodeCollabError,
  logCodeCollabInfo,
  warnCodeCollab,
} from '@/lib/code-collab-debug';
import { readinessBinding } from '@/lib/room-readiness';
import {
  flockVersionTokensEqual,
  readFlockVersionToken,
  type FlockVersionToken,
} from './flock-version';

const FILE_INDEX_CACHE_CAPACITY = 8;

export type CodeCollabFileIndexSnapshot = {
  readonly resourceKey: object;
  readonly fileIndex: CodeCollabV2FileIndexState;
  readonly revision: number;
  readonly updatedAtMs: number;
};

export type CodeCollabFileIndexLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly snapshot: CodeCollabFileIndexSnapshot }
  | { readonly status: 'error'; readonly error: unknown };

export type CodeCollabFileIndexResource = {
  getSnapshot(): CodeCollabFileIndexLoadState;
  subscribe(listener: () => void): () => void;
  seed(fileIndex: CodeCollabV2FileIndexState, updatedAtMs: number): void;
};

export type CodeCollabFileIndexCacheLease = {
  readonly resource: CodeCollabFileIndexResource;
  release(): Promise<void>;
};

export type CodeCollabFileIndexCache = {
  acquire(flockDocId: string): Promise<CodeCollabFileIndexCacheLease>;
  dispose(): Promise<void>;
};

export type CodeCollabFileIndexRuntimeRepo = {
  acquireFlockDoc: (flockDocId: string) => Promise<{
    readonly flock: Flock;
    readonly release: () => Promise<void>;
  }>;
  joinFlockDocRoom: (flockDocId: string) => Promise<RepoRoomSubscription>;
  unloadFlockDoc: (flockDocId: string) => Promise<void>;
};

type MutableFileIndexResource = CodeCollabFileIndexResource & {
  dispose(): Promise<void>;
};

async function openCodeCollabFileIndexResource(
  runtimeRepo: CodeCollabFileIndexRuntimeRepo,
  flockDocId: string,
  onSyncFailure: () => void
): Promise<MutableFileIndexResource> {
  logCodeCollabInfo('file-index flock open', { flockDocId });
  const repoLease = await runtimeRepo.acquireFlockDoc(flockDocId);
  const listeners = new Set<() => void>();
  const resourceKey = {};
  let state: CodeCollabFileIndexLoadState = { status: 'loading' };
  let currentFileIndex: CodeCollabV2FileIndexState = {};
  let materializedVersion: FlockVersionToken | null = null;
  let revision = 0;
  let remoteSynced = false;
  let disposed = false;
  let roomSubscription: RepoRoomSubscription | null = null;
  let unsubscribeFlock: (() => void) | null = null;

  const unloadReleasedReplica = async (): Promise<void> => {
    try {
      await runtimeRepo.unloadFlockDoc(flockDocId);
    } catch (error) {
      // Another repo lease may legitimately keep the same replica alive. This
      // cache has still released its ownership; that other owner now decides
      // the eviction boundary.
      if (error instanceof ResourceBusyError) return;
      throw error;
    }
  };

  const cleanupResource = async (): Promise<void> => {
    const errors: unknown[] = [];
    try {
      unsubscribeFlock?.();
    } catch (error) {
      errors.push(error);
    }
    unsubscribeFlock = null;
    try {
      roomSubscription?.unsubscribe();
    } catch (error) {
      errors.push(error);
    }
    roomSubscription = null;
    try {
      await repoLease.release();
    } catch (error) {
      errors.push(error);
    }
    try {
      await unloadReleasedReplica();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw errors[0];
    }
  };

  const publishState = (nextState: CodeCollabFileIndexLoadState): void => {
    if (disposed || state === nextState) return;
    state = nextState;
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        warnCodeCollab('file-index listener failed', {
          flockDocId,
          error: describeCodeCollabError(error),
        });
      }
    }
  };

  const publishFileIndex = (
    fileIndex: CodeCollabV2FileIndexState,
    options: { readonly allowEmpty: boolean; readonly updatedAtMs?: number }
  ): void => {
    currentFileIndex = fileIndex;
    if (!options.allowEmpty && Object.keys(fileIndex).length === 0) return;
    const previous = state.status === 'ready' ? state.snapshot.fileIndex : null;
    if (previous === fileIndex) return;
    revision += 1;
    publishState({
      status: 'ready',
      snapshot: {
        resourceKey,
        fileIndex,
        revision,
        updatedAtMs: options.updatedAtMs ?? getServerNow(),
      },
    });
  };

  // Subscribe before materializing the snapshot. Both calls are synchronous,
  // so no live event can fall into a scan/subscribe gap.
  try {
    unsubscribeFlock = repoLease.flock.subscribe((batch) => {
      if (disposed) return;
      const nextFileIndex = applyCodeCollabFileIndexFlockEvents(currentFileIndex, batch.events);
      materializedVersion = readFlockVersionToken(repoLease.flock);
      publishFileIndex(nextFileIndex, { allowEmpty: remoteSynced });
    });

    currentFileIndex = readCodeCollabFileIndexFromFlock(repoLease.flock);
    materializedVersion = readFlockVersionToken(repoLease.flock);
    publishFileIndex(currentFileIndex, { allowEmpty: false });
  } catch (error) {
    disposed = true;
    listeners.clear();
    try {
      await cleanupResource();
    } catch (cleanupError) {
      warnCodeCollab('file-index flock cleanup failed', {
        flockDocId,
        error: describeCodeCollabError(cleanupError),
      });
    }
    throw error;
  }

  void (async () => {
    const joined = await runtimeRepo.joinFlockDocRoom(flockDocId);
    if (disposed) {
      try {
        joined.unsubscribe();
      } finally {
        // A pending join can materialize the replica after dispose already
        // completed its first unload. Try once more after releasing that late
        // room interest. ResourceBusy means a newer legitimate owner won.
        await unloadReleasedReplica();
      }
      return;
    }
    roomSubscription = joined;
    await readinessBinding(joined).firstSyncedWithRemote;
    if (disposed) return;
    remoteSynced = true;

    const remoteVersion = readFlockVersionToken(repoLease.flock);
    if (!flockVersionTokensEqual(materializedVersion, remoteVersion)) {
      currentFileIndex = readCodeCollabFileIndexFromFlock(repoLease.flock);
      materializedVersion = remoteVersion;
    }
    publishFileIndex(currentFileIndex, { allowEmpty: true });
  })().catch((error: unknown) => {
    if (disposed) return;
    onSyncFailure();
    try {
      roomSubscription?.unsubscribe();
      roomSubscription = null;
    } catch (unsubscribeError) {
      warnCodeCollab('file-index room unsubscribe failed', {
        flockDocId,
        error: describeCodeCollabError(unsubscribeError),
      });
    }
    warnCodeCollab('file-index flock sync failed', {
      flockDocId,
      error: describeCodeCollabError(error),
    });
    publishState({ status: 'error', error });
  });

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    seed: (fileIndex, updatedAtMs) => {
      if (disposed) return;
      materializedVersion = readFlockVersionToken(repoLease.flock);
      publishFileIndex(fileIndex, { allowEmpty: true, updatedAtMs });
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      await cleanupResource();
    },
  };
}

export function createCodeCollabFileIndexCache(
  runtimeRepo: CodeCollabFileIndexRuntimeRepo
): CodeCollabFileIndexCache {
  const ownerScope = Effect.runSync(Scope.make());
  const borrowerScopes = new Set<Scope.Closeable>();
  const borrowerKeys = new Map<Scope.Closeable, string>();
  const borrowersByKey = new Map<string, Set<Scope.Closeable>>();
  const accessOrder = new Map<string, true>();
  const failedKeys = new Set<string>();
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  let evictionQueue = Promise.resolve();
  // v4 ScopedCache bulk release joins finalizer Exits without failing its owner.
  const ownerCleanupErrors: unknown[] = [];

  const cache = Effect.runSync(
    ScopedCache.make({
      // ScopedCache owns resource finalizers. Capacity is enforced below so an
      // actively borrowed key remains addressable instead of being reopened.
      capacity: Number.POSITIVE_INFINITY,
      timeToLive: Duration.infinity,
      lookup: (flockDocId: string) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              openCodeCollabFileIndexResource(runtimeRepo, flockDocId, () => {
                failedKeys.add(flockDocId);
              }),
            catch: (error) => error,
          }),
          (resource) =>
            Effect.promise(() => resource.dispose()).pipe(
              Effect.tapCause((cause) =>
                Effect.sync(() => {
                  if (disposed) ownerCleanupErrors.push(Cause.squash(cause));
                })
              )
            )
        ),
    }).pipe(Effect.provideService(Scope.Scope, ownerScope))
  );

  const touch = (flockDocId: string): void => {
    accessOrder.delete(flockDocId);
    accessOrder.set(flockDocId, true);
  };

  const maintainCache = async (recoverKey?: string): Promise<void> => {
    const recoveryKeys = recoverKey === undefined ? [...failedKeys] : [recoverKey];
    for (const flockDocId of recoveryKeys) {
      if (!failedKeys.has(flockDocId)) continue;
      if ((borrowersByKey.get(flockDocId)?.size ?? 0) > 0) continue;
      failedKeys.delete(flockDocId);
      accessOrder.delete(flockDocId);
      await Effect.runPromise(ScopedCache.invalidate(cache, flockDocId));
    }

    while (accessOrder.size > FILE_INDEX_CACHE_CAPACITY) {
      let candidate: string | undefined;
      for (const flockDocId of accessOrder.keys()) {
        if ((borrowersByKey.get(flockDocId)?.size ?? 0) === 0) {
          candidate = flockDocId;
          break;
        }
      }
      // Active resources may temporarily exceed capacity. Their Scope is the
      // authority; releasing one schedules another eviction pass.
      if (candidate === undefined) return;
      accessOrder.delete(candidate);
      failedKeys.delete(candidate);
      await Effect.runPromise(ScopedCache.invalidate(cache, candidate));
    }
  };

  const scheduleMaintenance = (recoverKey?: string): Promise<void> => {
    const next = evictionQueue.then(() => maintainCache(recoverKey));
    evictionQueue = next.catch(() => undefined);
    return next;
  };

  const closeScope = async (scope: Scope.Closeable): Promise<void> => {
    if (!borrowerScopes.delete(scope)) return;
    const flockDocId = borrowerKeys.get(scope);
    try {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    } finally {
      borrowerKeys.delete(scope);
      if (flockDocId !== undefined) {
        const keyBorrowers = borrowersByKey.get(flockDocId);
        keyBorrowers?.delete(scope);
        if (keyBorrowers?.size === 0) borrowersByKey.delete(flockDocId);
      }
    }
  };

  return {
    acquire: async (flockDocId) => {
      if (disposed) throw new Error('Code Collab file-index cache is disposed.');
      await scheduleMaintenance(flockDocId);
      if (disposed) throw new Error('Code Collab file-index cache is disposed.');
      const borrowerScope = Effect.runSync(Scope.make());
      borrowerScopes.add(borrowerScope);
      borrowerKeys.set(borrowerScope, flockDocId);
      const keyBorrowers = borrowersByKey.get(flockDocId) ?? new Set<Scope.Closeable>();
      keyBorrowers.add(borrowerScope);
      borrowersByKey.set(flockDocId, keyBorrowers);
      let resource: MutableFileIndexResource;
      try {
        resource = await Effect.runPromise(
          ScopedCache.get(cache, flockDocId).pipe(Effect.provideService(Scope.Scope, borrowerScope))
        );
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        try {
          await closeScope(borrowerScope);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        try {
          await Effect.runPromise(ScopedCache.invalidate(cache, flockDocId));
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        for (const cleanupError of cleanupErrors) {
          warnCodeCollab('file-index failed lookup cleanup failed', {
            flockDocId,
            error: describeCodeCollabError(cleanupError),
          });
        }
        throw error;
      }
      try {
        if (disposed) {
          await closeScope(borrowerScope);
          throw new Error('Code Collab file-index cache was disposed during acquisition.');
        }
        touch(flockDocId);
        await scheduleMaintenance();
        if (disposed) {
          await closeScope(borrowerScope);
          throw new Error('Code Collab file-index cache was disposed during acquisition.');
        }
        let releasePromise: Promise<void> | null = null;
        return {
          resource,
          release: () => {
            if (releasePromise) return releasePromise;
            releasePromise = (async () => {
              await closeScope(borrowerScope);
              if (!disposed) await scheduleMaintenance();
            })();
            return releasePromise;
          },
        };
      } catch (error) {
        await closeScope(borrowerScope);
        throw error;
      }
    },
    dispose: () => {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = (async () => {
        await evictionQueue;
        const errors: unknown[] = [];
        try {
          await Promise.all([...borrowerScopes].map(closeScope));
        } catch (error) {
          errors.push(error);
        }
        try {
          await Effect.runPromise(Scope.close(ownerScope, Exit.void));
        } catch (error) {
          errors.push(error);
        } finally {
          borrowerKeys.clear();
          borrowersByKey.clear();
          accessOrder.clear();
          failedKeys.clear();
        }
        errors.push(...ownerCleanupErrors);
        if (errors.length > 0) throw errors[0];
      })();
      return disposePromise;
    },
  };
}

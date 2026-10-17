import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { Cause, Deferred, Effect, Exit, Fiber, Scope, Stream, SubscriptionRef } from 'effect';
import type { RoomState, RoomStatus, TransportStatus } from 'loro-repo/effect';
import { acquireWorkspaceScope } from '@lody/shared/workspace-data/ownership';
import { RepoDocAlreadyExists, RepoIOError, RepoReleaseFailed } from 'loro-repo/effect';
import { IndexedDBStorageAdaptor } from 'loro-repo/storage/indexeddb';
import { make as makeWorkspaceRepo } from 'loro-repo/effect';
import {
  WorkspaceRepoLegacy,
  WorkspaceRepoLegacyFailure,
  workspaceSyncFailuresLegacy,
} from '@lody/shared/workspace-data/repo-legacy';
import { createLoroSyncErrorTools, getLoroSnapshotDiagnostic } from '@lody/shared/loro-sync-errors';
import { RepoSyncError, RepoTransportError } from 'loro-repo';
import { createManagedStoreCache } from '../src/providers/store-ref-tracker';
import { createRoomSyncTracker } from '../src/providers/room-sync-tracker';

let sequence = 0;
const storage = () =>
  new IndexedDBStorageAdaptor({ dbName: `native-workspace-repo-${++sequence}` });

describe('native workspace Repo ownership', () => {
  it('separates absent identity from explicit creation and rejects duplicate creation', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeWorkspaceRepo();
          expect(yield* repo.openDoc('missing')).toBeUndefined();
          const created = yield* repo.createDoc('session-a', { title: 'created' });
          created.doc.getText('body').insert(0, 'local');
          created.doc.commit();
          const opened = yield* repo.openDoc('session-a');
          expect(opened?.doc).toBe(created.doc);
          const duplicate = yield* repo.createDoc('session-a', {}).pipe(Effect.flip);
          expect(duplicate).toBeInstanceOf(RepoDocAlreadyExists);
          expect((yield* repo.getDocMeta('session-a'))?.meta.title).toBe('created');
        })
      )
    );
  });

  it('keeps another borrower alive and saves before the last lease is released', async () => {
    const adapter = storage();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeWorkspaceRepo({ storageAdapter: adapter });
          yield* repo.upsertDocMeta('session-a', { title: 'shared' });
          const parent = yield* Effect.scope;
          const a = yield* Scope.fork(parent);
          const b = yield* Scope.fork(parent);
          const left = yield* repo.openDoc('session-a').pipe(Effect.provideService(Scope.Scope, a));
          const right = yield* repo
            .openDoc('session-a')
            .pipe(Effect.provideService(Scope.Scope, b));
          expect(left?.doc).toBe(right?.doc);
          left?.doc.getText('body').insert(0, 'one');
          left?.doc.commit();
          yield* Scope.close(a, Exit.void);
          right?.doc.getText('body').insert(3, ' two');
          right?.doc.commit();
          yield* Scope.close(b, Exit.void);
          const reopened = yield* repo.openDoc('session-a');
          expect(reopened?.doc).not.toBe(left?.doc);
          expect(reopened?.doc.getText('body').toString()).toBe('one two');
          expect(reopened?.source).toBe('storage');
        })
      )
    );
  });

  it('preserves storage load failures rather than manufacturing an empty document', async () => {
    const adapter = storage();
    const failure = new Error('synthetic IndexedDB read failure');
    adapter.loadDoc = async () => {
      throw failure;
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeWorkspaceRepo({ storageAdapter: adapter });
          yield* repo.upsertDocMeta('session-a', { title: 'retained' });
          const exit = yield* Effect.scoped(repo.openDoc('session-a')).pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(
              exit.cause.reasons.some(
                (reason) =>
                  Cause.isFailReason(reason) &&
                  reason.error instanceof RepoIOError &&
                  reason.error.failure === failure
              )
            ).toBe(true);
          }
          expect((yield* repo.getDocMeta('session-a'))?.meta.title).toBe('retained');
        })
      )
    );
  });

  it('observes a coherent snapshot and every subsequent metadata change', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeWorkspaceRepo();
          yield* repo.upsertDocMeta('session-a', { title: 'before' });
          const observation = yield* repo.observeDocs();
          expect(observation.snapshot[0]?.meta.title).toBe('before');
          const received = yield* Deferred.make<void>();
          const consumer = yield* observation.changes.pipe(
            Stream.runForEach(({ event }) => {
              if (event.kind === 'doc-metadata' && event.patch.title === 'after')
                return Deferred.succeed(received, undefined);
              return Effect.void;
            }),
            Effect.forkScoped
          );
          yield* repo.upsertDocMeta('session-a', { title: 'after' });
          yield* Deferred.await(received);
          yield* Fiber.interrupt(consumer);
        })
      )
    );
  });

  it('the compatibility door shares native leases and persists through real IndexedDB', async () => {
    const adapter = storage();
    const repo = await WorkspaceRepoLegacy.create({ storageAdapter: adapter });
    const lease = await repo.acquireDoc('session-a');
    const handle = await repo.openPersistedDoc('session-a');
    expect(handle.doc).toBe(lease.doc);
    lease.doc.getText('body').insert(0, 'retained');
    lease.doc.commit();
    await repo.unloadDoc('session-a');
    lease.doc.getText('body').insert(8, ' borrower');
    lease.doc.commit();
    await lease.release();
    expect((await repo.openPersistedDoc('session-a')).doc.getText('body').toString()).toBe(
      'retained borrower'
    );
    await repo.destroy();
    await repo.destroy();
  });
});

describe('retained native release ownership', () => {
  it.each(['document', 'storage'] as const)(
    'reopens a Legacy store throughout a persistent %s save failure',
    async (failureScope) => {
      const adapter = storage();
      const save = adapter.save.bind(adapter);
      let blocked = false;
      adapter.save = async (payload) => {
        if (
          blocked &&
          (failureScope === 'storage' || ('docId' in payload && payload.docId === 'quota'))
        )
          throw new DOMException('synthetic quota', 'QuotaExceededError');
        await save(payload);
      };
      const repo = await WorkspaceRepoLegacy.create({ storageAdapter: adapter });
      const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cache = createManagedStoreCache({
        releaseDelayMs: 0,
        create: async (id: string) => {
          const handle = await repo.acquireDocHandleLegacy(id);
          return { doc: handle.doc, dispose: handle.release };
        },
        unload: (id) => repo.unloadDoc(id),
      });
      try {
        let store = await cache.acquire('quota');
        const original = store.doc;
        blocked = true;
        for (const text of ['one', ' two', ' three']) {
          store.doc.getText('body').insert(store.doc.getText('body').length, text);
          store.doc.commit();
          await cache.release('quota');
          const [left, right] = await Promise.all([cache.acquire('quota'), cache.acquire('quota')]);
          expect(left).toBe(right);
          expect(left.doc).toBe(original);
          store = left;
          const sibling = await cache.acquire('healthy');
          sibling.doc.getMap('state').set('available', true);
          sibling.doc.commit();
          await cache.release('healthy');
          if (failureScope === 'document')
            expect((await adapter.loadDoc('healthy'))?.getMap('state').get('available')).toBe(true);
          else
            expect((await cache.acquire('healthy')).doc.getMap('state').get('available')).toBe(
              true
            );
        }
        expect(store.doc.getText('body').toString()).toBe('one two three');
        blocked = false;
        await cache.release('healthy');
        await repo.unloadDoc('healthy');
        await cache.release('quota');
        expect((await adapter.loadDoc('quota'))?.getText('body').toString()).toBe('one two three');
        expect((await cache.acquire('quota')).doc).not.toBe(original);
      } finally {
        blocked = false;
        await cache.disposeAll();
        await repo.destroy();
        warnings.mockRestore();
      }
    }
  );

  it('keeps SDK recovery dependencies alive while another workspace remains usable', async () => {
    const adapter = storage();
    let blocked = true;
    let producerOpen = true;
    let closed = false;
    const close = adapter.close.bind(adapter);
    adapter.close = async () => {
      await close();
      closed = true;
    };
    const repo = await WorkspaceRepoLegacy.create({ storageAdapter: adapter });
    const closeProducer: Effect.Effect<void, RepoReleaseFailed> = Effect.suspend(() =>
      blocked
        ? Effect.fail(
            new RepoReleaseFailed(
              'private SDK producer',
              Cause.fail(new RepoIOError('unfinished stream', undefined)),
              closeProducer
            )
          )
        : Effect.sync(() => {
            producerOpen = false;
          })
    );
    const owner = await repo.acquireScopeLegacy('private SDK room');
    await repo.runLegacy(
      Effect.addFinalizer(() => closeProducer.pipe(Effect.orDie)).pipe(
        Effect.provideService(Scope.Scope, owner.scope)
      )
    );
    try {
      await expect(repo.destroy()).rejects.toBeInstanceOf(RepoReleaseFailed);
      expect({ producerOpen, closed }).toEqual({ producerOpen: true, closed: false });
      const otherStorage = storage();
      const other = await WorkspaceRepoLegacy.create({ storageAdapter: otherStorage });
      try {
        const handle = await other.acquireDocHandleLegacy('independent');
        handle.doc.getText('body').insert(0, 'available');
        handle.doc.commit();
        await handle.release();
        await other.unloadDoc('independent');
        expect((await otherStorage.loadDoc('independent'))?.getText('body').toString()).toBe(
          'available'
        );
      } finally {
        await other.destroy();
      }
      blocked = false;
      await repo.destroy();
      expect({ producerOpen, closed }).toEqual({ producerOpen: false, closed: true });
    } finally {
      blocked = false;
      await repo.destroy();
    }
  });

  it('bounds Legacy eviction waits without abandoning a hung save or fencing another view', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const adapter = storage();
    const save = adapter.save.bind(adapter);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let saving = false;
    adapter.save = async (payload) => {
      if ('docId' in payload && payload.docId === 'slow') {
        saving = true;
        entered.resolve();
        await finish.promise;
        await save(payload);
        saving = false;
        return;
      }
      await save(payload);
    };
    const repo = await WorkspaceRepoLegacy.create({
      storageAdapter: adapter,
      releaseTimeoutMs: 50,
    });
    const cache = createManagedStoreCache({
      releaseDelayMs: 0,
      create: async (id: string) => {
        const handle = await repo.acquireDocHandleLegacy(id);
        return { doc: handle.doc, dispose: handle.release };
      },
      unload: (id) => repo.unloadDoc(id),
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = await cache.acquire('slow');
      first.doc.getText('body').insert(0, 'accepted');
      first.doc.commit();
      const releasing = cache.release('slow');
      await entered.promise;
      await vi.advanceTimersByTimeAsync(50);
      await releasing;
      expect(saving).toBe(true);
      const reopened = await cache.acquire('slow');
      expect(reopened.doc).toBe(first.doc);
      expect(reopened.doc.getText('body').toString()).toBe('accepted');
      finish.resolve();
      await cache.release('slow');
      expect((await adapter.loadDoc('slow'))?.getText('body').toString()).toBe('accepted');
    } finally {
      finish.resolve();
      await cache.disposeAll();
      await repo.destroy();
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it('bounds Flock eviction without abandoning accepted storage I/O or retiring the replica', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const adapter = storage();
    const saveMany = adapter.saveMany.bind(adapter);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let saving = false;
    adapter.saveMany = async (payloads) => {
      if (payloads.some((payload) => 'flockDocId' in payload && payload.flockDocId === 'slow')) {
        saving = true;
        entered.resolve();
        await finish.promise;
        await saveMany(payloads);
        saving = false;
        return;
      }
      await saveMany(payloads);
    };
    const repo = await WorkspaceRepoLegacy.create({
      storageAdapter: adapter,
      releaseTimeoutMs: 50,
    });
    try {
      const first = await repo.acquireFlockDocHandleLegacy('slow');
      first.flock.set(['body'], 'accepted');
      first.flock.commit();
      await first.release();
      const eviction = repo.unloadFlockDoc('slow').then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error })
      );
      await entered.promise;
      await vi.advanceTimersByTimeAsync(50);
      expect((await eviction).status).toBe('rejected');
      expect(saving).toBe(true);
      const reopened = await repo.acquireFlockDocHandleLegacy('slow');
      expect(reopened.flock).toBe(first.flock);
      expect(reopened.flock.get(['body'])).toBe('accepted');
      reopened.flock.set(['body'], 'accepted and retained');
      reopened.flock.commit();
      finish.resolve();
      await reopened.release();
      await repo.unloadFlockDoc('slow');
      expect(saving).toBe(false);
      expect((await adapter.loadFlockDoc('slow'))?.get(['body'])).toBe('accepted and retained');
    } finally {
      finish.resolve();
      await repo.destroy();
      vi.useRealTimers();
    }
  });

  it.each(['make', 'connect'] as const)(
    'removes a transport during %s and keeps a same-name successor alive after late completion',
    async (stage) => {
      const repo = await WorkspaceRepoLegacy.create({});
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const resources = new Set<string>();
      const pause = Effect.promise(() => {
        entered.resolve();
        return release.promise;
      }).pipe(Effect.uninterruptible);
      const added = repo
        .addTransport('cloud', {
          kind: 'native-workspace-transport',
          make: (id) =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => resources.add('old')),
                () =>
                  Effect.sync(() => {
                    resources.delete('old');
                  })
              );
              if (stage === 'make') yield* pause;
              return {
                id,
                authority: 'server' as const,
                connect: stage === 'connect' ? pause : Effect.void,
                disconnect: Effect.void,
                join: () =>
                  Effect.gen(function* () {
                    return {
                      status: yield* SubscriptionRef.make<RoomStatus>('synced'),
                      close: Effect.void,
                      sync: Effect.succeed('confirmed' as const),
                    };
                  }),
              };
            }),
        })
        .then(
          () => 'attached',
          () => 'cancelled'
        );
      try {
        await entered.promise;
        const removed = repo.removeTransport('cloud');
        if (stage === 'connect') release.resolve();
        await removed;
        await repo.addTransport('cloud', {
          kind: 'native-workspace-transport',
          make: (id) =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => resources.add('new')),
                () =>
                  Effect.sync(() => {
                    resources.delete('new');
                  })
              );
              return {
                id,
                connect: Effect.void,
                disconnect: Effect.void,
                join: () =>
                  Effect.gen(function* () {
                    return {
                      status: yield* SubscriptionRef.make<RoomStatus>('synced'),
                      close: Effect.void,
                      sync: Effect.succeed('confirmed' as const),
                    };
                  }),
              };
            }),
        });
        // During construction, let the old make finish only after its successor exists.
        release.resolve();
        expect(await added).toBe('cancelled');
        expect(resources).toEqual(new Set(['new']));
        expect(await repo.runLegacy(repo.native.transportIds)).toEqual(['cloud']);
      } finally {
        release.resolve();
        await added;
        await repo.destroy();
      }
      expect(resources.size).toBe(0);
    }
  );

  it('retries a failed transport release on the next add without blocking a sibling', async () => {
    const repo = await WorkspaceRepoLegacy.create({});
    let fail = true;
    const specification = {
      kind: 'native-workspace-transport' as const,
      make: (id: string) =>
        Effect.succeed({
          id,
          connect: Effect.void,
          disconnect: Effect.suspend(() =>
            fail && id === 'cloud'
              ? Effect.fail(new RepoIOError('temporary disconnect failure', undefined))
              : Effect.void
          ),
          join: () =>
            Effect.gen(function* () {
              return {
                status: yield* SubscriptionRef.make<RoomStatus>('synced'),
                close: Effect.void,
                sync: Effect.succeed('confirmed' as const),
              };
            }),
        }),
    };
    try {
      await repo.addTransport('cloud', specification);
      await repo.addTransport('sibling', specification);
      await expect(repo.removeTransport('cloud')).rejects.toBeInstanceOf(RepoReleaseFailed);
      await repo.removeTransport('sibling');
      expect(await repo.runLegacy(repo.native.transportIds)).toEqual([]);
      fail = false;
      await repo.addTransport('cloud', specification);
      expect(await repo.runLegacy(repo.native.transportIds)).toEqual(['cloud']);
      expect(repo.hasTransport()).toBe(true);
    } finally {
      fail = false;
      await repo.destroy();
    }
  });

  it.each(['confirmed', 'offline'] as const)(
    'requires a peer protocol receipt (%s)',
    async (outcome) => {
      const repo = await WorkspaceRepoLegacy.create({});
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let delivered = '';
      try {
        await repo.addTransport('peer', {
          kind: 'native-workspace-transport',
          make: (id) =>
            Effect.succeed({
              id,
              authority: 'peer',
              connect: Effect.void,
              disconnect: Effect.void,
              join: (_target, replica) =>
                Effect.gen(function* () {
                  return {
                    status: yield* SubscriptionRef.make<RoomStatus>('synced'),
                    state: yield* SubscriptionRef.make<RoomState>({
                      connection: 'joined',
                      baseline: true,
                      current: true,
                      uploadPending: false,
                      epoch: 1,
                    }),
                    close: Effect.void,
                    sync: Effect.promise(async () => {
                      entered.resolve();
                      await release.promise;
                      if (outcome === 'confirmed' && replica.kind === 'doc')
                        delivered = replica.lease.doc.getText('body').toString();
                      return outcome;
                    }),
                  };
                }),
            }),
        });
        const room = await repo.joinDocRoom('handoff');
        await room.subscription('peer').firstSyncedWithRemote;
        const doc = (await repo.openPersistedDoc('handoff')).doc;
        doc.getText('body').insert(0, 'new write');
        doc.commit();
        let settled = false;
        const synced = room
          .subscription('peer')
          .waitUntilSynced()
          .then(
            () => {
              settled = true;
              return 'confirmed';
            },
            () => {
              settled = true;
              return 'unconfirmed';
            }
          );
        await entered.promise;
        expect(settled).toBe(false);
        release.resolve();
        expect(await synced).toBe(outcome === 'confirmed' ? 'confirmed' : 'unconfirmed');
        expect(delivered).toBe(outcome === 'confirmed' ? 'new write' : '');
        room.unsubscribe();
      } finally {
        release.resolve();
        await repo.destroy();
      }
    }
  );

  it.each(['acked', 'offline', 'unsupported'] as const)(
    'requires a captured server write receipt even when room status stays synced (%s)',
    async (outcome) => {
      const repo = await WorkspaceRepoLegacy.create({});
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let captured: unknown;
      try {
        await repo.addTransport('cloud', {
          kind: 'native-workspace-transport',
          make: (id) =>
            Effect.succeed({
              id,
              authority: 'server',
              connect: Effect.void,
              disconnect: Effect.void,
              join: () =>
                Effect.gen(function* () {
                  return {
                    status: yield* SubscriptionRef.make<RoomStatus>('synced'),
                    close: Effect.void,
                    sync: Effect.succeed('confirmed' as const),
                    ...(outcome === 'unsupported'
                      ? {}
                      : {
                          awaitUploaded: (version: Record<string, unknown>) =>
                            Effect.promise(async () => {
                              captured = version;
                              entered.resolve();
                              await release.promise;
                              return outcome;
                            }),
                        }),
                  };
                }),
            }),
        });
        const room = await repo.joinDocRoom('upload');
        await repo.runLegacy(room.native.awaitSynced('cloud'));
        const doc = (await repo.openPersistedDoc('upload')).doc;
        doc.getText('body').insert(0, 'new write');
        doc.commit();
        const version = Object.fromEntries(doc.version().toJSON());
        const uploaded = room
          .subscription('cloud')
          .waitUntilSynced()
          .then(
            () => 'acked',
            () => 'unconfirmed'
          );
        if (outcome !== 'unsupported') {
          expect(await Promise.race([uploaded, entered.promise.then(() => 'uploading')])).toBe(
            'uploading'
          );
          expect(captured).toEqual(version);
          release.resolve();
        }
        expect(await uploaded).toBe(outcome === 'acked' ? 'acked' : 'unconfirmed');
        room.unsubscribe();
      } finally {
        release.resolve();
        await repo.destroy();
      }
    }
  );

  it('closes storage after a background observer fails without poisoning shutdown', async () => {
    const adapter = storage();
    const repo = await WorkspaceRepoLegacy.create({ storageAdapter: adapter });
    const reported = Promise.withResolvers<void>();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => reported.resolve());
    const failure = new Error('synthetic private observer failure');
    const watch = repo.watch(() => {
      throw failure;
    });
    try {
      await repo.upsertDocMeta('observed', { title: 'retained' });
      await reported.promise;
      expect((await repo.getDocMeta('observed'))?.meta.title).toBe('retained');
      await expect(repo.destroy()).resolves.toBeUndefined();
      await expect(adapter.loadDoc('observed')).rejects.toThrow();
    } finally {
      watch.unsubscribe();
      warning.mockRestore();
      await repo.destroy();
    }
  });
  it('keeps an unrouted room detached and its first-sync waiter alive until attachment', async () => {
    const repo = await WorkspaceRepoLegacy.create({});
    try {
      const room = await repo.joinMetaRoom();
      const binding = room.subscription('streams');
      expect(binding.status).toBe('detached');
      const firstSync = binding.firstSyncedWithRemote;
      await repo.addTransport('streams', {
        kind: 'native-workspace-transport',
        make: (id) =>
          Effect.gen(function* () {
            return {
              id,
              authority: 'server' as const,
              status: yield* SubscriptionRef.make<TransportStatus>('online'),
              connect: Effect.void,
              disconnect: Effect.void,
              join: () =>
                Effect.gen(function* () {
                  return {
                    status: yield* SubscriptionRef.make<RoomStatus>('synced'),
                    state: yield* SubscriptionRef.make<RoomState>({
                      connection: 'joined',
                      baseline: true,
                      current: true,
                      uploadPending: false,
                      epoch: 1,
                    }),
                    close: Effect.void,
                    sync: Effect.succeed('confirmed' as const),
                  };
                }),
            };
          }),
      });
      await firstSync;
      expect(binding.status).toBe('joined');
      await repo.removeTransport('streams');
      expect(binding.status).toBe('detached');
    } finally {
      await repo.destroy();
    }
  });

  it('rejects a first-sync waiter when the native room fails instead of waiting forever', async () => {
    const repo = await WorkspaceRepoLegacy.create({});
    try {
      await repo.addTransport('broken', {
        kind: 'native-workspace-transport',
        make: (id) =>
          Effect.gen(function* () {
            return {
              id,
              authority: 'server' as const,
              status: yield* SubscriptionRef.make<TransportStatus>('online'),
              connect: Effect.void,
              disconnect: Effect.void,
              join: () => Effect.fail(new RepoIOError('synthetic failed join', undefined)),
            };
          }),
      });
      const room = await repo.joinDocRoom('unavailable');
      await expect(room.subscription('broken').firstSyncedWithRemote).rejects.toBeInstanceOf(
        RepoIOError
      );
      room.unsubscribe();
    } finally {
      await repo.destroy();
    }
  });
  it.each([
    { status: 'online', force: true, authority: 'peer' },
    { status: 'offline', force: false, authority: 'server' },
    { status: 'closed', force: false, authority: 'server' },
    { status: 'failed', force: false, authority: 'server' },
  ] as const)(
    'resets the $authority connection for transport $status, force=$force',
    async ({ status, force, authority }) => {
      const repo = await WorkspaceRepoLegacy.create({});
      try {
        const doc = (await repo.openPersistedDoc('transport-recovery')).doc;
        await repo.addTransport('cloud', {
          kind: 'native-workspace-transport',
          make: (id) =>
            Effect.gen(function* () {
              const physical = yield* SubscriptionRef.make<TransportStatus>(status);
              return {
                id,
                status: physical,
                authority,
                connect: Effect.void,
                disconnect: Effect.void,
                reconnect: Effect.gen(function* () {
                  doc.getText('body').insert(0, 'connection recovered');
                  doc.commit();
                  yield* SubscriptionRef.set(physical, 'online');
                }),
                join: () =>
                  Effect.gen(function* () {
                    return {
                      status: yield* SubscriptionRef.make<RoomStatus>('synced'),
                      close: Effect.void,
                      sync: Effect.succeed('confirmed' as const),
                    };
                  }),
              };
            }),
        });
        const room = await repo.joinDocRoom('transport-recovery');
        await repo.runLegacy(room.native.awaitSynced('cloud'));
        expect(doc.getText('body').toString()).toBe('');
        const report = await repo.reconnect({ transportIds: ['cloud'], resetBackoff: force });
        expect(report.ok).toBe(true);
        expect(doc.getText('body').toString()).toBe('connection recovered');
        expect((await repo.openPersistedDoc('transport-recovery')).doc).toBe(doc);
        room.unsubscribe();
      } finally {
        await repo.destroy();
      }
    }
  );

  it.each([false, true])(
    'isolates online server room repair, resetBackoff=%s',
    async (resetBackoff) => {
      const repo = await WorkspaceRepoLegacy.create({});
      const healthy = await repo.runLegacy(SubscriptionRef.make<RoomStatus>('synced'));
      const broken = await repo.runLegacy(SubscriptionRef.make<RoomStatus>('synced'));
      const connection = await repo.runLegacy(SubscriptionRef.make<TransportStatus>('online'));
      let unavailable = false;
      let generation = 1;
      let uploaded = '';
      try {
        await repo.addTransport('cloud', {
          kind: 'native-workspace-transport',
          make: (id) =>
            Effect.succeed({
              id,
              authority: 'server',
              connect: Effect.void,
              disconnect: Effect.void,
              status: connection,
              reconnect: Effect.gen(function* () {
                generation++;
                yield* SubscriptionRef.set(healthy, 'offline');
              }),
              join: (target, replica) =>
                Effect.sync(() => {
                  const problem = target.kind === 'doc' && target.id === 'problem';
                  return {
                    status: problem ? broken : healthy,
                    close: Effect.void,
                    sync: Effect.gen(function* () {
                      if (problem && unavailable)
                        return yield* Effect.fail(new RepoIOError('synthetic room 403', undefined));
                      if (problem && replica.kind === 'doc') {
                        uploaded = replica.lease.doc.getText('body').toString();
                        yield* SubscriptionRef.set(broken, 'synced');
                      }
                      return 'confirmed' as const;
                    }),
                  };
                }),
            }),
        });
        const sibling = await repo.joinDocRoom('healthy');
        const room = await repo.joinDocRoom('problem');
        await repo.runLegacy(sibling.native.awaitSynced('cloud'));
        await repo.runLegacy(room.native.awaitSynced('cloud'));
        const doc = (await repo.openPersistedDoc('problem')).doc;
        doc.getText('body').insert(0, 'pending upload');
        doc.commit();
        unavailable = true;
        await repo.runLegacy(SubscriptionRef.set(broken, 'failed'));
        await repo.runLegacy(
          room.native.status('cloud').pipe(
            Stream.filter((status) => status === 'failed'),
            Stream.take(1),
            Stream.runDrain
          )
        );
        await repo.reconnect({ transportIds: ['cloud'], resetBackoff });
        expect(uploaded).toBe('');
        expect(await repo.runLegacy(sibling.native.statusSnapshot('cloud'))).toBe('synced');
        expect(generation).toBe(1);
        unavailable = false;
        await repo.reconnect({ transportIds: ['cloud'], resetBackoff });
        expect(uploaded).toBe('pending upload');
        expect(await repo.runLegacy(room.native.statusSnapshot('cloud'))).toBe('synced');
        expect(generation).toBe(1);
        room.unsubscribe();
        sibling.unsubscribe();
      } finally {
        await repo.destroy();
      }
    }
  );

  it('native reconnect retries a failed room attach and retains the shared replica', async () => {
    const repo = await WorkspaceRepoLegacy.create({});
    const tracker = createRoomSyncTracker('retry');
    const synced = Promise.withResolvers<void>();
    const stop = tracker.subscribeSyncState((state) => {
      if (state === 'synced') synced.resolve();
    });
    let unavailable = true;
    try {
      await repo.addTransport('cloud', {
        kind: 'native-workspace-transport',
        make: (id) =>
          Effect.succeed({
            id,
            authority: 'server',
            connect: Effect.void,
            disconnect: Effect.void,
            join: (_target, replica) =>
              Effect.gen(function* () {
                if (replica.kind === 'doc') {
                  if (unavailable)
                    return yield* Effect.fail(new RepoIOError('temporary join failure', undefined));
                  replica.lease.doc.getText('body').insert(0, 'recovered');
                  replica.lease.doc.commit();
                }
                return {
                  state: yield* SubscriptionRef.make<RoomState>({
                    connection: 'joined',
                    baseline: true,
                    current: true,
                    uploadPending: false,
                    epoch: 1,
                  }),
                  status: yield* SubscriptionRef.make<RoomStatus>('synced'),
                  close: Effect.void,
                  sync: Effect.succeed('confirmed' as const),
                };
              }),
          }),
      });
      const doc = (await repo.openPersistedDoc('retry')).doc;
      const room = await repo.joinDocRoom('retry');
      const binding = room.subscription('cloud');
      tracker.attach(binding);
      const originalWait = binding.firstSyncedWithRemote;
      const originalFailure = await originalWait.then(
        () => {
          throw new Error('Expected the initial join to fail');
        },
        (error: unknown) => error
      );
      expect(originalFailure).toBeInstanceOf(RepoIOError);
      tracker.markFirstSyncFailed();
      expect(doc.getText('body').toString()).toBe('');
      unavailable = false;
      const report = await repo.reconnect({ transportIds: ['cloud'], resetBackoff: false });
      expect(report.ok).toBe(true);
      await repo.runLegacy(room.native.awaitSynced('cloud'));
      await expect(binding.firstSyncedWithRemote).resolves.toBeUndefined();
      await synced.promise;
      expect(tracker.getSyncState()).toBe('synced');
      expect(tracker.needsReconnect()).toBe(false);
      expect(room.subscription('cloud')).toBe(binding);
      await expect(originalWait).rejects.toBe(originalFailure);
      expect(doc.getText('body').toString()).toBe('recovered');
      expect((await repo.openPersistedDoc('retry')).doc).toBe(doc);
      await repo.runLegacy(
        Effect.scoped(
          Effect.gen(function* () {
            yield* repo.native.acquireRoom({ kind: 'doc', id: 'native-only' });
            expect(
              repo
                .transportRooms('cloud')
                .some(({ target }) => target.kind === 'doc' && target.id === 'native-only')
            ).toBe(true);
          })
        )
      );
      room.unsubscribe();
    } finally {
      stop();
      tracker.dispose();
      await repo.destroy();
    }
  });
  it('keeps storage owned after workspace close fails and finishes its original write on retry', async () => {
    const dbName = `native-workspace-close-${++sequence}`;
    const adapter = new IndexedDBStorageAdaptor({ dbName });
    const save = adapter.save.bind(adapter);
    const close = adapter.close.bind(adapter);
    let blocked = false;
    let storageClosed = false;
    adapter.save = async (payload) => {
      if (blocked && (payload.type === 'doc-update' || payload.type === 'doc-snapshot'))
        throw new Error('synthetic unavailable storage');
      await save(payload);
    };
    adapter.close = () => {
      storageClosed = true;
      return close();
    };
    const repo = await WorkspaceRepoLegacy.create({ storageAdapter: adapter });
    const lease = await repo.acquireDoc('retained');
    lease.doc.getText('body').insert(0, 'accepted write');
    lease.doc.commit();
    blocked = true;
    try {
      await expect(repo.destroy()).rejects.toBeInstanceOf(RepoReleaseFailed);
      expect(storageClosed).toBe(false);
    } finally {
      blocked = false;
      await repo.destroy();
    }
    expect(storageClosed).toBe(true);
    const reopened = new IndexedDBStorageAdaptor({ dbName });
    try {
      expect((await reopened.loadDoc('retained'))?.getText('body').toString()).toBe(
        'accepted write'
      );
    } finally {
      await reopened.close();
    }
  });
  it('projects native protocol diagnostics without exposing private Causes or request payloads', () => {
    class CallerTransportError extends RepoTransportError {}
    const tools = createLoroSyncErrorTools({
      RepoSyncError,
      RepoTransportError: CallerTransportError,
      nativeFailures: workspaceSyncFailuresLegacy,
    });
    const failure = new RepoIOError('streams protocol', {
      streamsCode: 'timeout',
      retryable: false,
      failureKind: 'timeout',
      streamsContext: {
        source: 'deadline',
        operation: 'snapshot',
        stage: 'upload',
        originalCode: 'timeout',
        retryable: false,
        phase: 'upload',
        abortKind: 'deadline',
        timeoutKind: 'idle',
        uploadStage: 'awaiting-response',
        requestId: 'synthetic-request-1',
        elapsedMs: 125,
      },
      fullCause: Cause.die(new Error('synthetic-private-token-in-request')),
    });
    const wrapped = new WorkspaceRepoLegacyFailure(Cause.fail(failure));
    const rendered = tools.formatLoroSyncError(wrapped);
    expect(rendered).toContain('timeout');
    expect(rendered).toContain('"retryable":false');
    expect(rendered).toContain('"abortKind":"deadline"');
    expect(rendered).toContain('"timeoutKind":"idle"');
    expect(rendered).toContain('"uploadStage":"awaiting-response"');
    expect(rendered).not.toContain('synthetic-private-token');
    expect(rendered).not.toContain('fullCause');
    expect(
      tools.getLoroSyncDiagnostic({ level: 'warn', event: 'room.sync.failed', error: wrapped })
    ).toMatchObject({
      failures: [
        {
          streamsContext: {
            abortKind: 'deadline',
            timeoutKind: 'idle',
            uploadStage: 'awaiting-response',
            requestId: 'synthetic-request-1',
            elapsedMs: 125,
          },
        },
      ],
    });
  });
  it('selects snapshot diagnostic scalars and excludes added payload/cause fields', () => {
    const secret = 'synthetic-private-request-body-token';
    const event = {
      snapshotId: 'snapshot-1',
      stage: 'put' as const,
      outcome: 'failed' as const,
      elapsedMs: 175,
      snapshotElapsedMs: 300,
      snapshotByteLength: 4096,
      requestId: 'request-1',
      requestOperation: 'put-snapshot' as const,
      uploadMode: 'progress' as const,
      uploadStage: 'uploading' as const,
      transferredBytes: 1024,
      idleTimeoutMs: 100,
      body: secret,
      url: `https://private.invalid/?token=${secret}`,
      error: {
        source: 'deadline' as const,
        operation: 'snapshot' as const,
        stage: 'upload' as const,
        originalCode: 'timeout' as const,
        retryable: true,
        phase: 'upload' as const,
        abortKind: 'deadline' as const,
        timeoutKind: 'idle' as const,
        uploadStage: 'uploading' as const,
        requestId: 'request-1',
        elapsedMs: 175,
        bodyText: secret,
        headers: { Authorization: secret },
        fullCause: Cause.die(new Error(secret)),
      },
    };
    const diagnostic = getLoroSnapshotDiagnostic(event);
    expect(diagnostic).toMatchObject({
      snapshotId: 'snapshot-1',
      stage: 'put',
      outcome: 'failed',
      elapsedMs: 175,
      snapshotElapsedMs: 300,
      snapshotByteLength: 4096,
      transferredBytes: 1024,
      requestId: 'request-1',
      uploadMode: 'progress',
      uploadStage: 'uploading',
      error: { abortKind: 'deadline', timeoutKind: 'idle', uploadStage: 'uploading' },
    });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(JSON.stringify(diagnostic)).not.toContain('private.invalid');
    expect(JSON.stringify(diagnostic)).not.toContain('fullCause');
  });
  it('retains a failed last-document save and retries before allowing a replacement', async () => {
    const adapter = storage();
    const save = adapter.save.bind(adapter);
    let fail = false;
    adapter.save = async (payload) => {
      if (fail && (payload.type === 'doc-update' || payload.type === 'doc-snapshot'))
        throw new Error('synthetic write failure');
      await save(payload);
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeWorkspaceRepo({
            storageAdapter: adapter,
            persistenceAttempts: 1,
            autoPersistMs: 0,
          });
          const owner = yield* acquireWorkspaceScope('test document');
          const lease = yield* repo
            .acquireDoc('session-a')
            .pipe(Effect.provideService(Scope.Scope, owner.scope));
          lease.doc.getText('body').insert(0, 'must survive release failure');
          lease.doc.commit();
          fail = true;
          const error = yield* owner.close.pipe(Effect.flip);
          expect(error).toBeInstanceOf(RepoReleaseFailed);
          fail = false;
          yield* error.retry;
          yield* owner.close;
          const reopened = yield* repo.acquireDoc('session-a');
          expect(reopened.doc).not.toBe(lease.doc);
          expect(reopened.doc.getText('body').toString()).toBe('must survive release failure');
        })
      )
    );
  });
});

import { describe, expect, vi } from 'vitest';
import { it } from '@effect/vitest';
import { Effect, Exit, Fiber, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { Flock } from '@loro-dev/flock-wasm';
import {
  LoroRepo,
  ResourceBusyError,
  type StorageAdapter,
  type TransportAdapter,
  type TransportSubscription,
} from 'loro-repo';
import {
  getMachineFlockDocId,
  getWorkspaceFlockDocId,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { makeWorkspaceCatalogSync } from './workspace-catalog-sync';
import { WorkspaceCatalogSyncLegacy } from './workspace-catalog-sync-legacy';
import { makePromiseRepoNetwork } from './promise-repo-network.test-support';

const workspaceId = 'catalog-sync-test' as WorkspaceId;
const workspace = getWorkspaceFlockDocId(workspaceId);
const machine = getMachineFlockDocId(workspaceId, 'target' as MachineId);
const logger = { debug: () => {} } as Logger;
const signal = <A = void>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const createRepo = (storageAdapter?: StorageAdapter) =>
  Effect.acquireRelease(
    Effect.promise(() => LoroRepo.create({ storageAdapter, metaDebounceCommitMs: 0 })),
    (repo) => Effect.promise(() => repo.destroy())
  );

/** Real Promise Repo replicas and Flock imports; only the transport is in memory. */
function network() {
  const sources = new Map<string, Flock>();
  const live = new Map<string, { flock: Flock; complete: () => void }>();
  const joins = new Map<string, ReturnType<typeof signal>>();
  const closed = new Set<string>();
  const subscription = (first: Promise<void>, unsubscribe = () => {}): TransportSubscription => ({
    status: 'joined',
    firstSyncedWithRemote: first,
    waitUntilSynced: () => first,
    onStatusChange: () => () => {},
    unsubscribe,
  });
  const inert = (): TransportAdapter => ({
    connect: async () => {},
    close: async () => {},
    isConnected: () => true,
    getStatus: () => 'connected',
    onStatusChange: () => () => {},
    syncMeta: async () => ({ ok: true }),
    syncDoc: async () => ({ ok: true }),
    joinMetaRoom: () => subscription(Promise.resolve()),
    joinDocRoom: () => subscription(Promise.resolve()),
  });
  const publisher: TransportAdapter = {
    ...inert(),
    joinMetaRoom: (flock) => {
      sources.set('meta', flock);
      return subscription(Promise.resolve());
    },
    joinFlockDocRoom: (id, flock) => {
      sources.set(id, flock);
      return subscription(Promise.resolve());
    },
  };
  const join = (key: string, flock: Flock) => {
    const source = sources.get(key);
    if (!source) throw new Error(`Missing publisher ${key}`);
    const synced = signal();
    let detach: (() => void) | undefined;
    live.set(key, {
      flock,
      complete: () => {
        flock.importFile(source.exportFile());
        detach ??= source.subscribe(() => flock.importFile(source.exportFile()));
        synced.resolve();
      },
    });
    joins.get(key)?.resolve(undefined);
    return subscription(synced.promise, () => {
      detach?.();
      live.delete(key);
      closed.add(key);
    });
  };
  const reader: TransportAdapter = {
    ...inert(),
    joinMetaRoom: (flock) => join('meta', flock),
    joinFlockDocRoom: join,
    // Reader code must not use request-level catch-up as a hidden prerequisite.
    syncMeta: async () => {
      throw new Error('Unexpected forced metadata sync');
    },
    syncFlockDoc: async () => {
      throw new Error('Unexpected forced Flock sync');
    },
  };
  return {
    publisher,
    reader,
    live,
    closed,
    joined: (key: string) => {
      if (live.has(key)) return Promise.resolve();
      let next = joins.get(key);
      if (!next) {
        next = signal();
        joins.set(key, next);
      }
      return next.promise;
    },
    complete: (key: string) => {
      const joined = live.get(key);
      if (!joined) throw new Error(`Not joined: ${key}`);
      joined.complete();
    },
  };
}

const fixture = Effect.fnUntraced(function* () {
  const net = network();
  const publisher = yield* createRepo();
  yield* Effect.promise(async () => {
    await publisher.addTransport('streams', net.publisher);
    await publisher.joinMetaRoom();
    await publisher.joinFlockDocRoom(workspace);
    await publisher.joinFlockDocRoom(machine);
    await publisher.upsertDocMeta('machine:target', { name: 'initial' });
    for (const id of [workspace, machine]) {
      const { flock } = await publisher.openFlockDoc(id);
      flock.set(['test'], 'initial');
      flock.commit();
    }
  });
  const repo = yield* createRepo();
  const owner = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
  const sync = yield* Scope.provide(makeWorkspaceCatalogSync(repo, workspaceId, logger), owner);
  yield* sync.hold(machine);
  yield* Effect.promise(() => repo.addTransport('streams', net.reader));
  for (const id of ['meta', workspace, machine]) yield* Effect.promise(() => net.joined(id));
  return { net, publisher, repo, owner, sync };
});

describe('daemon Promise Repo catalog ownership', () => {
  for (const recover of [true, false]) {
    it.effect(
      recover
        ? 'recovers a failed metadata durability barrier without replacing the joined reader'
        : 'bounds repeated baseline failures and releases readers while storage is still unavailable',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            let unavailable = true;
            let persisted = false;
            const originalError = new Error('SQLITE_BUSY');
            const failures = Array.from({ length: 7 }, () => signal<unknown>());
            let failureIndex = 0;
            const repo = yield* Effect.acquireRelease(
              Effect.promise(() =>
                LoroRepo.create({
                  metaDebounceCommitMs: 0,
                  // The explicit baseline barrier owns this flush, not a real timer.
                  metaPersistDebounceMs: 60_000,
                  storageAdapter: {
                    loadMeta: async () => undefined,
                    loadDoc: async () => undefined,
                    loadFlockDoc: async () => undefined,
                    save: async (payload) => {
                      if (payload.type !== 'meta-update' && payload.type !== 'meta-snapshot')
                        return;
                      if (unavailable) throw originalError;
                      persisted = true;
                    },
                  },
                })
              ),
              (acquiredRepo) => Effect.promise(() => acquiredRepo.destroy())
            );
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                // Terminal Repo flush is independent of the stopped baseline reader.
                unavailable = false;
              })
            );
            const meta = yield* Effect.promise(() => repo.joinMetaRoom());
            yield* Effect.addFinalizer(() => Effect.sync(() => meta.unsubscribe()));
            const binding = meta.subscription('streams');
            const waitFor = binding.waitFor.bind(binding);
            // Observe actual SDK results without changing its barrier or storage behavior.
            vi.spyOn(binding, 'waitFor').mockImplementation(async (options) => {
              const result = await waitFor(options);
              if (result.status === 'error') failures[failureIndex++]?.resolve(result.error);
              return result;
            });
            yield* Effect.promise(() => repo.upsertDocMeta('machine:target', { name: 'retained' }));
            const owner = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
            const sync = yield* Scope.provide(
              makeWorkspaceCatalogSync(repo, workspaceId, logger),
              owner
            );
            yield* Effect.promise(() =>
              repo.addTransport('streams', makePromiseRepoNetwork().transport())
            );
            expect(yield* Effect.promise(() => failures[0]!.promise)).toBe(originalError);
            expect(binding.status).toBe('joined');
            const attached = repo.transportRooms('streams');
            const waiters = yield* Effect.forkChild(
              Effect.all([sync.ready(undefined, 250), sync.ready(undefined, 250)], {
                concurrency: 'unbounded',
              })
            );
            yield* TestClock.adjust(250);
            expect(yield* Fiber.join(waiters)).toEqual([false, false]);
            expect(persisted).toBe(false);
            // A metadata persistence failure must not stop independent Flock readers.
            expect(yield* sync.ready(workspace, 1_000)).toBe(true);
            expect(yield* sync.ready(machine, 1_000)).toBe(true);
            yield* TestClock.adjust(750);
            expect(yield* Effect.promise(() => failures[1]!.promise)).toMatchObject({
              errors: [originalError, originalError],
            });
            if (recover) {
              unavailable = false;
              yield* TestClock.adjust(2_000);
              expect(yield* sync.ready(undefined, 1_000)).toBe(true);
              expect(persisted).toBe(true);
              expect(binding.status).toBe('joined');
              expect(repo.transportRooms('streams')).toEqual(expect.arrayContaining(attached));
              expect(
                (yield* Effect.promise(() => repo.getDocMeta('machine:target')))?.meta.name
              ).toBe('retained');
              expect(yield* sync.ready(undefined, 0)).toBe(true);
            } else {
              // Retry backoff grows to 30s, independent of how often requests arrive.
              for (const [index, delay] of [2_000, 4_000, 8_000, 16_000, 30_000].entries()) {
                yield* TestClock.adjust(delay);
                expect(yield* Effect.promise(() => failures[index + 2]!.promise)).toMatchObject({
                  errors: [originalError, originalError],
                });
                expect(yield* sync.ready(undefined, 0)).toBe(false);
                expect(persisted).toBe(false);
              }
            }
            yield* Scope.close(owner, Exit.void);
            for (const id of [workspace, machine])
              yield* Effect.promise(() => repo.unloadFlockDoc(id));
            meta.unsubscribe();
            expect(repo.transportRooms('streams')).toEqual([]);
            const failuresAtClose = failureIndex;
            yield* TestClock.adjust(120_000);
            expect(failureIndex).toBe(failuresAtClose);
          })
        )
    );
  }

  it.effect(
    'bounds cold waits, shares same-key ownership, and observes live edits after detach/reattach',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { net, publisher, repo, owner, sync } = yield* fixture();
          yield* Effect.all([sync.hold(machine), sync.hold(machine)], { concurrency: 'unbounded' });
          const waits = yield* Effect.forkChild(
            Effect.all(
              [undefined, workspace, machine].map((id) => sync.ready(id, 1_000)),
              { concurrency: 'unbounded' }
            )
          );
          yield* TestClock.adjust(1_000);
          expect(yield* Fiber.join(waits)).toEqual([false, false, false]);
          expect(net.live.size).toBe(3);
          expect(yield* Effect.promise(() => repo.getDocMeta('machine:target'))).toBeUndefined();
          for (const id of ['meta', workspace, machine]) net.complete(id);
          for (const id of [undefined, workspace, machine])
            expect(yield* sync.ready(id, 1_000)).toBe(true);
          expect((yield* Effect.promise(() => repo.getDocMeta('machine:target')))?.meta.name).toBe(
            'initial'
          );
          for (const id of [workspace, machine]) {
            const local = yield* Effect.promise(() => repo.openFlockDoc(id));
            expect(local.flock.get(['test'])).toBe('initial');
            const remote = yield* Effect.promise(() => publisher.openFlockDoc(id));
            remote.flock.set(['test'], 'later');
            remote.flock.commit();
            expect(local.flock.get(['test'])).toBe('later');
            yield* Effect.promise(async () => {
              await expect(repo.unloadFlockDoc(id)).rejects.toBeInstanceOf(ResourceBusyError);
            });
          }
          yield* Effect.promise(() => repo.removeTransport('streams'));
          expect(net.live.size).toBe(0);
          for (const id of [undefined, workspace, machine])
            expect(yield* sync.ready(id, 0)).toBe(true);
          yield* Effect.promise(() =>
            publisher.upsertDocMeta('machine:target', { name: 'reattached' })
          );
          yield* Effect.promise(() => repo.addTransport('streams', net.reader));
          for (const id of ['meta', workspace, machine]) net.complete(id);
          // Metadata hydration is asynchronous; the real public barrier drains it.
          const meta = yield* Effect.promise(() => repo.joinMetaRoom());
          yield* Effect.promise(() => meta.subscription('streams').waitFor());
          meta.unsubscribe();
          expect((yield* Effect.promise(() => repo.getDocMeta('machine:target')))?.meta.name).toBe(
            'reattached'
          );
          yield* Scope.close(owner, Exit.void);
          expect(net.live.size).toBe(0);
          for (const id of [workspace, machine])
            yield* Effect.promise(() => repo.unloadFlockDoc(id));
        })
      )
  );

  it.effect(
    'keeps a cold detached baseline uncertain and catches up when the same Repo attaches later',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { net, repo, sync } = yield* fixture();
          yield* Effect.promise(() => repo.removeTransport('streams'));
          expect(yield* sync.ready(workspace, 0)).toBe(false);
          yield* Effect.promise(() => repo.addTransport('streams', net.reader));
          net.complete(workspace);
          expect(yield* sync.ready(workspace, 1_000)).toBe(true);
          expect(
            (yield* Effect.promise(() => repo.openFlockDoc(workspace))).flock.get(['test'])
          ).toBe('initial');
        })
      )
  );

  it.effect(
    'retries failed real storage acquisition and lets unrelated catalogs serve during the failure',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let failed = true;
          const attempted = signal();
          const recovered = signal();
          const repo = yield* createRepo({
            loadMeta: async () => undefined,
            loadDoc: async () => undefined,
            save: async () => {},
            loadFlockDoc: async (id) => {
              if (id === workspace && failed) {
                attempted.resolve();
                throw new Error('SQLITE_BUSY');
              }
              if (id === workspace) recovered.resolve();
              return undefined;
            },
          });
          const owner = yield* Scope.make();
          const sync = yield* Scope.provide(
            makeWorkspaceCatalogSync(repo, workspaceId, logger, false),
            owner
          );
          yield* Effect.promise(() => attempted.promise);
          expect(yield* sync.ready(machine, 1_000)).toBe(true);
          expect(yield* sync.ready(workspace, 0)).toBe(false);
          failed = false;
          yield* TestClock.adjust(1_000);
          yield* Effect.promise(() => recovered.promise);
          expect(yield* sync.ready(workspace, 1_000)).toBe(true);
          yield* Scope.close(owner, Exit.void);
          yield* Effect.promise(() => repo.unloadFlockDoc(workspace));
        })
      )
  );

  it.effect(
    'closes during slow acquisition and releases its late result without blocking another key',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = signal();
          const resume = signal<Flock | undefined>();
          const repo = yield* createRepo({
            loadMeta: async () => undefined,
            loadDoc: async () => undefined,
            save: async () => {},
            loadFlockDoc: async (id) => {
              if (id === workspace) {
                started.resolve();
                return resume.promise;
              }
              return undefined;
            },
          });
          const released = signal();
          const acquire = repo.acquireFlockDoc.bind(repo);
          vi.spyOn(repo, 'acquireFlockDoc').mockImplementation(async (id) => {
            const lease = await acquire(id);
            return {
              ...lease,
              release: async () => {
                await lease.release();
                if (id === workspace) released.resolve();
              },
            };
          });
          const owner = yield* Scope.make();
          const sync = yield* Scope.provide(
            makeWorkspaceCatalogSync(repo, workspaceId, logger, false),
            owner
          );
          yield* Effect.promise(() => started.promise);
          expect(yield* sync.ready(machine, 1_000)).toBe(true);
          const waiting = yield* Effect.forkChild(sync.ready(workspace, 1_000));
          yield* TestClock.adjust(1_000);
          expect(yield* Fiber.join(waiting)).toBe(false);
          yield* Scope.close(owner, Exit.void);
          resume.resolve(undefined);
          yield* Effect.promise(() => released.promise);
          yield* Effect.promise(() => repo.unloadFlockDoc(workspace));
          yield* Effect.promise(() => repo.unloadFlockDoc(machine));
          yield* TestClock.adjust(120_000);
          expect(repo.transportRooms('streams')).toEqual([]);
        })
      )
  );

  it.effect(
    'releases a slow load arriving after Repo destruction without a room or closed-storage write',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = signal();
          const resume = signal<Flock | undefined>();
          const released = signal();
          let closed = false;
          const lateWrites: unknown[] = [];
          const repo = yield* createRepo({
            loadMeta: async () => undefined,
            loadDoc: async () => undefined,
            loadFlockDoc: async (id) => {
              if (id === workspace) {
                started.resolve();
                return resume.promise;
              }
              return undefined;
            },
            save: async (payload) => {
              if (closed) lateWrites.push(payload);
            },
            close: () => {
              closed = true;
            },
          });
          const acquire = repo.acquireFlockDoc.bind(repo);
          vi.spyOn(repo, 'acquireFlockDoc').mockImplementation(async (id) => {
            const lease = await acquire(id);
            return {
              ...lease,
              release: async () => {
                await lease.release();
                released.resolve();
              },
            };
          });
          const owner = yield* Scope.make();
          yield* Scope.provide(makeWorkspaceCatalogSync(repo, workspaceId, logger), owner);
          yield* Effect.promise(() => started.promise);
          yield* Scope.close(owner, Exit.void);
          yield* Effect.promise(() => repo.destroy());
          expect(closed).toBe(true);
          const remote = new Flock('late-storage-result');
          remote.set(['test'], 'late');
          remote.commit();
          resume.resolve(remote);
          yield* Effect.promise(() => released.promise);
          expect(repo.transportRooms('streams')).toEqual([]);
          expect(lateWrites).toEqual([]);
          // SDK 0.23.2 can still retain the late replica in this destroyed object's
          // internal cache. Never reuse this Repo or claim cancellation of its load.
          expect(repo.destroyed).toBe(true);
        })
      )
  );

  it.effect('delivers cleanup defects after all sibling readers release their real leases', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repo = yield* createRepo();
        const original = new Error('Synthetic lease cleanup failure');
        const acquire = repo.acquireFlockDoc.bind(repo);
        vi.spyOn(repo, 'acquireFlockDoc').mockImplementation(async (id) => {
          const lease = await acquire(id);
          return {
            ...lease,
            release: async () => {
              await lease.release();
              if (id === workspace) throw original;
            },
          };
        });
        const owner = yield* Scope.make();
        const sync = yield* Scope.provide(
          makeWorkspaceCatalogSync(repo, workspaceId, logger, false),
          owner
        );
        expect(yield* sync.ready(workspace, 1_000)).toBe(true);
        expect(yield* sync.ready(machine, 1_000)).toBe(true);
        const exit = yield* Effect.exit(Scope.close(owner, Exit.void));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const defect = exit.cause.reasons.find((reason) => reason._tag === 'Die');
          expect(defect).toMatchObject({
            defect: { cause: { reasons: [{ defect: { errors: [original] } }] } },
          });
        }
        for (const id of [workspace, machine]) yield* Effect.promise(() => repo.unloadFlockDoc(id));
      })
    )
  );

  it.effect(
    'shuts down the same Repo during a pending transport acquisition and rejects late attachment',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* createRepo();
          const owner = yield* Scope.make();
          const sync = yield* Scope.provide(
            makeWorkspaceCatalogSync(repo, workspaceId, logger),
            owner
          );
          const started = signal();
          const resume = signal();
          const net = network();
          const adapter: TransportAdapter = {
            ...net.reader,
            connect: async () => {
              started.resolve();
              await resume.promise;
            },
            isConnected: () => false,
          };
          const attached = repo.addTransport('streams', adapter);
          yield* Effect.promise(() => started.promise);
          expect(yield* sync.ready(workspace, 0)).toBe(false);
          yield* Scope.close(owner, Exit.void);
          yield* Effect.promise(() => repo.destroy());
          resume.resolve();
          yield* Effect.promise(() => attached);
          expect(net.live.size).toBe(0);
          expect(repo.transportRooms('streams')).toEqual([]);
          expect(repo.destroyed).toBe(true);
        })
      )
  );

  it('uses the actual Promise entry and releases readers before Repo shutdown', async () => {
    const repo = await LoroRepo.create({});
    const reader = new WorkspaceCatalogSyncLegacy(repo, workspaceId, logger, false);
    expect(await reader.ready(workspace, 1_000)).toBe(true);
    await reader.hold(machine);
    expect(await reader.ready(machine, 1_000)).toBe(true);
    await reader.close();
    expect(await reader.ready(machine, 0)).toBe(false);
    await repo.unloadFlockDoc(workspace);
    await repo.unloadFlockDoc(machine);
    await repo.destroy();
    expect(repo.destroyed).toBe(true);
  });
});

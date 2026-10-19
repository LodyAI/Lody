import { describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { make, makeMemoryNetwork, RepoIOError } from 'loro-repo/effect';
import { getWorkspaceFlockDocId, type WorkspaceId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { makeWorkspaceCatalogSync, startWorkspaceCatalogSync } from './workspace-catalog-sync';

const workspaceId = 'catalog-sync-test' as WorkspaceId;
const logger = { debug: () => {} } as Logger;

describe('daemon workspace catalog ownership', () => {
  it.effect('starts without waiting for a slow acquisition and releases its lease on close', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repo = yield* make();
        const owner = yield* Scope.make();
        const started = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const acquired = yield* Deferred.make<void>();
        let releases = 0;
        yield* Scope.provide(
          startWorkspaceCatalogSync(
            {
              ...repo,
              acquireRoom: (target) =>
                Effect.gen(function* () {
                  expect(target).toEqual({
                    kind: 'flock',
                    id: getWorkspaceFlockDocId(workspaceId),
                  });
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(resume);
                  const lease = yield* repo.acquireRoom(target);
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                      releases += 1;
                    })
                  );
                  yield* Deferred.succeed(acquired, undefined);
                  return lease;
                }),
            },
            workspaceId,
            logger
          ),
          owner
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust(60_000);
        expect(releases).toBe(0);
        yield* Deferred.succeed(resume, undefined);
        yield* Deferred.await(acquired);
        yield* Scope.close(owner, Exit.void);
        expect(releases).toBe(1);
      })
    )
  );

  it.effect(
    'retries failed local acquisition, recovers, and cancels pending retries at close',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* make();
          const owner = yield* Scope.make();
          const acquired = yield* Deferred.make<void>();
          const failure = new RepoIOError('local catalog unavailable', undefined);
          const errors: string[] = [];
          let attempts = 0;
          let releases = 0;
          const recovering = {
            ...repo,
            acquireRoom: (target: Parameters<typeof repo.acquireRoom>[0]) =>
              Effect.gen(function* () {
                attempts += 1;
                if (attempts <= 2) return yield* Effect.fail(failure);
                const lease = yield* repo.acquireRoom(target);
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    releases += 1;
                  })
                );
                yield* Deferred.succeed(acquired, undefined);
                return lease;
              }),
          };
          const reporting = {
            debug: (message: string) => {
              errors.push(message);
              throw new Error('diagnostics unavailable');
            },
          } as Logger;
          yield* Scope.provide(
            startWorkspaceCatalogSync(recovering, workspaceId, reporting),
            owner
          );
          yield* TestClock.adjust(1_000);
          yield* TestClock.adjust(2_000);
          yield* Deferred.await(acquired);
          expect(attempts).toBe(3);
          expect(errors).toEqual([
            `[${workspaceId}] Catalog reader failed: RepoIOError`,
            `[${workspaceId}] Catalog reader failed: RepoIOError`,
          ]);
          yield* Scope.close(owner, Exit.void);
          expect(releases).toBe(1);
          const retryOwner = yield* Scope.make();
          yield* Scope.provide(
            startWorkspaceCatalogSync(
              {
                ...repo,
                acquireRoom: () =>
                  Effect.suspend(() => {
                    attempts += 1;
                    return Effect.fail(failure);
                  }),
              },
              workspaceId,
              logger
            ),
            retryOwner
          );
          yield* TestClock.adjust(1_000);
          yield* Scope.close(retryOwner, Exit.void);
          const stoppedAt = attempts;
          yield* TestClock.adjust(120_000);
          expect(attempts).toBe(stoppedAt);
        })
      )
  );

  it.effect(
    'recovers a native retained release after transient catalog read and cleanup write failure',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let unavailable = true;
          let loads = 0;
          const failed = yield* Deferred.make<void>();
          const loaded = yield* Deferred.make<void>();
          const repo = yield* make({
            autoPersistMs: 0,
            storageAdapter: {
              loadMeta: async () => undefined,
              loadDoc: async () => undefined,
              loadFlockDoc: async () => {
                loads += 1;
                if (unavailable) throw new Error('SQLITE_BUSY');
                Deferred.doneUnsafe(loaded, Exit.void);
                return undefined;
              },
              save: async () => {
                if (unavailable) throw new Error('SQLITE_BUSY');
              },
            },
          });
          yield* repo.upsertDocMeta('machine:a', { id: 'a' });
          const owner = yield* Scope.make();
          const sync = yield* Scope.provide(
            makeWorkspaceCatalogSync(repo, workspaceId, {
              debug: (message: string) => {
                if (message.includes('Die')) Deferred.doneUnsafe(failed, Exit.void);
              },
            } as Logger),
            owner
          );
          yield* Deferred.await(failed);
          yield* TestClock.adjust(1_000);
          yield* TestClock.adjust(2_000);
          const failedLoads = loads;
          unavailable = false;
          yield* sync.hold(getWorkspaceFlockDocId(workspaceId));
          yield* TestClock.adjust(4_000);
          yield* Deferred.await(loaded);
          expect(loads).toBe(failedLoads + 1);
          yield* Scope.close(owner, Exit.void);
          const stoppedAt = loads;
          yield* TestClock.adjust(120_000);
          expect(loads).toBe(stoppedAt);
        })
      )
  );

  it.effect(
    'bounds only the first-baseline waiter and keeps the reader alive across timeout and detach',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const network = yield* makeMemoryNetwork();
          const publisher = yield* make();
          const id = getWorkspaceFlockDocId(workspaceId);
          const remote = yield* publisher.acquireRoom({ kind: 'flock', id });
          if (remote.replica.kind !== 'flock') throw new Error('Expected Flock');
          remote.replica.lease.flock.set(['test'], 'remote');
          remote.replica.lease.flock.commit();
          yield* publisher.attachTransport({
            ...network.transport('streams'),
            authority: 'server',
          });
          yield* remote.sync('streams');
          const repo = yield* make({ authority: { mode: 'remote', transports: ['streams'] } });
          const sync = yield* makeWorkspaceCatalogSync(repo, workspaceId, logger);
          const waiting = yield* Effect.forkChild(sync.ready(id, 1_000));
          yield* TestClock.adjust(1_000);
          expect(yield* Fiber.join(waiting)).toBe(false);
          yield* repo.attachTransport({ ...network.transport('streams'), authority: 'server' });
          expect(yield* sync.ready(id, 1_000)).toBe(true);
          const local = yield* repo.acquireFlockDoc(id);
          expect(local.flock.get(['test'])).toBe('remote');
          yield* repo.removeTransport('streams');
          expect(yield* sync.ready(id, 0)).toBe(true);
        })
      )
  );

  it.effect(
    'preserves cleanup defects and does not retry a failed release into a replacement owner',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* make();
          const owner = yield* Scope.make();
          const original = new Error('cleanup failed');
          const acquisition = new RepoIOError('acquisition failed', undefined);
          let attempts = 0;
          const fiber = yield* Scope.provide(
            startWorkspaceCatalogSync(
              {
                ...repo,
                acquireRoom: () =>
                  Effect.gen(function* () {
                    attempts += 1;
                    yield* Effect.addFinalizer(() => Effect.die(original));
                    return yield* Effect.fail(acquisition);
                  }),
              },
              workspaceId,
              logger
            ),
            owner
          );
          const result = yield* Fiber.await(fiber);
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            expect(result.cause.reasons).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ _tag: 'Fail', error: acquisition }),
                expect.objectContaining({ _tag: 'Die', defect: original }),
              ])
            );
          }
          yield* TestClock.adjust(120_000);
          expect(attempts).toBe(1);
          // A failed catalog owner does not fence unrelated rooms.
          yield* Effect.scoped(repo.acquireRoom({ kind: 'flock', id: 'unrelated' }));
          yield* Scope.close(owner, Exit.void);
        })
      )
  );
});

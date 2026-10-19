import { Deferred, Effect, Exit, Fiber, Result, Scope } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeLabRuntime } from '../src/platform/runtime';
import { makeLabOperations } from '../src/platform/operation-scope';
import { fixture } from './ledger-fixture';
import Database from 'better-sqlite3';
import { join } from 'node:path';
const latch = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
describe('scoped Lab permit runtime and borrowed work settlement', () => {
  it('Scope close aborts and awaits a borrowed native fetch that ignores abort, without exposing its late result', async () => {
    const entered = latch(),
      aborted = latch(),
      release = latch();
    let settled = false;
    let ownerClosedBeforeSettlement = false;
    let ownerClosed = false;
    // Explicit mock boundary for a native owner that cannot be stopped by abort.
    const raw: typeof fetch = async (input) => {
      const request = input as Request;
      request.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      entered.resolve();
      await release.promise;
      settled = true;
      return new Response('late');
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              ownerClosedBeforeSettlement = !settled;
              ownerClosed = true;
            })
          ).pipe(Effect.provideService(Scope.Scope, scope));
          const runtime = yield* makeLabRuntime({ mode: 'auto', time: 0, fetch: raw }).pipe(
            Effect.provideService(Scope.Scope, scope)
          );

          const worker = yield* Effect.forkChild(
            Effect.result(
              Effect.tryPromise({
                try: () =>
                  runtime.gatedFetch('alice')(
                    'http://synthetic.invalid/ds/local/control?offset=-1'
                  ),
                catch: (error) => error,
              })
            )
          );
          yield* Effect.promise(() => entered.promise);
          const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
          yield* Effect.promise(() => aborted.promise);
          const before = closing.pollUnsafe();
          const prematurelySettled = settled;
          release.resolve();
          yield* Fiber.join(closing);
          expect(before).toBeUndefined();
          expect(prematurelySettled).toBe(false);
          expect(settled).toBe(true);
          expect(ownerClosed).toBe(true);
          expect(ownerClosedBeforeSettlement).toBe(false);
          expect(Result.isFailure(yield* Fiber.join(worker))).toBe(true);
          expect(runtime.frames).toEqual([]);
          expect(
            Result.isFailure(
              yield* Effect.result(
                Effect.tryPromise({
                  try: () =>
                    runtime.gatedFetch('alice')('http://synthetic.invalid/ds/local/control'),
                  catch: (error) => error,
                })
              )
            )
          ).toBe(true);
        })
      )
    );
  });
  it('does not start a native request before an explicit permit and closes a pending gate', async () => {
    const observed: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeLabRuntime({
            mode: 'manual',
            time: 0,
            fetch: async () => {
              observed.push('request');
              return new Response('ok');
            },
          });
          const worker = yield* Effect.forkChild(
            Effect.result(
              Effect.tryPromise({
                try: () => runtime.gatedFetch('alice')('http://synthetic.invalid/ds/local/control'),
                catch: (error) => error,
              })
            )
          );
          yield* runtime.whenRequested(1);
          expect(observed).toEqual([]);
          expect(runtime.events().map((event) => event.status)).toEqual(['requested']);
          yield* runtime.disposeEffect();
          expect(Result.isFailure(yield* Fiber.join(worker))).toBe(true);
          expect(observed).toEqual([]);
        })
      )
    );
  });
});

it('closes all operation children despite one native cleanup defect and waits another real SDK borrower before the earlier owner', async () => {
  const f = await fixture(),
    entered = latch(),
    release = latch();
  let secondSettled = false,
    closedEarly = false,
    closed = false;
  const defect = new Error('synthetic native cleanup defect');
  let database: Database.Database | undefined;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* Scope.make();
          yield* Scope.addFinalizer(
            child,
            Effect.promise(async () => {
              closedEarly = !secondSettled;
              await f.close();
              closed = true;
            })
          );
          const operations = yield* makeLabOperations().pipe(
            Effect.provideService(Scope.Scope, child)
          );
          const acquired = yield* Deferred.make<void>();
          const idle = yield* Deferred.make<void>();
          const first = yield* Effect.forkChild(
            Effect.exit(
              operations.run(
                Effect.gen(function* () {
                  database = yield* Effect.acquireRelease(
                    Effect.sync(() => new Database(join(f.dir, 'cleanup.sqlite'))),
                    (handle) =>
                      Effect.sync(() => handle.close()).pipe(Effect.andThen(Effect.die(defect)))
                  );
                  yield* Deferred.succeed(acquired, undefined);
                  yield* Deferred.await(idle);
                })
              )
            )
          );
          yield* Deferred.await(acquired);
          // Explicit abort-ignoring native phase gate, then an actual published SDK read.
          const second = yield* Effect.forkChild(
            Effect.exit(
              operations.run(
                Effect.uninterruptible(
                  Effect.promise(async () => {
                    entered.resolve();
                    await release.promise;
                    const result = await f.sdk.read({
                      offset: '-1',
                      signal: new AbortController().signal,
                    });
                    secondSettled = true;
                    if (!result.ok) throw new Error('actual SDK read failed before owner closure');
                  })
                )
              )
            )
          );
          yield* Effect.addFinalizer(() => Effect.sync(release.resolve));
          yield* Effect.promise(() => entered.promise);
          const closing = yield* Effect.forkChild(Effect.exit(Scope.close(child, Exit.void)), {
            startImmediately: true,
          });
          const denied = yield* Effect.result(operations.run(Effect.void));
          expect(Result.isFailure(denied)).toBe(true);
          const pending = closing.pollUnsafe();
          release.resolve();
          const result = yield* Fiber.join(closing);
          expect(closedEarly).toBe(false);
          expect(pending).toBeUndefined();
          expect(closed).toBe(true);
          expect(secondSettled).toBe(true);
          expect(database?.open).toBe(false);
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result))
            expect(
              result.cause.reasons.some(
                (reason) => reason._tag === 'Die' && reason.defect === defect
              )
            ).toBe(true);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
        })
      )
    );
  } finally {
    release.resolve();
    if (!closed) await f.close();
  }
});

it.each([false, true])(
  'waits already-started operation cleanup before real SQLite/SDK owners (defect=%s)',
  async (fails) => {
    const f = await fixture();
    const database = new Database(':memory:');
    database.exec('CREATE TABLE retained(value); INSERT INTO retained VALUES(7)');
    const defect = new Error('shared close result');
    let childSettled = false,
      closedEarly = false,
      readOk = false;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const parent = yield* Scope.make();
            const entered = yield* Deferred.make<void>(),
              release = yield* Deferred.make<void>(),
              closingEntered = yield* Deferred.make<void>();
            yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
            yield* Scope.addFinalizer(
              parent,
              Effect.promise(async () => {
                closedEarly = !childSettled;
                database.close();
                await f.server.close();
              })
            );
            const operations = yield* makeLabOperations().pipe(
              Effect.provideService(Scope.Scope, parent)
            );
            operations.signal.addEventListener(
              'abort',
              () => Deferred.doneUnsafe(closingEntered, Effect.void),
              { once: true }
            );
            const worker = yield* Effect.forkChild(
              Effect.exit(
                operations.run(
                  Effect.gen(function* () {
                    yield* Effect.addFinalizer(() =>
                      Effect.gen(function* () {
                        yield* Deferred.succeed(entered, undefined);
                        yield* Deferred.await(release);
                        expect(database.prepare('SELECT value FROM retained').get()).toEqual({
                          value: 7,
                        });
                        const response = yield* Effect.promise(() =>
                          f.sdk.read({ offset: '-1', signal: new AbortController().signal })
                        );
                        readOk = response.ok;
                        childSettled = true;
                        if (fails) yield* Effect.die(defect);
                      })
                    );
                  })
                )
              )
            );
            yield* Deferred.await(entered);
            const closing = yield* Effect.forkChild(Effect.exit(Scope.close(parent, Exit.void)));
            yield* Deferred.await(closingEntered);
            yield* Deferred.succeed(release, undefined);
            const parentResult = yield* Fiber.join(closing),
              workerResult = yield* Fiber.join(worker);
            expect(closedEarly).toBe(false);
            expect(childSettled).toBe(true);
            expect(readOk).toBe(true);
            expect(database.open).toBe(false);
            for (const result of [parentResult, workerResult]) {
              expect(Exit.isFailure(result)).toBe(fails);
              if (Exit.isFailure(result))
                expect(
                  result.cause.reasons.some(
                    (reason) => reason._tag === 'Die' && reason.defect === defect
                  )
                ).toBe(true);
            }
          })
        )
      );
    } finally {
      if (database.open) database.close();
      await f.close();
    }
  }
);

it('native Effect phases are interrupted and both close callers await actual uninterruptible SQLite settlement before releasing the database', async () => {
  const f = await fixture();
  const db = new Database(join(f.dir, 'native-phase.sqlite'));
  db.exec('CREATE TABLE writes(value TEXT)');
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.make(),
            entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Effect.sync(() => db.close())).pipe(
            Effect.provideService(Scope.Scope, scope)
          );
          const runtime = yield* makeLabRuntime({ mode: 'auto', time: 0, fetch }).pipe(
            Effect.provideService(Scope.Scope, scope)
          );
          const writer = yield* Effect.forkChild(
            Effect.exit(
              runtime.phaseEffect(
                'alice',
                'persist',
                'native',
                Effect.uninterruptible(
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(
                      Effect.sync(() => {
                        db.prepare('INSERT INTO writes VALUES (?)').run('settled');
                      })
                    )
                  )
                )
              )
            )
          );
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          yield* Deferred.await(entered);
          const first = yield* Effect.forkChild(Scope.close(scope, Exit.void));
          yield* Effect.sync(() => runtime.close());
          const second = yield* Effect.forkChild(runtime.disposeEffect());
          yield* Effect.yieldNow;
          const openBeforeRelease = db.open;
          const firstEarly = first.pollUnsafe(),
            secondEarly = second.pollUnsafe();
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          const writerExit = yield* Fiber.join(writer);
          expect(Exit.isFailure(writerExit)).toBe(true);
          expect(openBeforeRelease).toBe(true);
          expect(firstEarly).toBeUndefined();
          expect(secondEarly).toBeUndefined();
          expect(db.open).toBe(false);
          const reopened = new Database(join(f.dir, 'native-phase.sqlite'));
          try {
            expect(reopened.prepare('SELECT value FROM writes').all()).toEqual([
              { value: 'settled' },
            ]);
          } finally {
            reopened.close();
          }
        })
      )
    );
  } finally {
    if (db.open) db.close();
    await f.close();
  }
});

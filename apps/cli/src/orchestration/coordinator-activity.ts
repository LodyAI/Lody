import { Context, Deferred, Effect, Exit, Fiber, Layer, Queue } from 'effect';

type Wake = { reason: string; done: Deferred.Deferred<void, unknown> };
export class CoordinatorActivity extends Context.Service<
  CoordinatorActivity,
  {
    wake(reason: string): Effect.Effect<void, unknown>;
    signal(reason: string): Effect.Effect<void>;
    arm(key: string, delay: number, reason: string): Effect.Effect<void>;
    cancel(key: string): Effect.Effect<void>;
    cancelWhere(predicate: (key: string) => boolean): Effect.Effect<void>;
    has(key: string): boolean;
    drain: Effect.Effect<void, unknown>;
  }
>()('lody/orchestration/CoordinatorActivity') {
  static layer(
    reconcile: (reason: string) => Effect.Effect<void, unknown>,
    report: (cause: unknown) => Effect.Effect<void>
  ) {
    return Layer.effect(
      CoordinatorActivity,
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const queue = yield* Queue.unbounded<Wake>();
        let closed = false;
        const pending = new Set<Deferred.Deferred<void, unknown>>();
        const timers = new Map<string, { fiber?: Fiber.Fiber<void, never> }>();
        const enqueue = Effect.fnUntraced(function* (reason: string) {
          const done = yield* Deferred.make<void, unknown>();
          if (closed) yield* Deferred.succeed(done, undefined);
          else {
            pending.add(done);
            yield* Queue.offer(queue, { reason, done });
          }
          return done;
        });
        const wake = (reason: string) => enqueue(reason).pipe(Effect.flatMap(Deferred.await));
        const signal = (reason: string) => enqueue(reason).pipe(Effect.asVoid);
        yield* Effect.forever(
          Effect.gen(function* () {
            const first = yield* Queue.take(queue);
            const rest = yield* Queue.takeBetween(queue, 0, Number.MAX_SAFE_INTEGER);
            const exit = yield* Effect.exit(reconcile(first.reason));
            if (Exit.isFailure(exit)) yield* report(exit.cause);
            for (const entry of [first, ...rest]) {
              pending.delete(entry.done);
              yield* Deferred.done(entry.done, Exit.succeed(undefined));
            }
          })
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            closed = true;
            for (const done of pending) yield* Deferred.succeed(done, undefined);
            pending.clear();
          })
        );
        const cancel = Effect.fnUntraced(function* (key: string) {
          const fiber = timers.get(key)?.fiber;
          timers.delete(key);
          if (fiber) yield* Fiber.interrupt(fiber);
        });
        return {
          wake,
          signal,
          has: (key: string) => timers.has(key),
          cancel,
          cancelWhere: (predicate) =>
            Effect.forEach([...timers.keys()].filter(predicate), cancel, { discard: true }),
          arm: Effect.fnUntraced(function* (key: string, delay: number, reason: string) {
            if (timers.has(key)) return;
            const token: { fiber?: Fiber.Fiber<void, never> } = {};
            timers.set(key, token);
            const fiber = yield* Effect.sleep(Math.max(0, Math.min(delay, 2_147_483_647))).pipe(
              Effect.andThen(Effect.sync(() => timers.delete(key))),
              Effect.andThen(signal(reason)),
              Effect.interruptible,
              Effect.forkIn(scope)
            );
            token.fiber = fiber;
          }),
          drain: Effect.suspend(() =>
            Effect.forEach([...pending], Deferred.await, { discard: true })
          ),
        } satisfies CoordinatorActivity['Service'];
      })
    );
  }
}

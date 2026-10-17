import { Cause, Data, Deferred, Effect, Exit, Fiber, Scope } from 'effect';
export class LabOperationError extends Data.TaggedError('LabOperationError')<{
  readonly code: 'closed';
}> {}
/** Parent-owned child fibers for finite Lab workflows. Closing rejects admission,
 * aborts native-capability signals, interrupts and awaits every child before earlier
 * owners. One defective finalizer cannot skip the other children or hide its cause. */
export function makeLabOperations() {
  return Effect.gen(function* () {
    const controller = new AbortController();
    const active = new Set<{
      readonly scope: Scope.Closeable;
      readonly close: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>;
    }>();
    yield* Effect.addFinalizer((parentExit) =>
      Effect.gen(function* () {
        controller.abort();
        const exits = yield* Effect.forEach(
          [...active],
          (child) => Effect.exit(child.close(parentExit)),
          { concurrency: 'unbounded' }
        );
        const reasons = exits.flatMap((exit) => (Exit.isFailure(exit) ? exit.cause.reasons : []));
        if (reasons.length > 0) yield* Effect.failCause(Cause.fromReasons(reasons));
      })
    );
    return Object.freeze({
      signal: controller.signal,
      run: <A, E, R>(work: Effect.Effect<A, E, R | Scope.Scope>) =>
        Effect.acquireUseRelease(
          Effect.try({
            try: () => {
              if (controller.signal.aborted) throw new LabOperationError({ code: 'closed' });
              // Admission and registration are synchronous, so parent close cannot
              // observe an empty set between a successful check and registration.
              const scope = Scope.makeUnsafe();
              const completed = Deferred.makeUnsafe<void>();
              let closing = false;
              const child = {
                scope,
                close: (exit: Exit.Exit<unknown, unknown>) =>
                  Effect.uninterruptible(
                    Effect.gen(function* () {
                      if (!closing) {
                        closing = true;
                        const result = yield* Effect.exit(Scope.close(scope, exit));
                        yield* Deferred.done(completed, result);
                        active.delete(child);
                      }
                      return yield* Deferred.await(completed);
                    })
                  ),
              };
              active.add(child);
              return child;
            },
            catch: () => new LabOperationError({ code: 'closed' }),
          }),
          (child) =>
            work.pipe(
              Effect.provideService(Scope.Scope, child.scope),
              Effect.forkIn(child.scope),
              Effect.flatMap(Fiber.join)
            ),
          (child, exit) => child.close(exit)
        ),
    });
  });
}

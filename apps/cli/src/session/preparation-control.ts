import { Cause, Deferred, Effect, Exit, Scope } from 'effect';

/**
 * Preparation-only lifetime. Runtime resources must never be registered here:
 * claiming closes this scope while the adopted runtime continues to initialize.
 */
export const makePreparationControl = (hardTtlMs: number) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const completion = yield* Deferred.make<'expired' | 'closed'>();
    yield* Effect.forkIn(
      Effect.sleep(Math.max(1, hardTtlMs)).pipe(
        Effect.andThen(Deferred.succeed(completion, 'expired'))
      ),
      scope,
      { startImmediately: true }
    );
    return {
      completion: Deferred.await(completion),
      close: Scope.close(scope, Exit.void).pipe(
        Effect.andThen(Deferred.succeed(completion, 'closed')),
        Effect.asVoid
      ),
    };
  });

/**
 * Temporary synchronous admission / Promise cleanup facade for SessionManager.
 * Memoizing the close receipt makes all retirement callers await the same close.
 * @deprecated Effect owners should use makePreparationControl directly.
 */
export function makePreparationControlLegacy(hardTtlMs: number, onExpired: () => void) {
  const control = Effect.runSync(makePreparationControl(hardTtlMs));
  // Notify Promise callers only after leaving the Effect runtime. In particular,
  // expiry may call close(), which is another execution entry at this facade.
  const observed = Effect.runPromiseExit(control.completion).then((exit) => {
    if (Exit.isSuccess(exit) && exit.value === 'expired') onExpired();
  });
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= Effect.runPromiseExit(control.close).then(async (exit) => {
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        await observed;
      })),
  };
}

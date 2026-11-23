import { Effect, Exit, Fiber, Scope, Semaphore } from 'effect';

/** The disposal fiber outlives a timed-out waiter. close retains that receipt even if
 * disposal later succeeds; recover awaits the original fiber, never repeats Scope.close. */
export const makeInboxCloseOwner = Effect.fnUntraced(function* (ports: {
  dispose: Effect.Effect<void, unknown>;
  recover: Effect.Effect<void, unknown>;
}) {
  const lifetime = yield* Scope.make();
  const gate = yield* Semaphore.make(1);
  let raw: Fiber.Fiber<void, unknown> | undefined;
  let original: Exit.Exit<void, unknown> | undefined;
  let recovered = false;
  const awaitRaw = Effect.suspend(() =>
    (raw ? Fiber.await(raw) : Effect.fail(new Error('Inbox disposal has not started'))).pipe(
      Effect.timeoutOrElse({
        duration: 10_000,
        orElse: () => Effect.fail(new Error('Inbox Scope release remains unresolved')),
      }),
      Effect.flatMap((exit) => exit)
    )
  );
  return {
    close: gate.withPermit(
      Effect.gen(function* () {
        if (recovered) return;
        if (original) {
          yield* original;
          return;
        }
        raw ??= yield* ports.dispose.pipe(
          Effect.uninterruptible,
          Effect.forkIn(lifetime, { startImmediately: true })
        );
        original = yield* Effect.exit(awaitRaw);
        if (Exit.isSuccess(original)) yield* Scope.close(lifetime, Exit.void);
        yield* original;
      })
    ),
    recover: gate.withPermit(
      Effect.gen(function* () {
        if (recovered || !raw) return;
        // A failed completed disposal is recoverable; a still-running disposal is not.
        yield* Fiber.await(raw).pipe(
          Effect.timeoutOrElse({
            duration: 10_000,
            orElse: () => Effect.fail(new Error('Inbox Scope release remains unresolved')),
          })
        );
        yield* ports.recover;
        recovered = true;
        yield* Scope.close(lifetime, Exit.void);
      })
    ),
  };
});

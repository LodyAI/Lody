import { Effect, Exit, Semaphore } from 'effect';

/** A failed release retains its phase and original receipt. Recovery is a new attempt. */
export const makeWorkspaceCleanupOwner = Effect.fnUntraced(function* (
  phases: readonly Effect.Effect<void, unknown>[]
) {
  const gate = yield* Semaphore.make(1);
  let phase = 0;
  let original: Exit.Exit<void, unknown> | undefined;
  const failures: unknown[] = [];
  const attempt = Effect.fnUntraced(function* () {
    while (phase < phases.length) {
      const current = phases[phase];
      if (!current) return yield* Effect.die(new Error('Missing workspace cleanup phase'));
      yield* current;
      phase++;
    }
    return undefined;
  });
  const run = (recover: boolean) =>
    gate.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (!recover && original) return yield* original;
          const exit = yield* Effect.exit(attempt());
          if (!original) original = exit;
          if (Exit.isFailure(exit)) failures.push(exit.cause);
          return yield* exit;
        })
      )
    );
  return { close: run(false), recover: run(true), failures };
});

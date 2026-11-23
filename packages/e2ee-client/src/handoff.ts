import { Effect, Exit, Fiber, FiberSet } from 'effect';
import { fail } from './errors';

/** Internal transfer between the retained worker and its interruptible consumer. */
export const handoffOwnedResult = Effect.fnUntraced(function* <A, E, F>(
  tasks: FiberSet.FiberSet<unknown, unknown>,
  operation: Effect.Effect<A, E>,
  guard: Effect.Effect<void, F>,
  dispose: (value: A) => void
) {
  let abandoned = false,
    produced: { readonly value: A } | undefined;
  const work = Effect.acquireUseRelease(
    operation,
    (value) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          produced = { value };
          if (abandoned) return yield* fail('closed');
          yield* guard;
          return value;
        })
      ),
    (value, result) =>
      Effect.sync(() => {
        if (Exit.isFailure(result) || abandoned) {
          dispose(value);
          produced = undefined;
        }
      })
  );
  return yield* Effect.gen(function* () {
    yield* guard;
    const fiber = yield* FiberSet.run(tasks, work);
    return yield* Fiber.join(fiber);
  }).pipe(
    Effect.onExit((result) =>
      Effect.sync(() => {
        // The waiter may disappear before the worker returns or after it publishes.
        // Only a completed producer owns output; cancellation never wipes its borrowed input.
        if (Exit.isFailure(result)) {
          abandoned = true;
          if (produced) dispose(produced.value);
        }
        produced = undefined;
      })
    )
  );
});

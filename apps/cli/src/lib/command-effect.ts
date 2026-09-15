import { Effect, Either } from 'effect';

/**
 * Keep domain errors intact at Promise entrypoints instead of exposing FiberFailure.
 * Interruption/defects are Causes, not Either.Left: callers with durable writes must
 * inspect the completed Exit and recover according to their own acceptance boundary.
 */
export async function runCommandEffect<A, E>(
  effect: Effect.Effect<A, E>,
  options?: { signal?: AbortSignal }
): Promise<A> {
  const result = await Effect.runPromise(Effect.either(effect), options);
  if (Either.isLeft(result)) throw result.left;
  return result.right;
}

/** Foreign Promise failures remain values until the owning stage classifies them. */
export const commandPromise = <A>(run: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: run, catch: (error) => error });

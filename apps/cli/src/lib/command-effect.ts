import { Effect, Either } from 'effect';

/** Keep domain errors intact at Promise entrypoints instead of exposing FiberFailure. */
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

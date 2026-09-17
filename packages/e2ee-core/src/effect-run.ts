import { Cause, Effect, Exit } from 'effect';

/** Promise boundary: unwrap Effect failures so callers still see LedgerError. */
export async function runPromiseThrow<A>(
  effect: Effect.Effect<A, unknown>,
  signal?: AbortSignal
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

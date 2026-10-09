import { Cause, Effect, Exit } from 'effect';

/** Ordinary JS error boundary. Preserve simultaneous failure/defect/cancellation
 * without leaking an Effect Cause object into callers on another major. */
export function boundaryFailure<E>(cause: Cause.Cause<E>): unknown {
  if (cause.reasons.length > 1) {
    return new AggregateError(
      cause.reasons.map((reason) => Cause.squash(Cause.fromReasons([reason]))),
      'Multiple E2EE failures'
    );
  }
  return Cause.squash(cause);
}

/** Promise boundary: unwrap Effect failures so callers still see LedgerError. */
export async function runPromiseThrow<A>(
  effect: Effect.Effect<A, unknown>,
  signal?: AbortSignal
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  throw boundaryFailure(exit.cause);
}

/** Temporary adaptation while deterministic protocol functions migrate to Either.
 * Only known protocol failures become typed errors; bugs remain Effect defects. */
import { Effect } from 'effect';
import { LedgerError } from '../ledger/error';
import { ValidationError } from '../pure/errors';

function failure(error: unknown): Effect.Effect<never, ValidationError> {
  return error instanceof LedgerError
    ? Effect.fail(new ValidationError({ code: error.code, position: error.position }))
    : Effect.die(error);
}
export function protocol<A>(work: () => A): Effect.Effect<A, ValidationError> {
  return Effect.try({ try: work, catch: (error) => error }).pipe(Effect.catchAll(failure));
}
export function protocolAsync<A>(work: () => Promise<A>): Effect.Effect<A, ValidationError> {
  return Effect.tryPromise({ try: work, catch: (error) => error }).pipe(Effect.catchAll(failure));
}

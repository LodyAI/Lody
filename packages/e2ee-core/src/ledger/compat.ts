/** The only value/throw and Promise boundary for the legacy `./ledger` facade.
 * Every protocol computation lives in pure/ or workflows/; this module only
 * runs those descriptions and maps typed failures back to `LedgerError`. */
import { Cause, Effect, Either, Exit, Layer } from 'effect';
import { SignatureVerifier } from '../ports/ledger';
import type { ValidationError } from '../pure/errors';
import { makeSignatureVerifier, type SigningPointCache } from '../platform/signature-verifier';
import { LedgerError } from './error';

export function unwrap<A>(value: Either.Either<A, ValidationError>): A {
  if (Either.isLeft(value)) throw new LedgerError(value.left.code, value.left.position);
  return value.right;
}

function legacyFailure(error: unknown): unknown {
  if (
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    error._tag === 'ValidationError'
  ) {
    const { code, position } = error as ValidationError;
    return new LedgerError(code, position);
  }
  if (typeof error === 'object' && error !== null && '_tag' in error) {
    if (error._tag === 'PendingOperationExists') return new LedgerError('replay');
  }
  return error;
}

function squash<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === 'Some') throw legacyFailure(failure.value);
  throw Cause.squash(exit.cause);
}

/** Runs a self-contained description; expected failures become `LedgerError`. */
export async function runLegacy<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return squash(await Effect.runPromiseExit(effect));
}

/** Synchronous variant for descriptions that perform no asynchronous work. */
export function runLegacySync<A, E>(effect: Effect.Effect<A, E>): A {
  return squash(Effect.runSyncExit(effect));
}

/** In-process verifier for one legacy call; the cache is caller-owned or absent. */
export function legacyVerifierLayer(cache?: SigningPointCache): Layer.Layer<SignatureVerifier> {
  return Layer.succeed(SignatureVerifier, makeSignatureVerifier({ cache }));
}

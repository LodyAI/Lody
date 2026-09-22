/** Temporary throwing boundary; snapshot computation is implemented only in pure/. */
import { Either } from 'effect';
import * as pure from '../pure/ledger-snapshot';
import type { ValidationError } from '../pure/errors';
import type { InternalState } from '../pure/ledger-state';
import type { CborValue } from '../pure/cbor';
import type { Hash, Signature, SigningPublicKey, SigningPointCache } from './crypto';
import { fail } from './error';
export * from '../pure/ledger-snapshot';
export { headAttestationSigningBytes, snapshotSigningBytes } from './crypto';
function unwrap<A>(result: Either.Either<A, ValidationError>): A {
  if (Either.isLeft(result)) fail(result.left.code, result.left.position);
  return result.right;
}
export function encodeSnapshotBody(state: InternalState, signer: SigningPublicKey): Uint8Array {
  return unwrap(pure.encodeSnapshotBody(state, signer));
}
export function digestBodyBytes(state: InternalState): Uint8Array {
  return unwrap(pure.digestBodyBytes(state));
}
export function stateDigestOf(state: InternalState): Hash {
  return unwrap(pure.stateDigestOf(state));
}
export function encodeSignedSnapshot(bodyBytes: Uint8Array, signature: Signature): Uint8Array {
  return unwrap(pure.encodeSignedSnapshot(bodyBytes, signature));
}
export function assertEndorserEligible(state: InternalState, signer: SigningPublicKey): void {
  return unwrap(pure.assertEndorserEligible(state, signer));
}
export function parseSignedSnapshot(
  bytes: Uint8Array,
  cache?: SigningPointCache
): {
  bodyBytes: Uint8Array;
  signature: Signature;
  genesis: Hash;
  length: number;
  head: Hash;
  signer: SigningPublicKey;
  auth: CborValue;
} {
  return unwrap(pure.parseSignedSnapshot(bytes, cache?.schemaFacts));
}
export function snapshotStateFromParsed(
  parsed: ReturnType<typeof parseSignedSnapshot>,
  cache?: SigningPointCache
): InternalState {
  return unwrap(pure.snapshotStateFromParsed(parsed, cache?.schemaFacts));
}
export function decodeSignedSnapshot(
  bytes: Uint8Array,
  cache?: SigningPointCache
): {
  bodyBytes: Uint8Array;
  signature: Signature;
  genesis: Hash;
  length: number;
  head: Hash;
  signer: SigningPublicKey;
  state: InternalState;
} {
  return unwrap(pure.decodeSignedSnapshot(bytes, cache?.schemaFacts));
}

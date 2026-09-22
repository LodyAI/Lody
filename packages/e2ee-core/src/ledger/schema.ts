/** Temporary value/throw adapter; the only schema implementation is pure. */
import { Either } from 'effect';
import * as pure from '../pure/ledger-schema';
import type {
  JoinRequest,
  DeviceKind,
  GenesisFields,
  OrdinaryFields,
  DecodedRecord,
  Body,
} from '../pure/ledger-schema';
import type {
  Hash,
  SigningPublicKey,
  Signature,
  EncryptionPublicKey,
  SigningPointCache,
} from './crypto';
import type { ValidationError } from '../pure/errors';
import { fail } from './error';
import { liveSigningPointCache } from './crypto';
export * from '../pure/ledger-schema';

function unwrap<A>(result: Either.Either<A, ValidationError>): A {
  if (Either.isLeft(result)) fail(result.left.code, result.left.position);
  return result.right;
}
export function joinRequestSigningBytes(
  genesis: Hash,
  request: Omit<JoinRequest, 'signature'>
): Uint8Array {
  return unwrap(pure.joinRequestSigningBytes(genesis, request));
}
export function possessionSigningBytes(input: {
  genesis: Hash;
  targetMembershipId: Uint8Array;
  signingPublicKey: SigningPublicKey;
  encryptionPublicKey: EncryptionPublicKey;
  kind: DeviceKind;
  canManage: boolean;
}): Uint8Array {
  return unwrap(pure.possessionSigningBytes(input));
}
export function encodeGenesisBody(fields: GenesisFields, _cache?: SigningPointCache): Uint8Array {
  return unwrap(pure.encodeGenesisBody(fields));
}
export function encodeOrdinaryBody(fields: OrdinaryFields, _cache?: SigningPointCache): Uint8Array {
  return unwrap(pure.encodeOrdinaryBody(fields));
}
export function encodeSignedRecord(bodyBytes: Uint8Array, signature: Signature): Uint8Array {
  return unwrap(pure.encodeSignedRecord(bodyBytes, signature));
}
export function signingBytesForBody(bodyBytes: Uint8Array): Uint8Array {
  return unwrap(pure.signingBytesForBody(bodyBytes));
}
export function decodeRecord(
  recordBytes: Uint8Array,
  cache = liveSigningPointCache
): DecodedRecord {
  const decoded = unwrap(pure.decodeRecordWithFacts(recordBytes, cache.schemaFacts));
  cache.rememberSchemaFacts(decoded.facts);
  return decoded.record;
}
export function encodeRecord(
  body: Body,
  signature: Signature,
  _cache?: SigningPointCache
): Uint8Array {
  return unwrap(pure.encodeRecord(body, signature));
}

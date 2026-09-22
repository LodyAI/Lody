import { Either } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import { encryptionPublicKey } from './bytes';
import { SigningFacts } from './signing-facts';
import { copyBytes, encodeCbor, type CborValue } from './cbor';
import { ValidationError, type LedgerErrorCode } from './errors';

export const HASH_BYTES = 32;
export const SIGNING_KEY_BYTES = 32;
export const ENCRYPTION_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;
export const MEMBERSHIP_ID_BYTES = 16;
export const REQUEST_ID_BYTES = 16;
export const USER_ID_BYTES = 32;
export const HISTORY_PACKET_BYTES = 72;
export const PROTOCOL_VERSION = 1;
export const EPOCH_U32_MAX = 0xffff_ffff;
export type Hash = Uint8Array;
export type SigningPublicKey = Uint8Array;
export type EncryptionPublicKey = Uint8Array;
export type Signature = Uint8Array;
type Result<A> = Either.Either<A, ValidationError>;
const invalid = (code: LedgerErrorCode): Result<never> =>
  Either.left(new ValidationError({ code }));

export function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

// Domain byte arrays stay private to each calculation, not mutable exported state.
function domain(name: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`lody-e2ee/${name}\0`);
}
function exact(value: Uint8Array, size: number, code: LedgerErrorCode): Result<Uint8Array> {
  return value.byteLength === size ? Either.right(copyBytes(value)) : invalid(code);
}
export const checkSigningPublicKey = (
  value: Uint8Array,
  facts = SigningFacts.empty
): Result<SigningPublicKey> =>
  Either.map(
    Either.mapLeft(facts.check(value), () => new ValidationError({ code: 'invalid-key' })),
    ({ key }) => key.toBytes()
  );
export const checkEncryptionPublicKey = (value: Uint8Array): Result<EncryptionPublicKey> =>
  Either.map(
    Either.mapLeft(encryptionPublicKey(value), () => new ValidationError({ code: 'invalid-key' })),
    (key) => key.toBytes()
  );
export const checkHash = (value: Uint8Array) => exact(value, HASH_BYTES, 'canonical');
export const checkSignature = (value: Uint8Array) => exact(value, SIGNATURE_BYTES, 'canonical');
export const checkMembershipId = (value: Uint8Array) =>
  exact(value, MEMBERSHIP_ID_BYTES, 'canonical');
export const checkUserId = (value: Uint8Array) => exact(value, USER_ID_BYTES, 'canonical');
export const checkRequestId = (value: Uint8Array) => exact(value, REQUEST_ID_BYTES, 'canonical');
export const checkHistoryPacket = (value: Uint8Array) =>
  exact(value, HISTORY_PACKET_BYTES, 'invalid-operation');
export const checkEpoch = (epoch: number, min = 0): Result<number> =>
  Number.isSafeInteger(epoch) && epoch >= min && epoch <= EPOCH_U32_MAX
    ? Either.right(epoch)
    : invalid('invalid-operation');

export const recordSigningBytes = (body: Uint8Array) => concat([domain('sig/v1'), body]);
export const snapshotSigningBytes = (body: Uint8Array) => concat([domain('snapshot/v1'), body]);
export const joinSigningBytes = (payload: CborValue) =>
  Either.map(encodeCbor(payload), (body) => concat([domain('join/v1'), body]));
export const possessSigningBytes = (payload: CborValue) =>
  Either.map(encodeCbor(payload), (body) => concat([domain('possess/v2'), body]));
export function headAttestationSigningBytes(genesis: Hash, head: Hash): Result<Uint8Array> {
  return Either.gen(function* () {
    return concat([domain('head-attest/v1'), yield* checkHash(genesis), yield* checkHash(head)]);
  });
}
export function hashRecordBytes(bytes: Uint8Array): Hash {
  return sha256.create().update(domain('rec/v1')).update(bytes).digest();
}
export function snapshotStateDigest(body: Uint8Array): Hash {
  return sha256.create().update(domain('snapshot-digest/v1')).update(body).digest();
}
export function commitEpochKey(genesis: Hash, epoch: number, secret: Uint8Array): Result<Hash> {
  return Either.gen(function* () {
    if (secret.byteLength !== 32) return yield* invalid('invalid-operation');
    yield* checkEpoch(epoch);
    const epochBytes = new Uint8Array(4);
    new DataView(epochBytes.buffer).setUint32(0, epoch);
    // Epoch zero deliberately does not bind genesis: preserve the protocol.
    const tagged =
      epoch === 0
        ? concat([domain('epoch-key/v1'), secret])
        : concat([domain('epoch-key/v1'), genesis, epochBytes, secret]);
    try {
      return sha256(tagged);
    } finally {
      tagged.fill(0);
    }
  });
}

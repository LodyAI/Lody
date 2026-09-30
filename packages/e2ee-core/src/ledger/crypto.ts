/** Legacy throwing names. Byte rules live in pure/wire-crypto; Ed25519 in platform. */
import * as pure from '../pure/wire-crypto';
import type { CborValue } from '../pure/cbor';
import { SigningFacts } from '../pure/signing-facts';
import { verifySignature, type SigningPointCache } from '../platform/signature-verifier';
import { unwrap } from './compat';
import { LedgerError } from './error';
export { keyId, joinKey } from '../pure/identifiers';
export {
  DEFAULT_SIGNING_POINT_CACHE_LIMIT,
  SigningPointCache,
  createSequentialSignatureVerify,
  isTrustedSignatureVerifyExecutor,
  sequentialSignatureVerify,
  trustSignatureVerifyExecutor,
  verifySignature,
} from '../platform/signature-verifier';
export {
  HASH_BYTES,
  SIGNING_KEY_BYTES,
  ENCRYPTION_KEY_BYTES,
  SIGNATURE_BYTES,
  MEMBERSHIP_ID_BYTES,
  REQUEST_ID_BYTES,
  USER_ID_BYTES,
  HISTORY_PACKET_BYTES,
  PROTOCOL_VERSION,
  EPOCH_U32_MAX,
  concat,
  hashRecordBytes,
  recordSigningBytes,
  snapshotSigningBytes,
  snapshotStateDigest,
} from '../pure/wire-crypto';
export type { Hash, SigningPublicKey, EncryptionPublicKey, Signature } from '../pure/wire-crypto';
export { bytesEqual } from '../pure/cbor';

const text = new TextEncoder();
export const SIGNATURE_DOMAIN = text.encode('lody-e2ee/sig/v1\0');
export const RECORD_HASH_DOMAIN = text.encode('lody-e2ee/rec/v1\0');
export const JOIN_DOMAIN = text.encode('lody-e2ee/join/v1\0');
export const POSSESS_DOMAIN = text.encode('lody-e2ee/possess/v2\0');
export const EPOCH_COMMIT_DOMAIN = text.encode('lody-e2ee/epoch-key/v1\0');
export const HISTORY_AEAD_DOMAIN = text.encode('lody-e2ee/epoch-history/v1\0');
export const SNAPSHOT_DOMAIN = text.encode('lody-e2ee/snapshot/v1\0');
export const SNAPSHOT_DIGEST_DOMAIN = text.encode('lody-e2ee/snapshot-digest/v1\0');
export const HEAD_ATTEST_DOMAIN = text.encode('lody-e2ee/head-attest/v1\0');

export function checkSigningPublicKey(value: Uint8Array): Uint8Array {
  return unwrap(pure.checkSigningPublicKey(value));
}
export const checkEncryptionPublicKey = (value: Uint8Array) =>
  unwrap(pure.checkEncryptionPublicKey(value));
export const checkHash = (value: Uint8Array) => unwrap(pure.checkHash(value));
export const checkSignature = (value: Uint8Array) => unwrap(pure.checkSignature(value));
export const checkMembershipId = (value: Uint8Array) => unwrap(pure.checkMembershipId(value));
export const checkUserId = (value: Uint8Array) => unwrap(pure.checkUserId(value));
export const checkRequestId = (value: Uint8Array) => unwrap(pure.checkRequestId(value));
export const checkHistoryPacket = (value: Uint8Array) => unwrap(pure.checkHistoryPacket(value));
export const checkEpoch = (epoch: number, min = 0) => unwrap(pure.checkEpoch(epoch, min));
export const headAttestationSigningBytes = (genesis: Uint8Array, head: Uint8Array) =>
  unwrap(pure.headAttestationSigningBytes(genesis, head));
export const joinSigningBytes = (payload: CborValue) => unwrap(pure.joinSigningBytes(payload));
export const possessSigningBytes = (payload: CborValue) =>
  unwrap(pure.possessSigningBytes(payload));
export async function hashRecord(recordBytes: Uint8Array): Promise<Uint8Array> {
  return pure.hashRecordBytes(recordBytes);
}
export async function commitEpochKey(
  genesis: Uint8Array,
  epoch: number,
  secret: Uint8Array
): Promise<Uint8Array> {
  return unwrap(pure.commitEpochKey(genesis, epoch, secret));
}

export function assertSignature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
  code: 'bad-signature' | 'bad-proof' = 'bad-signature',
  cache?: SigningPointCache
): void {
  if (!verifySignature(publicKey, message, signature, cache, SigningFacts.empty))
    throw new LedgerError(code);
}

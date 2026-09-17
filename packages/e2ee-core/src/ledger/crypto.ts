import { hashes, Point, verify as nobleVerify } from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import type { SignatureJob, SignatureVerifyExecutor } from '../capabilities';
import { bytesEqual, copyBytes, encodeCbor, type CborValue } from './cbor';
import { fail } from './error';

export const HASH_BYTES = 32;
export const SIGNING_KEY_BYTES = 32;
export const ENCRYPTION_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;
export const MEMBERSHIP_ID_BYTES = 16;
export const REQUEST_ID_BYTES = 16;
export const USER_ID_BYTES = 32;
export const HISTORY_PACKET_BYTES = 72;

const text = new TextEncoder();
const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

hashes.sha512 = (message) => sha512(message);

export const DEFAULT_SIGNING_POINT_CACHE_LIMIT = 8192;

/** Instance-owned prime-subgroup point cache. Disable or bound per experiment. */
export class SigningPointCache {
  private readonly points = new Map<string, Point>();
  readonly enabled: boolean;
  readonly maxEntries: number;

  constructor(options?: { enabled?: boolean; maxEntries?: number }) {
    this.enabled = options?.enabled !== false;
    this.maxEntries = options?.maxEntries ?? DEFAULT_SIGNING_POINT_CACHE_LIMIT;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 0) fail('invalid-operation');
  }

  get size(): number {
    return this.points.size;
  }

  get(bytes: Uint8Array): Point | undefined {
    if (!this.enabled) return undefined;
    return this.points.get(keyId(bytes));
  }

  set(bytes: Uint8Array, point: Point): void {
    if (!this.enabled || this.maxEntries === 0) return;
    if (this.points.size >= this.maxEntries) {
      const first = this.points.keys().next().value;
      if (first !== undefined) this.points.delete(first);
    }
    this.points.set(keyId(bytes), point);
  }
}

export const liveSigningPointCache = new SigningPointCache();

export const PROTOCOL_VERSION = 1;
export const SIGNATURE_DOMAIN = text.encode('lody-e2ee/sig/v1\0');
export const RECORD_HASH_DOMAIN = text.encode('lody-e2ee/rec/v1\0');
export const JOIN_DOMAIN = text.encode('lody-e2ee/join/v1\0');
export const POSSESS_DOMAIN = text.encode('lody-e2ee/possess/v1\0');
export const EPOCH_COMMIT_DOMAIN = text.encode('lody-e2ee/epoch-key/v1\0');
export const HISTORY_AEAD_DOMAIN = text.encode('lody-e2ee/epoch-history/v1\0');
export const SNAPSHOT_DOMAIN = text.encode('lody-e2ee/snapshot/v1\0');
export const SNAPSHOT_DIGEST_DOMAIN = text.encode('lody-e2ee/snapshot-digest/v1\0');
export const HEAD_ATTEST_DOMAIN = text.encode('lody-e2ee/head-attest/v1\0');

export type Hash = Uint8Array;
export type SigningPublicKey = Uint8Array;
export type EncryptionPublicKey = Uint8Array;
export type Signature = Uint8Array;

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function validSigningPoint(
  bytes: Uint8Array,
  cache: SigningPointCache = liveSigningPointCache
): boolean {
  if (bytes.byteLength !== SIGNING_KEY_BYTES) return false;
  if (cache.get(bytes)) return true;
  try {
    const point = Point.fromBytes(bytes, false);
    if (point.isSmallOrder() || !point.isTorsionFree()) return false;
    cache.set(bytes, point);
    return true;
  } catch {
    return false;
  }
}

export function checkSigningPublicKey(
  value: Uint8Array,
  cache: SigningPointCache = liveSigningPointCache
): SigningPublicKey {
  if (value.byteLength !== SIGNING_KEY_BYTES || !validSigningPoint(value, cache))
    fail('invalid-key');
  return copyBytes(value);
}

export function checkEncryptionPublicKey(value: Uint8Array): EncryptionPublicKey {
  if (value.byteLength !== ENCRYPTION_KEY_BYTES) fail('invalid-key');
  let nonzero = false;
  for (const byte of value) if (byte !== 0) nonzero = true;
  if (!nonzero) fail('invalid-key');
  return copyBytes(value);
}

export function checkHash(value: Uint8Array): Hash {
  if (value.byteLength !== HASH_BYTES) fail('canonical');
  return copyBytes(value);
}

export function checkSignature(value: Uint8Array): Signature {
  if (value.byteLength !== SIGNATURE_BYTES) fail('canonical');
  return copyBytes(value);
}

export function checkMembershipId(value: Uint8Array): Uint8Array {
  if (value.byteLength !== MEMBERSHIP_ID_BYTES) fail('canonical');
  return copyBytes(value);
}

export function checkUserId(value: Uint8Array): Uint8Array {
  if (value.byteLength !== USER_ID_BYTES) fail('canonical');
  return copyBytes(value);
}

export function checkRequestId(value: Uint8Array): Uint8Array {
  if (value.byteLength !== REQUEST_ID_BYTES) fail('canonical');
  return copyBytes(value);
}

export function checkHistoryPacket(value: Uint8Array): Uint8Array {
  if (value.byteLength !== HISTORY_PACKET_BYTES) fail('invalid-operation');
  return copyBytes(value);
}

export function recordSigningBytes(bodyBytes: Uint8Array): Uint8Array {
  return concat([SIGNATURE_DOMAIN, bodyBytes]);
}

export function snapshotSigningBytes(bodyBytes: Uint8Array): Uint8Array {
  return concat([SNAPSHOT_DOMAIN, bodyBytes]);
}

export function headAttestationSigningBytes(genesis: Hash, head: Hash): Uint8Array {
  return concat([HEAD_ATTEST_DOMAIN, checkHash(genesis), checkHash(head)]);
}

export function snapshotStateDigest(bodyWithoutSigner: Uint8Array): Hash {
  const digest = sha256.create();
  digest.update(SNAPSHOT_DIGEST_DOMAIN);
  digest.update(bodyWithoutSigner);
  return digest.digest();
}

export function joinSigningBytes(payload: CborValue): Uint8Array {
  return concat([JOIN_DOMAIN, encodeCbor(payload)]);
}

export function possessSigningBytes(payload: CborValue): Uint8Array {
  return concat([POSSESS_DOMAIN, encodeCbor(payload)]);
}

export function hashRecordBytes(recordBytes: Uint8Array): Hash {
  const digest = sha256.create();
  digest.update(RECORD_HASH_DOMAIN);
  digest.update(recordBytes);
  return digest.digest();
}

export async function hashRecord(recordBytes: Uint8Array): Promise<Hash> {
  return hashRecordBytes(recordBytes);
}

export async function commitEpochKey(
  genesis: Hash,
  epoch: number,
  secret: Uint8Array
): Promise<Hash> {
  if (secret.byteLength !== 32) fail('invalid-operation');
  if (!Number.isSafeInteger(epoch) || epoch < 0) fail('invalid-operation');
  let tagged: Uint8Array<ArrayBuffer>;
  if (epoch === 0) {
    tagged = concat([EPOCH_COMMIT_DOMAIN, secret]);
  } else {
    const epochBytes = new Uint8Array(4);
    new DataView(epochBytes.buffer).setUint32(0, epoch);
    tagged = concat([EPOCH_COMMIT_DOMAIN, genesis, epochBytes, secret]);
  }
  try {
    return sha256(tagged);
  } finally {
    tagged.fill(0);
  }
}

export function verifySignature(
  publicKey: SigningPublicKey,
  message: Uint8Array,
  signature: Signature,
  cache: SigningPointCache = liveSigningPointCache
): boolean {
  if (signature.byteLength !== SIGNATURE_BYTES) return false;
  if (!validSigningPoint(publicKey, cache)) return false;
  try {
    if (!Point.fromBytes(signature.subarray(0, 32), false).isTorsionFree()) return false;
  } catch {
    return false;
  }
  try {
    return nobleVerify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

const trustedSignatureVerifiers = new WeakSet<SignatureVerifyExecutor>();

export function isTrustedSignatureVerifyExecutor(executor: SignatureVerifyExecutor): boolean {
  return trustedSignatureVerifiers.has(executor);
}

/** Only sequential/Node factories may call this. Do not re-export from the package. */
export function trustSignatureVerifyExecutor<T extends SignatureVerifyExecutor>(executor: T): T {
  trustedSignatureVerifiers.add(executor);
  return executor;
}

export function createSequentialSignatureVerify(
  cache: SigningPointCache = liveSigningPointCache
): SignatureVerifyExecutor {
  return trustSignatureVerifyExecutor(
    Object.freeze({
      async verify(jobs: readonly SignatureJob[]): Promise<boolean[]> {
        return jobs.map((job) => verifySignature(job.pk, job.msg, job.sig, cache));
      },
    })
  );
}

export const sequentialSignatureVerify: SignatureVerifyExecutor = createSequentialSignatureVerify();

export function assertSignature(
  publicKey: SigningPublicKey,
  message: Uint8Array,
  signature: Signature,
  code: 'bad-signature' | 'bad-proof' = 'bad-signature',
  cache: SigningPointCache = liveSigningPointCache
): void {
  if (!verifySignature(publicKey, message, signature, cache)) fail(code);
}

export function keyId(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.byteLength; i++) hex += HEX[bytes[i]!]!;
  return hex;
}

export function joinKey(signingPublicKey: Uint8Array, requestId: Uint8Array): string {
  return `${keyId(signingPublicKey)}:${keyId(requestId)}`;
}

export { bytesEqual, concat };

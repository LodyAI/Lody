import { encode } from '@ipld/dag-cbor';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Data, Result } from 'effect';

/**
 * Account-wide personal device pairing primitives (owner-approved 2026-11-01,
 * `specs/e2ee-foundations.md`). Pure and synchronous: the pairing string, the
 * secret's domain-separated keys, the canonical request and approval, and
 * their HMAC tags. No network, storage or ledger authority lives here.
 */

/** Why a pairing string, request or tag was refused. `code` never carries secret material. */
export class PairingError extends Data.TaggedError('PairingError')<{
  readonly code:
    | 'length'
    | 'character'
    | 'checksum'
    | 'version'
    | 'invalid-input'
    | 'authentication'
    | 'expired';
}> {}
const fail = (code: PairingError['code']) => Result.fail(new PairingError({ code }));

/** Characters in a pairing string, excluding separators. */
export const PAIRING_STRING_LENGTH = 28;
/** QR payload prefix; the plain string is accepted wherever the QR form is. */
export const PAIRING_URL_PREFIX = 'lody://pair/';
/** Longest allowed request lifetime: 10 minutes. */
export const PAIRING_REQUEST_MAX_LIFETIME_MS = 10 * 60_000;
/** Clock disagreement tolerated when checking a request's original expiry. */
export const PAIRING_CLOCK_SKEW_MS = 60_000;

const SECRET_BYTES = 16;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const VERSION = 0;
const text = new TextEncoder();
const CHECK_DOMAIN = text.encode('lody-e2ee/pair-check/v1\0');
const HKDF_SALT = text.encode('lody-e2ee/pair/v1\0');
const REQUEST_DOMAIN = 'lody-e2ee/pair-request/v1';
const APPROVAL_DOMAIN = 'lody-e2ee/pair-approval/v1';

const isBytes = (value: unknown, size?: number): value is Uint8Array =>
  value instanceof Uint8Array && (size === undefined || value.length === size);
const toBigInt = (bytes: Uint8Array) =>
  bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
const checkBits = (version: number, secret: Uint8Array) => {
  const input = new Uint8Array(CHECK_DOMAIN.length + 1 + SECRET_BYTES);
  input.set(CHECK_DOMAIN);
  input[CHECK_DOMAIN.length] = version;
  input.set(secret, CHECK_DOMAIN.length + 1);
  const digest = sha256(input);
  input.fill(0);
  return (digest[0]! << 2) | (digest[1]! >> 6);
};
const constantTimeEqual = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
  return difference === 0;
};

/**
 * Encode a fresh 16-byte secret as the 28-character pairing string: 26 Crockford
 * base32 characters for a 2-bit version plus the secret, then two check
 * characters (10 bits of a domain-separated SHA-256). The caller owns `secret`.
 */
export function encodePairingSecret(secret: Uint8Array): Result.Result<string, PairingError> {
  if (!isBytes(secret, SECRET_BYTES)) return fail('invalid-input');
  const value = (BigInt(VERSION) << 128n) | toBigInt(secret);
  let body = '';
  for (let index = 25; index >= 0; index--)
    body += ALPHABET[Number((value >> BigInt(5 * index)) & 31n)];
  const check = checkBits(VERSION, secret);
  return Result.succeed(body + ALPHABET[check >> 5] + ALPHABET[check & 31]);
}

/** Display form: seven groups of four separated by dashes. */
export const formatPairingString = (value: string) => value.match(/.{1,4}/g)?.join('-') ?? '';

/** QR payload for a pairing string. */
export const pairingQrPayload = (value: string) => `${PAIRING_URL_PREFIX}${value}`;

/**
 * Parse a scanned or pasted pairing string back to its 16-byte secret. Accepts
 * the QR URL, any case, spaces and dashes, and reads `O` as `0` and `I`/`L` as
 * `1`. Fails with `length`, `character`, `version` or `checksum` so the UI can
 * tell the user what to fix before any network request.
 */
export function parsePairingString(input: string): Result.Result<Uint8Array, PairingError> {
  if (typeof input !== 'string') return fail('invalid-input');
  let value = input.trim();
  if (value.toLowerCase().startsWith(PAIRING_URL_PREFIX))
    value = value.slice(PAIRING_URL_PREFIX.length);
  value = value.replace(/[\s-]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
  if (value.length !== PAIRING_STRING_LENGTH) return fail('length');
  const digits: number[] = [];
  for (const character of value) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) return fail('character');
    digits.push(digit);
  }
  let decoded = 0n;
  for (const digit of digits.slice(0, 26)) decoded = (decoded << 5n) | BigInt(digit);
  const version = Number(decoded >> 128n);
  if (version !== VERSION) return fail('version');
  const secret = new Uint8Array(SECRET_BYTES);
  for (let index = SECRET_BYTES - 1; index >= 0; index--) {
    secret[index] = Number(decoded & 0xffn);
    decoded >>= 8n;
  }
  if (checkBits(version, secret) !== ((digits[26]! << 5) | digits[27]!)) {
    secret.fill(0);
    return fail('checksum');
  }
  return Result.succeed(secret);
}

/** Keys derived from one pairing secret. Dispose with {@link disposePairingKeys}. */
export interface PairingKeys {
  /** The only value the service sees; indexes the request under the account. */
  readonly lookupId: Uint8Array;
  readonly requestKey: Uint8Array;
  readonly approvalKey: Uint8Array;
}

// RFC 5869 with SHA-256 and output of at most 32 bytes: one expand block. Every
// intermediate is written into a buffer owned and wiped here.
const hkdf32 = (secret: Uint8Array, label: string, length: number) => {
  const info = text.encode(label);
  const prk = new Uint8Array(32),
    block = new Uint8Array(32),
    message = new Uint8Array(info.length + 1);
  try {
    hmac.create(sha256, HKDF_SALT).update(secret).digestInto(prk);
    message.set(info);
    message[info.length] = 1;
    hmac.create(sha256, prk).update(message).digestInto(block);
    return block.slice(0, length);
  } finally {
    prk.fill(0);
    block.fill(0);
    message.fill(0);
  }
};

/**
 * Derive the lookup ID, request key and approval key from a pairing secret with
 * HKDF-SHA256, salt `lody-e2ee/pair/v1\0`, and the distinct labels `lookup`,
 * `request-mac` and `approval-mac`. The caller keeps owning `secret`.
 */
export function derivePairingKeys(secret: Uint8Array): Result.Result<PairingKeys, PairingError> {
  if (!isBytes(secret, SECRET_BYTES)) return fail('invalid-input');
  return Result.succeed({
    lookupId: hkdf32(secret, 'lookup', 16),
    requestKey: hkdf32(secret, 'request-mac', 32),
    approvalKey: hkdf32(secret, 'approval-mac', 32),
  });
}

/** Wipe derived keys; the lookup ID is public and kept. */
export function disposePairingKeys(keys: PairingKeys) {
  keys.requestKey.fill(0);
  keys.approvalKey.fill(0);
}

/** One workspace in a pairing request: the new device's keys and proofs for that genesis. */
export interface PairingRequestRow {
  readonly genesis: Uint8Array;
  readonly signingPublicKey: Uint8Array;
  readonly encryptionPublicKey: Uint8Array;
  readonly possessionProof: Uint8Array;
  readonly credentialHash: Uint8Array;
}
/** The account-scoped request a new device submits. Every field is covered by its tag. */
export interface PairingRequest {
  readonly account: string;
  readonly lookupId: Uint8Array;
  /** Which side displayed the pairing string. */
  readonly direction: 'requester-shows' | 'approver-shows';
  /** Provided by the requesting device; display only. */
  readonly deviceName: string;
  /** Original expiry in milliseconds since the epoch. */
  readonly expiresAt: number;
  readonly rows: readonly PairingRequestRow[];
}
/** One approved workspace: the admission record and snapshot invitation the approver published. */
export interface PairingApprovalRow {
  readonly genesis: Uint8Array;
  readonly admissionRecordHash: Uint8Array;
  readonly invitationDigest: Uint8Array;
}
/** What an approver's tag binds for the new device. */
export interface PairingApproval {
  readonly requestDigest: Uint8Array;
  readonly approverSigningPublicKey: Uint8Array;
  readonly rows: readonly PairingApprovalRow[];
}

const MAX_ROWS = 256;
const compareBytes = (a: Uint8Array, b: Uint8Array) => {
  for (let index = 0; index < Math.min(a.length, b.length); index++)
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
};
const sortedUnique = <T extends { readonly genesis: Uint8Array }>(rows: readonly T[]) => {
  const sorted = [...rows].sort((a, b) => compareBytes(a.genesis, b.genesis));
  for (let index = 1; index < sorted.length; index++)
    if (compareBytes(sorted[index - 1]!.genesis, sorted[index]!.genesis) === 0) return undefined;
  return sorted;
};
const boundedText = (value: unknown, max: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/**
 * Canonical DAG-CBOR bytes of a request: a fixed tuple with the domain, account,
 * lookup ID, direction, device name, expiry and rows sorted by genesis.
 * Malformed input fails with `invalid-input`; nothing is repaired.
 */
export function encodePairingRequest(
  request: PairingRequest
): Result.Result<Uint8Array, PairingError> {
  const rows = Array.isArray(request?.rows) ? sortedUnique(request.rows) : undefined;
  if (
    !rows ||
    rows.length === 0 ||
    rows.length > MAX_ROWS ||
    !boundedText(request.account, 256) ||
    !boundedText(request.deviceName, 128) ||
    !isBytes(request.lookupId, 16) ||
    (request.direction !== 'requester-shows' && request.direction !== 'approver-shows') ||
    !Number.isSafeInteger(request.expiresAt) ||
    request.expiresAt < 0 ||
    rows.some(
      (row) =>
        !isBytes(row.genesis, 32) ||
        !isBytes(row.signingPublicKey, 32) ||
        !isBytes(row.encryptionPublicKey, 32) ||
        !isBytes(row.credentialHash, 32) ||
        !isBytes(row.possessionProof) ||
        row.possessionProof.length === 0 ||
        row.possessionProof.length > 1024
    )
  )
    return fail('invalid-input');
  return Result.succeed(
    encode([
      REQUEST_DOMAIN,
      request.account,
      request.lookupId,
      request.direction,
      request.deviceName,
      request.expiresAt,
      rows.map((row) => [
        row.genesis,
        row.signingPublicKey,
        row.encryptionPublicKey,
        row.possessionProof,
        row.credentialHash,
      ]),
    ])
  );
}

/** SHA-256 of the canonical request; the approval binds this digest. */
export const pairingRequestDigest = (request: PairingRequest) =>
  Result.map(encodePairingRequest(request), (bytes) => sha256(bytes));

/** Canonical DAG-CBOR bytes of an approval, rows sorted by genesis. */
export function encodePairingApproval(
  approval: PairingApproval
): Result.Result<Uint8Array, PairingError> {
  const rows = Array.isArray(approval?.rows) ? sortedUnique(approval.rows) : undefined;
  if (
    !rows ||
    rows.length === 0 ||
    rows.length > MAX_ROWS ||
    !isBytes(approval.requestDigest, 32) ||
    !isBytes(approval.approverSigningPublicKey, 32) ||
    rows.some(
      (row) =>
        !isBytes(row.genesis, 32) ||
        !isBytes(row.admissionRecordHash, 32) ||
        !isBytes(row.invitationDigest, 32)
    )
  )
    return fail('invalid-input');
  return Result.succeed(
    encode([
      APPROVAL_DOMAIN,
      approval.requestDigest,
      approval.approverSigningPublicKey,
      rows.map((row) => [row.genesis, row.admissionRecordHash, row.invitationDigest]),
    ])
  );
}

const tag = (key: Uint8Array, bytes: Uint8Array) => hmac(sha256, key, bytes);
const verifyTag = (expected: Uint8Array, actual: Uint8Array) =>
  isBytes(actual, 32) && constantTimeEqual(expected, actual)
    ? Result.succeed(undefined)
    : fail('authentication');

/** `HMAC-SHA256(requestKey, canonical request)`. */
export const pairingRequestTag = (keys: PairingKeys, request: PairingRequest) =>
  Result.map(encodePairingRequest(request), (bytes) => tag(keys.requestKey, bytes));

/** Verify a request tag in constant time; any changed field fails with `authentication`. */
export const verifyPairingRequestTag = (
  keys: PairingKeys,
  request: PairingRequest,
  actual: Uint8Array
) => Result.flatMap(pairingRequestTag(keys, request), (expected) => verifyTag(expected, actual));

/** `HMAC-SHA256(approvalKey, canonical approval)`. */
export const pairingApprovalTag = (keys: PairingKeys, approval: PairingApproval) =>
  Result.map(encodePairingApproval(approval), (bytes) => tag(keys.approvalKey, bytes));

/** Verify an approval tag in constant time; a request tag never verifies here. */
export const verifyPairingApprovalTag = (
  keys: PairingKeys,
  approval: PairingApproval,
  actual: Uint8Array
) => Result.flatMap(pairingApprovalTag(keys, approval), (expected) => verifyTag(expected, actual));

/**
 * Client-side check of a request's original, tag-covered expiry. The request
 * must still be open (`now < expiresAt`) and its expiry at most 10 minutes plus
 * the clock-skew allowance away. Each client runs this itself; the service's
 * view of the request state is never trusted.
 */
export function checkPairingRequestLifetime(
  request: Pick<PairingRequest, 'expiresAt'>,
  now: number
): Result.Result<void, PairingError> {
  if (!Number.isSafeInteger(request.expiresAt) || !Number.isSafeInteger(now))
    return fail('invalid-input');
  if (request.expiresAt <= now) return fail('expired');
  if (request.expiresAt - now > PAIRING_REQUEST_MAX_LIFETIME_MS + PAIRING_CLOCK_SKEW_MS)
    return fail('invalid-input');
  return Result.succeed(undefined);
}

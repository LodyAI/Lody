import { Brand, Result } from 'effect';
import { Point } from '@noble/ed25519';
import { ValidationError } from './errors';
import { keyId } from './identifiers';
import { OwnedBytes } from './owned-bytes';

/** A device's Ed25519 public key (32 bytes); also its device id in hex. */
export type SigningPublicKey = OwnedBytes<'SigningPublicKey'>;
/** A nonzero 32-byte X25519 public key; shape validation alone does not establish device membership. */
export type EncryptionPublicKey = OwnedBytes<'EncryptionPublicKey'>;
/** A 64-byte Ed25519 signature frame; its length alone proves neither validity nor authority. */
export type Signature = OwnedBytes<'Signature'>;
/** Hash of a workspace's genesis record: the workspace identity every protocol object is bound to. */
export type GenesisHash = OwnedBytes<'GenesisHash'>;
/** The 32-byte hash identifying exact signed ledger-record bytes. */
export type RecordHash = OwnedBytes<'RecordHash'>;
/** A 32-byte epoch-key commitment; validate its binding against a genuine ledger before use. */
export type EpochCommitment = OwnedBytes<'EpochCommitment'>;
export { epochKey, type EpochKey } from './epoch-key';
/** A 16-byte membership identifier scoped by the workspace ledger. */
export type MembershipId = OwnedBytes<'MembershipId'>;
/** A 16-byte admission request identifier; replay rules are enforced by the ledger. */
export type RequestId = OwnedBytes<'RequestId'>;
/** A 16-byte stable envelope delivery identifier, reused for retries of the same original. */
export type DeliveryId = OwnedBytes<'DeliveryId'>;
/** A 32-byte user identifier; it does not by itself prove an account or membership. */
export type UserId = OwnedBytes<'UserId'>;
/** An unsigned 32-bit integer epoch number; parse with epochNumber before use. */
export type EpochNumber = number & Brand.Brand<'EpochNumber'>;
const epochBrand = Brand.nominal<EpochNumber>();
// Only exact bytes that passed the fixed point checks enter this bounded cache.
// A cache hit proves key shape, never signer authority or signature validity.
const SIGNING_KEY_CACHE_LIMIT = 256;
const validatedSigningKeys = new Set<string>();

function exact<K extends string>(
  kind: K,
  size: number,
  input: unknown
): Result.Result<OwnedBytes<K>, ValidationError> {
  if (!(input instanceof Uint8Array) || input.byteLength !== size) {
    return Result.fail(new ValidationError({ code: 'canonical' }));
  }
  return Result.succeed(new OwnedBytes(kind, input));
}

/** Copy and validate a canonical nonzero prime-subgroup Ed25519 key; returns canonical or invalid-key errors without repairing bytes. */
export function signingPublicKey(input: unknown): Result.Result<SigningPublicKey, ValidationError> {
  return Result.gen(function* () {
    const key = yield* exact('SigningPublicKey', 32, input);
    const bytes = key.toBytes();
    const id = keyId(bytes);
    if (validatedSigningKeys.has(id)) return key;
    const valid = Result.try({
      try: () => {
        const point = Point.fromBytes(bytes, false);
        return !point.isSmallOrder() && point.isTorsionFree();
      },
      catch: () => new ValidationError({ code: 'invalid-key' }),
    });
    if (!(yield* valid)) return yield* Result.fail(new ValidationError({ code: 'invalid-key' }));
    if (validatedSigningKeys.size === SIGNING_KEY_CACHE_LIMIT)
      validatedSigningKeys.delete(validatedSigningKeys.values().next().value!);
    validatedSigningKeys.add(id);
    return key;
  });
}

/** Copy a nonzero 32-byte X25519 key under the current wire policy; does not prove ownership or perform ledger authorization. */
export function encryptionPublicKey(
  input: unknown
): Result.Result<EncryptionPublicKey, ValidationError> {
  return Result.gen(function* () {
    const key = yield* exact('EncryptionPublicKey', 32, input);
    // Preserve the current wire policy; low-order hardening is a separate change.
    if (!key.toBytes().some((byte) => byte !== 0)) {
      return yield* Result.fail(new ValidationError({ code: 'invalid-key' }));
    }
    return key;
  });
}

/** Copy exactly 64 bytes as a signature; wrong type or length returns canonical, and parsing grants no authority. */
export const signature = (input: unknown) => exact('Signature', 64, input);
/** Copy exactly 32 bytes as a genesis hash; wrong type or length returns canonical, and parsing grants no authority. */
export const genesisHash = (input: unknown) => exact('GenesisHash', 32, input);
/** Copy exactly 32 bytes as a record hash; wrong type or length returns canonical, and parsing grants no authority. */
export const recordHash = (input: unknown) => exact('RecordHash', 32, input);
/** Copy exactly 32 bytes as a epoch commitment; wrong type or length returns canonical, and parsing grants no authority. */
export const epochCommitment = (input: unknown) => exact('EpochCommitment', 32, input);
/** Copy exactly 16 bytes as a membership id; wrong type or length returns canonical, and parsing grants no authority. */
export const membershipId = (input: unknown) => exact('MembershipId', 16, input);
/** Copy exactly 16 bytes as a request id; wrong type or length returns canonical, and parsing grants no authority. */
export const requestId = (input: unknown) => exact('RequestId', 16, input);
/** Copy exactly 16 bytes as a delivery id; wrong type or length returns canonical, and parsing grants no authority. */
export const deliveryId = (input: unknown) => exact('DeliveryId', 16, input);
/** Copy exactly 32 bytes as a user id; wrong type or length returns canonical, and parsing grants no authority. */
export const userId = (input: unknown) => exact('UserId', 32, input);

/** Accept an integer from 0 through 2^32−1; otherwise return invalid-operation without coercion. */
export function epochNumber(input: unknown): Result.Result<EpochNumber, ValidationError> {
  return typeof input === 'number' &&
    Number.isSafeInteger(input) &&
    input >= 0 &&
    input <= 0xffff_ffff
    ? Result.succeed(epochBrand(input))
    : Result.fail(new ValidationError({ code: 'invalid-operation' }));
}

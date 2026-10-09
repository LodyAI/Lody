import { Brand, Result } from 'effect';
import { Point } from '@noble/ed25519';
import { ValidationError } from './errors';

/** Unexported constructor: successful parsers are the only public constructors. */
class OwnedBytes<K extends string> implements Brand.Brand<K> {
  declare readonly ['~effect/Brand']: { readonly [P in K]: K };
  readonly #bytes: Uint8Array<ArrayBuffer>;

  constructor(
    readonly kind: K,
    bytes: Uint8Array
  ) {
    this.#bytes = new Uint8Array(bytes);
    Object.freeze(this);
  }

  toBytes(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.#bytes);
  }

  equals(other: OwnedBytes<K>): boolean {
    if (this.kind !== other.kind || this.#bytes.length !== other.#bytes.length) return false;
    return this.#bytes.every((value, i) => value === other.#bytes[i]);
  }
}

export type SigningPublicKey = OwnedBytes<'SigningPublicKey'>;
export type EncryptionPublicKey = OwnedBytes<'EncryptionPublicKey'>;
export type Signature = OwnedBytes<'Signature'>;
export type GenesisHash = OwnedBytes<'GenesisHash'>;
export type RecordHash = OwnedBytes<'RecordHash'>;
export type EpochCommitment = OwnedBytes<'EpochCommitment'>;
export { epochKey, type EpochKey } from './epoch-key';
export type MembershipId = OwnedBytes<'MembershipId'>;
export type RequestId = OwnedBytes<'RequestId'>;
export type DeliveryId = OwnedBytes<'DeliveryId'>;
export type UserId = OwnedBytes<'UserId'>;
export type EpochNumber = number & Brand.Brand<'EpochNumber'>;
const epochBrand = Brand.nominal<EpochNumber>();

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

export function signingPublicKey(input: unknown): Result.Result<SigningPublicKey, ValidationError> {
  return Result.gen(function* () {
    const key = yield* exact('SigningPublicKey', 32, input);
    const valid = Result.try({
      try: () => {
        const point = Point.fromBytes(key.toBytes(), false);
        return !point.isSmallOrder() && point.isTorsionFree();
      },
      catch: () => new ValidationError({ code: 'invalid-key' }),
    });
    if (!(yield* valid)) return yield* Result.fail(new ValidationError({ code: 'invalid-key' }));
    return key;
  });
}

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

export const signature = (input: unknown) => exact('Signature', 64, input);
export const genesisHash = (input: unknown) => exact('GenesisHash', 32, input);
export const recordHash = (input: unknown) => exact('RecordHash', 32, input);
export const epochCommitment = (input: unknown) => exact('EpochCommitment', 32, input);
export const membershipId = (input: unknown) => exact('MembershipId', 16, input);
export const requestId = (input: unknown) => exact('RequestId', 16, input);
export const deliveryId = (input: unknown) => exact('DeliveryId', 16, input);
export const userId = (input: unknown) => exact('UserId', 32, input);

export function epochNumber(input: unknown): Result.Result<EpochNumber, ValidationError> {
  return typeof input === 'number' &&
    Number.isSafeInteger(input) &&
    input >= 0 &&
    input <= 0xffff_ffff
    ? Result.succeed(epochBrand(input))
    : Result.fail(new ValidationError({ code: 'invalid-operation' }));
}

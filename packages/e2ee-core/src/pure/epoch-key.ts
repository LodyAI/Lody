import { Brand, Either } from 'effect';
import { ValidationError } from './errors';

const material = Symbol('epoch-key-material');
class EpochKeyValue implements Brand.Brand<'EpochKey'> {
  declare readonly [Brand.BrandTypeId]: { readonly EpochKey: 'EpochKey' };
  readonly #bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.#bytes = new Uint8Array(bytes);
    Object.freeze(this);
  }
  [material](): Uint8Array {
    return new Uint8Array(this.#bytes);
  }
}

/** A secret, not a public byte identifier. No public byte-export method. */
export type EpochKey = EpochKeyValue;
export function epochKey(input: unknown): Either.Either<EpochKey, ValidationError> {
  return input instanceof Uint8Array && input.length === 32
    ? Either.right(new EpochKeyValue(input))
    : Either.left(new ValidationError({ code: 'canonical' }));
}

/** Package-internal crypto/persistence boundary; never re-export from an entrypoint. */
export function copyEpochKeyBytes(key: EpochKey): Uint8Array {
  return key[material]();
}

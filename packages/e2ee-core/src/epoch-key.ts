import { Brand, Result } from 'effect';
import { ValidationError } from './errors';

const material = Symbol('epoch-key-material');
class EpochKeyValue implements Brand.Brand<'EpochKey'> {
  declare readonly ['~effect/Brand']: { readonly EpochKey: 'EpochKey' };
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
export function epochKey(input: unknown): Result.Result<EpochKey, ValidationError> {
  return input instanceof Uint8Array && input.length === 32
    ? Result.succeed(new EpochKeyValue(input))
    : Result.fail(new ValidationError({ code: 'canonical' }));
}

/** Package-internal crypto/persistence boundary; never re-export from an entrypoint. */
export function copyEpochKeyBytes(key: EpochKey): Uint8Array {
  return key[material]();
}

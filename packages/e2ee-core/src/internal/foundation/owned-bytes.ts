import type { Brand } from 'effect';

/** Not exported by any public entry: the parsers in `bytes.ts` are the public constructors. */
export class OwnedBytes<K extends string> implements Brand.Brand<K> {
  declare readonly ['~effect/Brand']: { readonly [P in K]: K };
  readonly #bytes: Uint8Array<ArrayBuffer>;

  constructor(
    readonly kind: K,
    bytes: Uint8Array
  ) {
    this.#bytes = new Uint8Array(bytes);
    Object.freeze(this);
  }

  /** Return a fresh owned copy; modifying it cannot change this value. */
  toBytes(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.#bytes);
  }

  /** Compare kind and bytes for equality; this is not an authorization check. */
  equals(other: OwnedBytes<K>): boolean {
    if (this.kind !== other.kind || this.#bytes.length !== other.#bytes.length) return false;
    return this.#bytes.every((value, i) => value === other.#bytes[i]);
  }
}

/** A signing key from the caller's own retained state, which already passed
 * `signingPublicKey` when its record was verified. Length only; skips the curve check. */
export const retainedSigningPublicKey = (bytes: Uint8Array) =>
  new OwnedBytes('SigningPublicKey', bytes) as OwnedBytes<'SigningPublicKey'>;

import { Either, HashMap, Option } from 'effect';
import { signingPublicKey, type SigningPublicKey } from './bytes';
import { keyId } from './identifiers';
import type { ValidationError } from './errors';

/** Immutable evidence of point validity, never membership or signature authority.
 * Updates share structure but never mutate a caller's collection. */
export class SigningFacts {
  static readonly empty = new SigningFacts(HashMap.empty());
  private constructor(readonlyMap: HashMap.HashMap<string, SigningPublicKey>) {
    this.#keys = readonlyMap;
    Object.freeze(this);
  }
  readonly #keys: HashMap.HashMap<string, SigningPublicKey>;
  get size(): number {
    return HashMap.size(this.#keys);
  }
  /** Exact-byte evidence only; no caller-supplied boolean or mutable key escapes. */
  has(bytes: Uint8Array): boolean {
    return HashMap.has(this.#keys, keyId(bytes));
  }
  check(bytes: Uint8Array): Either.Either<
    {
      readonly key: SigningPublicKey;
      readonly facts: SigningFacts;
    },
    ValidationError
  > {
    const id = keyId(bytes);
    const known = HashMap.get(this.#keys, id);
    if (Option.isSome(known)) return Either.right({ key: known.value, facts: this });
    return Either.map(signingPublicKey(bytes), (key) => ({
      key,
      facts: new SigningFacts(HashMap.set(this.#keys, id, key)),
    }));
  }
}

import { Result, HashMap, Option } from 'effect';
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
  /** Both operands only hold checked keys, so the union is checked evidence too. */
  union(other: SigningFacts): SigningFacts {
    if (other.size === 0 || other === this) return this;
    if (this.size === 0) return other;
    return new SigningFacts(HashMap.union(this.#keys, other.#keys));
  }
  check(bytes: Uint8Array): Result.Result<
    {
      readonly key: SigningPublicKey;
      readonly facts: SigningFacts;
    },
    ValidationError
  > {
    const id = keyId(bytes);
    const known = HashMap.get(this.#keys, id);
    if (Option.isSome(known)) return Result.succeed({ key: known.value, facts: this });
    return Result.map(signingPublicKey(bytes), (key) => ({
      key,
      facts: new SigningFacts(HashMap.set(this.#keys, id, key)),
    }));
  }
}

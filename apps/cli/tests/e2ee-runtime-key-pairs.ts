import { beforeEach, vi } from 'vitest';

/** Reuse immutable native key handles, never custody owners or mutable bytes.
 * Each test gets a fresh allocation cursor: devices within one scenario still
 * have distinct keys, while independent scenarios avoid generating them again.
 * All imports, signatures, wrapping, disk writes and ledger verification stay real.
 */
export function reuseRuntimeKeyPairs() {
  const subtle = globalThis.crypto.subtle;
  const generate = subtle.generateKey.bind(subtle);
  const pairs = new Map<string, ReturnType<SubtleCrypto['generateKey']>>();
  beforeEach(() => {
    const allocations = new Map<string, number>();
    vi.spyOn(subtle, 'generateKey').mockImplementation((algorithm, extractable, usages) => {
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
      if (name !== 'Ed25519' && name !== 'X25519') {
        return generate(algorithm, extractable, usages);
      }
      const kind = JSON.stringify([name, extractable, usages]);
      const index = allocations.get(kind) ?? 0;
      allocations.set(kind, index + 1);
      const key = `${kind}:${index}`;
      let pair = pairs.get(key);
      if (!pair) {
        pair = generate(algorithm, extractable, usages).then((keys) => Object.freeze(keys));
        pairs.set(key, pair);
        void pair.catch(() => pairs.delete(key));
      }
      return pair;
    });
  });
}

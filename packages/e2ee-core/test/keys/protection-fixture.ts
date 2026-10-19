import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
// Synthetic host encryption, never a native-platform custody claim.
export function synthetic() {
  const key = new Uint8Array(32).fill(91);
  const plains: Uint8Array[] = [];
  const protector = {
    protect: async (body: Uint8Array) => {
      plains.push(body);
      const nonce = crypto.getRandomValues(new Uint8Array(24));
      return new Uint8Array([...nonce, ...xchacha20poly1305(key, nonce).encrypt(body)]);
    },
    unprotect: async (blob: Uint8Array) => {
      const body = xchacha20poly1305(key, blob.subarray(0, 24)).decrypt(blob.subarray(24));
      plains.push(body);
      return body;
    },
  };
  return { protector, plains };
}

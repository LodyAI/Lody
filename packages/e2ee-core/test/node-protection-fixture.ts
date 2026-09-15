import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { LocalEpochContext } from '../src/node-epoch-store';

/** Test-owned authenticated port, not an Electron safeStorage implementation or OS acceptance. */
export function protection() {
  const key = randomBytes(32);
  const state = { available: true };
  function available() {
    if (!state.available) throw new Error('secure-key-storage-unavailable');
  }
  function port<T>(domain: string) {
    const aad = (context: T) => Buffer.from(JSON.stringify([domain, context]));
    return {
      seal(context: T, bytes: Uint8Array): Uint8Array {
        available();
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(aad(context));
        const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
        return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
      },
      open(context: T, bytes: Uint8Array): Uint8Array {
        available();
        const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        cipher.setAAD(aad(context));
        cipher.setAuthTag(bytes.subarray(12, 28));
        return new Uint8Array(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]));
      },
    };
  }
  return {
    state,
    value: port<LocalEpochContext>('test-epoch'),
    device: port<string>('test-device'),
    user: port<string>('test-user'),
  };
}

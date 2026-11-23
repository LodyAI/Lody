import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { NativeEpochProtector } from '@lody/e2ee-core/internal';
/** Fixed publicly known Lab-only protector. Encrypts the complete supplied body.
 * Reuses the existing synthetic AES-GCM fixture format; not a production wrapping
 * algorithm, OS custody, secure backup, or JS erasure guarantee. Core owns and
 * clears its borrowed body/unprotected result after actual native settlement. */
export const labSyntheticProtector: NativeEpochProtector = {
  async protect(body) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 91), nonce);
    return new Uint8Array(
      Buffer.concat([nonce, cipher.update(body), cipher.final(), cipher.getAuthTag()])
    );
  },
  async unprotect(blob) {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.alloc(32, 91), blob.subarray(0, 12));
    decipher.setAuthTag(blob.subarray(-16));
    return new Uint8Array(
      Buffer.concat([decipher.update(blob.subarray(12, -16)), decipher.final()])
    );
  },
};

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { checkHex, ControlLogError, fromHex, invariant, toHex } from './wire';

const FILE_DOMAIN = 'lody-recovery-file/v1';
const BACKUP_DOMAIN = 'lody-recovery-backup/v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_HEADER = 256;
export const MAX_RECOVERY_MATERIAL_BYTES = 2048;

export interface RecoveryBackupContext {
  /** Expected fingerprint of the user identity, supplied independently of the backup. */
  readonly identity: string;
  readonly revision: number;
}

/** Secret file bytes. Save/reselect/read-back confirmation belongs to the UI, not this primitive. */
export function createRecoveryFile(): Uint8Array {
  const key = crypto.getRandomValues(new Uint8Array(32));
  try {
    return encoder.encode(
      JSON.stringify([FILE_DOMAIN, toHex(crypto.getRandomValues(new Uint8Array(16))), toHex(key)])
    );
  } finally {
    key.fill(0);
  }
}

/** Contains a secret key; caller must clear its copy after use. Never treats a file as a URL. */
export function parseRecoveryFile(file: Uint8Array): { backupId: string; key: Uint8Array } {
  invariant(
    file instanceof Uint8Array && file.length > 0 && file.length <= 256,
    'invalid-recovery-file'
  );
  let text: string;
  let fields: unknown;
  try {
    text = decoder.decode(file);
    fields = JSON.parse(text);
  } catch {
    throw new ControlLogError('invalid-recovery-file');
  }
  invariant(
    Array.isArray(fields) && fields.length === 3 && fields[0] === FILE_DOMAIN,
    'invalid-recovery-file'
  );
  checkHex(fields[1], 16);
  checkHex(fields[2], 32);
  invariant(JSON.stringify(fields) === text, 'noncanonical-recovery-file');
  return { backupId: fields[1], key: fromHex(fields[2]) };
}

function header(backupId: string, context: RecoveryBackupContext): Uint8Array {
  checkHex(context.identity, 32);
  invariant(
    Number.isSafeInteger(context.revision) && context.revision >= 0,
    'invalid-recovery-revision'
  );
  return encoder.encode(
    JSON.stringify([BACKUP_DOMAIN, backupId, context.identity, String(context.revision)])
  );
}

/** Wrap serialized USER identity material, never a device identity or login token.
 * This module authenticates bytes and context, not their private-key schema or membership.
 * The identity owner must validate restored key pairs before installing them.
 */
export function sealRecoveryBackup(
  file: Uint8Array,
  context: RecoveryBackupContext,
  material: Uint8Array
): Uint8Array {
  invariant(
    material instanceof Uint8Array &&
      material.length > 0 &&
      material.length <= MAX_RECOVERY_MATERIAL_BYTES,
    'invalid-recovery-material'
  );
  const { backupId, key } = parseRecoveryFile(file);
  const copy = new Uint8Array(material);
  try {
    const aad = header(backupId, context);
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(copy);
    const frame = new Uint8Array(2 + aad.length + nonce.length + ciphertext.length);
    new DataView(frame.buffer).setUint16(0, aad.length);
    frame.set(aad, 2);
    frame.set(nonce, 2 + aad.length);
    frame.set(ciphertext, 2 + aad.length + nonce.length);
    return frame;
  } finally {
    key.fill(0);
    copy.fill(0);
  }
}

/** File + matching ciphertext suffice offline. Login is not a second cryptographic factor.
 * No membership grant, backup-ready flag, storage mutation or automatic identity replacement.
 */
export function openRecoveryBackup(
  file: Uint8Array,
  context: RecoveryBackupContext,
  frame: Uint8Array
): Uint8Array {
  invariant(
    frame instanceof Uint8Array &&
      frame.length >= 2 + 24 + 16 + 1 &&
      frame.length <= 2 + MAX_HEADER + 24 + 16 + MAX_RECOVERY_MATERIAL_BYTES,
    'invalid-recovery-backup'
  );
  const { backupId, key } = parseRecoveryFile(file);
  try {
    const aad = header(backupId, context);
    const size = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(0);
    invariant(
      size === aad.length &&
        frame.length > 2 + size + 24 + 16 &&
        frame.length <= 2 + size + 24 + 16 + MAX_RECOVERY_MATERIAL_BYTES,
      'invalid-recovery-backup'
    );
    invariant(
      aad.every((byte, index) => byte === frame[2 + index]),
      'recovery-context-mismatch'
    );
    try {
      return xchacha20poly1305(key, frame.subarray(2 + size, 2 + size + 24), aad).decrypt(
        frame.subarray(2 + size + 24)
      );
    } catch {
      throw new ControlLogError('recovery-authentication-failed');
    }
  } finally {
    key.fill(0);
  }
}

import { Either } from 'effect';
import { liveEntropy, type Entropy } from './capabilities';
import {
  encodeRecoveryFile,
  MAX_RECOVERY_MATERIAL_BYTES,
  openRecoveryBackupFrame,
  parseRecoveryFileBytes,
  sealRecoveryBackupFrame,
  type RecoveryBackupContext,
} from './pure/recovery-file';
import { RecoveryError } from './pure/errors';
import { ControlLogError } from './pure/legacy-error';
import { keyId } from './pure/identifiers';

export { MAX_RECOVERY_MATERIAL_BYTES };
export type { RecoveryBackupContext };

function unwrap<A>(result: Either.Either<A, RecoveryError>): A {
  if (Either.isLeft(result)) throw new ControlLogError(result.left.code);
  return result.right;
}

/** Secret file bytes. Save/reselect/read-back confirmation belongs to the UI, not this primitive. */
export function createRecoveryFile(entropy: Entropy = liveEntropy): Uint8Array {
  const key = entropy.fill('recovery-file-key', new Uint8Array(32));
  try {
    const backupId = keyId(entropy.fill('recovery-file-id', new Uint8Array(16)));
    return unwrap(encodeRecoveryFile(backupId, key));
  } finally {
    key.fill(0);
  }
}

/** Contains a secret key; caller must clear its copy after use. Never treats a file as a URL. */
export function parseRecoveryFile(file: Uint8Array): { backupId: string; key: Uint8Array } {
  return unwrap(parseRecoveryFileBytes(file));
}

/** Wrap serialized USER identity material, never a device identity or login token.
 * This module authenticates bytes and context, not their private-key schema or membership.
 * The identity owner must validate restored key pairs before installing them.
 */
export function sealRecoveryBackup(
  file: Uint8Array,
  context: RecoveryBackupContext,
  material: Uint8Array,
  entropy: Entropy = liveEntropy
): Uint8Array {
  const nonce = entropy.fill('recovery-backup-nonce', new Uint8Array(24));
  return unwrap(sealRecoveryBackupFrame({ file, context, material, nonce }));
}

/** File + matching ciphertext suffice offline. Login is not a second cryptographic factor.
 * No membership grant, backup-ready flag, storage mutation or automatic identity replacement.
 */
export function openRecoveryBackup(
  file: Uint8Array,
  context: RecoveryBackupContext,
  frame: Uint8Array
): Uint8Array {
  return unwrap(openRecoveryBackupFrame(file, context, frame));
}

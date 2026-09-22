import { Either } from 'effect';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { copyBytes } from './cbor';
import { RecoveryError } from './errors';
import { keyId } from './identifiers';

const FILE_DOMAIN = 'lody-recovery-file/v1';
const BACKUP_DOMAIN = 'lody-recovery-backup/v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_HEADER = 256;
export const MAX_RECOVERY_MATERIAL_BYTES = 2048;
const fail = (code: string) => Either.left(new RecoveryError({ code }));

export interface RecoveryBackupContext {
  /** Expected fingerprint of the user identity, supplied independently of the backup. */
  readonly identity: string;
  readonly revision: number;
}

export interface ParsedRecoveryFile {
  readonly backupId: string;
  readonly key: Uint8Array;
}

function checkHex(value: unknown, bytes?: number): Either.Either<string, RecoveryError> {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(value)) return fail('invalid-hex');
  if (bytes !== undefined && value.length !== bytes * 2) return fail('invalid-length');
  return Either.right(value);
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function encodeRecoveryFile(
  backupId: string,
  key: Uint8Array
): Either.Either<Uint8Array, RecoveryError> {
  return Either.gen(function* () {
    yield* checkHex(backupId, 16);
    if (!(key instanceof Uint8Array) || key.byteLength !== 32)
      return yield* fail('invalid-recovery-file');
    return encoder.encode(JSON.stringify([FILE_DOMAIN, backupId, keyId(key)]));
  });
}

export function parseRecoveryFileBytes(
  file: Uint8Array
): Either.Either<ParsedRecoveryFile, RecoveryError> {
  if (!(file instanceof Uint8Array) || file.length === 0 || file.length > 256)
    return fail('invalid-recovery-file');
  let text: string;
  let fields: unknown;
  try {
    text = decoder.decode(file);
    fields = JSON.parse(text);
  } catch {
    return fail('invalid-recovery-file');
  }
  if (!Array.isArray(fields) || fields.length !== 3 || fields[0] !== FILE_DOMAIN)
    return fail('invalid-recovery-file');
  return Either.gen(function* () {
    const backupId = yield* checkHex(fields[1], 16);
    const keyHex = yield* checkHex(fields[2], 32);
    if (JSON.stringify(fields) !== text) return yield* fail('noncanonical-recovery-file');
    return { backupId, key: fromHex(keyHex) };
  });
}

export function recoveryBackupHeader(
  backupId: string,
  context: RecoveryBackupContext
): Either.Either<Uint8Array, RecoveryError> {
  return Either.gen(function* () {
    yield* checkHex(context.identity, 32);
    if (!Number.isSafeInteger(context.revision) || context.revision < 0)
      return yield* fail('invalid-recovery-revision');
    yield* checkHex(backupId, 16);
    return encoder.encode(
      JSON.stringify([BACKUP_DOMAIN, backupId, context.identity, String(context.revision)])
    );
  });
}

export function sealRecoveryBackupFrame(input: {
  readonly file: Uint8Array;
  readonly context: RecoveryBackupContext;
  readonly material: Uint8Array;
  readonly nonce: Uint8Array;
}): Either.Either<Uint8Array, RecoveryError> {
  return Either.gen(function* () {
    if (
      !(input.material instanceof Uint8Array) ||
      input.material.length === 0 ||
      input.material.length > MAX_RECOVERY_MATERIAL_BYTES
    )
      return yield* fail('invalid-recovery-material');
    if (!(input.nonce instanceof Uint8Array) || input.nonce.byteLength !== 24)
      return yield* fail('invalid-recovery-backup');
    const parsed = yield* parseRecoveryFileBytes(input.file);
    const copy = copyBytes(input.material);
    const nonce = copyBytes(input.nonce);
    try {
      const aad = yield* recoveryBackupHeader(parsed.backupId, input.context);
      const ciphertext = yield* Either.try({
        try: () => xchacha20poly1305(parsed.key, nonce, aad).encrypt(copy),
        catch: () => new RecoveryError({ code: 'invalid-recovery-material' }),
      });
      const frame = new Uint8Array(2 + aad.length + nonce.length + ciphertext.length);
      new DataView(frame.buffer).setUint16(0, aad.length);
      frame.set(aad, 2);
      frame.set(nonce, 2 + aad.length);
      frame.set(ciphertext, 2 + aad.length + nonce.length);
      return frame;
    } finally {
      parsed.key.fill(0);
      copy.fill(0);
    }
  });
}

export function openRecoveryBackupFrame(
  file: Uint8Array,
  context: RecoveryBackupContext,
  frame: Uint8Array
): Either.Either<Uint8Array, RecoveryError> {
  if (
    !(frame instanceof Uint8Array) ||
    frame.length < 2 + 24 + 16 + 1 ||
    frame.length > 2 + MAX_HEADER + 24 + 16 + MAX_RECOVERY_MATERIAL_BYTES
  )
    return fail('invalid-recovery-backup');
  return Either.gen(function* () {
    const parsed = yield* parseRecoveryFileBytes(file);
    try {
      const aad = yield* recoveryBackupHeader(parsed.backupId, context);
      const size = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(0);
      if (
        size !== aad.length ||
        frame.length <= 2 + size + 24 + 16 ||
        frame.length > 2 + size + 24 + 16 + MAX_RECOVERY_MATERIAL_BYTES
      )
        return yield* fail('invalid-recovery-backup');
      if (!aad.every((byte, index) => byte === frame[2 + index]))
        return yield* fail('recovery-context-mismatch');
      return yield* Either.try({
        try: () =>
          xchacha20poly1305(parsed.key, frame.subarray(2 + size, 2 + size + 24), aad).decrypt(
            frame.subarray(2 + size + 24)
          ),
        catch: () => new RecoveryError({ code: 'recovery-authentication-failed' }),
      });
    } finally {
      parsed.key.fill(0);
    }
  });
}

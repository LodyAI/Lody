import { checkHex, ControlLogError, fromHex, invariant, toHex } from './wire';

const DOMAIN = 'lody-recovery-device/v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_SECRET = 2048;

export interface RecoveryDeviceSecretView {
  readonly publicKey: Uint8Array;
  readonly enc: Uint8Array;
  readonly secret: Uint8Array;
}

export interface RecoveryDeviceHandle {
  readonly publicKey: Uint8Array;
  readonly enc: Uint8Array;
  readonly recipientKeyPair: CryptoKeyPair;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

function encodeSecret(
  publicKey: Uint8Array,
  enc: Uint8Array,
  signPkcs8: Uint8Array,
  dhPkcs8: Uint8Array
): Uint8Array {
  return encoder.encode(
    JSON.stringify([DOMAIN, toHex(publicKey), toHex(enc), toHex(signPkcs8), toHex(dhPkcs8)])
  );
}

function decodeSecret(secret: Uint8Array): {
  publicKey: Uint8Array;
  enc: Uint8Array;
  signPkcs8: Uint8Array;
  dhPkcs8: Uint8Array;
} {
  invariant(
    secret instanceof Uint8Array && secret.length > 0 && secret.length <= MAX_SECRET,
    'invalid-recovery-device'
  );
  let fields: unknown;
  try {
    fields = JSON.parse(decoder.decode(secret));
  } catch {
    throw new ControlLogError('invalid-recovery-device');
  }
  invariant(
    Array.isArray(fields) && fields.length === 5 && fields[0] === DOMAIN,
    'invalid-recovery-device'
  );
  checkHex(fields[1], 32);
  checkHex(fields[2], 32);
  checkHex(fields[3]);
  checkHex(fields[4]);
  invariant(JSON.stringify(fields) === decoder.decode(secret), 'noncanonical-recovery-device');
  const signPkcs8 = fromHex(fields[3]);
  const dhPkcs8 = fromHex(fields[4]);
  invariant(signPkcs8.byteLength >= 32 && signPkcs8.byteLength <= 128, 'invalid-recovery-device');
  invariant(dhPkcs8.byteLength >= 32 && dhPkcs8.byteLength <= 128, 'invalid-recovery-device');
  return {
    publicKey: fromHex(fields[1]),
    enc: fromHex(fields[2]),
    signPkcs8,
    dhPkcs8,
  };
}

/**
 * Generate R material: extractable only long enough to export PKCS8, then discarded.
 * Wrap `secret` with sealRecoveryBackup. Daily handles come from importRecoveryDevice.
 */
export async function createRecoveryDeviceSecret(): Promise<RecoveryDeviceSecretView> {
  const sign = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const dh = (await crypto.subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', sign.publicKey));
  const enc = new Uint8Array(await crypto.subtle.exportKey('raw', dh.publicKey));
  const signPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', sign.privateKey));
  const dhPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', dh.privateKey));
  const secret = encodeSecret(publicKey, enc, signPkcs8, dhPkcs8);
  signPkcs8.fill(0);
  dhPkcs8.fill(0);
  return { publicKey, enc, secret };
}

/** Import a backup secret as non-extractable signing and X25519 handles. */
export async function importRecoveryDevice(secret: Uint8Array): Promise<RecoveryDeviceHandle> {
  const parsed = decodeSecret(secret);
  const copy = (bytes: Uint8Array) => {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
  };
  const signPrivate = await crypto.subtle.importKey(
    'pkcs8',
    copy(parsed.signPkcs8),
    'Ed25519',
    false,
    ['sign']
  );
  const dhPrivate = await crypto.subtle.importKey('pkcs8', copy(parsed.dhPkcs8), 'X25519', false, [
    'deriveBits',
  ]);
  const dhPublic = await crypto.subtle.importKey('raw', copy(parsed.enc), 'X25519', true, []);
  parsed.signPkcs8.fill(0);
  parsed.dhPkcs8.fill(0);
  const recipientKeyPair = { publicKey: dhPublic, privateKey: dhPrivate } as CryptoKeyPair;
  return {
    publicKey: parsed.publicKey,
    enc: parsed.enc,
    recipientKeyPair,
    async sign(bytes: Uint8Array) {
      const message = new Uint8Array(bytes.byteLength);
      message.set(bytes);
      return new Uint8Array(await crypto.subtle.sign('Ed25519', signPrivate, message));
    },
  };
}

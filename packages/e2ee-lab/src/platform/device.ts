import { createPrivateKey, createPublicKey } from 'node:crypto';
import { Data, Effect, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { verifySignature } from '@lody/e2ee-core/protocol';
import { type DeviceSigner } from '@lody/e2ee-core';
import { nativeDeviceSigner } from '@lody/e2ee-core/services';
import { labPossessionMessage } from './credentials';

export class LabDeviceError extends Data.TaggedError('LabDeviceError')<{
  readonly code: 'invalid-fixture' | 'native-crypto';
}> {}
const ok = Result.getOrThrow;
const invalid = () => new LabDeviceError({ code: 'invalid-fixture' });
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const native = <A>(work: () => Promise<A>) =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: work,
      catch: (error) =>
        error instanceof LabDeviceError ? error : new LabDeviceError({ code: 'native-crypto' }),
    })
  );

/** Synthetic fixture only. Caller owns native handles; WebCrypto has no key close
 * or revocation API. Exportable fixture keys are not a platform custody contract. */
export interface DemoDevice extends DeviceSigner {
  readonly enc: Bytes.EncryptionPublicKey;
  readonly signing: CryptoKeyPair;
  readonly encryption: CryptoKeyPair;
}
function device(
  signing: CryptoKeyPair,
  encryption: CryptoKeyPair,
  publicKey: Uint8Array,
  enc: Uint8Array
): DemoDevice {
  const signer = ok(nativeDeviceSigner(ok(Bytes.signingPublicKey(publicKey)), signing.privateKey));
  return Object.freeze({
    ...signer,
    enc: ok(Bytes.encryptionPublicKey(enc)),
    signing: Object.freeze({ ...signing }),
    encryption: Object.freeze({ ...encryption }),
  });
}
/** Optional trusted native port is for instrumented synthetic fixtures only. */
export function generateDevice(subtle: SubtleCrypto = crypto.subtle) {
  return native(async () => {
    // A rejected generator must not release its caller while the sibling native
    // generator is still borrowed. Crypto operations cannot be cancelled.
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => subtle.generateKey('Ed25519', true, ['sign', 'verify'])),
      Promise.resolve().then(() => subtle.generateKey('X25519', true, ['deriveBits'])),
    ]);
    for (const result of settled) if (result.status === 'rejected') throw result.reason;
    const [signing, encryption] = settled.map(
      (result) => (result as PromiseFulfilledResult<CryptoKeyPair>).value
    );
    return device(
      signing,
      encryption,
      new Uint8Array(await subtle.exportKey('raw', signing.publicKey)),
      new Uint8Array(await subtle.exportKey('raw', encryption.publicKey))
    );
  });
}

export function deviceHex(value: DemoDevice): string {
  return hex(value.publicKey.toBytes());
}
function decode(value: unknown, bytes?: number): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'string' ||
    !/^(?:[0-9a-f]{2})+$/.test(value) ||
    value.length > 256 ||
    (bytes !== undefined && value.length !== bytes * 2)
  )
    throw invalid();
  return new Uint8Array(Buffer.from(value, 'hex'));
}
function checkPair(
  privateBytes: Uint8Array,
  publicBytes: Uint8Array,
  algorithm: 'ed25519' | 'x25519'
) {
  const key = createPrivateKey({
    key: Buffer.from(privateBytes.buffer, privateBytes.byteOffset, privateBytes.byteLength),
    format: 'der',
    type: 'pkcs8',
  });
  if (key.asymmetricKeyType !== algorithm) throw invalid();
  const actual = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
  if (actual.length !== publicBytes.length || actual.some((byte, i) => byte !== publicBytes[i]))
    throw invalid();
}
/** Preserve original four-field synthetic JSON, not a recovery-vault wire format.
 * Await native export before clearing scratch; strings/native handles cannot be zeroized. */
export function exportDevice(value: DemoDevice) {
  return native(async () => {
    let signing: Uint8Array | undefined, encryption: Uint8Array | undefined;
    try {
      signing = new Uint8Array(await crypto.subtle.exportKey('pkcs8', value.signing.privateKey));
      encryption = new Uint8Array(
        await crypto.subtle.exportKey('pkcs8', value.encryption.privateKey)
      );
      const publicKey = value.publicKey.toBytes(),
        enc = value.enc.toBytes();
      checkPair(signing, publicKey, 'ed25519');
      checkPair(encryption, enc, 'x25519');
      return JSON.stringify({
        publicKey: hex(publicKey),
        enc: hex(enc),
        signing: hex(signing),
        encryption: hex(encryption),
      });
    } finally {
      signing?.fill(0);
      encryption?.fill(0);
    }
  });
}
export function importDevice(raw: string) {
  return native(async () => {
    let signing: Uint8Array<ArrayBuffer> | undefined,
      encryption: Uint8Array<ArrayBuffer> | undefined;
    try {
      if (typeof raw !== 'string' || raw.length > 4096) throw invalid();
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
      const fields = value as Record<string, unknown>;
      if (Object.keys(fields).sort().join(',') !== 'enc,encryption,publicKey,signing')
        throw invalid();
      const publicKey = decode(fields.publicKey, 32),
        enc = decode(fields.enc, 32);
      signing = decode(fields.signing);
      encryption = decode(fields.encryption);
      checkPair(signing, publicKey, 'ed25519');
      checkPair(encryption, enc, 'x25519');
      const signingPair = {
        privateKey: await crypto.subtle.importKey('pkcs8', signing, 'Ed25519', true, ['sign']),
        publicKey: await crypto.subtle.importKey('raw', publicKey, 'Ed25519', true, ['verify']),
      };
      const encryptionPair = {
        privateKey: await crypto.subtle.importKey('pkcs8', encryption, 'X25519', true, [
          'deriveBits',
        ]),
        // Locked HPKE serializes the public recipient handle. Only synthetic private
        // fixture exports are allowed here; this is not a native production key store.
        publicKey: await crypto.subtle.importKey('raw', enc, 'X25519', true, []),
      };
      return device(signingPair, encryptionPair, publicKey, enc);
    } catch (error) {
      if (error instanceof LabDeviceError) throw error;
      throw invalid();
    } finally {
      signing?.fill(0);
      encryption?.fill(0);
    }
  });
}
export function possessionProof(account: string, value: DemoDevice, nonce: string) {
  return Effect.flatMap(
    Effect.fromResult(labPossessionMessage(account, value.publicKey, nonce)),
    value.sign
  );
}
export function verifyPossession(
  account: string,
  publicKey: Bytes.SigningPublicKey,
  nonce: string,
  signature: Bytes.Signature
) {
  return Effect.gen(function* () {
    const message = yield* Effect.fromResult(labPossessionMessage(account, publicKey, nonce));
    return Result.isSuccess(verifySignature(publicKey.toBytes(), message, signature.toBytes()));
  });
}

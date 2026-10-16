import { Effect, Result } from 'effect';
import * as Bytes from '../foundation/bytes';
import { nativeDeviceSigner, type DeviceSigner } from '../foundation/signing';
import { attempt, vaultError } from './crypto';
import type { RecoveryPrivatePackage } from './vault';

const native = <A>(work: () => Promise<A>) =>
  Effect.uninterruptible(
    Effect.tryPromise({ try: work, catch: () => vaultError('authentication') })
  );
const b64 = (value: string) =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (v) => v.charCodeAt(0));
/** The recovery device's signer and encryption key pair, imported from a private package. */
export interface RecoveryIdentity extends DeviceSigner {
  readonly encryptionPublicKey: Bytes.EncryptionPublicKey;
  readonly encryption: CryptoKeyPair;
}
/** Fresh keys only for temporary R. Exports are operation-owned vault plaintext,
 * never a device-store fallback. WebCrypto cannot zeroize imported native handles. */
export const generateRecoveryPackage = Effect.fnUntraced(function* (
  binding: Omit<
    RecoveryPrivatePackage,
    'signingPublic' | 'encryptionPublic' | 'signingPrivate' | 'encryptionPrivate'
  >
) {
  return yield* native(async () => {
    const settled = await Promise.allSettled([
      crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
      crypto.subtle.generateKey('X25519', true, ['deriveBits']),
    ]);
    const [signingResult, encryptionResult] = settled;
    if (signingResult.status === 'rejected') throw signingResult.reason;
    if (encryptionResult.status === 'rejected') throw encryptionResult.reason;
    const signing = signingResult.value,
      encryption = encryptionResult.value;
    if (
      !('privateKey' in signing) ||
      !('publicKey' in signing) ||
      !('privateKey' in encryption) ||
      !('publicKey' in encryption)
    )
      throw vaultError('authentication');
    return {
      ...binding,
      signingPublic: new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey)),
      encryptionPublic: new Uint8Array(await crypto.subtle.exportKey('raw', encryption.publicKey)),
      signingPrivate: new Uint8Array(await crypto.subtle.exportKey('pkcs8', signing.privateKey)),
      encryptionPrivate: new Uint8Array(
        await crypto.subtle.exportKey('pkcs8', encryption.privateKey)
      ),
    };
  });
});
/** Import the recovery device identity (signer and encryption keys) from a private recovery package. */
export const importRecoveryIdentity = Effect.fnUntraced(function* (value: RecoveryPrivatePackage) {
  // Derive actual public halves via native JWK export, rather than trusting the
  // public bytes stored next to a private key in an encrypted package.
  return yield* native(async () => {
    const signingPrivate = await crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array(value.signingPrivate),
      'Ed25519',
      true,
      ['sign']
    );
    const encryptionPrivate = await crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array(value.encryptionPrivate),
      'X25519',
      true,
      ['deriveBits']
    );
    const signingJwk = await crypto.subtle.exportKey('jwk', signingPrivate),
      encryptionJwk = await crypto.subtle.exportKey('jwk', encryptionPrivate);
    const same = (actual: Uint8Array, expected: Uint8Array) =>
      actual.length === expected.length && actual.every((byte, i) => byte === expected[i]);
    if (
      typeof signingJwk.x !== 'string' ||
      typeof encryptionJwk.x !== 'string' ||
      !same(b64(signingJwk.x), value.signingPublic) ||
      !same(b64(encryptionJwk.x), value.encryptionPublic)
    )
      throw vaultError('authentication');
    const signing = await crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array(value.signingPrivate),
      'Ed25519',
      false,
      ['sign']
    );
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array(value.encryptionPrivate),
      'X25519',
      false,
      ['deriveBits']
    );
    const publicKey = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(value.encryptionPublic),
      'X25519',
      true,
      []
    );
    const signer = Result.getOrThrow(
      nativeDeviceSigner(Result.getOrThrow(Bytes.signingPublicKey(value.signingPublic)), signing)
    );
    return Object.freeze({
      ...signer,
      encryptionPublicKey: Result.getOrThrow(Bytes.encryptionPublicKey(value.encryptionPublic)),
      encryption: { privateKey, publicKey },
    }) satisfies RecoveryIdentity;
  });
});
export const validateRecoveryPackage = Effect.fnUntraced(function* (value: RecoveryPrivatePackage) {
  yield* attempt(() => {
    if (value.signingPrivate.length > 256 || value.encryptionPrivate.length > 256)
      throw vaultError('invalid-input');
  });
  return yield* importRecoveryIdentity(value);
});

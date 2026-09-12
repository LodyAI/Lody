import {
  checkHex,
  checkSigningKey,
  ControlLogError,
  fromHex,
  invariant,
  toHex,
  WebCryptoControl,
} from './wire';

const FORMAT = 'lody-user-identity-secret/v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface UserIdentity {
  readonly fingerprint: string;
  readonly signing: CryptoKeyPair;
  readonly encryption: CryptoKeyPair;
}

async function fingerprint(signing: string, encryption: string): Promise<string> {
  return toHex(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        encoder.encode(JSON.stringify(['lody-user-identity/v1', signing, encryption]))
      )
    )
  );
}

/** No storage, device creation or membership restoration. Expected fingerprint must
 * be independently retained/verified, not copied from an untrusted backup header. */
export async function restoreUserIdentity(
  material: Uint8Array,
  expectedFingerprint: string
): Promise<UserIdentity> {
  checkHex(expectedFingerprint, 32);
  invariant(
    material instanceof Uint8Array && material.length > 0 && material.length <= 2048,
    'invalid-user-identity'
  );
  let text: string;
  let value: unknown;
  try {
    text = decoder.decode(material);
    value = JSON.parse(text);
  } catch {
    throw new ControlLogError('invalid-user-identity');
  }
  invariant(
    Array.isArray(value) &&
      value.length === 5 &&
      value[0] === FORMAT &&
      value.every((field: unknown) => typeof field === 'string') &&
      JSON.stringify(value) === text,
    'invalid-user-identity'
  );
  const signingPublic = value[1]!;
  const signingPrivate = value[2]!;
  const encryptionPublic = value[3]!;
  const encryptionPrivate = value[4]!;
  checkSigningKey(signingPublic);
  checkHex(encryptionPublic, 32);
  let coordinate = 0n;
  for (const byte of [...fromHex(encryptionPublic)].reverse())
    coordinate = (coordinate << 8n) | BigInt(byte);
  invariant(coordinate < (1n << 255n) - 19n, 'noncanonical-encryption-key');
  for (const secret of [signingPrivate, encryptionPrivate]) {
    checkHex(secret);
    invariant(secret.length > 0 && secret.length <= 256, 'invalid-user-private-key');
  }
  const signingBytes = fromHex(signingPrivate);
  const encryptionBytes = fromHex(encryptionPrivate);
  let left: Uint8Array | undefined;
  let right: Uint8Array | undefined;
  try {
    invariant(
      (await fingerprint(signingPublic, encryptionPublic)) === expectedFingerprint,
      'user-identity-mismatch'
    );
    const signing = {
      privateKey: await crypto.subtle.importKey(
        'pkcs8',
        new Uint8Array(signingBytes),
        'Ed25519',
        false,
        ['sign']
      ),
      publicKey: await crypto.subtle.importKey(
        'raw',
        new Uint8Array(fromHex(signingPublic)),
        'Ed25519',
        true,
        ['verify']
      ),
    };
    const encryption = {
      privateKey: await crypto.subtle.importKey(
        'pkcs8',
        new Uint8Array(encryptionBytes),
        'X25519',
        false,
        ['deriveBits']
      ),
      publicKey: await crypto.subtle.importKey(
        'raw',
        new Uint8Array(fromHex(encryptionPublic)),
        'X25519',
        true,
        []
      ),
    };
    const challenge = encoder.encode(`lody-user-identity-possession/v1\0${expectedFingerprint}`);
    const signature = new Uint8Array(
      await crypto.subtle.sign('Ed25519', signing.privateKey, challenge)
    );
    invariant(
      await new WebCryptoControl().verify(signingPublic, challenge, toHex(signature)),
      'user-key-pair-mismatch'
    );
    // Validate the encryption pair by agreement, without extracting private handles.
    const peer = await crypto.subtle.generateKey('X25519', false, ['deriveBits']);
    invariant('privateKey' in peer, 'invalid-generated-key-pair');
    left = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'X25519', public: peer.publicKey },
        encryption.privateKey,
        256
      )
    );
    right = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'X25519', public: encryption.publicKey },
        peer.privateKey,
        256
      )
    );
    invariant(
      left.length === 32 &&
        right.length === 32 &&
        left.every((byte, index) => byte === right![index]),
      'user-key-pair-mismatch'
    );
    return { fingerprint: expectedFingerprint, signing, encryption };
  } catch (error) {
    if (error instanceof ControlLogError) throw error;
    throw new ControlLogError('invalid-user-identity');
  } finally {
    signingBytes.fill(0);
    encryptionBytes.fill(0);
    left?.fill(0);
    right?.fill(0);
  }
}

/** Explicit new USER identity, separate from every device. Persist privateMaterial
 * safely before publishing this identity; erase the returned byte buffer after use.
 * Generation does not mark a backup ready or replace an existing identity. */
export async function createUserIdentity(): Promise<{
  identity: UserIdentity;
  privateMaterial: Uint8Array;
}> {
  const signing = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const encryption = await crypto.subtle.generateKey('X25519', true, ['deriveBits']);
  invariant('privateKey' in signing && 'privateKey' in encryption, 'invalid-generated-key-pair');
  const signingPrivate = new Uint8Array(await crypto.subtle.exportKey('pkcs8', signing.privateKey));
  let encryptionPrivate: Uint8Array | undefined;
  let material: Uint8Array | undefined;
  let returned = false;
  try {
    encryptionPrivate = new Uint8Array(
      await crypto.subtle.exportKey('pkcs8', encryption.privateKey)
    );
    const signingPublic = toHex(
      new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey))
    );
    const encryptionPublic = toHex(
      new Uint8Array(await crypto.subtle.exportKey('raw', encryption.publicKey))
    );
    material = encoder.encode(
      JSON.stringify([
        FORMAT,
        signingPublic,
        toHex(signingPrivate),
        encryptionPublic,
        toHex(encryptionPrivate),
      ])
    );
    const identity = await restoreUserIdentity(
      material,
      await fingerprint(signingPublic, encryptionPublic)
    );
    returned = true;
    return { identity, privateMaterial: material };
  } finally {
    signingPrivate.fill(0);
    encryptionPrivate?.fill(0);
    if (!returned) material?.fill(0);
  }
}

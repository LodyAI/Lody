import { createPrivateKey, createPublicKey } from 'node:crypto';
import { SqliteTextStore } from './node-text-store';
import { checkHex, checkSigningKey, fromHex, invariant, toHex } from './wire';

export interface LocalDeviceProtection {
  seal(accountBinding: string, plaintext: Uint8Array): Uint8Array;
  open(accountBinding: string, wrapped: Uint8Array): Uint8Array;
}
export interface DeviceIdentity {
  readonly id: string;
  readonly signing: CryptoKeyPair;
  readonly encryption: CryptoKeyPair;
}
const FORMAT = 'lody-device-identity/v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

async function restore(bytes: Uint8Array, binding: string): Promise<DeviceIdentity> {
  invariant(bytes.length > 0 && bytes.length <= 2048, 'invalid-device-bundle');
  const text = decoder.decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('invalid-device-bundle');
  }
  invariant(
    Array.isArray(value) &&
      value.length === 7 &&
      value.every((x: unknown) => typeof x === 'string'),
    'invalid-device-bundle'
  );
  const fields = value;
  invariant(
    fields[0] === FORMAT && fields[1] === binding && JSON.stringify(fields) === text,
    'device-binding-mismatch'
  );
  const id = fields[2]!;
  checkHex(id, 16);
  async function pair(
    algorithm: 'Ed25519' | 'X25519',
    publicHex: string,
    privateHex: string
  ): Promise<CryptoKeyPair> {
    checkHex(publicHex, 32);
    checkHex(privateHex);
    invariant(privateHex.length > 0 && privateHex.length <= 256, 'invalid-device-private-key');
    const pkcs8 = fromHex(privateHex);
    try {
      const key = createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' });
      invariant(key.asymmetricKeyType === algorithm.toLowerCase(), 'wrong-device-key-type');
      const derived = createPublicKey(key).export({ format: 'jwk' });
      invariant(
        typeof derived.x === 'string' &&
          Buffer.from(derived.x, 'base64url').toString('hex') === publicHex,
        'device-key-pair-mismatch'
      );
      if (algorithm === 'Ed25519') checkSigningKey(publicHex);
      return {
        privateKey: await crypto.subtle.importKey(
          'pkcs8',
          new Uint8Array(pkcs8),
          algorithm,
          false,
          algorithm === 'Ed25519' ? ['sign'] : ['deriveBits']
        ),
        publicKey: await crypto.subtle.importKey(
          'raw',
          new Uint8Array(fromHex(publicHex)),
          algorithm,
          true,
          algorithm === 'Ed25519' ? ['verify'] : []
        ),
      };
    } finally {
      pkcs8.fill(0);
    }
  }
  return {
    id,
    signing: await pair('Ed25519', fields[3]!, fields[4]!),
    encryption: await pair('X25519', fields[5]!, fields[6]!),
  };
}

/** Explicit create/load, never replace a missing/locked/corrupt identity on login.
 * Binding is a caller-selected stable account/domain digest, not proof of login or membership. */
export class SqliteDeviceIdentityStore {
  private readonly database: SqliteTextStore;
  constructor(
    path: string,
    private readonly binding: string,
    private readonly protection: LocalDeviceProtection
  ) {
    checkHex(binding, 32);
    this.database = new SqliteTextStore(path, 0x4c444931, 1);
  }

  async create(): Promise<DeviceIdentity> {
    return this.database.exclusive(async (tx) => {
      invariant((await tx.load()) === null, 'device-identity-exists');
      const id = toHex(crypto.getRandomValues(new Uint8Array(16)));
      const signing = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      const encryption = await crypto.subtle.generateKey('X25519', true, ['deriveBits']);
      invariant(
        'privateKey' in signing && 'privateKey' in encryption,
        'invalid-generated-key-pair'
      );
      const signingPrivate = new Uint8Array(
        await crypto.subtle.exportKey('pkcs8', signing.privateKey)
      );
      let encryptionPrivate: Uint8Array | undefined;
      let plaintext: Uint8Array | undefined;
      let opened: Uint8Array | undefined;
      try {
        encryptionPrivate = new Uint8Array(
          await crypto.subtle.exportKey('pkcs8', encryption.privateKey)
        );
        plaintext = encoder.encode(
          JSON.stringify([
            FORMAT,
            this.binding,
            id,
            toHex(new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey))),
            toHex(signingPrivate),
            toHex(new Uint8Array(await crypto.subtle.exportKey('raw', encryption.publicKey))),
            toHex(encryptionPrivate),
          ])
        );
        const wrapped = this.protection.seal(this.binding, plaintext);
        invariant(
          wrapped instanceof Uint8Array && wrapped.length > 0 && wrapped.length <= 8192,
          'invalid-wrapped-device'
        );
        const wrappedHex = toHex(wrapped);
        opened = this.protection.open(this.binding, fromHex(wrappedHex));
        invariant(toHex(opened) === toHex(plaintext), 'device-protection-roundtrip-mismatch');
        const identity = await restore(opened, this.binding);
        await tx.save(JSON.stringify([FORMAT, this.binding, wrappedHex]));
        return identity;
      } finally {
        signingPrivate.fill(0);
        encryptionPrivate?.fill(0);
        plaintext?.fill(0);
        opened?.fill(0);
      }
    });
  }

  async load(): Promise<DeviceIdentity> {
    return this.database.exclusive(async (tx) => {
      const text = await tx.load();
      invariant(text !== null, 'device-identity-missing');
      invariant(text.length <= 16600, 'invalid-device-store');
      const value: unknown = JSON.parse(text);
      invariant(
        Array.isArray(value) &&
          value.length === 3 &&
          value[0] === FORMAT &&
          value[1] === this.binding &&
          typeof value[2] === 'string',
        'invalid-device-store'
      );
      const wrapped: string = value[2];
      invariant(wrapped.length > 0 && wrapped.length <= 16384, 'invalid-wrapped-device');
      checkHex(wrapped);
      invariant(JSON.stringify([FORMAT, this.binding, wrapped]) === text, 'invalid-device-store');
      const plaintext = this.protection.open(this.binding, fromHex(wrapped));
      try {
        return await restore(plaintext, this.binding);
      } finally {
        plaintext.fill(0);
      }
    });
  }
}

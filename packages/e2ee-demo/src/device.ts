import { asArrayBuffer, fromHex, toHex } from './bytes';

export interface DemoDevice {
  readonly publicKey: Uint8Array;
  readonly enc: Uint8Array;
  readonly signing: CryptoKeyPair;
  readonly encryption: CryptoKeyPair;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export async function generateDevice(): Promise<DemoDevice> {
  const signing = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const encryption = (await crypto.subtle.generateKey('X25519', true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey));
  const enc = new Uint8Array(await crypto.subtle.exportKey('raw', encryption.publicKey));
  return {
    publicKey,
    enc,
    signing,
    encryption,
    async sign(bytes: Uint8Array) {
      const message = new Uint8Array(bytes.byteLength);
      message.set(bytes);
      return new Uint8Array(await crypto.subtle.sign('Ed25519', signing.privateKey, message));
    },
  };
}

export function deviceHex(device: DemoDevice): string {
  return toHex(device.publicKey);
}

function fromKey(device: {
  publicKey: Uint8Array;
  enc: Uint8Array;
  signing: CryptoKeyPair;
  encryption: CryptoKeyPair;
}): DemoDevice {
  return {
    publicKey: device.publicKey,
    enc: device.enc,
    signing: device.signing,
    encryption: device.encryption,
    async sign(bytes: Uint8Array) {
      const message = new Uint8Array(bytes.byteLength);
      message.set(bytes);
      return new Uint8Array(
        await crypto.subtle.sign('Ed25519', device.signing.privateKey, message)
      );
    },
  };
}

export async function exportDevice(device: DemoDevice): Promise<string> {
  const signing = new Uint8Array(await crypto.subtle.exportKey('pkcs8', device.signing.privateKey));
  const encryption = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', device.encryption.privateKey)
  );
  return JSON.stringify({
    publicKey: toHex(device.publicKey),
    enc: toHex(device.enc),
    signing: toHex(signing),
    encryption: toHex(encryption),
  });
}

export async function importDevice(raw: string): Promise<DemoDevice> {
  const fields = JSON.parse(raw) as {
    publicKey: string;
    enc: string;
    signing: string;
    encryption: string;
  };
  const publicKey = fromHex(fields.publicKey);
  const enc = fromHex(fields.enc);
  const signingPrivate = await crypto.subtle.importKey(
    'pkcs8',
    asArrayBuffer(fromHex(fields.signing)),
    'Ed25519',
    true,
    ['sign']
  );
  const signingPublic = await crypto.subtle.importKey(
    'raw',
    asArrayBuffer(publicKey),
    'Ed25519',
    true,
    ['verify']
  );
  const encryptionPrivate = await crypto.subtle.importKey(
    'pkcs8',
    asArrayBuffer(fromHex(fields.encryption)),
    'X25519',
    true,
    ['deriveBits']
  );
  const encryptionPublic = await crypto.subtle.importKey(
    'raw',
    asArrayBuffer(enc),
    'X25519',
    true,
    []
  );
  return fromKey({
    publicKey,
    enc,
    signing: { privateKey: signingPrivate, publicKey: signingPublic },
    encryption: { privateKey: encryptionPrivate, publicKey: encryptionPublic },
  });
}

export async function possessionProof(account: string, device: DemoDevice): Promise<Uint8Array> {
  const message = new TextEncoder().encode(`e2ee-demo-device/v1\0${account}\0${deviceHex(device)}`);
  return device.sign(message);
}

export async function verifyPossession(
  account: string,
  publicKey: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  const message = new TextEncoder().encode(`e2ee-demo-device/v1\0${account}\0${toHex(publicKey)}`);
  const key = await crypto.subtle.importKey('raw', new Uint8Array(publicKey), 'Ed25519', false, [
    'verify',
  ]);
  return crypto.subtle.verify('Ed25519', key, new Uint8Array(signature), message);
}

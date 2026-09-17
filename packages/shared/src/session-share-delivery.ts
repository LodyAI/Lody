import { z } from 'zod';

// Only a 32-byte reader secret is encrypted, never arbitrary conversation data.
// RSA-OAEP uses an explicit request/origin label to prevent envelope substitution.
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
const bytes = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
export const ShareDeliveryPublicKeySchema = z.string().regex(/^[a-f0-9]{588}$/);
export const ShareDeliveryEnvelopeSchema = z
  .object({
    version: z.literal(1),
    origin: z.string().url().max(2048),
    ciphertext: z.string().regex(/^[a-f0-9]{512}$/),
  })
  .strict();
export type ShareDeliveryEnvelope = z.infer<typeof ShareDeliveryEnvelopeSchema>;
export type ShareDeliveryKey = { publicKey: string; privateKey: string };
const algorithm = { name: 'RSA-OAEP', hash: 'SHA-256' };
const label = (requestId: string, origin: string) =>
  new TextEncoder().encode(JSON.stringify(['lody-share-delivery-v1', requestId, origin]));

export async function createShareDeliveryKey(): Promise<ShareDeliveryKey> {
  const pair = await crypto.subtle.generateKey(
    {
      ...algorithm,
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ['encrypt', 'decrypt']
  );
  return {
    publicKey: ShareDeliveryPublicKeySchema.parse(
      hex(await crypto.subtle.exportKey('spki', pair.publicKey))
    ),
    privateKey: hex(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
}

export async function encryptShareDelivery(
  publicKey: string,
  requestId: string,
  origin: string,
  secret: string
): Promise<ShareDeliveryEnvelope> {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid share credential');
  const key = await crypto.subtle.importKey(
    'spki',
    bytes(ShareDeliveryPublicKeySchema.parse(publicKey)),
    algorithm,
    false,
    ['encrypt']
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP', label: label(requestId, origin) },
    key,
    new TextEncoder().encode(secret)
  );
  return ShareDeliveryEnvelopeSchema.parse({ version: 1, origin, ciphertext: hex(ciphertext) });
}

export async function decryptShareDelivery(
  privateKey: string,
  requestId: string,
  envelope: ShareDeliveryEnvelope
): Promise<string> {
  const parsed = ShareDeliveryEnvelopeSchema.parse(envelope);
  const key = await crypto.subtle.importKey('pkcs8', bytes(privateKey), algorithm, false, [
    'decrypt',
  ]);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP', label: label(requestId, parsed.origin) },
    key,
    bytes(parsed.ciphertext)
  );
  const secret = new TextDecoder().decode(plaintext);
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid share delivery');
  return secret;
}

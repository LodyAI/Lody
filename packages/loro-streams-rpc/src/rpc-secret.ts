import {
  RPC_SECRET_ALGORITHM,
  RpcSecretEcPublicJwkSchema,
  RpcSecretEnvelopeSchema,
  RpcSecretPublicKeySchema,
  type RpcSecretEcPublicJwk,
  type RpcSecretEnvelope,
  type RpcSecretPublicKey,
} from '@lody/shared';

const RPC_SECRET_AAD_LABEL = 'lody-machine-rpc-secret-v1';

const getCryptoOrThrow = (): Crypto => {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle || !crypto.getRandomValues) {
    throw new Error('WebCrypto is required for secret-safe Machine RPC input.');
  }
  return crypto;
};

const copyToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + 0x8000));
    binary += String.fromCharCode(...chunk);
  }
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlToBytes = (value: string): Uint8Array => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary =
    typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const exportPublicJwk = async (key: CryptoKey): Promise<RpcSecretEcPublicJwk> => {
  const exported = await getCryptoOrThrow().subtle.exportKey('jwk', key);
  return RpcSecretEcPublicJwkSchema.parse({
    kty: exported.kty,
    crv: exported.crv,
    x: exported.x,
    y: exported.y,
  });
};

const importPublicKey = async (jwk: RpcSecretEcPublicJwk): Promise<CryptoKey> =>
  await getCryptoOrThrow().subtle.importKey(
    'jwk',
    { ...jwk, ext: true, key_ops: [] },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

const deriveSecretKey = async (privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> =>
  await getCryptoOrThrow().subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

const buildAdditionalData = (keyId: string, context: string): Uint8Array =>
  new TextEncoder().encode(`${RPC_SECRET_AAD_LABEL}\0${keyId}\0${context}`);

const createKeyPair = async (): Promise<CryptoKeyPair> => {
  const pair = await getCryptoOrThrow().subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey']
  );
  if (!('privateKey' in pair)) {
    throw new Error('WebCrypto did not return an ECDH key pair.');
  }
  return pair;
};

export const getMachineAcpAuthorizationCodeSecretContext = (options: {
  workspaceId: string;
  machineId: string;
  authenticationRequestId: string;
}): string =>
  `machine/acp-authenticate\0${options.workspaceId}\0${options.machineId}\0${options.authenticationRequestId}`;

export const getMachineAcpAuthenticationInputSecretContext = (options: {
  workspaceId: string;
  machineId: string;
  authenticationRequestId: string;
  interactionId: string;
}): string =>
  `machine/acp-authenticate-input\0${options.workspaceId}\0${options.machineId}\0${options.authenticationRequestId}\0${options.interactionId}`;

export type RpcSecretRecipient = {
  readonly publicKey: RpcSecretPublicKey;
  decrypt(envelope: RpcSecretEnvelope, context: string): Promise<string>;
};

export const createRpcSecretRecipient = async (): Promise<RpcSecretRecipient> => {
  const pair = await createKeyPair();
  const keyIdBytes = new Uint8Array(16);
  getCryptoOrThrow().getRandomValues(keyIdBytes);
  const publicKey = RpcSecretPublicKeySchema.parse({
    type: 'rpc-secret-public-key-v1',
    algorithm: RPC_SECRET_ALGORITHM,
    keyId: bytesToBase64Url(keyIdBytes),
    publicKey: await exportPublicJwk(pair.publicKey),
  });

  return {
    publicKey,
    async decrypt(envelope, context) {
      const parsed = RpcSecretEnvelopeSchema.parse(envelope);
      if (parsed.keyId !== publicKey.keyId) {
        throw new Error('Machine RPC secret recipient key mismatch.');
      }
      const sharedKey = await deriveSecretKey(
        pair.privateKey,
        await importPublicKey(parsed.ephemeralPublicKey)
      );
      const plaintext = await getCryptoOrThrow().subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: copyToArrayBuffer(base64UrlToBytes(parsed.iv)),
          additionalData: copyToArrayBuffer(buildAdditionalData(parsed.keyId, context)),
        },
        sharedKey,
        copyToArrayBuffer(base64UrlToBytes(parsed.ciphertext))
      );
      return new TextDecoder().decode(plaintext);
    },
  };
};

export const encryptRpcSecret = async (
  recipientPublicKey: RpcSecretPublicKey,
  plaintext: string,
  context: string
): Promise<RpcSecretEnvelope> => {
  const recipient = RpcSecretPublicKeySchema.parse(recipientPublicKey);
  const senderPair = await createKeyPair();
  const sharedKey = await deriveSecretKey(
    senderPair.privateKey,
    await importPublicKey(recipient.publicKey)
  );
  const iv = new Uint8Array(12);
  getCryptoOrThrow().getRandomValues(iv);
  const ciphertext = await getCryptoOrThrow().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: copyToArrayBuffer(iv),
      additionalData: copyToArrayBuffer(buildAdditionalData(recipient.keyId, context)),
    },
    sharedKey,
    copyToArrayBuffer(new TextEncoder().encode(plaintext))
  );
  return RpcSecretEnvelopeSchema.parse({
    type: 'rpc-secret-envelope-v1',
    algorithm: RPC_SECRET_ALGORITHM,
    keyId: recipient.keyId,
    ephemeralPublicKey: await exportPublicJwk(senderPair.publicKey),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  });
};

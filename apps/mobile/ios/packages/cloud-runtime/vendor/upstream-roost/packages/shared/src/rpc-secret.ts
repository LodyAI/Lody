import { z } from 'zod';

export const RPC_SECRET_PUBLIC_KEY_TYPE = 'rpc-secret-public-key-v1';
export const RPC_SECRET_ENVELOPE_TYPE = 'rpc-secret-envelope-v1';
export const RPC_SECRET_ALGORITHM = 'ECDH-P256-AES-256-GCM';

const Base64UrlSchema = z.string().trim().min(1).max(16_384).regex(/^[A-Za-z0-9_-]+$/);

export const RpcSecretEcPublicJwkSchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: Base64UrlSchema.max(128),
    y: Base64UrlSchema.max(128),
  })
  .strict();
export type RpcSecretEcPublicJwk = z.infer<typeof RpcSecretEcPublicJwkSchema>;

export const RpcSecretPublicKeySchema = z
  .object({
    type: z.literal(RPC_SECRET_PUBLIC_KEY_TYPE),
    algorithm: z.literal(RPC_SECRET_ALGORITHM),
    keyId: Base64UrlSchema.max(128),
    publicKey: RpcSecretEcPublicJwkSchema,
  })
  .strict();
export type RpcSecretPublicKey = z.infer<typeof RpcSecretPublicKeySchema>;

export const RpcSecretEnvelopeSchema = z
  .object({
    type: z.literal(RPC_SECRET_ENVELOPE_TYPE),
    algorithm: z.literal(RPC_SECRET_ALGORITHM),
    keyId: Base64UrlSchema.max(128),
    ephemeralPublicKey: RpcSecretEcPublicJwkSchema,
    iv: Base64UrlSchema.max(64),
    ciphertext: Base64UrlSchema,
  })
  .strict();
export type RpcSecretEnvelope = z.infer<typeof RpcSecretEnvelopeSchema>;

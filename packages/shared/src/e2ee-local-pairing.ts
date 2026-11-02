import { z } from 'zod';

/** This route is served exclusively on the same-user local control socket, never a network listener. */
export const LOCAL_E2EE_PAIRING_PATH = '/e2ee/pairing';
const identifier = z.string().min(1).max(128);
const machineId = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => {
    const bytes = new TextEncoder().encode(value);
    return (
      bytes.length <= 256 &&
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) === value
    );
  });
const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const hex16 = z.string().regex(/^[0-9a-f]{32}$/);
const common = {
  machineId,
  accountId: identifier,
  workspaceId: identifier,
  genesisHash: hex32,
  frontendSigningPublicKey: hex32,
};
export const LocalE2eePrepareRequestSchema = z
  .object({
    ...common,
    type: z.literal('prepare'),
    genesisRecordHex: z.string().regex(/^(?:[0-9a-f]{2}){1,8192}$/),
    membershipId: hex16,
    pairingSessionId: hex16,
  })
  .strict();
export const LocalE2eeActivateRequestSchema = z
  .object({
    ...common,
    type: z.literal('activate'),
    pairingSessionId: hex16,
    signingPublicKey: hex32,
  })
  .strict();
export const LocalE2eePairingRequestSchema = z.discriminatedUnion('type', [
  LocalE2eePrepareRequestSchema,
  LocalE2eeActivateRequestSchema,
]);
export const LocalE2eePrepareResponseSchema = z
  .object({
    ok: z.literal(true),
    type: z.literal('prepare'),
    machineId,
    pairingSessionId: hex16,
    signingPublicKey: hex32,
    encryptionPublicKey: hex32,
    possessionSignature: z.string().regex(/^[0-9a-f]{128}$/),
    credentialHash: hex32,
    bindingSignature: z.string().regex(/^[0-9a-f]{128}$/),
    protection: z.enum(['os-keystore', 'file']),
  })
  .strict();
/** Exact same-user receipt: this request's unpublished generation was superseded. */
export const LocalE2eePrepareSupersededResponseSchema = z
  .object({
    ok: z.literal(true),
    type: z.literal('prepare-superseded'),
    machineId,
    pairingSessionId: hex16,
  })
  .strict();
export const LocalE2eePrepareReplySchema = z.union([
  LocalE2eePrepareResponseSchema,
  LocalE2eePrepareSupersededResponseSchema,
]);
export type LocalE2eePrepareReply = z.infer<typeof LocalE2eePrepareReplySchema>;
export const LocalE2eeActivateResponseSchema = z
  .object({ ok: z.literal(true), type: z.literal('activate') })
  .strict();
export type LocalE2eePrepareRequest = z.infer<typeof LocalE2eePrepareRequestSchema>;
export type LocalE2eeActivateRequest = z.infer<typeof LocalE2eeActivateRequestSchema>;
export type LocalE2eePairingRequest = z.infer<typeof LocalE2eePairingRequestSchema>;
export type LocalE2eePrepareResponse = z.infer<typeof LocalE2eePrepareResponseSchema>;
export type LocalE2eeActivateResponse = z.infer<typeof LocalE2eeActivateResponseSchema>;

/** Explicit, same-OS-user recovery. This route grants no ledger authority. */
export const LOCAL_E2EE_RESET_PATH = '/e2ee/reset-identity';
export const LocalE2eeResetRequestSchema = z
  .object({
    machineId: identifier,
    accountId: identifier,
    workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    resetId: z.string().uuid(),
  })
  .strict();
export const LocalE2eeResetResponseSchema = z
  .object({
    ok: z.literal(true),
    resetId: z.string().uuid(),
    archive: z.string().nullable(),
  })
  .strict();
export type LocalE2eeResetRequest = z.infer<typeof LocalE2eeResetRequestSchema>;
export type LocalE2eeResetResponse = z.infer<typeof LocalE2eeResetResponseSchema>;

/** Content-free local recovery failures; raw native/SQLite causes never cross IPC. */
export const LocalE2eeRecoveryFailureSchema = z
  .object({
    ok: z.literal(false),
    error: z.enum([
      'e2ee_permissions',
      'e2ee_identity-lost',
      'e2ee_corrupt',
      'e2ee_conflict',
      'e2ee_unavailable',
      'e2ee_identity-busy',
    ]),
  })
  .strict();

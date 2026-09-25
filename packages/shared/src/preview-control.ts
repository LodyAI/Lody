import { z } from 'zod';
import { PreviewTargetSchema } from './message-schemas';

const identifier = z.string().min(1).max(200);

export const PreviewControlOperationSchema = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('create'), target: PreviewTargetSchema, restart: z.boolean() })
    .strict(),
  z.object({ action: z.literal('revoke') }).strict(),
  z.object({ action: z.literal('status'), renewEndpointId: identifier.optional() }).strict(),
]);

/** A narrow, signed operation, never a login credential or viewer capability. */
export const PreviewControlIntentSchema = z
  .object({
    workspaceId: identifier,
    machineId: identifier,
    sessionId: identifier,
    requesterUserId: identifier,
    runtimeNonce: z.string().uuid(),
    requestId: z.string().uuid(),
    operation: PreviewControlOperationSchema,
  })
  .strict();

export const PreviewControlProofSchema = z
  .object({
    runtimeNonce: z.string().uuid(),
    requestId: z.string().uuid(),
    requestToken: z.string().min(1).max(8192),
  })
  .strict();

export type PreviewControlOperation = z.infer<typeof PreviewControlOperationSchema>;
export type PreviewControlIntent = z.infer<typeof PreviewControlIntentSchema>;
export type PreviewControlProof = z.infer<typeof PreviewControlProofSchema>;

export type VerifyPreviewControlInput = {
  intent: PreviewControlIntent;
  requestToken: string;
  /** Resolved by the target CLI from Session metadata, never from the RPC caller. */
  localProjectId?: string;
};

export const PreviewControlVerificationSchema = z
  .object({
    requesterUserId: identifier,
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();

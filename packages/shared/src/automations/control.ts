import { z } from 'zod';
import { automationRegistrationSchema, automationSettingsSchema } from './conditions';
import { RpcSecretEnvelopeSchema, RpcSecretPublicKeySchema } from '../rpc-secret';

const id = z.string().min(1).max(512);
export const AUTOMATION_CONTROL_PATH = '/automation-control';
export const automationCommandSchema = z.discriminatedUnion('type', [
  automationRegistrationSchema
    .extend({ type: z.literal('register'), sessionId: id.optional() })
    .strict(),
  z
    .object({
      type: z.literal('configure'),
      sessionId: id.optional(),
      settings: automationSettingsSchema,
    })
    .strict(),
  z.object({ type: z.literal('settings'), sessionId: id.optional() }).strict(),
  z.object({ type: z.literal('list'), sessionId: id.optional() }).strict(),
  z.object({ type: z.literal('show'), id }).strict(),
  z.object({ type: z.literal('cancel'), id }).strict(),
  z
    .object({
      type: z.literal('activities'),
      sessionId: id.optional(),
      limit: z.number().int().min(1).max(100).default(50),
      before: z.object({ updatedAt: z.number().int().nonnegative(), id }).strict().optional(),
    })
    .strict(),
]);
export const automationControlRequestSchema = z
  .object({
    machineId: id,
    workspaceId: id,
    requesterSessionId: id.optional(),
    command: automationCommandSchema,
  })
  .strict();
export type AutomationControlRequest = z.infer<typeof automationControlRequestSchema>;
export type AutomationCommand = z.infer<typeof automationCommandSchema>;
export const automationControlResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);
export type AutomationControlResponse = z.infer<typeof automationControlResponseSchema>;

/** Remote UI controls are restricted to one Session and never accept programs. */
export const remoteAutomationOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('list'), after: id.optional() }).strict(),
  z.object({ type: z.literal('settings') }).strict(),
  z.object({ type: z.literal('configure'), settings: automationSettingsSchema }).strict(),
  z.object({ type: z.literal('cancel'), id }).strict(),
]);
export const remoteAutomationIntentSchema = z
  .object({
    workspaceId: id,
    machineId: id,
    sessionId: id,
    requesterUserId: id,
    runtimeNonce: z.string().uuid(),
    requestId: z.string().uuid(),
    responseKey: RpcSecretPublicKeySchema,
    operation: remoteAutomationOperationSchema,
  })
  .strict();
export const remoteAutomationProofSchema = z
  .object({
    runtimeNonce: z.string().uuid(),
    requestId: z.string().uuid(),
    requestToken: z.string().min(1).max(8192),
  })
  .strict();
export type RemoteAutomationOperation = z.infer<typeof remoteAutomationOperationSchema>;
export type RemoteAutomationIntent = z.infer<typeof remoteAutomationIntentSchema>;
export type RemoteAutomationProof = z.infer<typeof remoteAutomationProofSchema>;

export const remoteAutomationWaitSchema = z
  .object({
    id,
    sessionId: id,
    reason: z.string().max(2000).optional(),
    state: z.enum(['waiting', 'checking', 'matched', 'cancelled', 'expired', 'failed']),
    nextCheckAt: z.number(),
    expiresAt: z.number().optional(),
    continuation: z
      .object({ state: z.string(), reason: z.string().optional() })
      .strict()
      .optional(),
  })
  .strict();
export const remoteAutomationResultSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('list'),
      waits: z.array(remoteAutomationWaitSchema),
      next: id.optional(),
    })
    .strict(),
  z.object({ type: z.literal('settings'), settings: automationSettingsSchema }).strict(),
  z.object({ type: z.literal('cancel') }).strict(),
]);
export type RemoteAutomationResult = z.infer<typeof remoteAutomationResultSchema>;
export const remoteAutomationHandshakeSchema = z.discriminatedUnion('success', [
  z
    .object({
      type: z.literal('machine/automation-control_response'),
      machineId: id,
      success: z.literal(true),
      runtimeNonce: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal('machine/automation-control_response'),
      machineId: id,
      success: z.literal(false),
      error: z.string(),
    })
    .strict(),
]);
export const remoteAutomationRpcResultSchema = z.discriminatedUnion('success', [
  z
    .object({
      type: z.literal('session/automation-control_response'),
      sessionId: id,
      success: z.literal(true),
      result: remoteAutomationResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('session/automation-control_response'),
      sessionId: id,
      success: z.literal(false),
      error: z.string(),
    })
    .strict(),
]);
export type RemoteAutomationHandshake = z.infer<typeof remoteAutomationHandshakeSchema>;
export type RemoteAutomationRpcResult = z.infer<typeof remoteAutomationRpcResultSchema>;
export const remoteAutomationSecretEnvelopeSchema = RpcSecretEnvelopeSchema.extend({
  ciphertext: z
    .string()
    .min(1)
    .max(65_536)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export const remoteAutomationEncryptedResponseSchema = z
  .object({
    type: z.literal('session/automation-control_encrypted'),
    payload: remoteAutomationSecretEnvelopeSchema,
  })
  .strict();
export type RemoteAutomationEncryptedResponse = z.infer<
  typeof remoteAutomationEncryptedResponseSchema
>;

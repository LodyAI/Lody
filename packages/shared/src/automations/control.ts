import { z } from 'zod';
import { automationRegistrationSchema, automationSettingsSchema } from './conditions';

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

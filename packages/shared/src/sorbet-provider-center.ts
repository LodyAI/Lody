import { z } from 'zod';

import type { MachineId } from './ids';
import { RpcSecretPublicKeySchema } from './rpc-secret';

export const SorbetCustomProviderProtocolSchema = z.enum([
  'anthropic-messages',
  'openai-responses',
  'openai-completions',
]);
export type SorbetCustomProviderProtocol = z.infer<typeof SorbetCustomProviderProtocolSchema>;

export const SorbetCustomProviderModelSchema = z
  .object({
    id: z.string().trim().min(1).max(512),
    name: z.string().trim().min(1).max(512).optional(),
    reasoning: z.boolean().optional(),
    thinkingLevelMap: z
      .object({
        off: z.string().nullable().optional(),
        minimal: z.string().nullable().optional(),
        low: z.string().nullable().optional(),
        medium: z.string().nullable().optional(),
        high: z.string().nullable().optional(),
        xhigh: z.string().nullable().optional(),
        max: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
    input: z.array(z.enum(['text', 'image'])).min(1).max(2).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
  })
  .strict();
export type SorbetCustomProviderModel = z.infer<typeof SorbetCustomProviderModelSchema>;

export const SorbetCustomProviderInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    protocol: SorbetCustomProviderProtocolSchema,
    baseUrl: z
      .string()
      .trim()
      .url()
      .max(8192)
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === 'https:' || protocol === 'http:';
      }, 'baseUrl must use http or https'),
    catalogRefs: z.array(z.string().trim().min(1).max(512)).min(1).max(100).optional(),
    models: z.array(SorbetCustomProviderModelSchema).min(1).max(100),
  })
  .strict();
export type SorbetCustomProviderInput = z.infer<typeof SorbetCustomProviderInputSchema>;

export const SorbetProviderModelSchema = SorbetCustomProviderModelSchema.extend({
  selector: z.string().trim().min(1).max(2048),
}).strict();
export type SorbetProviderModel = z.infer<typeof SorbetProviderModelSchema>;

export const SorbetProviderConnectionSchema = z
  .object({
    id: z.string().trim().min(1).max(512),
    name: z.string().trim().min(1).max(512),
    kind: z.enum(['oauth', 'custom']),
    credentialType: z.enum(['oauth', 'api_key']).optional(),
    connected: z.boolean(),
    enabled: z.boolean(),
    models: z.array(SorbetProviderModelSchema).max(500),
    custom: SorbetCustomProviderInputSchema.optional(),
  })
  .strict();
export type SorbetProviderConnection = z.infer<typeof SorbetProviderConnectionSchema>;

export const SorbetProviderCenterSnapshotSchema = z
  .object({
    version: z.literal(1),
    claudeOAuthEnabled: z.boolean(),
    defaultProviderId: z.string().trim().min(1).max(512).optional(),
    defaultModelSelector: z.string().trim().min(1).max(2048).optional(),
    providers: z.array(SorbetProviderConnectionSchema).max(100),
  })
  .strict();
export type SorbetProviderCenterSnapshot = z.infer<
  typeof SorbetProviderCenterSnapshotSchema
>;

export const SorbetProviderCenterOperationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('snapshot') }).strict(),
  z
    .object({
      action: z.literal('set-claude-oauth-enabled'),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal('set-default'),
      providerId: z.string().trim().min(1).max(512),
    })
    .strict(),
  z
    .object({
      action: z.literal('create-custom'),
      provider: SorbetCustomProviderInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('update-custom'),
      providerId: z.string().trim().min(1).max(512),
      provider: SorbetCustomProviderInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('delete-custom'),
      providerId: z.string().trim().min(1).max(512),
    })
    .strict(),
  z
    .object({
      action: z.literal('logout'),
      providerId: z.string().trim().min(1).max(512),
    })
    .strict(),
]);
export type SorbetProviderCenterOperation = z.infer<
  typeof SorbetProviderCenterOperationSchema
>;

export const SorbetProviderCenterLocalOperationSchema = z.discriminatedUnion('action', [
  ...SorbetProviderCenterOperationSchema.options,
  z
    .object({
      action: z.literal('set-api-key'),
      providerId: z.string().trim().min(1).max(512),
      apiKey: z.string().trim().min(1).max(65_536),
    })
    .strict(),
]);
export type SorbetProviderCenterLocalOperation = z.infer<
  typeof SorbetProviderCenterLocalOperationSchema
>;

export const SorbetProviderCenterResponseSchema = z
  .object({
    type: z.literal('machine/sorbet-provider-center_response'),
    machineId: z.string().trim().min(1),
    success: z.boolean(),
    snapshot: SorbetProviderCenterSnapshotSchema.optional(),
    affectedProviderId: z.string().trim().min(1).max(512).optional(),
    secretInput: z
      .object({
        operationId: z.string().trim().min(1).max(1024),
        publicKey: RpcSecretPublicKeySchema,
      })
      .strict()
      .optional(),
    error: z.string().trim().min(1).max(65_536).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.success && value.snapshot === undefined && value.secretInput === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['snapshot'],
        message: 'successful response must contain snapshot or secretInput',
      });
    }
    if (!value.success && value.error === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'failed response must contain error',
      });
    }
  });
export type SorbetProviderCenterResponse = z.infer<typeof SorbetProviderCenterResponseSchema> & {
  machineId: MachineId;
};

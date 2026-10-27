import { z } from 'zod';
import { AgentConfigIdSchema } from './message-schemas';

// Registry packages only: never interpret user input as flags, paths, URLs or shell code.
export const DshPluginPackageNameSchema = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
export const DshPluginPackageSpecSchema = z
  .string()
  .max(300)
  .regex(
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9*^~][a-zA-Z0-9.*+^~_-]*)?$/
  );
export const DshPluginsRequestSchema = z.discriminatedUnion('action', [
  z.object({ configId: AgentConfigIdSchema, action: z.literal('list') }).strict(),
  z
    .object({
      configId: AgentConfigIdSchema,
      action: z.literal('install'),
      package: DshPluginPackageSpecSchema,
    })
    .strict(),
  z
    .object({
      configId: AgentConfigIdSchema,
      action: z.enum(['update', 'remove']),
      package: DshPluginPackageNameSchema,
    })
    .strict(),
]);
export type DshPluginsRequest = z.infer<typeof DshPluginsRequestSchema>;
export const DshPluginSchema = z
  .object({
    name: DshPluginPackageNameSchema,
    version: z.string().max(300),
    active: z.boolean(),
  })
  .strict();
export type DshPlugin = z.infer<typeof DshPluginSchema>;
export const DshPluginsResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), plugins: z.array(DshPluginSchema).max(256) }).strict(),
  z.object({ success: z.literal(false), error: z.string().max(4096) }).strict(),
]);
export type DshPluginsResponse = z.infer<typeof DshPluginsResponseSchema>;

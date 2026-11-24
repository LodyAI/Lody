import { AgentRoleSnapshotSchema } from '../message-author';
import { MemoryBindingSchema } from '../memory-provider';
import { z } from 'zod';
import { descriptorIdSchema, pluginIdSchema, pluginManifestSchema } from './manifest-schema';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const configValues = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export const pluginControlParams = z.strictObject({
  pluginId: pluginIdSchema,
  action: z.enum(['inspect', 'configure-many', 'enable', 'disable', 'reload']),
  changes: configValues.optional(),
  clientDigest: digest.optional(),
});
export const pluginInspectionSchema = z.object({
  lifecycle: z.string(),
  pid: z.number().optional(),
  registrations: z.array(z.string()),
  diagnostics: z.array(z.string()),
  logs: z.array(z.string()).max(500),
  preferences: configValues,
  configured: z.array(z.string()),
});
export const pluginCatalogParams = z.strictObject({});
export const pluginBundleParams = z.strictObject({
  pluginId: pluginIdSchema,
  clientDigest: digest,
  offset: z.number().int().nonnegative().lt(4194304),
});
export const pluginInvocationParams = z.strictObject({
  pluginId: pluginIdSchema,
  descriptorId: descriptorIdSchema,
  scope: z.enum(['machine', 'project', 'session']),
  target: z.strictObject({
    workspaceId: z.string().min(1),
    machineId: z.string().min(1),
    projectId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  }),
  input: z.json(),
});
const createSessionRef = pluginInvocationParams.shape.target.extend({
  sessionId: z.string().min(1),
});
export const pluginInitialRole = z.strictObject({
  snapshot: AgentRoleSnapshotSchema,
  prefix: z.string().optional(),
  modeId: z.string().optional(),
  modelId: z.string().optional(),
  memory: MemoryBindingSchema.optional(),
  configOptionValues: z.record(z.string(), z.union([z.boolean(), z.string()])).optional(),
});
export const pluginSessionCreateParams = z.strictObject({
  pluginId: pluginIdSchema,
  clientDigest: digest,
  scope: z.enum(['machine', 'project']),
  target: pluginInvocationParams.shape.target,
  input: z.strictObject({
    requestId: z.string().min(1).max(256),
    businessKey: z.string().min(1).max(512).optional(),
    prompt: z.string().trim().min(1),
    providerId: z.string().min(1).optional(),
    roleId: z.string().min(1).optional(),
    parentSession: createSessionRef.optional(),
    originTurn: z
      .strictObject({ session: createSessionRef, userTurnId: z.string().min(1) })
      .optional(),
    skillIds: z.array(z.string().min(1)).max(128).optional(),
    pullRequestUrl: z.string().max(4096).optional(),
  }),
});
export const pluginRpcResultSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('plugin/session-create'),
    sessionId: z.string().uuid(),
    userId: z.string().min(1),
    createdAt: z.string(),
    archived: z.boolean(),
    role: pluginInitialRole.optional(),
    cliType: z.enum(['builtin', 'custom', 'registry']),
    agentType: z.string(),
  }),
  z.strictObject({ type: z.literal('plugin/control'), inspection: pluginInspectionSchema }),
  z.strictObject({
    type: z.literal('plugin/catalog'),
    installations: z.array(
      z.strictObject({
        manifest: pluginManifestSchema,
        enabled: z.boolean(),
        inspection: pluginInspectionSchema.optional(),
        clientDigest: digest.optional(),
        devSessionNonce: z.string().optional(),
      })
    ),
  }),
  z.strictObject({
    type: z.literal('plugin/bundle-chunk'),
    base64: z.string().max(349528),
    totalBytes: z.number().int().positive().max(4194304),
  }),
  z.strictObject({
    type: z.enum([
      'plugin/query',
      'plugin/mutate',
      'plugin/attachment-search',
      'plugin/attachment-resolve',
    ]),
    data: z.json(),
  }),
]);

export type PluginMachineRequest = Extract<
  import('../local-machine-rpc').LocalMachineRpcRequest,
  { method: `plugin/${string}` }
>;
export function isPluginMachineRequest(
  request: import('../local-machine-rpc').LocalMachineRpcRequest
): request is PluginMachineRequest {
  return pluginMethods.has(request.method);
}
export const pluginMethods: ReadonlySet<string> = new Set([
  'plugin/control',
  'plugin/catalog',
  'plugin/session-create',
  'plugin/bundle-chunk',
  'plugin/query',
  'plugin/mutate',
  'plugin/attachment-search',
  'plugin/attachment-resolve',
]);
export type PluginMachineResult = z.infer<typeof pluginRpcResultSchema>;

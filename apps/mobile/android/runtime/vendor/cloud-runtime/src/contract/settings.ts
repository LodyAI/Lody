import { z } from 'zod/v4';

const settingsScope = {
  workspaceId: z.string().min(1),
  userId: z.string(),
};
const visibility = z.enum(['private', 'workspace']);

export const RemoteSetting = z
  .object({
    kind: z.enum(['machine', 'agent', 'mcp']),
    id: z.string(),
    name: z.string(),
    machineId: z.string().optional(),
    machineName: z.string().optional(),
    readOnly: z.boolean().optional(),
    detail: z.string().optional(),
    prompt: z.string().optional(),
    enabledByDefault: z.boolean().optional(),
    configured: z.boolean().optional(),
    updatedAt: z.number().optional(),
  })
  .meta({ id: 'RemoteSetting' });

export const RemoteSettingsParams = z
  .object({
    ...settingsScope,
    kind: z.enum(['machine', 'agent', 'mcp']),
    edit: z
      .object({
        item: RemoteSetting,
        name: z.string(),
        prompt: z.string().optional(),
        enabledByDefault: z.boolean().optional(),
      })
      .optional(),
    remove: RemoteSetting.optional(),
  })
  .meta({ id: 'RemoteSettingsParams' });

export const RemoteSettingsResult = z
  .object({ settings: z.array(RemoteSetting) })
  .meta({ id: 'RemoteSettingsResult' });

export const MemoryAssociation = z
  .object({
    machineId: z.string().min(1),
    providerId: z.string().min(1),
    memoryId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
  })
  .meta({ id: 'MemoryAssociation' });

const memoryScope = {
  ...settingsScope,
  machineId: z.string().min(1).optional(),
};

export const MemorySettingsParams = z
  .discriminatedUnion('action', [
    z.object({ ...memoryScope, action: z.literal('list') }),
    z.object({
      ...memoryScope,
      action: z.literal('import'),
      memoryId: z.string().min(1),
    }),
    z.object({
      ...memoryScope,
      action: z.literal('remove'),
      base: MemoryAssociation,
    }),
  ])
  .meta({ id: 'MemorySettingsParams' });

export const MemorySnapshot = z
  .object({
    machines: z.array(z.object({ id: z.string(), name: z.string() })),
    machineId: z.string().optional(),
    entries: z.array(MemoryAssociation),
    identities: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        description: z.string().optional(),
        role: z.string().optional(),
      }),
    ),
    status: z.enum([
      'ready',
      'not_installed',
      'not_running',
      'error',
      'offline',
      'unknown',
      'unsupported',
      'forbidden',
    ]),
    cached: z.boolean(),
  })
  .meta({ id: 'MemorySnapshot' });

export const AgentRoleItem = z
  .object({
    id: z.string().min(1),
    ownerUserId: z.string().min(1),
    visibility,
    name: z.string(),
    description: z.string(),
    promptPrefix: z.string(),
    /** The Role's glyph (web `getAgentRoleEmoji`: the stored one, else the default). */
    emoji: z.string().optional(),
    revision: z.number().int(),
    updatedAt: z.number(),
    targets: z.array(
      z.object({
        machineId: z.string().min(1),
        agentConfigId: z.string().min(1),
        alias: z.string().optional(),
        /** What this target pins; secret-shaped option keys never leave the row. */
        runConfig: z
          .object({
            modelId: z.string().optional(),
            modeId: z.string().optional(),
            // Strings or booleans only (the runtime filters); Swift reads JSONValue.
            configOptionValues: z.record(z.string(), z.unknown()).optional(),
          })
          .optional(),
        machineName: z.string(),
        agentName: z.string(),
        state: z.enum(['configured', 'machineUnavailable', 'agentUnavailable']),
      }),
    ),
  })
  .meta({ id: 'AgentRoleItem' });

export const AgentRolesParams = z
  .discriminatedUnion('action', [
    z.object({ ...settingsScope, action: z.literal('list') }),
    z.object({
      ...settingsScope,
      action: z.literal('save'),
      id: z.string().min(1),
      base: AgentRoleItem.nullable(),
      fields: z.object({
        name: z.string(),
        description: z.string(),
        promptPrefix: z.string(),
        visibility,
      }),
      target: z
        .object({
          machineId: z.string().min(1),
          agentConfigId: z.string().min(1),
        })
        .optional(),
    }),
    z.object({
      ...settingsScope,
      action: z.literal('delete'),
      base: AgentRoleItem,
    }),
  ])
  .meta({ id: 'AgentRolesParams' });

export const AgentRoleSnapshot = z
  .object({
    roles: z.array(AgentRoleItem),
    agents: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        machineId: z.string(),
        machineName: z.string(),
        cliType: z.string().optional(),
        agentType: z.string().optional(),
      }),
    ),
  })
  .meta({ id: 'AgentRoleSnapshot' });

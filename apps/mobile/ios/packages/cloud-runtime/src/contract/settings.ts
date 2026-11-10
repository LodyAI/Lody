import { z } from 'zod/v4';
import { providerAdvancedFields, ProviderPreset } from './provider-details.ts';

const settingsScope = {
  workspaceId: z.string().min(1),
  userId: z.string(),
};
const visibility = z.enum(['private', 'workspace']);

export const RemoteSetting = z
  .object({
    kind: z.enum(['machine', 'agent']),
    id: z.string(),
    name: z.string(),
    machineId: z.string().optional(),
    machineName: z.string().optional(),
    readOnly: z.boolean().optional(),
    detail: z.string().optional(),
    prompt: z.string().optional(),
  })
  .meta({ id: 'RemoteSetting' });

export const RemoteSettingsParams = z
  .object({
    ...settingsScope,
    kind: z.enum(['machine', 'agent']),
    edit: z
      .object({
        item: RemoteSetting,
        name: z.string(),
        prompt: z.string().optional(),
      })
      .optional(),
  })
  .meta({ id: 'RemoteSettingsParams' });

export const RemoteSettingsResult = z
  .object({ settings: z.array(RemoteSetting) })
  .meta({ id: 'RemoteSettingsResult' });

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

const providerFields = {
  name: z.string().min(1).max(200),
  prompt: z.string().max(32000),
  cliType: z.string().min(1),
  agentType: z.string().min(1),
  command: z.string().max(4096),
  args: z.array(z.string().max(4096)).max(128),
};
export const ProviderItem = z
  .object({
    id: z.string().min(1),
    machineId: z.string().min(1),
    ...providerFields,
    readOnly: z.boolean(),
  })
  .meta({ id: 'ProviderItem' });
export const ProviderSetup = z
  .object({
    id: z.string().min(1),
    machineId: z.string().min(1),
    name: z.string(),
    agentType: z.string(),
    status: z.enum([
      'queued',
      'preparing-runtime',
      'verifying',
      'awaiting-auth',
      'failed',
    ]),
    attempt: z.number().int().min(1),
    canRetry: z.boolean(),
    canDelete: z.boolean(),
    failureCode: z.string().optional(),
  })
  .meta({ id: 'ProviderSetup' });
export const AgentProvidersParams = z
  .discriminatedUnion('action', [
    z.object({
      ...settingsScope,
      action: z.literal('list'),
      machineId: z.string().min(1).optional(),
    }),
    z.object({
      ...settingsScope,
      action: z.literal('save'),
      machineId: z.string().min(1),
      id: z.string().min(1),
      base: ProviderItem.nullable(),
      fields: z.object({ ...providerFields, ...providerAdvancedFields }),
    }),
    z.object({
      ...settingsScope,
      action: z.literal('delete'),
      base: ProviderItem,
    }),
    z.object({
      ...settingsScope,
      action: z.literal('refresh'),
      base: ProviderItem,
    }),
    z.object({
      ...settingsScope,
      action: z.literal('retrySetup'),
      setup: ProviderSetup,
    }),
    z.object({
      ...settingsScope,
      action: z.literal('deleteSetup'),
      setup: ProviderSetup,
    }),
  ])
  .meta({ id: 'AgentProvidersParams' });
export const AgentProvidersResult = z
  .object({
    machines: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        os: z.string(),
        readOnly: z.boolean(),
        online: z.boolean(),
        supportsSetup: z.boolean(),
        supportsCodexProfiles: z.boolean().optional(),
        supportsAuthentication: z.boolean().optional(),
        supportsPiExtensions: z.boolean().optional(),
      }),
    ),
    providers: z.array(ProviderItem),
    setups: z.array(ProviderSetup),
    catalog: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        cliType: z.string(),
        agentType: z.string(),
        presetId: z.string().optional(),
      }),
    ),
    presets: z.array(ProviderPreset).optional(),
    authRequired: z.boolean().optional(),
  })
  .meta({ id: 'AgentProvidersResult' });

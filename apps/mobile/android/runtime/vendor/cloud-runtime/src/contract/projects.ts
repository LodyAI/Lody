import { z } from 'zod/v4';

export const Project = z
  .object({
    id: z.string().min(1),
    machineId: z.string(),
    name: z.string(),
    rootPath: z.string(),
    repoFullName: z.string().optional(),
  })
  .meta({ id: 'Project' });

export const CapabilityChoice = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().optional(),
  })
  .meta({ id: 'CapabilityChoice' });

const configOption = {
  id: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  options: z.array(CapabilityChoice),
};

export const ConfigOption = z
  .discriminatedUnion('type', [
    z.object({
      ...configOption,
      type: z.literal('select'),
      currentValue: z.string().optional(),
    }),
    z.object({
      ...configOption,
      type: z.literal('boolean'),
      currentValue: z.boolean().optional(),
    }),
  ])
  .meta({ id: 'ConfigOption' });

export const Capability = z
  .object({
    machineId: z.string(),
    /** The agent config (ACP provider) this was probed for; capabilities are per config, as web. */
    agentConfigId: z.string().optional(),
    cliType: z.string(),
    agentType: z.string(),
    models: z.array(CapabilityChoice),
    modes: z.array(CapabilityChoice),
    legacyModes: z.array(CapabilityChoice).optional(),
    fastModes: z.record(z.string(), z.boolean()).optional(),
    reasoningEfforts: z.record(z.string(), z.array(z.string())),
    reasoningEffortConfigId: z.string().optional(),
    configOptions: z.array(ConfigOption).optional(),
    steer: z.boolean(),
  })
  .meta({ id: 'Capability' });

export const CreationOptionsParams = z
  .object({
    workspaceId: z.string().min(1),
    projectId: z.string().optional(),
    agentConfigId: z.string().min(1).optional(),
  })
  .meta({ id: 'CreationOptionsParams' });

export const CreationOptions = z
  .object({
    availability: z.enum(['online', 'offline', 'unknown']).optional(),
    onlineMachineIds: z.array(z.string()).optional(),
    sessionId: z.string().min(1),
    project: Project.optional(),
    agents: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        machineId: z.string(),
        machineName: z.string(),
        cliType: z.string(),
        agentType: z.string(),
      }),
    ),
    capabilities: z.array(Capability),
  })
  .meta({ id: 'CreationOptions' });
export type CreationOptions = z.input<typeof CreationOptions>;

const browser = {
  workspaceId: z.string().min(1),
  browserId: z.string().min(1),
  userId: z.string(),
};

export const LocalProjectsParams = z
  .discriminatedUnion('action', [
    z.object({ ...browser, action: z.literal('cancel') }),
    z.object({ ...browser, action: z.literal('machines') }),
    z.object({
      ...browser,
      action: z.literal('browse'),
      machineId: z.string().optional(),
      path: z.string().optional(),
      cursor: z.string().optional(),
    }),
    z.object({
      ...browser,
      action: z.literal('add'),
      machineId: z.string().optional(),
      path: z.string().optional(),
    }),
  ])
  .meta({ id: 'LocalProjectsParams' });

export const LocalProjectsResult = z
  .discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('cancelled') }),
    z.object({
      outcome: z.literal('machines'),
      machines: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
    z.object({
      outcome: z.literal('directory'),
      path: z.string().min(1),
      parentPath: z.string().nullable(),
      entries: z.array(
        z.object({
          name: z.string(),
          absolutePath: z.string(),
          error: z.string().optional(),
        }),
      ),
      truncated: z.boolean(),
      nextCursor: z.string().optional(),
    }),
    z.object({ outcome: z.literal('project'), project: Project }),
  ])
  .meta({ id: 'LocalProjectsResult' });

/** The workspace's multi-repository projects (web Project groups): the new-chat picker, Projects and Settings. */
export const ProjectGroupsParams = z
  .object({ workspaceId: z.string().min(1), userId: z.string() })
  .meta({ id: 'ProjectGroupsParams' });

export const ProjectGroupItem = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    /** Its creator; only they can edit or delete it. */
    ownerUserId: z.string(),
    /** The machine its local members pin; null when it runs anywhere. */
    machineId: z.string().nullable(),
    /** Local members on different machines: it cannot start a conversation. */
    conflict: z.boolean(),
    members: z.array(
      z.object({
        id: z.string().min(1),
        kind: z.enum(['github', 'local']),
        label: z.string(),
        repoFullName: z.string().optional(),
        machineId: z.string().optional(),
        localProjectId: z.string().optional(),
        preferLocal: z.boolean().optional(),
        path: z.string(),
      }),
    ),
  })
  .meta({ id: 'ProjectGroupItem' });

export const ProjectGroupsResult = z
  .object({ groups: z.array(ProjectGroupItem) })
  .meta({ id: 'ProjectGroupsResult' });

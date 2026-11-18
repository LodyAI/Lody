import { MemoryAssociationSchema } from '../memory-provider';
import {
  machineCatalogPublicRateLimitSchema,
  type MachineCatalogPublicRateLimit,
} from '../machine-catalog-ipc';
import { normalizePersistedRateLimit } from '../acp/lody-rate-limit-migration';
import { projectMachinePublicCapability } from './native-machine-public-capability';
import {
  readMachineFlockRowsFromFlock,
  getMachineFlockAgentConfigs,
  getMachineFlockProviderSetups,
  getMachineFlockLocalProjects,
  getMachineFlockAcpCapabilities,
  getMachineFlockProviderSetupCancellations,
  type MachineFlockScanRow,
  type AgentConfigListSummary,
} from '../machine-flock';
import type { MachineId, AgentConfigId } from '../ids';
import type { AgentConfigMeta } from '../schema';

export const agentSummary = (config: AgentConfigMeta): AgentConfigListSummary => ({
  id: config.id,
  machineId: config.machineId,
  name: config.name,
  description: config.description,
  cliType: config.cliType,
  agentType: config.agentType,
  ...(config.brandId === undefined ? {} : { brandId: config.brandId }),
});
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const finiteNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Renderer projection is constructed field by field. A structurally valid row
 * may still carry unknown credentials; never spread it into an outward DTO. */
export function projectNativeMachineCatalog(
  entries: readonly MachineFlockScanRow[],
  machineId: MachineId
) {
  const flock = { scan: () => entries };
  const rows = readMachineFlockRowsFromFlock(flock);
  const configs = getMachineFlockAgentConfigs(rows);
  const cancelled = getMachineFlockProviderSetupCancellations(rows);
  const summaries = new Map<string, AgentConfigListSummary>();
  for (const row of Object.values(rows))
    if (row.key[0] === 'agentConfigIndex') {
      const config = row.value as AgentConfigListSummary;
      if (config.machineId === machineId && !cancelled[config.id])
        summaries.set(config.id, agentSummary(config as AgentConfigMeta));
    }
  for (const config of Object.values(configs))
    if (config.machineId === machineId && !cancelled[config.id])
      summaries.set(config.id, agentSummary(config));
  const acp = Object.entries(getMachineFlockAcpCapabilities(rows)).map(([configId, value]) => {
    const config = configs[configId as AgentConfigId];
    return {
      configId,
      cliType: value.cliType,
      agentType: value.agentType,
      fetchedAt: value.fetchedAt,
      modes: value.modes.flatMap((mode: unknown) =>
        record(mode) && typeof mode.id === 'string' && typeof mode.name === 'string'
          ? [{ id: mode.id, name: mode.name }]
          : []
      ),
      models: value.models.flatMap((model: unknown) =>
        record(model) && typeof model.modelId === 'string' && typeof model.name === 'string'
          ? [{ modelId: model.modelId, name: model.name }]
          : []
      ),
      optionIds: Array.isArray(value.configOptions)
        ? value.configOptions.flatMap((option: unknown) =>
            record(option) && typeof option.id === 'string' ? [option.id] : []
          )
        : [],
      sessionFork: value.sessionFork === true,
      sessionTitle: value.sessionTitle === true,
      acknowledgedSteer: value.acknowledgedSteer === true,
      ...(config && config.machineId === machineId && !cancelled[configId as AgentConfigId]
        ? projectMachinePublicCapability(config, value)
        : {}),
    };
  });
  const modelCapabilities: { configId: string; modelIds: string[] }[] = [];
  const modelOptions: { configId: string; modelId: string; shape: string }[] = [];
  const modelShapes: { configId: string; shapeId: string; optionIds: string[] }[] = [];
  const quotas: {
    configId?: string;
    cliType: string;
    limitId: string;
    used?: number;
    limit?: number;
    remaining?: number;
    resetsAt?: number;
    snapshot?: MachineCatalogPublicRateLimit;
  }[] = [];
  const optOuts: { agentType: string; removedAt: number }[] = [];
  const commandCounts = {
    archiveSession: 0,
    deleteSession: 0,
    deleteLocalProject: 0,
    providerCancellation: 0,
  };
  const localProjectDeletions: { projectId: string; requestedAt: number; completed: boolean }[] =
    [];
  const localProjectDeletionResults: {
    projectId: string;
    projectName?: string;
    completedAt: number;
    deletedCount: number;
    skippedDirtyCount: number;
    failedCount: number;
  }[] = [];
  let dotlodyPath: string | undefined;
  let legacyLaunchCount = 0;
  for (const row of Object.values(rows)) {
    const value: unknown = row.value;
    if (row.key[0] === 'dotlodyPath' && typeof value === 'string') dotlodyPath = value;
    else if (row.key[0] === 'acpModelCapability' && record(value))
      modelCapabilities.push({
        configId: row.key[1],
        modelIds: record(value.models) ? Object.keys(value.models) : [],
      });
    else if (row.key[0] === 'acpModelConfigOptions' && record(value))
      modelOptions.push({ configId: row.key[1], modelId: row.key[2], shape: String(value.shape) });
    else if (row.key[0] === 'acpModelConfigOptionsShape' && record(value))
      modelShapes.push({
        configId: row.key[1],
        shapeId: row.key[2],
        optionIds: Array.isArray(value.configOptions)
          ? value.configOptions.flatMap((option) =>
              record(option) && typeof option.id === 'string' ? [option.id] : []
            )
          : [],
      });
    else if (row.key[0] === 'rateLimit' && record(value)) {
      const provider = row.key.length === 4;
      const normalized = normalizePersistedRateLimit(
        String(row.key[provider ? 2 : 1]),
        String(row.key[provider ? 3 : 2]),
        value
      );
      const snapshot = machineCatalogPublicRateLimitSchema.safeParse(normalized);
      quotas.push({
        ...(snapshot.success ? { snapshot: snapshot.data } : {}),
        ...(provider ? { configId: String(row.key[1]) } : {}),
        cliType: String(row.key[provider ? 2 : 1]),
        limitId: String(row.key[provider ? 3 : 2]),
        used: finiteNumber(value.used),
        limit: finiteNumber(value.limit),
        remaining: finiteNumber(value.remaining),
        resetsAt: finiteNumber(value.resetsAt),
      });
    } else if (row.key[0] === 'builtinAgentOptOut' && record(value))
      optOuts.push({ agentType: row.key[1], removedAt: Number(value.removedAt) });
    else if (row.key[0] === 'cmd') {
      commandCounts[row.key[1]]++;
      if (row.key[1] === 'deleteLocalProject' && record(value))
        localProjectDeletions.push({
          projectId: row.key[2],
          requestedAt: Number(value.requestedAt),
          completed: value.status === 'completed',
        });
      if (
        row.key[1] === 'deleteLocalProject' &&
        record(value) &&
        value.status === 'completed' &&
        record(value.cleanupResult)
      ) {
        const result = value.cleanupResult;
        localProjectDeletionResults.push({
          projectId: row.key[2],
          projectName: typeof value.projectName === 'string' ? value.projectName : undefined,
          completedAt: Number(result.completedAt),
          deletedCount: Array.isArray(result.deleted) ? result.deleted.length : 0,
          skippedDirtyCount: Array.isArray(result.skippedDirty) ? result.skippedDirty.length : 0,
          failedCount: Array.isArray(result.failed) ? result.failed.length : 0,
        });
      }
    } else if (row.key[0] === 'providerSetupCancellation') commandCounts.providerCancellation++;
    else if (row.key[0] === 'sessionLaunchConfig') legacyLaunchCount++;
  }
  return {
    dotlodyPath,
    agents: [...summaries.values()],
    projects: Object.values(getMachineFlockLocalProjects(rows)).map((project) => ({
      id: project.id,
      name: project.name,
      rootPath: project.rootPath,
      createdAtMs: project.createdAtMs,
      lastOpenedAtMs: project.lastOpenedAtMs,
      githubRepoFullName: project.githubRepoFullName,
      standaloneVisible: project.standaloneVisible,
    })),
    memories: entries.flatMap((entry) => {
      if (entry.key[0] !== 'memory') return [];
      const parsed = MemoryAssociationSchema.strip().safeParse(entry.value);
      return parsed.success &&
        parsed.data.machineId === machineId &&
        entry.key[1] === parsed.data.providerId &&
        entry.key[2] === parsed.data.memoryId
        ? [parsed.data]
        : [];
    }),
    acp,
    modelCapabilities,
    modelOptions,
    modelShapes,
    quotas,
    optOuts,
    providerSetups: Object.values(getMachineFlockProviderSetups(rows))
      .filter((task) => task.machineId === machineId && !cancelled[task.id])
      .map((task) => ({
        id: task.id,
        machineId: task.machineId,
        status: task.status,
        attempt: task.attempt,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        failureCode: task.failureCode,
        config: agentSummary(task.config),
      })),
    commandCounts,
    localProjectDeletionResults,
    localProjectDeletions,
    legacyLaunchCount,
  };
}
export type NativeMachineCatalogProjection = ReturnType<typeof projectNativeMachineCatalog>;

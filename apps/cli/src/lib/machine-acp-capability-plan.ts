import {
  CustomAcpLaunchSpecSchema,
  BuiltinRuntimeOverridesSchema,
  isBuiltinAgentType,
  type CliType,
  type AgentConfigMeta,
  type MachineId,
} from '@lody/shared';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  getServerNow,
  getAcpCapabilityCacheKey,
  getMachineFlockAcpCapabilities,
  getMachineFlockAgentConfigs,
  readMachineFlockRowsFromFlock,
  getReadableAcpCapabilityCacheEntry,
  machineFlockKeys,
  writeMachineFlockRowToFlock,
  getAcpConfigOptionsModelId,
  writeAcpModelConfigOptionsToFlock,
  shouldRenewAcpCapabilityFetchTime,
  type MachineFlockWritableFlock,
  type AgentConfigId,
  type AgentConfigCliType,
  type AcpConfigOptionSummary,
  type AcpCommandSummary,
  type SessionGoalAction,
  type AcpCapabilityCacheEntry,
} from '@lody/shared';
import type { AcpCapabilityWriteOptions, MachineDocument } from './loro/doc';

export function publishMachineRateLimits(
  flock: MachineFlockWritableFlock,
  ...args: Parameters<MachineDocument['updateRateLimits']>
): boolean {
  const [agentConfigId, cliType, limits, shouldWrite = () => true, expectedConfig] = args;
  if ((!agentConfigId && !isBuiltinAgentType(cliType)) || !shouldWrite()) return false;
  if (expectedConfig) {
    const current = getMachineFlockAgentConfigs(
      readMachineFlockRowsFromFlock(flock, { families: ['agentConfig'] })
    )[expectedConfig.id];
    if (!current || JSON.stringify(current) !== JSON.stringify(expectedConfig)) return false;
  }
  const limitId = ((limits as { limitId?: string }).limitId ?? cliType).trim() || cliType;
  return writeMachineFlockRowToFlock(flock, {
    key: agentConfigId
      ? machineFlockKeys.rateLimit(agentConfigId, cliType, limitId)
      : machineFlockKeys.legacyRateLimit(cliType as CliType, limitId),
    value: limits,
  });
}

const serializeAcpCapabilityWithoutFetchTime = (entry: AcpCapabilityCacheEntry): string =>
  JSON.stringify({
    cliType: entry.cliType,
    agentType: entry.agentType,
    cacheVersion: entry.cacheVersion,
    provenance: entry.provenance,
    sourceVersion: entry.sourceVersion,
    modes: entry.modes,
    models: entry.models,
    configOptions: entry.configOptions,
    modelReasoningEfforts: entry.modelReasoningEfforts,
    availableCommands: entry.availableCommands,
    authMethods: entry.authMethods,
    sessionFork: entry.sessionFork,
    acknowledgedSteer: entry.acknowledgedSteer,
    sessionTitle: entry.sessionTitle,
    rateLimits: entry.rateLimits,
    sessionForkWorktree: entry.sessionForkWorktree,
  });

export function publishMachineAcpCapabilities(
  flock: MachineFlockWritableFlock,
  configId: AgentConfigId,
  cliType: AgentConfigCliType,
  agentType: string,
  modes: Parameters<MachineDocument['updateAcpCapabilities']>[3],
  models: Parameters<MachineDocument['updateAcpCapabilities']>[4],
  configOptions: AcpConfigOptionSummary[] | undefined,
  availableCommands: AcpCommandSummary[] | undefined,
  sessionFork: boolean,
  sourceVersion: string,
  modelReasoningEfforts?: Record<string, string[]>,
  acknowledgedSteer = false,
  goalActions?: SessionGoalAction[],
  options: AcpCapabilityWriteOptions = {}
) {
  options.signal?.throwIfAborted();
  const normalizedModes = modes.map((mode) => ({
    id: mode.id,
    name: mode.name,
    description: mode.description ?? undefined,
  }));
  const normalizedModels = models.map((model) => ({
    modelId: model.modelId,
    name: model.name ?? model.modelId,
    description: model.description ?? undefined,
  }));
  const entry: AcpCapabilityCacheEntry = {
    cliType,
    agentType,
    cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
    provenance: 'runtime',
    sourceVersion,
    modes: normalizedModes,
    models: normalizedModels,
    configOptions: configOptions?.length ? configOptions : undefined,
    availableCommands,
    authMethods: options.authMethods,
    sessionFork,
    acknowledgedSteer,
    goalActions: goalActions?.length ? goalActions : undefined,
    sessionTitle: options.sessionTitle,
    rateLimits: options.rateLimits,
    sessionForkWorktree: sessionFork,
    modelReasoningEfforts:
      modelReasoningEfforts && Object.keys(modelReasoningEfforts).length > 0
        ? modelReasoningEfforts
        : undefined,
    fetchedAt: getServerNow(),
  };
  options.signal?.throwIfAborted();
  const capabilityKey = getAcpCapabilityCacheKey(configId);
  // Reads the stored row alone, without per-model controls, so the
  // comparison below sees exactly what was written.
  const existing = getMachineFlockAcpCapabilities(
    readMachineFlockRowsFromFlock(flock, { families: ['acpCapability'] })
  )[capabilityKey];
  // A caller that did not ask the agent — session-created capability updates —
  // must not erase methods an earlier probe recorded for the same launch.
  if (
    options.authMethods === undefined &&
    existing?.authMethods !== undefined &&
    existing.sourceVersion === entry.sourceVersion
  ) {
    entry.authMethods = existing.authMethods;
  }
  // Only probes replace the preview. Omission preserves the latest same-runtime
  // probe, read beside the write so concurrent session starts cannot roll it back.
  if (availableCommands === undefined && existing?.sourceVersion === sourceVersion) {
    entry.availableCommands = getReadableAcpCapabilityCacheEntry(existing)?.availableCommands;
  }
  // The per-model row holds no timestamp, so an unchanged declaration is
  // skipped by the row comparison and costs no write or sync.
  const modelCapabilitiesChanged =
    options.modelCapabilities !== undefined &&
    writeMachineFlockRowToFlock(flock, {
      key: machineFlockKeys.acpModelCapability(configId),
      value: { version: 1, sourceVersion, models: options.modelCapabilities },
    });
  // The snapshot is also its own model's answer; keep it beside the other
  // models' answers so a later snapshot of another model does not lose it.
  const modelAnswers: Record<string, AcpConfigOptionSummary[]> = {
    ...options.modelConfigOptions,
  };
  const snapshotModelId = getAcpConfigOptionsModelId(entry.configOptions);
  if (snapshotModelId && entry.configOptions) modelAnswers[snapshotModelId] = entry.configOptions;
  const modelAnswersChanged = writeAcpModelConfigOptionsToFlock(
    flock,
    configId,
    sourceVersion,
    modelAnswers
  );
  const capabilityUnchanged =
    existing &&
    serializeAcpCapabilityWithoutFetchTime(existing) ===
      serializeAcpCapabilityWithoutFetchTime(entry) &&
    // Unchanged content is still rewritten once it is old enough: the refresh
    // cache trusts `fetchedAt`, and an entry never renewed would expire once
    // and then miss on every later request, re-probing forever.
    !shouldRenewAcpCapabilityFetchTime(existing, entry.fetchedAt);
  options.signal?.throwIfAborted();
  const changed =
    !capabilityUnchanged &&
    writeMachineFlockRowToFlock(flock, {
      key: machineFlockKeys.acpCapability(configId),
      value: entry,
    });
  return {
    changed: Boolean(changed || modelCapabilitiesChanged || modelAnswersChanged),
    entry: (capabilityUnchanged ? existing : undefined) ?? entry,
  };
}

export const isValidDaemonLaunchConfig = (
  config: AgentConfigMeta,
  expectedConfigId: AgentConfigId,
  expectedMachineId: MachineId
): boolean => {
  if (
    config.id !== expectedConfigId ||
    config.machineId !== expectedMachineId ||
    typeof config.agentType !== 'string' ||
    config.agentType.trim().length === 0 ||
    typeof config.env !== 'object' ||
    config.env === null ||
    Array.isArray(config.env) ||
    Object.values(config.env).some((value) => typeof value !== 'string')
  ) {
    return false;
  }

  if (config.cliType === 'custom') {
    return (
      CustomAcpLaunchSpecSchema.safeParse(config.customAcp).success &&
      config.runtimeOverrides === undefined
    );
  }
  if (config.cliType === 'registry') {
    return config.customAcp === undefined && config.runtimeOverrides === undefined;
  }
  if (config.cliType === 'builtin') {
    return (
      config.customAcp === undefined &&
      (config.runtimeOverrides === undefined ||
        BuiltinRuntimeOverridesSchema.safeParse(config.runtimeOverrides).success)
    );
  }
  return false;
};

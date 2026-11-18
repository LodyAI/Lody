import {
  bindAgentRoleTarget,
  canManageAgentRole,
  getAgentRoleTargets,
  isAgentRoleContentEqual,
  isSensitiveAgentRoleConfigOptionKey,
  normalizeAgentRole,
  serializeAgentRoleRow,
  withAgentRoleTargets,
  type AgentRole,
} from './agent-role';
import {
  isAcpCapabilityCacheEntryCurrentForRuntimeOverrides,
  type AcpCapabilityCacheEntry,
  type BuiltinRuntimeOverrides,
} from './ai';
import type { AgentConfigId, MachineId } from './ids';
import { z } from 'zod';

/** Finite runtime evidence: never includes launch env, commands, tokens or saved secrets. */
export type AgentRoleSchemaEvidence = {
  readonly target: {
    readonly machineId: MachineId;
    readonly agentConfigId: AgentConfigId;
    readonly cliType: AcpCapabilityCacheEntry['cliType'];
    readonly agentType: AcpCapabilityCacheEntry['agentType'];
    readonly runtimeOverrides?: BuiltinRuntimeOverrides;
  };
  readonly schema: Pick<
    AcpCapabilityCacheEntry,
    'cliType' | 'agentType' | 'cacheVersion' | 'provenance' | 'sourceVersion' | 'fetchedAt'
  > & {
    readonly configOptions?: ReadonlyArray<{
      readonly id: string;
      readonly type: string;
      readonly category?: string;
      readonly currentValue?: string;
    }>;
  };
};
export type ReconcileAgentRoleSchemaCommand = {
  readonly kind: 'reconcile-role-schema';
  readonly expected: AgentRole;
  readonly evidence: AgentRoleSchemaEvidence;
  readonly now: number;
};

export function createAgentRoleSchemaEvidence(
  expected: AgentRole,
  capability: AcpCapabilityCacheEntry,
  target: AgentRoleSchemaEvidence['target'] = {
    machineId: expected.machineId,
    agentConfigId: expected.agentConfigId,
    cliType: capability.cliType,
    agentType: capability.agentType,
  }
): AgentRoleSchemaEvidence {
  return {
    target: { ...target },
    schema: {
      cliType: capability.cliType,
      agentType: capability.agentType,
      cacheVersion: capability.cacheVersion,
      provenance: capability.provenance,
      sourceVersion: capability.sourceVersion,
      fetchedAt: capability.fetchedAt,
      configOptions: capability.configOptions?.map((option) => ({
        id: option.id,
        type: option.type,
        ...(option.category ? { category: option.category } : {}),
        ...(option.category === 'model' && typeof option.currentValue === 'string'
          ? { currentValue: option.currentValue }
          : {}),
      })),
    },
  };
}

/** Only a freshly-probed schema may remove keys; existing values and pins stay authored. */
export function reconcileAgentRoleSchema(
  role: AgentRole,
  capability: Pick<AcpCapabilityCacheEntry, 'provenance'> & {
    configOptions?: ReadonlyArray<{
      id: string;
      type: string;
      category?: string;
      currentValue?: unknown;
    }>;
  }
): AgentRole {
  if (capability.provenance !== 'runtime' || !capability.configOptions) return role;
  const advertised = new Set(capability.configOptions.map((option) => option.id));
  const values = { ...role.runConfig.configOptionValues };
  let changed = false;
  const hasPlan = capability.configOptions.some(
    (option) => option.id === 'plan_mode' && option.type === 'boolean'
  );
  if (hasPlan && values.plan_mode === undefined) {
    const legacy = !advertised.has('collaboration_mode') ? values.collaboration_mode : undefined;
    if (legacy === 'plan' || legacy === 'default') values.plan_mode = legacy === 'plan';
    else if (!advertised.has('interaction_mode') && values.interaction_mode === 'plan')
      values.plan_mode = true;
  }
  const probedModel = capability.configOptions.find((option) => option.category === 'model');
  const sameModel = !role.runConfig.modelId || probedModel?.currentValue === role.runConfig.modelId;
  for (const key of Object.keys(values)) {
    if (advertised.has(key)) continue;
    if (/(permission|approval|sandbox)/i.test(key) || key === 'mode') continue;
    const retiredPlanField =
      hasPlan && (key === 'collaboration_mode' || key === 'interaction_mode');
    if (!sameModel && !retiredPlanField) continue;
    delete values[key];
    changed = true;
  }
  if (!changed) return role;
  return { ...role, runConfig: { ...role.runConfig, configOptionValues: values } };
}

/**
 * Pure conditional maintenance. The owner calls this inside its real legacy
 * update or native CAS loop, after resolving trustworthy runtime evidence.
 */
export function planAgentRoleSchemaReconciliation(
  stored: unknown,
  command: ReconcileAgentRoleSchemaCommand,
  actorUserId: string | null,
  evidence: AgentRoleSchemaEvidence = command.evidence
): unknown | undefined {
  const { expected } = command;
  if (
    !Number.isFinite(command.now) ||
    !Number.isFinite(evidence.schema.fetchedAt) ||
    evidence.target.machineId !== expected.machineId ||
    evidence.target.agentConfigId !== expected.agentConfigId ||
    evidence.target.cliType !== evidence.schema.cliType ||
    evidence.target.agentType !== evidence.schema.agentType ||
    evidence.schema.provenance !== 'runtime' ||
    !evidence.schema.configOptions ||
    !isAcpCapabilityCacheEntryCurrentForRuntimeOverrides(
      { ...evidence.schema, configOptions: undefined, modes: [], models: [] },
      evidence.target.runtimeOverrides
    )
  )
    return undefined;
  const current = normalizeAgentRole(stored);
  const bound = current && bindAgentRoleTarget(current, expected.machineId);
  if (
    !current ||
    !bound ||
    !canManageAgentRole(current, actorUserId) ||
    current.revision !== expected.revision ||
    !isAgentRoleContentEqual(bound, expected)
  )
    return undefined;
  const next = reconcileAgentRoleSchema(bound, evidence.schema);
  if (next === bound) return undefined;
  const [first, ...rest] = getAgentRoleTargets(current).map((target) =>
    target.machineId === expected.machineId ? { ...target, runConfig: next.runConfig } : target
  );
  if (!first) return undefined;
  const updated = {
    ...withAgentRoleTargets(current, [first, ...rest]),
    revision: current.revision + 1,
    updatedAt: command.now,
  };
  return preserveStoredRole(stored, current, updated, expected.machineId);
}

const record = z.record(z.string(), z.unknown());
function preserveStoredRole(
  stored: unknown,
  current: AgentRole,
  next: AgentRole,
  machineId: MachineId
): unknown {
  const raw = record.parse(stored);
  const before = bindAgentRoleTarget(current, machineId);
  const after = bindAgentRoleTarget(next, machineId);
  if (!before || !after) return stored;
  const values = (runConfig: unknown) => {
    const parsed = record.safeParse(runConfig);
    const previous = parsed.success ? record.safeParse(parsed.data.configOptionValues) : undefined;
    const result = previous?.success ? { ...previous.data } : {};
    for (const key of Object.keys(before.runConfig.configOptionValues ?? {})) {
      if (!Object.hasOwn(after.runConfig.configOptionValues ?? {}, key)) delete result[key];
    }
    for (const [key, value] of Object.entries(after.runConfig.configOptionValues ?? {}))
      result[key] = value;
    for (const key of Object.keys(result))
      if (isSensitiveAgentRoleConfigOptionKey(key)) delete result[key];
    return { ...(parsed.success ? parsed.data : {}), configOptionValues: result };
  };
  const serialized = serializeAgentRoleRow(next);
  const result = { ...raw, ...serialized };
  if (Array.isArray(serialized.targets)) {
    const previousTargets = Array.isArray(raw.targets)
      ? raw.targets
      : [raw, ...(Array.isArray(raw.additionalTargets) ? raw.additionalTargets : [])];
    result.targets = serialized.targets.map((target: unknown) => {
      const projected = record.parse(target);
      const original = previousTargets.find((candidate: unknown) => {
        const entry = record.safeParse(candidate);
        return entry.success && entry.data.machineId === projected.machineId;
      });
      const entry = record.safeParse(original);
      const targetRow = entry.success ? entry.data : projected;
      if (projected.machineId === machineId)
        return { ...targetRow, runConfig: values(targetRow.runConfig) };
      const config = record.safeParse(targetRow.runConfig);
      const options = config.success ? record.safeParse(config.data.configOptionValues) : undefined;
      if (!options?.success) return targetRow;
      const filtered = Object.fromEntries(
        Object.entries(options.data).filter(([key]) => !isSensitiveAgentRoleConfigOptionKey(key))
      );
      return { ...targetRow, runConfig: { ...config.data, configOptionValues: filtered } };
    });
    for (const key of ['machineId', 'agentConfigId', 'runConfig', 'additionalTargets'])
      delete result[key];
  } else result.runConfig = values(raw.runConfig);
  return result;
}

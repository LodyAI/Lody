import {
  bindAgentRoleTarget,
  canManageAgentRole,
  getAgentRoleTargets,
  getWorkspaceFlockDocId,
  isAgentRoleContentEqual,
  normalizeAgentRole,
  serializeAgentRoleRow,
  withAgentRoleTargets,
  workspaceFlockKeys,
  type AcpCapabilityCacheEntry,
  type AgentRole,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import { uploadWorkspaceCatalog } from './workspace-catalog-write';

/** Only a complete, freshly probed runtime schema may remove saved keys.
 * Values of existing fields, model and permission pins remain user decisions.
 */
export function reconcileAgentRoleSchema(
  role: AgentRole,
  capability: AcpCapabilityCacheEntry
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
    else if (!advertised.has('interaction_mode') && values.interaction_mode === 'plan') {
      values.plan_mode = true;
    }
  }
  const probedModel = capability.configOptions.find((option) => option.category === 'model');
  const sameModel = !role.runConfig.modelId || probedModel?.currentValue === role.runConfig.modelId;
  for (const key of Object.keys(values)) {
    if (advertised.has(key)) continue;
    // Permission policy must never silently fall back to the runtime default.
    if (/(permission|approval|sandbox)/i.test(key) || key === 'mode') continue;
    // Some agents expose different option keys for different models. Independent
    // Plan's retired field identities are known; other omissions need a matching model.
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
 * Fence a delayed probe against editing, deletion, ownership and workspace changes.
 * `expected` is the Role bound to the probed machine; only that target changes,
 * and the row keeps its stored shape (v1 for a single-target Role).
 */
export async function persistReconciledAgentRole(
  runtime: WorkspaceRuntime,
  expected: AgentRole,
  capability: AcpCapabilityCacheEntry,
  userId: string,
  now: number,
  isCurrent: () => boolean
): Promise<void> {
  const next = reconcileAgentRoleSchema(expected, capability);
  if (next === expected) return;
  const changed = await runtime.writer.flockRowUpdate(
    getWorkspaceFlockDocId(runtime.workspaceId),
    workspaceFlockKeys.agentRole(expected.id),
    (stored) => {
      const current = normalizeAgentRole(stored);
      const bound = current && bindAgentRoleTarget(current, expected.machineId);
      if (
        !isCurrent() ||
        !current ||
        !bound ||
        !canManageAgentRole(current, userId) ||
        current.revision !== expected.revision ||
        !isAgentRoleContentEqual(bound, expected)
      )
        return undefined;
      const [first, ...rest] = getAgentRoleTargets(current).map((target) =>
        target.machineId === expected.machineId ? { ...target, runConfig: next.runConfig } : target
      );
      if (!first) return undefined;
      return serializeAgentRoleRow({
        ...withAgentRoleTargets(current, [first, ...rest]),
        revision: current.revision + 1,
        updatedAt: now,
      });
    }
  );
  if (changed) void uploadWorkspaceCatalog(runtime);
}

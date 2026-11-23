import {
  bindAgentRoleTarget,
  canManageAgentRole,
  getAgentRoleTargets,
  getWorkspaceFlockDocId,
  isAgentRoleContentEqual,
  normalizeAgentRole,
  reconcileAgentRoleRunConfig,
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
  const nextRunConfig = reconcileAgentRoleRunConfig(role.runConfig, capability);
  if (nextRunConfig === role.runConfig) return role;
  return { ...role, runConfig: nextRunConfig };
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

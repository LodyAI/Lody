import { useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { selectAtom } from 'jotai/utils';
import {
  listAccessibleAgentRoles,
  resolveAgentRoleAvailability,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleAvailability,
  type AgentRoleAvailabilityContext,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { machineFlockRowsByWorkspaceAtom } from '@/atoms/machine-flock';
import { onlineMachineIdsAtom } from '@/atoms/presence';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { deleteWorkspaceAgentRole, writeWorkspaceAgentRole } from '@/lib/workspace-catalog-write';

export type WorkspaceAgentRolesSnapshot = {
  /** Roles this user may see: their own, plus every workspace-shared one. */
  roles: AgentRole[];
  /** True once the first remote sync landed, which makes an empty catalog authoritative. */
  synced: boolean;
};

/**
 * The Roles the current user may read.
 *
 * Filtered through the shared `listAccessibleAgentRoles` rule rather than by a
 * local predicate: Settings, the mention menu, and any later Role resolution
 * must agree on what "private" means, and a rule copied into a component is one
 * that can drift into merely hiding a row.
 */
export function useWorkspaceAgentRoles(): WorkspaceAgentRolesSnapshot {
  const { roles, synced } = useWorkspaceCatalog();
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  return useMemo(
    () => ({ roles: listAccessibleAgentRoles(roles, currentUserId), synced }),
    [currentUserId, roles, synced]
  );
}

export type AgentRoleAvailabilityResolver = {
  resolve: (role: AgentRole) => AgentRoleAvailability;
};

/**
 * Whether each Role can still run, and why not when it cannot.
 *
 * Subscribes the agent configs of exactly the machines the given Roles point
 * at, so a Role bound to a machine no surface has opened yet still resolves
 * instead of reporting a missing config. Until those rows are read the
 * availability is `unknown`, never `unavailable` — reporting a Role broken
 * because its config list has not loaded is the same silent lie as falling back
 * to another config.
 */
export function useAgentRoleAvailability(
  roles: readonly AgentRole[]
): AgentRoleAvailabilityResolver {
  const roleMachineIdsKey = useMemo(
    () => [...new Set(roles.map((role) => role.machineId))].filter(Boolean).sort().join('\0'),
    [roles]
  );
  const roleMachineIds = useMemo(
    () => (roleMachineIdsKey ? (roleMachineIdsKey.split('\0') as MachineId[]) : []),
    [roleMachineIdsKey]
  );
  useMachineFlockAgentConfigsForMachineIds(roleMachineIds);

  const { machines } = useVisibleMachineMetas();
  const onlineMachineIds = useAtomValue(onlineMachineIdsAtom);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);

  // Presence of a machine key means its Flock rows were read, which is what
  // makes "no such agent config" an answer rather than a guess. Only the KEY
  // SET matters, so it is selected out here: the row map itself changes on every
  // rate-limit, launch-config, or provider row of every machine, and rebuilding
  // the whole Role pipeline on each of those is work no Role asked for.
  const loadedMachineIds = useAtomValue(
    useMemo(
      () =>
        selectAtom(
          machineFlockRowsByWorkspaceAtom,
          (rowsByWorkspace) =>
            Object.keys(
              (runtime ? rowsByWorkspace[String(runtime.workspaceId)] : undefined) ?? {}
            ) as MachineId[],
          (left, right) =>
            left.length === right.length && left.every((id, index) => id === right[index])
        ),
      [runtime]
    )
  );

  const context = useMemo<AgentRoleAvailabilityContext>(() => {
    const agentConfigMachineIds = new Map<AgentConfigId, MachineId>();
    for (const config of agentConfigs) {
      if (config.machineId) agentConfigMachineIds.set(config.id, config.machineId);
    }
    return {
      authorizedMachineIds: new Set(machines.keys()),
      onlineMachineIds,
      agentConfigMachineIds,
      loadedAgentConfigMachineIds: new Set(loadedMachineIds),
    };
  }, [agentConfigs, loadedMachineIds, machines, onlineMachineIds]);

  const resolve = useCallback(
    (role: AgentRole) => resolveAgentRoleAvailability(role, context),
    [context]
  );

  return { resolve };
}

export function useWorkspaceAgentRoleActions(): {
  /**
   * Write a Role and resolve as soon as it is durable locally. The upload runs
   * on its own; no surface waits for it, because the row already exists and a
   * deferred upload is not something the user can act on.
   */
  upsert: (role: AgentRole) => Promise<void>;
  remove: (id: AgentRoleId) => Promise<void>;
} {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const upsert = useCallback(
    async (role: AgentRole) => {
      if (!runtime) throw new Error('Workspace runtime is unavailable');
      await writeWorkspaceAgentRole(runtime, role);
    },
    [runtime]
  );
  const remove = useCallback(
    async (id: AgentRoleId) => {
      if (!runtime) throw new Error('Workspace runtime is unavailable');
      await deleteWorkspaceAgentRole(runtime, id);
    },
    [runtime]
  );
  return { upsert, remove };
}

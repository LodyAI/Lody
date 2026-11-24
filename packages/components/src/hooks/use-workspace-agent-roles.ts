import { useWorkspaceClientPlugins } from '../plugins/client-host-provider';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { selectAtom } from 'jotai/utils';
import {
  getAgentRoleTargets,
  listAccessibleAgentRoles,
  machineSupportsMemoryProviders,
  resolveAgentRoleAvailability,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleAvailability,
  type AgentRoleAvailabilityContext,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';
import { useWorkspaceLocalAccountId } from '@/lib/e2ee-account';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { machineFlockRowsByWorkspaceAtom } from '@/atoms/machine-flock';
import { presumedOnlineMachineIdsAtom } from '@/atoms/presence';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { createAgentRoleCapabilityResolver } from '@/lib/composer-agent-roles';
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
const noPluginSubscription = () => () => {};
const zero = () => 0;
function useWorkflowInstallations() {
  const host = useWorkspaceClientPlugins();
  const revision = useSyncExternalStore(
    host?.subscribe ?? noPluginSubscription,
    host?.snapshot ?? zero,
    zero
  );
  return useMemo(
    () => host?.installations().filter((i) => i.enabled && i.dev.owner && i.workflowPrompts) ?? [],
    [host, revision]
  );
}
export function useWorkspaceAgentRoles(): WorkspaceAgentRolesSnapshot {
  const { roles, synced } = useWorkspaceCatalog();
  const currentUserId = useWorkspaceLocalAccountId();
  const installations = useWorkflowInstallations(),
    configs = useAtomValue(getAllAgentConfigAtom);
  return useMemo(() => {
    const merged = listAccessibleAgentRoles(roles, currentUserId);
    if (currentUserId)
      for (const i of installations)
        for (const r of i.dev.manifest.agentRoles ?? []) {
          const id = `plugin:${i.pluginId}:${r.id}` as AgentRoleId,
            machineId = i.machineId as MachineId;
          if (merged.some((row) => row.id === id && row.machineId === machineId)) continue;
          const provider = r.defaultProvider?.startsWith('plugin:')
            ? r.defaultProvider
            : configs.find(
                (c) =>
                  c.machineId === machineId && (!r.defaultProvider || c.id === r.defaultProvider)
              )?.id;
          const promptPrefix = i.workflowPrompts?.[r.id];
          if (!provider || promptPrefix === undefined) continue;
          const target = { machineId, agentConfigId: provider as AgentConfigId, runConfig: {} };
          const other = merged.find((row) => row.id === id);
          if (other) {
            const idx = merged.indexOf(other);
            merged[idx] = {
              ...other,
              additionalTargets: [...(other.additionalTargets ?? []), target],
            };
            continue;
          }
          merged.push({
            v: 1,
            id,
            ownerUserId: currentUserId,
            visibility: 'workspace',
            name: r.name,
            emoji: r.emoji,
            description: r.description,
            ...target,
            promptPrefix,
            createdAt: 0,
            updatedAt: 0,
            revision: 1,
          });
        }
    return { roles: merged, synced };
  }, [currentUserId, roles, synced, installations, configs]);
}

export type AgentRoleAvailabilityResolver = {
  /**
   * Availability of the Role's inline (first or bound) target. Pass a Role
   * bound with `bindAgentRoleTarget` to judge another machine's target.
   */
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
    () =>
      [
        ...new Set(
          roles.flatMap((role) => getAgentRoleTargets(role).map((target) => target.machineId))
        ),
      ]
        .filter(Boolean)
        .sort()
        .join('\0'),
    [roles]
  );
  const roleMachineIds = useMemo(
    () => (roleMachineIdsKey ? (roleMachineIdsKey.split('\0') as MachineId[]) : []),
    [roleMachineIdsKey]
  );
  useMachineFlockAgentConfigsForMachineIds(roleMachineIds);

  const { machines } = useVisibleMachineMetas();
  const onlineMachineIds = useAtomValue(presumedOnlineMachineIdsAtom);
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

  const workflow = useWorkflowInstallations();
  const context = useMemo<AgentRoleAvailabilityContext>(() => {
    const agentConfigMachineIds = new Map<AgentConfigId, MachineId>();
    for (const i of workflow)
      for (const provider of i.dev.manifest.acpProviders ?? [])
        agentConfigMachineIds.set(
          `plugin:${i.pluginId}:${provider.id}` as AgentConfigId,
          i.machineId as MachineId
        );
    for (const config of agentConfigs) {
      if (config.machineId) agentConfigMachineIds.set(config.id, config.machineId);
    }
    return {
      memoryProviderMachineIds: new Set(
        Array.from(machines)
          .filter(([, machine]) => machineSupportsMemoryProviders(machine))
          .map(([id]) => id)
      ),
      authorizedMachineIds: new Set(machines.keys()),
      onlineMachineIds,
      agentConfigMachineIds,
      loadedAgentConfigMachineIds: new Set(loadedMachineIds),
      runConfigCapability: createAgentRoleCapabilityResolver(agentConfigs, machines),
    };
  }, [agentConfigs, loadedMachineIds, machines, onlineMachineIds, workflow]);

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
      await writeWorkspaceAgentRole(
        runtime,
        role.id.startsWith('plugin:')
          ? { ...role, id: crypto.randomUUID() as AgentRoleId, revision: 1 }
          : role
      );
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

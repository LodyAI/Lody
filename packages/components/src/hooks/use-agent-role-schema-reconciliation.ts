import { useEffect, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import {
  canManageAgentRole,
  getServerNow,
  isAcpCapabilityCacheEntryCurrentForRuntimeOverrides,
  type MachineAcpCapabilitiesRefreshResponse,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { onlineMachineIdsAtom } from '@/atoms/presence';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { persistReconciledAgentRole } from '@/lib/agent-role-schema-reconciliation';
import { useWorkspaceAgentRoles } from './use-workspace-agent-roles';
import { useMachineFlockAgentConfigsForMachineIds } from './use-machine-flock-agent-configs';
import { useVisibleMachineMetas } from './use-visible-machine-metas';

/** Startup maintenance; no editor, toast or user acknowledgement is involved. */
export function useAgentRoleSchemaReconciliation(): void {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const userId = useAtomValue(userAtom)?.id;
  const { roles, synced } = useWorkspaceAgentRoles();
  const owned = useMemo(
    () => roles.filter((role) => canManageAgentRole(role, userId)),
    [roles, userId]
  );
  const machineIds = useMemo(() => [...new Set(owned.map((role) => role.machineId))], [owned]);
  useMachineFlockAgentConfigsForMachineIds(machineIds);
  const configs = useAtomValue(getAllAgentConfigAtom);
  const online = useAtomValue(onlineMachineIdsAtom);
  const { machines } = useVisibleMachineMetas();
  // One serialized probe per exact target/source per startup. Failed probes remain
  // pending work, retried on reconnect or the next launch, never a completed migration flag.
  const probes = useMemo(
    () => ({
      runtime,
      userId,
      entries: new Map<string, Promise<MachineAcpCapabilitiesRefreshResponse | null>>(),
      tail: Promise.resolve(),
    }),
    [runtime, userId]
  );

  useEffect(() => {
    if (!runtime || !userId || !synced) return;
    let cancelled = false;
    for (const role of owned) {
      const config = configs.find(
        (item) => item.id === role.agentConfigId && item.machineId === role.machineId
      );
      const machine = machines.get(role.machineId);
      if (!config || !machine || !Object.keys(role.runConfig.configOptionValues ?? {}).length)
        continue;
      const key = JSON.stringify([
        role.machineId,
        config,
        machine.acpCapabilities?.[config.id]?.sourceVersion,
      ]);
      if (!online.has(role.machineId)) {
        probes.entries.delete(key);
        continue;
      }
      let probe = probes.entries.get(key);
      if (!probe) {
        probe = probes.tail
          .then(() =>
            runtime.requestMachineAcpCapabilitiesRefresh({
              type: 'machine/acp-capabilities-refresh',
              workspaceId: runtime.workspaceId,
              machineId: role.machineId,
              configId: config.id,
            })
          )
          .catch(() => null);
        probes.entries.set(key, probe);
        probes.tail = probe.then(() => undefined);
      }
      void probe
        .then(async (response) => {
          if (
            cancelled ||
            !response?.success ||
            response.machineId !== role.machineId ||
            response.configId !== config.id ||
            response.cliType !== config.cliType ||
            response.agentType !== config.agentType ||
            response.capability?.cliType !== config.cliType ||
            response.capability?.agentType !== config.agentType ||
            !isAcpCapabilityCacheEntryCurrentForRuntimeOverrides(
              response.capability,
              config.runtimeOverrides
            )
          )
            return;
          await persistReconciledAgentRole(
            runtime,
            role,
            response.capability,
            userId,
            getServerNow(),
            () => !cancelled
          );
        })
        .catch(() => {
          // Keep maintenance silent. The original row remains and the next startup retries.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [runtime, userId, synced, owned, configs, machines, online, probes]);
}

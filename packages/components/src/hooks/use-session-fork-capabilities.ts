import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { getAgentConfigsByMachineAtomFamily } from '@/atoms/agents';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import {
  getAcpCapabilityCacheKey,
  getAcpCapabilityCacheEntryAuthority,
  resolveSessionAcpTargetId,
  type MachineViewMeta,
  type MachineId,
  type SessionMeta,
} from '@lody/shared';

export function useSessionForkCapabilities(
  machineId: MachineId | null | undefined,
  capabilities: MachineViewMeta['acpCapabilities']
) {
  useMachineFlockAgentConfigsForMachineIds([machineId]);
  const configs = useAtomValue(getAgentConfigsByMachineAtomFamily(machineId ?? undefined));
  const canForkSession = useCallback(
    (target: SessionMeta): boolean => {
      if (target.isArchived || !target.agentConfigId || !resolveSessionAcpTargetId(target))
        return false;
      const config = configs.find(
        (candidate) =>
          candidate.id === target.agentConfigId &&
          candidate.machineId === target.machineId &&
          candidate.cliType === target.cliType &&
          candidate.agentType === target.agentType
      );
      if (!config) return false;
      const capability = capabilities?.[getAcpCapabilityCacheKey(target.agentConfigId)];
      return (
        getAcpCapabilityCacheEntryAuthority(capability, config.runtimeOverrides) ===
          'authoritative' && capability?.sessionFork === true
      );
    },
    [capabilities, configs]
  );
  const canForkSessionToWorktree = useCallback(
    (target: SessionMeta): boolean => {
      if (
        !target.agentConfigId ||
        !resolveSessionAcpTargetId(target) ||
        !target.project ||
        (target.project.kind !== 'local' && target.project.kind !== 'github')
      ) {
        return false;
      }
      const config = configs.find(
        (candidate) =>
          candidate.id === target.agentConfigId &&
          candidate.machineId === target.machineId &&
          candidate.cliType === target.cliType &&
          candidate.agentType === target.agentType
      );
      if (!config) return false;
      const capability = capabilities?.[getAcpCapabilityCacheKey(target.agentConfigId)];
      return (
        getAcpCapabilityCacheEntryAuthority(capability, config.runtimeOverrides) ===
          'authoritative' && capability?.sessionForkWorktree === true
      );
    },
    [capabilities, configs]
  );
  return { canForkSession, canForkSessionToWorktree };
}

import { useNativeMachineCatalogPublicReader } from './use-native-machine-catalog-public';
import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import {
  getAgentConfigsByMachineAtomFamily,
  getLegacyAgentConfigsByMachineAtomFamily,
} from '@/atoms/agents';
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
  const legacyConfigs = useAtomValue(
    getLegacyAgentConfigsByMachineAtomFamily(machineId ?? undefined)
  );
  const readNative = useNativeMachineCatalogPublicReader();
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
      const native = readNative(target.machineId);
      if (native.kind === 'native') {
        const capability = native.capability(config);
        return capability?.authority === 'authoritative' && capability.sessionFork === true;
      }
      const legacyConfig = legacyConfigs.find((value) => value.id === config.id);
      const capability = capabilities?.[getAcpCapabilityCacheKey(target.agentConfigId)];
      return (
        getAcpCapabilityCacheEntryAuthority(capability, legacyConfig?.runtimeOverrides) ===
          'authoritative' && capability?.sessionFork === true
      );
    },
    [capabilities, configs, legacyConfigs, readNative]
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
      const native = readNative(target.machineId);
      if (native.kind === 'native') {
        const capability = native.capability(config);
        return capability?.authority === 'authoritative' && capability.sessionForkWorktree === true;
      }
      const legacyConfig = legacyConfigs.find((value) => value.id === config.id);
      const capability = capabilities?.[getAcpCapabilityCacheKey(target.agentConfigId)];
      return (
        getAcpCapabilityCacheEntryAuthority(capability, legacyConfig?.runtimeOverrides) ===
          'authoritative' && capability?.sessionForkWorktree === true
      );
    },
    [capabilities, configs, legacyConfigs, readNative]
  );
  return { canForkSession, canForkSessionToWorktree };
}

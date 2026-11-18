import { useNativeMachineCatalogPublicReader } from './use-native-machine-catalog-public';
import { useMemo } from 'react';
import {
  getAcpCapabilityCacheKey,
  getReadableAcpCapabilityCacheEntryForRuntimeOverrides,
  type AcpCommandSummary,
} from '@lody/shared';
import type { AcpSelectorTarget } from '@/components/shared/acp-selector-options';

/**
 * Use the session's actual list, including [], once reported; otherwise show the probe preview.
 */
export function useAvailableCommands(
  target?: AcpSelectorTarget,
  sessionCommands?: AcpCommandSummary[]
): AcpCommandSummary[] {
  const readNative = useNativeMachineCatalogPublicReader();
  const configId = target?.configId;
  const machineId = target?.machineId ?? target?.machine?.id;
  const cliType = target?.cliType;
  const agentType = target?.agentType;
  const runtimeOverrides = target?.runtimeOverrides;
  const machine = target?.machine;

  return useMemo(() => {
    if (sessionCommands !== undefined) return sessionCommands;
    if (!configId || !cliType || !agentType) return [];
    const native = machineId ? readNative(machineId) : undefined;
    if (target?.nativeSelected || native?.kind === 'native') {
      const capability =
        target?.nativeCapability ??
        (native?.kind === 'native'
          ? native.capability({ id: configId, machineId: machineId!, cliType, agentType })
          : undefined);
      return capability?.availableCommands ?? [];
    }
    const key = getAcpCapabilityCacheKey(configId);
    const capability = getReadableAcpCapabilityCacheEntryForRuntimeOverrides(
      machine?.acpCapabilities?.[key],
      runtimeOverrides
    );
    return capability?.cliType === cliType && capability.agentType === agentType
      ? (capability.availableCommands ?? [])
      : [];
  }, [
    configId,
    cliType,
    agentType,
    runtimeOverrides,
    machine,
    sessionCommands,
    machineId,
    readNative,
    target?.nativeSelected,
    target?.nativeCapability,
  ]);
}

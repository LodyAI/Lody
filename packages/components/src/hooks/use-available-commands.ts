import { useMemo } from 'react';
import {
  getAcpCapabilityCacheKey,
  isAcpCapabilityCacheEntryCurrentForRuntimeOverrides,
  type AcpCommandSummary,
} from '@lody/shared';
import type { AcpSelectorTarget } from '@/components/shared/acp-selector-options';

/**
 * Hook that extracts available slash commands from the ACP capabilities cache.
 */
export function useAvailableCommands(target?: AcpSelectorTarget): AcpCommandSummary[] {
  const configId = target?.configId;
  const cliType = target?.cliType;
  const agentType = target?.agentType;
  const runtimeOverrides = target?.runtimeOverrides;
  const machine = target?.machine;

  return useMemo(() => {
    if (!configId || !cliType || !agentType) return [];
    const key = getAcpCapabilityCacheKey(configId);
    const capability = machine?.acpCapabilities?.[key];
    if (
      !isAcpCapabilityCacheEntryCurrentForRuntimeOverrides(capability, runtimeOverrides, machine)
    ) {
      return [];
    }
    return capability.availableCommands ?? [];
  }, [configId, cliType, agentType, runtimeOverrides, machine]);
}

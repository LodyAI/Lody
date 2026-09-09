import { useMemo } from 'react';
import {
  getAcpCapabilityCacheKey,
  getReadableAcpCapabilityCacheEntryForRuntimeOverrides,
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
    const capability = getReadableAcpCapabilityCacheEntryForRuntimeOverrides(
      machine?.acpCapabilities?.[key],
      runtimeOverrides,
      machine
    );
    return capability?.availableCommands ?? [];
  }, [configId, cliType, agentType, runtimeOverrides, machine]);
}

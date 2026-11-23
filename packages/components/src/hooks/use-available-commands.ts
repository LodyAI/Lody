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
  const configId = target?.configId;
  const cliType = target?.cliType;
  const agentType = target?.agentType;
  const runtimeOverrides = target?.runtimeOverrides;
  const machine = target?.machine;

  return useMemo(() => {
    if (sessionCommands !== undefined) return sessionCommands;
    if (!configId || !cliType || !agentType) return [];
    const key = getAcpCapabilityCacheKey(configId);
    const capability = getReadableAcpCapabilityCacheEntryForRuntimeOverrides(
      machine?.acpCapabilities?.[key],
      runtimeOverrides
    );
    return capability?.cliType === cliType && capability.agentType === agentType
      ? (capability.availableCommands ?? [])
      : [];
  }, [configId, cliType, agentType, runtimeOverrides, machine, sessionCommands]);
}

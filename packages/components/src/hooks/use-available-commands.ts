import { useMemo } from 'react';
import {
  applyAcpCommandScopeDelta,
  getAcpCapabilityCacheKey,
  getReadableAcpCapabilityCacheEntryForRuntimeOverrides,
  type AcpCommandSummary,
} from '@lody/shared';
import type { AcpSelectorTarget } from '@/components/shared/acp-selector-options';

/**
 * Slash commands for the target agent: the config's base list from the ACP
 * capabilities cache, plus the target project's own additions and removals.
 */
export function resolveAvailableCommands(target?: AcpSelectorTarget): AcpCommandSummary[] {
  const { configId, cliType, agentType, runtimeOverrides, commandScopeKey, machine } = target ?? {};
  if (!configId || !cliType || !agentType) return [];
  const key = getAcpCapabilityCacheKey(configId);
  const capability = getReadableAcpCapabilityCacheEntryForRuntimeOverrides(
    machine?.acpCapabilities?.[key],
    runtimeOverrides
  );
  if (capability?.cliType !== cliType || capability.agentType !== agentType) return [];
  const base = capability.availableCommands ?? [];
  const delta = commandScopeKey ? machine?.acpCommandScopes?.[key]?.[commandScopeKey] : undefined;
  return delta ? applyAcpCommandScopeDelta(base, capability.sourceVersion, delta) : base;
}

export function useAvailableCommands(target?: AcpSelectorTarget): AcpCommandSummary[] {
  const configId = target?.configId;
  const cliType = target?.cliType;
  const agentType = target?.agentType;
  const runtimeOverrides = target?.runtimeOverrides;
  const commandScopeKey = target?.commandScopeKey;
  const machine = target?.machine;

  return useMemo(
    () =>
      resolveAvailableCommands({
        configId,
        cliType,
        agentType,
        runtimeOverrides,
        commandScopeKey,
        machine,
      }),
    [configId, cliType, agentType, runtimeOverrides, commandScopeKey, machine]
  );
}

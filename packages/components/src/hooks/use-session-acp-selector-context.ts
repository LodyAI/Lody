import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { getAgentMetaByIdAtomFamily } from '@/atoms/agents';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import type { AgentConfigCliType, AgentConfigId, MachineId } from '@lody/shared';
import type { AcpConfigOptionValue } from '@/components/shared/acp-selector-options';

import { useAcpSelectorOptions } from '@/hooks/use-acp-selector-options';
import { useAvailableCommands } from '@/hooks/use-available-commands';
import { useResolvedMachineMeta } from '@/hooks/use-resolved-machine-meta';

type UseSessionAcpSelectorContextArgs = {
  machineId: MachineId | null | undefined;
  configId: AgentConfigId | null | undefined;
  cliType: AgentConfigCliType | null | undefined;
  agentType: string | null | undefined;
  selectedModeId?: string | null;
  selectedModelId?: string | null;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
};

export function useSessionAcpSelectorContext({
  machineId,
  configId,
  cliType,
  agentType,
  selectedModeId,
  selectedModelId,
  configOptionValues,
}: UseSessionAcpSelectorContextArgs) {
  const { machine: sessionMachine, machineFlockRows } = useResolvedMachineMeta(machineId);
  useMachineFlockAgentConfigsForMachineIds([machineId]);
  const config = useAtomValue(getAgentMetaByIdAtomFamily(configId ?? undefined));
  const matchesProvider =
    config?.machineId === machineId &&
    config?.cliType === cliType &&
    config?.agentType === agentType;
  const runtimeOverrides = matchesProvider ? config?.runtimeOverrides : undefined;
  const acpTarget = useMemo(
    () =>
      configId && !matchesProvider
        ? undefined
        : {
            configId,
            cliType,
            agentType,
            selectedModeId,
            selectedModelId,
            configOptionValues,
            runtimeOverrides,
            machine: sessionMachine,
          },
    [
      agentType,
      cliType,
      configId,
      configOptionValues,
      selectedModeId,
      selectedModelId,
      sessionMachine,
      matchesProvider,
      runtimeOverrides,
    ]
  );
  const selectorOptions = useAcpSelectorOptions(acpTarget);
  const availableCommands = useAvailableCommands(acpTarget);

  return {
    ...selectorOptions,
    /** The memoized options object itself, for callers that pass it on whole. */
    selectorOptions,
    availableCommands,
    machineFlockRows,
    sessionMachine,
  };
}

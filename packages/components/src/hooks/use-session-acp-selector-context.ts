import { useMemo } from 'react';
import {
  getAcpCommandScopeKey,
  type AgentConfigCliType,
  type AgentConfigId,
  type MachineId,
  type ProjectRef,
} from '@lody/shared';
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
  /** Project of the session, so its own slash commands are offered. */
  project?: ProjectRef | null;
};

export function useSessionAcpSelectorContext({
  machineId,
  configId,
  cliType,
  agentType,
  selectedModeId,
  selectedModelId,
  configOptionValues,
  project,
}: UseSessionAcpSelectorContextArgs) {
  const { machine: sessionMachine, machineFlockRows } = useResolvedMachineMeta(machineId);
  const acpTarget = useMemo(
    () => ({
      configId,
      cliType,
      agentType,
      selectedModeId,
      selectedModelId,
      configOptionValues,
      machine: sessionMachine,
    }),
    [
      agentType,
      cliType,
      configId,
      configOptionValues,
      selectedModeId,
      selectedModelId,
      sessionMachine,
    ]
  );
  const selectorOptions = useAcpSelectorOptions(acpTarget);
  const availableCommands = useAvailableCommands({
    ...acpTarget,
    commandScopeKey: getAcpCommandScopeKey(project),
  });

  return {
    ...selectorOptions,
    availableCommands,
    machineFlockRows,
    sessionMachine,
  };
}

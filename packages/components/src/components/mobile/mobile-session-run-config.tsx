import { useMemo, useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';

import { getAllAgentConfigAtom } from '@/atoms';
import { AgentIcon } from '@/components/icons/agent-icon';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import type { AgentSelection } from '@/components/shared/agent-selector';
import type { AgentConfigCliType, AgentRole, AgentRoleId, MachineId } from '@lody/shared';
import type { ComposerAgentRoleItem } from '@/lib/composer-agent-roles';
import { MobileRunConfigButton } from './mobile-run-config-button';
import { MobileRunConfigSheet } from './mobile-run-config-sheet';

/**
 * Mobile composer run-config control: the collapsed `MobileRunConfigButton`
 * (agent icon + model + reasoning + mode face + Plan/Fast) that opens the
 * `MobileRunConfigSheet`.
 *
 * Shared by the in-session composer and the mobile new-chat sheet. Callers
 * pass an `agentSelection` (no SessionMeta dependency) so new-chat can wire
 * the same face + sheet as an existing conversation.
 */
export type MobileSessionRunConfigProps = {
  agentSelection: AgentSelection | null;
  /**
   * Restrict the sheet's agent list to these machines. Empty array → no
   * agents. Omit to list every cached agent config.
   */
  allowedMachineIds?: MachineId[];
  /** When true the agent row is display-only (conversation already has turns). */
  agentLocked?: boolean;
  onAgentConfigChange?: (selection: AgentSelection) => void;
  modelOptions: ReadonlyArray<AcpSessionSelectOption>;
  selectedModelId: string | null;
  onModelChange: (value: string) => void;
  modeOptions: ReadonlyArray<AcpSessionSelectOption>;
  selectedModeId: string | null;
  onModeChange: (value: string) => void;
  configOptionSelectors?: AcpConfigOptionSelector[];
  configOptionValues?: Record<string, AcpConfigOptionValue>;
  onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
  /** Brand icon fallback when the selected config isn't in the cache yet. */
  fallbackAgent?: {
    cliType?: AgentConfigCliType | null;
    agentType?: string | null;
  };
  /**
   * Agent Roles for the machine this chat starts on. Renders a Role row above
   * Agent in the sheet; omit to leave it out. Mobile has no detail pane and no
   * create action — the sheet is the picker.
   */
  agentRoles?: {
    items: ReadonlyArray<ComposerAgentRoleItem>;
    selectedRoleId: AgentRoleId | null;
    onSelect: (roleId: AgentRoleId | null) => void;
    onCreate?: () => void;
    onSendInstruction?: (role: AgentRole) => Promise<boolean>;
  };
};

export function MobileSessionRunConfig(props: MobileSessionRunConfigProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const {
    agentSelection,
    allowedMachineIds,
    agentLocked = false,
    modelOptions,
    selectedModelId,
    modeOptions,
    selectedModeId,
    fallbackAgent,
  } = props;
  const executorConfigs = useAtomValue(getAllAgentConfigAtom);

  const agentIcon = useMemo((): ReactNode => {
    if (agentSelection) {
      const cfg = executorConfigs.find(
        (c) => c.id === agentSelection.agentId && c.machineId === agentSelection.machineId
      );
      if (cfg) {
        return (
          <AgentIcon
            cliType={cfg.cliType}
            agentType={cfg.agentType}
            brandId={cfg.brandId}
            env={cfg.env}
            className="h-4 w-4"
          />
        );
      }
    }
    if (fallbackAgent?.cliType && fallbackAgent.agentType) {
      return (
        <AgentIcon
          cliType={fallbackAgent.cliType}
          agentType={fallbackAgent.agentType}
          className="h-4 w-4"
        />
      );
    }
    return undefined;
  }, [agentSelection, executorConfigs, fallbackAgent]);

  return (
    <>
      <MobileRunConfigButton
        agentIcon={agentIcon}
        modelOptions={modelOptions}
        selectedModelId={selectedModelId}
        modeOptions={modeOptions}
        selectedModeId={selectedModeId}
        configOptionSelectors={props.configOptionSelectors}
        configOptionValues={props.configOptionValues}
        onOpen={() => setOpen(true)}
        ariaLabel={t('chat.runConfig.buttonAriaLabel', 'Run configuration')}
      />
      <MobileRunConfigSheet
        open={open}
        onOpenChange={setOpen}
        agentSelection={agentSelection}
        allowedMachineIds={allowedMachineIds}
        agentLocked={agentLocked}
        onAgentConfigChange={props.onAgentConfigChange}
        modelOptions={modelOptions}
        selectedModelId={selectedModelId}
        onModelChange={props.onModelChange}
        modeOptions={modeOptions}
        selectedModeId={selectedModeId}
        onModeChange={props.onModeChange}
        configOptionSelectors={props.configOptionSelectors}
        configOptionValues={props.configOptionValues}
        onConfigOptionChange={props.onConfigOptionChange}
        agentRoles={props.agentRoles}
      />
    </>
  );
}

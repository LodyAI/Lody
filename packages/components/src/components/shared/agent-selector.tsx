import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import {
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineViewMeta,
} from '@lody/shared';
import { getAllAgentConfigAtom } from '@/atoms';
import { cn } from '@/lib/utils';
import { useOnlineMachines } from '@/hooks/use-online-machines';
import { Bot } from 'lucide-react';
import { Spinner } from '@/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui';
import { OptionSelector, type OptionSelectorOption } from './option-selector';

export type AgentSelection = {
  agentId: AgentConfigId;
  machineId: MachineId;
};

type AgentOption = OptionSelectorOption<string> & {
  agentId: AgentConfigId;
  machineId: MachineId;
  config: AgentConfigMeta;
  machine: MachineViewMeta;
};

interface AgentSelectorProps {
  value: AgentSelection | null;
  onChange: (selection: AgentSelection) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  disabledReason?: string | null;
  loading?: boolean;
  className?: string;
  showIcon?: boolean;
  align?: 'left' | 'center';
  tone?: 'light' | 'dark';
  /** Restrict selectable agents to these machine IDs. */
  allowedMachineIds?: MachineId[];
  /** Hide machine name from options (useful when machine is selected separately). */
  hideMachineDescription?: boolean;
  /**
   * Additional validation function for each agent config item
   * Returns true if the item should be disabled
   */
  validateItem?: (config: AgentConfigMeta, machine?: MachineViewMeta) => boolean;
  /**
   * Optional icon renderer for each agent config item.
   */
  getOptionIcon?: (config: AgentConfigMeta, machine?: MachineViewMeta) => ReactNode;
}

export function AgentSelector({
  value,
  onChange,
  open,
  onOpenChange,
  disabled = false,
  disabledReason,
  loading = false,
  className,
  showIcon = true,
  align = 'left',
  tone = 'light',
  allowedMachineIds,
  hideMachineDescription = false,
  validateItem,
  getOptionIcon,
}: AgentSelectorProps) {
  const { t } = useTranslation();
  const executorConfigs = useAtomValue(getAllAgentConfigAtom);
  const machineList = useOnlineMachines(allowedMachineIds);

  const selectedValue = value ? `${value.agentId}:${value.machineId}` : undefined;

  const agentOptions = useMemo<AgentOption[]>(() => {
    const machineById = new Map(machineList.map((m) => [m.id, m]));
    return executorConfigs.flatMap((config) => {
      const machine = machineById.get(config.machineId);
      if (!machine) return [];
      const disabledItem = validateItem ? validateItem(config, machine) : false;
      return [
        {
          value: `${config.id}:${machine.id}`,
          label: config.name,
          description: hideMachineDescription ? undefined : machine.name,
          disabled: disabledItem,
          agentId: config.id,
          machineId: machine.id,
          config,
          machine,
          startContent: getOptionIcon ? getOptionIcon(config, machine) : undefined,
        },
      ];
    });
  }, [executorConfigs, machineList, hideMachineDescription, validateItem, getOptionIcon]);

  const renderAgentIcon = (option?: OptionSelectorOption<string>) => {
    if (!showIcon) return null;
    if (option?.startContent) return option.startContent;
    return <Bot className="h-3! w-3! shrink-0 opacity-70" />;
  };

  const loadingText = t('sessions.filter.loadingAgent', 'Loading agent...');

  const selectorNode = (
    <OptionSelector
      value={selectedValue}
      options={agentOptions}
      onSelect={(option) => {
        const agentOption = option as AgentOption;
        onChange({ agentId: agentOption.agentId, machineId: agentOption.machineId });
      }}
      placeholder={t('sessions.filter.selectAgent')}
      placeholderIcon={showIcon ? Bot : undefined}
      className={cn('w-full', className)}
      contentClassName="w-64"
      disabled={disabled || loading}
      searchable={!loading && agentOptions.length > 5}
      searchPlaceholder={t('sessions.filter.selectAgent')}
      emptyText={t('agents.noAgents')}
      tone={tone}
      open={open}
      onOpenChange={onOpenChange}
      renderTriggerValue={(option) => (
        <div
          className={cn(
            'flex min-w-0 items-center gap-2',
            align === 'left' ? 'justify-start text-left' : 'justify-center text-center'
          )}
        >
          {loading ? (
            <Spinner className="h-3! w-3! shrink-0 opacity-70" />
          ) : (
            renderAgentIcon(option)
          )}
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-medium">
              {loading ? loadingText : (option?.label ?? t('sessions.filter.selectAgent'))}
            </span>
            {!loading && option?.description ? (
              <span className="max-w-[140px] truncate text-[11px] text-muted-foreground/70">
                {option.description}
              </span>
            ) : null}
          </div>
        </div>
      )}
      renderOption={(option) => (
        <>
          {renderAgentIcon(option)}
          <div className="flex min-w-0 flex-col leading-tight text-left">
            <span className="truncate text-sm font-medium">{option.label}</span>
            {option.description ? (
              <span className="max-w-[180px] truncate text-[11px] text-muted-foreground/70">
                {option.description}
              </span>
            ) : null}
          </div>
        </>
      )}
    />
  );

  // Suppress the disabled-reason tooltip while we are still loading: the
  // reason ("Select a machine first") would be misleading in that window.
  if (disabledReason && !loading) {
    return (
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <div className="w-full">{selectorNode}</div>
        </TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    );
  }

  return selectorNode;
}

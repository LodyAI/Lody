import { useMemo, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
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
import { Spinner } from '@lody/ui/spinner';
import { Tooltip } from '@lody/ui/tooltip';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { composerSurface } from './composer-surface';
import { OptionSelector, type OptionSelectorOption } from './option-selector';

const styles = stylex.create({
  face: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  faceStart: { justifyContent: 'flex-start', textAlign: 'start' },
  faceCenter: { justifyContent: 'center', textAlign: 'center' },
  /** The agent's name, and the machine it runs on under it. */
  lines: { display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.25 },
  machine: {
    minWidth: 0,
    maxWidth: '140px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
    fontWeight: 400,
  },
  machineInRow: { maxWidth: '180px' },
  fill: { width: '100%' },
});

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
    return <Bot {...stylex.props(composerSurface.glyph12, composerSurface.hint)} />;
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
      appearance="field"
      size="lg"
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
        <span
          {...stylex.props(styles.face, align === 'left' ? styles.faceStart : styles.faceCenter)}
        >
          {loading ? <Spinner size="small" label={null} /> : renderAgentIcon(option)}
          <span {...stylex.props(styles.lines)}>
            <span {...stylex.props(composerSurface.truncate)}>
              {loading ? loadingText : (option?.label ?? t('sessions.filter.selectAgent'))}
            </span>
            {!loading && option?.description ? (
              <span {...stylex.props(styles.machine)}>{option.description}</span>
            ) : null}
          </span>
        </span>
      )}
      renderOption={(option) => (
        <>
          {renderAgentIcon(option)}
          <span
            {...stylex.props(
              composerSurface.rowText,
              !!option.description && composerSurface.rowTextStacked
            )}
          >
            <span {...stylex.props(composerSurface.rowLabel)}>{option.label}</span>
            {option.description ? (
              <span {...stylex.props(styles.machine, styles.machineInRow)}>
                {option.description}
              </span>
            ) : null}
          </span>
        </>
      )}
    />
  );

  // Suppress the disabled-reason tooltip while we are still loading: the
  // reason ("Select a machine first") would be misleading in that window.
  if (disabledReason && !loading) {
    return (
      <Tooltip.Root>
        <Tooltip.Trigger
          delay={500}
          render={<div {...stylex.props(styles.fill)}>{selectorNode}</div>}
        />
        <Tooltip.Content>{disabledReason}</Tooltip.Content>
      </Tooltip.Root>
    );
  }

  return selectorNode;
}

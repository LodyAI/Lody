import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import {
  Bot,
  Check,
  ListChecks,
  Monitor,
  ShieldAlert,
  Zap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  classifyPermissionModeFace,
  getBuiltinDefaultModeId,
  type AgentConfigId,
  type AgentConfigMeta,
  type TaskAgentRef,
} from '@lody/shared';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { getModeIcon as getPermissionModeIcon } from '@/components/chat/chat-landing-selectors';
import { AgentIcon } from '@/components/icons/agent-icon';
import {
  resolveConfigOptionValue,
  resolveOnOffConfigOptionEnabled,
  resolvePlanModeSelectorEnabled,
  toggleOnOffConfigOptionValue,
  togglePlanModeSelectorValue,
  type AcpConfigOptionValue,
  type AcpSelectConfigOptionSelector,
} from '@/components/shared/acp-selector-options';
import { orderAcpConfigOptionSelectors } from '@/lib/acp-selector-order';
import { cn } from '@/lib/utils';
import { useAcpSelectorOptions } from '@/hooks/use-acp-selector-options';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { Switch } from '@/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { tasksMenuClassName, tasksMenuSurfaceStyle } from './tasks-surface';

const RECENT_LIMIT = 3;

type RecentTaskAgentCombo = {
  agentConfigId: string;
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, string>;
  /** Display cache so the row stays readable if the config is later renamed. */
  label: string;
  machineName: string;
  usedAt: number;
};

const recentTaskAgentCombosAtom = atomWithStorage<RecentTaskAgentCombo[]>(
  'lody-task-recent-agent-combos',
  []
);

/** Keep the menu open while multi-selecting run knobs (same as DesktopRunConfigMenu). */
function OptionItem({
  icon,
  label,
  description,
  selected,
  disabled,
  onSelect,
}: {
  icon?: ReactNode;
  label: string;
  description?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      role="menuitemradio"
      aria-checked={selected}
      onSelect={(event) => {
        event.preventDefault();
        onSelect();
      }}
      className="items-start gap-2 py-1"
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('truncate leading-tight', selected && 'font-medium')}>{label}</span>
        {description ? (
          <span className="text-xs leading-snug text-muted-foreground">{description}</span>
        ) : null}
      </span>
      {selected ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
    </DropdownMenuItem>
  );
}

function ValueSubTrigger({ label, value }: { label: string; value: string | null }) {
  return (
    <DropdownMenuSubTrigger className="pr-1.5">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="ml-4 max-w-36 truncate text-xs text-muted-foreground">{value}</span>
    </DropdownMenuSubTrigger>
  );
}

function ToggleItem({
  icon,
  label,
  checked,
  onToggle,
}: {
  icon: ReactNode;
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <DropdownMenuItem
      role="menuitemcheckbox"
      aria-checked={checked}
      onSelect={(event) => {
        event.preventDefault();
        onToggle();
      }}
    >
      <span
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center',
          checked ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Switch
        checked={checked}
        aria-hidden="true"
        tabIndex={-1}
        className="pointer-events-none ml-4 shrink-0"
      />
    </DropdownMenuItem>
  );
}

function permissionModeIcon(modeId: string | null): ReactNode {
  const face = classifyPermissionModeFace(modeId);
  if (face.kind !== 'hidden' && face.tone === 'warning') {
    return <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-status-warning" />;
  }
  return getPermissionModeIcon(modeId);
}

/** Prefer Auto when available (same intent as landing first-run default). */
function pickDefaultModeId(
  config: AgentConfigMeta | null,
  modeOptions: ReadonlyArray<{ value: string }>
): string | undefined {
  if (!config || modeOptions.length === 0) return undefined;
  const builtin = getBuiltinDefaultModeId(config.cliType, config.agentType);
  if (builtin && modeOptions.some((option) => option.value === builtin)) {
    return builtin;
  }
  const auto = modeOptions.find((option) => {
    const value = option.value.toLowerCase();
    return value === 'auto' || value.includes('auto');
  });
  return auto?.value;
}

export type TaskAgentRunConfigMenuProps = {
  value: TaskAgentRef | null;
  onChange: (next: TaskAgentRef) => void;
  disabled?: boolean;
  /** Presence badge on the property-row trigger. */
  trailing?: ReactNode;
};

/**
 * Task-detail run-config picker: Machine → Agent (filtered) → Model / Reasoning
 * / Plan / Fast / Permission, plus recent combinations. Selections keep the
 * menu open so several knobs can be set in one visit (landing DesktopRunConfigMenu
 * convention). Writes `lastRunConfig` only — never the delegated `agent` field.
 */
export function TaskAgentRunConfigMenu({
  value,
  onChange,
  disabled = false,
  trailing,
}: TaskAgentRunConfigMenuProps) {
  const { t } = useTranslation();
  const agentConfigs = useAtomValue(getAllAgentConfigAtom) as AgentConfigMeta[];
  const onlineMachineIds = useOnlineMachineIds();
  const { machines } = useVisibleMachineMetas({ includeMachineFlock: true });
  const [recents, setRecents] = useAtom(recentTaskAgentCombosAtom);

  const selectedConfig = useMemo(
    () => agentConfigs.find((config) => config.id === value?.agentConfigId) ?? null,
    [agentConfigs, value?.agentConfigId]
  );

  // Machine filter for the agent list. Follows the selected agent when set;
  // otherwise the user can pick a machine first to narrow agents.
  const [machineFilterId, setMachineFilterId] = useState<string | null>(
    selectedConfig?.machineId ?? null
  );
  useEffect(() => {
    if (selectedConfig?.machineId) {
      setMachineFilterId(selectedConfig.machineId);
    }
  }, [selectedConfig?.machineId]);

  const machinesWithAgents = useMemo(() => {
    const ids = new Set(agentConfigs.map((config) => config.machineId));
    return [...ids].map((machineId) => ({
      machineId,
      name: machines.get(machineId)?.name ?? t('tasks.slots.unknownMachine', 'Unknown machine'),
      online: onlineMachineIds.has(machineId),
    }));
  }, [agentConfigs, machines, onlineMachineIds, t]);

  const agentsOnMachine = useMemo(() => {
    const list = agentConfigs.filter((config) =>
      machineFilterId ? config.machineId === machineFilterId : true
    );
    return list.map((config) => ({
      config,
      machineName:
        machines.get(config.machineId)?.name ?? t('tasks.slots.unknownMachine', 'Unknown machine'),
      online: onlineMachineIds.has(config.machineId),
    }));
  }, [agentConfigs, machineFilterId, machines, onlineMachineIds, t]);

  const selectedMachine = useMemo(
    () => (selectedConfig ? machines.get(selectedConfig.machineId) : undefined),
    [machines, selectedConfig]
  );

  const selectorOptions = useAcpSelectorOptions(
    selectedConfig
      ? {
          configId: selectedConfig.id,
          cliType: selectedConfig.cliType,
          agentType: selectedConfig.agentType,
          selectedModeId: value?.modeId,
          selectedModelId: value?.modelId,
          configOptionValues: value?.configOptionValues,
          runtimeOverrides: selectedConfig.runtimeOverrides,
          machine: selectedMachine,
        }
      : undefined
  );

  const { modeOptions, modelOptions, configOptionSelectors } = selectorOptions;
  const ordered = useMemo(
    () => orderAcpConfigOptionSelectors(configOptionSelectors),
    [configOptionSelectors]
  );

  const modelConfigSelector = ordered.modelSelectors[0] as AcpSelectConfigOptionSelector | undefined;
  // The Reasoning row binds the effort ladder when there is one; a lone thinking
  // toggle keeps that row. Any other toggle-shaped thought option stays visible
  // as a provider-defined select, since this menu has no dedicated toggle rows.
  const thinkingSelector = useMemo(
    () =>
      (ordered.thoughtLevelSelectors.find((s) => s.type === 'select') ??
        ordered.thoughtToggleSelectors.find((s) => s.type === 'select')) as
        | AcpSelectConfigOptionSelector
        | undefined,
    [ordered.thoughtLevelSelectors, ordered.thoughtToggleSelectors]
  );
  const extraSelectSelectors = useMemo(
    () =>
      [...ordered.otherSelectors, ...ordered.thoughtToggleSelectors].filter(
        (selector): selector is AcpSelectConfigOptionSelector =>
          selector.type === 'select' && selector !== thinkingSelector
      ),
    [ordered.otherSelectors, ordered.thoughtToggleSelectors, thinkingSelector]
  );
  const modelPickerOptions = useMemo(
    () => (modelOptions.length > 0 ? modelOptions : (modelConfigSelector?.options ?? [])),
    [modelConfigSelector, modelOptions]
  );
  const modelValue: string | null =
    modelOptions.length > 0
      ? (value?.modelId ?? null)
      : modelConfigSelector
        ? ((resolveConfigOptionValue(
            modelConfigSelector,
            value?.configOptionValues?.[modelConfigSelector.configId]
          ) as string) ?? null)
        : null;
  const modelLabel =
    modelPickerOptions.find((opt) => opt.value === modelValue)?.label ?? modelValue;

  const thinkingValue = thinkingSelector
    ? ((resolveConfigOptionValue(
        thinkingSelector,
        value?.configOptionValues?.[thinkingSelector.configId]
      ) as string) ?? null)
    : null;
  const thinkingLabel =
    thinkingSelector?.options.find((opt) => opt.value === thinkingValue)?.label ?? thinkingValue;

  const planSelector = ordered.planModeSelectors[0];
  const planOn = planSelector
    ? resolvePlanModeSelectorEnabled(
        planSelector,
        value?.configOptionValues?.[planSelector.configId]
      )
    : false;
  const fastSelector = ordered.fastModeSelectors[0];
  const fastOn = fastSelector
    ? resolveOnOffConfigOptionEnabled(
        fastSelector,
        value?.configOptionValues?.[fastSelector.configId]
      )
    : false;

  const explicitPermissionSelector = ordered.permissionModeSelectors[0];
  const modeConfigSelector = (explicitPermissionSelector ?? ordered.modeSelectors[0]) as
    | AcpSelectConfigOptionSelector
    | undefined;
  const permissionOptions = useMemo(
    () =>
      explicitPermissionSelector
        ? explicitPermissionSelector.options
        : modeOptions.length > 0
          ? modeOptions
          : (modeConfigSelector?.options ?? []),
    [explicitPermissionSelector, modeConfigSelector, modeOptions]
  );
  const permissionValue =
    explicitPermissionSelector || modeOptions.length === 0
      ? modeConfigSelector
        ? ((resolveConfigOptionValue(
            modeConfigSelector,
            value?.configOptionValues?.[modeConfigSelector.configId]
          ) as string) ?? null)
        : null
      : (value?.modeId ?? null);
  const permissionLabel =
    permissionOptions.find((opt) => opt.value === permissionValue)?.label ?? null;

  const rememberRecent = useCallback(
    (next: TaskAgentRef, config: AgentConfigMeta) => {
      const entry: RecentTaskAgentCombo = {
        agentConfigId: next.agentConfigId,
        ...(next.modeId ? { modeId: next.modeId } : {}),
        ...(next.modelId ? { modelId: next.modelId } : {}),
        ...(next.configOptionValues ? { configOptionValues: next.configOptionValues } : {}),
        label: config.name || `${config.cliType}`,
        machineName:
          machines.get(config.machineId)?.name ??
          t('tasks.slots.unknownMachine', 'Unknown machine'),
        usedAt: Date.now(),
      };
      setRecents((previous) => {
        const without = previous.filter(
          (item) =>
            !(
              item.agentConfigId === entry.agentConfigId &&
              item.modelId === entry.modelId &&
              item.modeId === entry.modeId
            )
        );
        return [entry, ...without].slice(0, RECENT_LIMIT);
      });
    },
    [machines, setRecents, t]
  );

  const commit = useCallback(
    (next: TaskAgentRef) => {
      onChange(next);
      const config = agentConfigs.find((candidate) => candidate.id === next.agentConfigId);
      if (config) {
        rememberRecent(next, config);
      }
    },
    [agentConfigs, onChange, rememberRecent]
  );

  const patchConfigOption = useCallback(
    (configId: string, optionValue: AcpConfigOptionValue) => {
      if (!value?.agentConfigId) return;
      const nextValues = {
        ...(value.configOptionValues ?? {}),
        [configId]: String(optionValue),
      };
      commit({
        agentConfigId: value.agentConfigId as AgentConfigId,
        ...(value.modeId ? { modeId: value.modeId } : {}),
        ...(value.modelId ? { modelId: value.modelId } : {}),
        configOptionValues: nextValues,
      });
    },
    [commit, value]
  );

  const selectAgentConfig = useCallback(
    (config: AgentConfigMeta) => {
      setMachineFilterId(config.machineId);
      const modeOptionsForDefault =
        // Prefer built-in Auto when the new agent offers it (landing first-run
        // policy). Selector options for the *next* agent are not loaded yet, so
        // use the static builtin default id when known.
        [] as { value: string }[];
      const defaultMode =
        pickDefaultModeId(config, modeOptionsForDefault) ??
        getBuiltinDefaultModeId(config.cliType, config.agentType) ??
        undefined;
      // When we have live mode options for the *current* selection path after
      // agent switch, re-resolve with Auto preference in an effect below.
      commit({
        agentConfigId: config.id as AgentConfigId,
        ...(defaultMode ? { modeId: defaultMode } : {}),
      });
    },
    [commit]
  );

  // After agent + selector options settle, force permission mode to Auto when
  // available and the current mode is missing or invalid for this agent.
  useEffect(() => {
    // Explicit permission config options are initialized and persisted through
    // configOptionValues; modeId remains available for the interaction mode.
    if (explicitPermissionSelector) return;
    if (!value?.agentConfigId || !selectedConfig || permissionOptions.length === 0) {
      return;
    }
    const currentOk =
      value.modeId != null && permissionOptions.some((option) => option.value === value.modeId);
    if (currentOk) return;
    const preferred = pickDefaultModeId(selectedConfig, permissionOptions);
    if (!preferred || preferred === value.modeId) return;
    commit({
      agentConfigId: value.agentConfigId as AgentConfigId,
      modeId: preferred,
      ...(value.modelId ? { modelId: value.modelId } : {}),
      ...(value.configOptionValues ? { configOptionValues: value.configOptionValues } : {}),
    });
  }, [commit, explicitPermissionSelector, permissionOptions, selectedConfig, value]);

  const machineFilterLabel =
    machinesWithAgents.find((entry) => entry.machineId === machineFilterId)?.name ??
    t('chat.machineSelector.placeholder', 'Machine');

  const agentLabel = selectedConfig?.name ?? null;
  const triggerSecondary = [modelLabel, thinkingLabel].filter(Boolean).join(' · ');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors',
            'hover:bg-hover data-[state=open]:bg-hover',
            'disabled:cursor-not-allowed disabled:opacity-50',
            agentLabel ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {selectedConfig ? (
            <AgentIcon
              cliType={selectedConfig.cliType}
              agentType={selectedConfig.agentType}
              brandId={selectedConfig.brandId}
              env={selectedConfig.env}
              className="h-3.5 w-3.5 shrink-0 opacity-80"
            />
          ) : (
            <Bot className="h-3.5 w-3.5 shrink-0 opacity-70" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {agentLabel ?? t('tasks.slots.chooseAgent', 'Choose agent')}
            {triggerSecondary ? (
              <span className="text-muted-foreground"> · {triggerSecondary}</span>
            ) : null}
          </span>
          {trailing}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className={tasksMenuClassName('min-w-64 max-w-80')}
        style={tasksMenuSurfaceStyle}
      >
        {recents.length > 0 ? (
          <>
            <DropdownMenuLabel className="text-[0.68rem] font-medium tracking-wide text-muted-foreground/70">
              {t('tasks.agent.recent', 'Recent')}
            </DropdownMenuLabel>
            {recents.map((entry) => {
              const config = agentConfigs.find((candidate) => candidate.id === entry.agentConfigId);
              const selected =
                value?.agentConfigId === entry.agentConfigId &&
                value?.modelId === entry.modelId &&
                value?.modeId === entry.modeId;
              return (
                <OptionItem
                  key={`${entry.agentConfigId}:${entry.modelId ?? ''}:${entry.modeId ?? ''}:${entry.usedAt}`}
                  icon={
                    config ? (
                      <AgentIcon
                        cliType={config.cliType}
                        agentType={config.agentType}
                        brandId={config.brandId}
                        env={config.env}
                        className="mt-0.5 h-4 w-4 shrink-0"
                      />
                    ) : (
                      <Bot className="mt-0.5 h-4 w-4 shrink-0" />
                    )
                  }
                  label={entry.label}
                  description={entry.machineName}
                  selected={selected}
                  disabled={!config}
                  onSelect={() => {
                    if (!config) return;
                    setMachineFilterId(config.machineId);
                    commit({
                      agentConfigId: entry.agentConfigId as AgentConfigId,
                      ...(entry.modeId ? { modeId: entry.modeId } : {}),
                      ...(entry.modelId ? { modelId: entry.modelId } : {}),
                      ...(entry.configOptionValues
                        ? { configOptionValues: entry.configOptionValues }
                        : {}),
                    });
                  }}
                />
              );
            })}
            <DropdownMenuSeparator />
          </>
        ) : null}

        {/* Machine — selecting stays open and filters the agent list. */}
        <DropdownMenuSub>
          <ValueSubTrigger
            label={t('chat.machineSelector.placeholder', 'Machine')}
            value={machineFilterId ? machineFilterLabel : null}
          />
          <DropdownMenuSubContent
            className={tasksMenuClassName('min-w-52')}
            style={tasksMenuSurfaceStyle}
          >
            {machinesWithAgents.map((entry) => (
              <OptionItem
                key={entry.machineId}
                icon={
                  <Monitor
                    className={cn(
                      'mt-0.5 h-4 w-4 shrink-0',
                      entry.online ? 'text-muted-foreground' : 'text-muted-foreground/50'
                    )}
                  />
                }
                label={entry.name}
                description={
                  entry.online
                    ? undefined
                    : t('tasks.slots.offline', 'Offline')
                }
                selected={entry.machineId === machineFilterId}
                onSelect={() => setMachineFilterId(entry.machineId)}
              />
            ))}
            {machinesWithAgents.length === 0 ? (
              <DropdownMenuItem disabled>
                {t('tasks.slots.noMachines', 'No machines with agents')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* Agent — scoped to the machine filter when set. */}
        <DropdownMenuSub>
          <ValueSubTrigger
            label={t('chat.agentSelector.placeholder', 'Agent')}
            value={agentLabel}
          />
          <DropdownMenuSubContent
            className={tasksMenuClassName('min-w-56')}
            style={tasksMenuSurfaceStyle}
          >
            {agentsOnMachine.map(({ config, machineName, online }) => (
              <OptionItem
                key={config.id}
                icon={
                  <AgentIcon
                    cliType={config.cliType}
                    agentType={config.agentType}
                    brandId={config.brandId}
                    env={config.env}
                    className="mt-0.5 h-4 w-4 shrink-0"
                  />
                }
                label={config.name || `${config.cliType}`}
                description={
                  machineFilterId
                    ? online
                      ? undefined
                      : t('tasks.slots.offline', 'Offline')
                    : online
                      ? machineName
                      : `${machineName} · ${t('tasks.slots.offline', 'Offline')}`
                }
                selected={config.id === value?.agentConfigId}
                onSelect={() => selectAgentConfig(config)}
              />
            ))}
            {agentsOnMachine.length === 0 ? (
              <DropdownMenuItem disabled>
                {t('tasks.slots.noAgentsOnMachine', 'No agents on this machine')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {extraSelectSelectors.map((selector) => {
          const selectedValue =
            (resolveConfigOptionValue(
              selector,
              value?.configOptionValues?.[selector.configId]
            ) as string) ?? null;
          const selectedLabel =
            selector.options.find((option) => option.value === selectedValue)?.label ??
            selectedValue;
          return (
            <DropdownMenuSub key={selector.configId}>
              <ValueSubTrigger label={selector.label} value={selectedLabel} />
              <DropdownMenuSubContent
                className={tasksMenuClassName('max-w-80')}
                style={tasksMenuSurfaceStyle}
              >
                {selector.options.map((option) => (
                  <OptionItem
                    key={option.value}
                    label={option.label}
                    description={option.description}
                    selected={option.value === selectedValue}
                    disabled={option.disabled || !value?.agentConfigId}
                    onSelect={() => patchConfigOption(selector.configId, option.value)}
                  />
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}

        {modelPickerOptions.length > 0 ? (
          <DropdownMenuSub>
            <ValueSubTrigger
              label={t('chat.runConfig.modelLabel', 'Model')}
              value={modelLabel}
            />
            <DropdownMenuSubContent
              className={tasksMenuClassName('max-w-80')}
              style={{
                ...tasksMenuSurfaceStyle,
                maxHeight: 'min(20rem, var(--radix-dropdown-menu-content-available-height, 20rem))',
              }}
            >
              {modelPickerOptions.map((opt) => (
                <OptionItem
                  key={opt.value}
                  label={opt.label}
                  description={opt.description}
                  selected={opt.value === modelValue}
                  disabled={opt.disabled || !value?.agentConfigId}
                  onSelect={() => {
                    if (!value?.agentConfigId) return;
                    if (modelOptions.length > 0) {
                      commit({
                        agentConfigId: value.agentConfigId as AgentConfigId,
                        modelId: opt.value,
                        ...(value.modeId ? { modeId: value.modeId } : {}),
                        ...(value.configOptionValues
                          ? { configOptionValues: value.configOptionValues }
                          : {}),
                      });
                    } else if (modelConfigSelector) {
                      patchConfigOption(modelConfigSelector.configId, opt.value);
                    }
                  }}
                />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}

        {thinkingSelector ? (
          <DropdownMenuSub>
            <ValueSubTrigger
              label={t('chat.runConfig.reasoningLabel', 'Reasoning')}
              value={thinkingLabel}
            />
            <DropdownMenuSubContent
              className={tasksMenuClassName()}
              style={tasksMenuSurfaceStyle}
            >
              {thinkingSelector.options.map((opt) => (
                <OptionItem
                  key={opt.value}
                  label={opt.label}
                  description={opt.description}
                  selected={opt.value === thinkingValue}
                  disabled={opt.disabled || !value?.agentConfigId}
                  onSelect={() =>
                    patchConfigOption(thinkingSelector.configId, opt.value as AcpConfigOptionValue)
                  }
                />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}

        {permissionOptions.length > 0 ? (
          <DropdownMenuSub>
            <ValueSubTrigger
              label={t('chat.runConfig.permissionLabel', 'Permission')}
              value={permissionLabel}
            />
            <DropdownMenuSubContent
              className={tasksMenuClassName('min-w-52 max-w-80')}
              style={tasksMenuSurfaceStyle}
            >
              {permissionOptions.map((opt) => (
                <OptionItem
                  key={opt.value}
                  icon={
                    <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                      {permissionModeIcon(opt.value)}
                    </span>
                  }
                  label={opt.label}
                  description={opt.description}
                  selected={opt.value === permissionValue}
                  disabled={opt.disabled || !value?.agentConfigId}
                  onSelect={() => {
                    if (!value?.agentConfigId) return;
                    if (!explicitPermissionSelector && modeOptions.length > 0) {
                      commit({
                        agentConfigId: value.agentConfigId as AgentConfigId,
                        modeId: opt.value,
                        ...(value.modelId ? { modelId: value.modelId } : {}),
                        ...(value.configOptionValues
                          ? { configOptionValues: value.configOptionValues }
                          : {}),
                      });
                    } else if (modeConfigSelector) {
                      patchConfigOption(modeConfigSelector.configId, opt.value);
                    }
                  }}
                />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}

        {(planSelector || fastSelector) && value?.agentConfigId ? (
          <DropdownMenuSeparator />
        ) : null}
        {planSelector && value?.agentConfigId ? (
          <ToggleItem
            icon={<ListChecks className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />}
            label={t('chat.mobileNewChat.planModeLabel', 'Plan')}
            checked={planOn}
            onToggle={() =>
              patchConfigOption(
                planSelector.configId,
                togglePlanModeSelectorValue(
                  planSelector,
                  value.configOptionValues?.[planSelector.configId]
                )
              )
            }
          />
        ) : null}
        {fastSelector && value?.agentConfigId ? (
          <ToggleItem
            icon={<Zap className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />}
            label={t('chat.runConfig.fastLabel', 'Fast')}
            checked={fastOn}
            onToggle={() =>
              patchConfigOption(
                fastSelector.configId,
                toggleOnOffConfigOptionValue(
                  fastSelector,
                  value.configOptionValues?.[fastSelector.configId]
                )
              )
            }
          />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

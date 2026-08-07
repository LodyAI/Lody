import { useMemo, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { Bot, Check, ListChecks, LockKeyhole, Monitor, Plus, ShieldAlert, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  classifyPermissionModeFace,
  type AgentConfigCliType,
  type AgentConfigMeta,
  type MachineId,
} from '@lody/shared';

import { getAllAgentConfigAtom } from '@/atoms';
import { getModeIcon as getPermissionModeIcon } from '@/components/chat/chat-landing-selectors';
import { AgentIcon } from '@/components/icons/agent-icon';
import {
  resolveConfigOptionValue,
  resolveOnOffConfigOptionEnabled,
  resolvePlanModeSelectorEnabled,
  toggleOnOffConfigOptionValue,
  togglePlanModeSelectorValue,
  type AcpConfigOptionSelector,
  type AcpConfigOptionValue,
  type AcpSelectConfigOptionSelector,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import type { AgentSelection } from '@/components/shared/agent-selector';
import { orderAcpConfigOptionSelectors } from '@/lib/acp-selector-order';
import { cn } from '@/lib/utils';
import { useOnlineMachines } from '@/hooks/use-online-machines';
import { Switch } from '@/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
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

/**
 * Desktop composer run-config controls. Two buttons on the composer footer:
 *
 *   [ agent icon + model · reasoning (· plan/fast glyphs) ⌄ ]  [ mode icon + mode name ⌄ ]
 *
 * `DesktopRunConfigMenu` consolidates Agent / Model / Reasoning (side submenus)
 * plus Plan / Fast (toggle rows) into one dropdown; `DesktopPermissionModeButton`
 * stays a separate button because the mode is the knob users flip most — its
 * face shows the full mode name (truncating, then the label can be hidden via
 * container width) and opens a flat mode list.
 *
 * Both menus use the app-wide DropdownMenu surface.
 */

/* Option row with a trailing check for the selected value; description under
   the label when present. Selecting keeps the menu (and submenu) OPEN — same
   as the Plan/Fast toggle rows — so several run knobs can be adjusted in one
   visit; the check mark moving is the feedback. Dismiss via Esc/outside. */
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
      // Tighter vertical rhythm than the default menu item (py-2): these rows
      // carry a two-line label + description, so a smaller pad keeps the list
      // from getting tall enough to overflow.
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

/* Submenu row: label left, current value + chevron right. */
function ValueSubTrigger({ label, value }: { label: string; value: string | null }) {
  return (
    <DropdownMenuSubTrigger className="pr-1.5">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="ml-4 max-w-36 truncate text-xs text-muted-foreground">{value}</span>
    </DropdownMenuSubTrigger>
  );
}

/* Switch row that keeps the menu open on click. The whole row is the control;
   the Switch is a purely visual state indicator (clicks land on the item). */
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

/* Shared trigger chrome for both footer buttons. */
const TRIGGER_CLASS = cn(
  'inline-flex h-7 min-w-0 select-none items-center gap-1.5 rounded-[4px] px-2 text-xs leading-tight',
  'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
  'data-[state=open]:bg-muted data-[state=open]:text-foreground',
  'disabled:cursor-default disabled:opacity-70'
);

export type DesktopMachineMenuOption = {
  value: MachineId;
  label: string;
  disabled?: boolean;
  isPrivate?: boolean;
};

export function DesktopMachineMenu({
  value,
  selectedLabel,
  options,
  onChange,
  disabled = false,
  disabledReason,
  onAddMachine,
}: {
  value: MachineId | null;
  selectedLabel?: string | null;
  options: ReadonlyArray<DesktopMachineMenuOption>;
  onChange: (machineId: MachineId) => void;
  disabled?: boolean;
  disabledReason?: string;
  onAddMachine?: () => void;
}) {
  const { t } = useTranslation();
  const selectedOption = options.find((option) => option.value === value);
  const label =
    selectedOption?.label ?? selectedLabel ?? t('chat.machineSelector.placeholder', 'Machine');
  const isDisabled = disabled || (options.length === 0 && !onAddMachine);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-6 min-w-0 select-none items-center gap-1.5 rounded-md bg-input/60 px-2 dark:bg-foreground/[0.08]',
            'text-xs font-normal leading-tight text-foreground/80 transition-colors [&_svg]:text-current [&_svg]:opacity-100',
            'hover:bg-input hover:text-foreground data-[state=open]:bg-input data-[state=open]:text-foreground dark:hover:bg-foreground/[0.12] dark:data-[state=open]:bg-foreground/[0.12]',
            'disabled:cursor-default disabled:opacity-70'
          )}
          disabled={isDisabled}
          title={disabledReason}
          aria-label={t('chat.machineSelector.placeholder', 'Machine')}
        >
          <Monitor className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="max-w-32 truncate">{label}</span>
          {selectedOption?.isPrivate ? (
            <LockKeyhole
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        avoidCollisions={false}
        className="min-w-52 max-w-72"
      >
        <DropdownMenuLabel className="px-2.5 pb-1 pt-1.5 text-[0.68rem] font-medium tracking-wide text-muted-foreground/70">
          {t('chat.machineSelector.placeholder', 'Machine')}
        </DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            disabled={option.disabled}
            onSelect={() => onChange(option.value)}
          >
            <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span
              className={cn('min-w-0 flex-1 truncate', option.value === value && 'font-medium')}
            >
              {option.label}
            </span>
            {option.isPrivate ? (
              <Tooltip delayDuration={250}>
                <TooltipTrigger asChild>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded border border-border/70 px-1.5 py-0.5 text-[0.64rem] font-medium text-muted-foreground">
                    <LockKeyhole className="h-3 w-3" aria-hidden="true" />
                    {t('sharing.private', 'Private')}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-64 text-xs">
                  {t(
                    'sharing.machinePrivateHelp',
                    'Only you can use this machine. Share it from machine settings so teammates can see its shared projects and conversations.'
                  )}
                </TooltipContent>
              </Tooltip>
            ) : null}
            {option.value === value ? (
              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : null}
          </DropdownMenuItem>
        ))}
        {onAddMachine ? (
          <>
            {options.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem onSelect={onAddMachine}>
              <Plus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                {t('machinePairing.addMachine', 'Add machine')}
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ── Run config (agent + model + reasoning + plan/fast) ──────────────── */

export type DesktopRunConfigMenuProps = {
  agentSelection: AgentSelection | null;
  /** Restrict agents to the session/project machine. Omit for new chats that
   * may run on any online machine. */
  allowedMachineIds?: MachineId[];
  /**
   * Explicit agent pool for non-composer surfaces such as machine settings.
   * Unlike the default pool, these configs are not filtered by online presence.
   */
  availableAgentConfigs?: ReadonlyArray<AgentConfigMeta>;
  /** Include the selected agent name in the trigger face. */
  showAgentNameInTrigger?: boolean;
  /** Trigger copy while no agent has been selected. */
  emptyAgentLabel?: string;
  agentLocked?: boolean;
  fallbackAgent?: {
    cliType?: AgentConfigCliType | null;
    agentType?: string | null;
  };
  onAgentConfigChange?: (selection: AgentSelection) => void;
  modelOptions: ReadonlyArray<AcpSessionSelectOption>;
  selectedModelId: string | null;
  onModelChange?: (value: string) => void;
  configOptionSelectors?: AcpConfigOptionSelector[];
  configOptionValues?: Record<string, AcpConfigOptionValue>;
  onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
};

export function DesktopRunConfigMenu({
  agentSelection,
  allowedMachineIds,
  availableAgentConfigs,
  showAgentNameInTrigger = false,
  emptyAgentLabel,
  agentLocked = false,
  fallbackAgent,
  onAgentConfigChange,
  modelOptions,
  selectedModelId,
  onModelChange,
  configOptionSelectors = [],
  configOptionValues,
  onConfigOptionChange,
}: DesktopRunConfigMenuProps) {
  const { t } = useTranslation();
  const executorConfigs = useAtomValue(getAllAgentConfigAtom);
  const onlineMachines = useOnlineMachines(allowedMachineIds);
  const selectableAgentConfigs = availableAgentConfigs ?? executorConfigs;
  const { modelSelectors, thoughtLevelSelectors, planModeSelectors, fastModeSelectors } = useMemo(
    () => orderAcpConfigOptionSelectors(configOptionSelectors),
    [configOptionSelectors]
  );

  /* Agent options follow the caller's machine scope. On chat landing the
     explicit machine picker owns that scope, including GitHub/no-project drafts. */
  const agentOptions = useMemo(() => {
    if (availableAgentConfigs) {
      return availableAgentConfigs.map((config) => ({ config, machineName: '' }));
    }
    const machineNames = new Map(onlineMachines.map((machine) => [machine.id, machine.name]));
    return executorConfigs.flatMap((config) => {
      const machineName = machineNames.get(config.machineId);
      return machineName ? [{ config, machineName }] : [];
    });
  }, [availableAgentConfigs, executorConfigs, onlineMachines]);
  const selectedAgentConfig = useMemo(
    () =>
      agentSelection
        ? selectableAgentConfigs.find(
            (cfg) => cfg.id === agentSelection.agentId && cfg.machineId === agentSelection.machineId
          )
        : null,
    [agentSelection, selectableAgentConfigs]
  );
  const isAgentLocked = agentLocked || onAgentConfigChange == null || agentOptions.length === 0;

  /* Model (free-standing modelOptions first, else the model config selector). */
  const modelConfigSelector: AcpSelectConfigOptionSelector | undefined = modelSelectors[0];
  const modelPickerOptions = useMemo(
    () => (modelOptions.length > 0 ? modelOptions : (modelConfigSelector?.options ?? [])),
    [modelConfigSelector, modelOptions]
  );
  const modelValue: string | null =
    modelOptions.length > 0
      ? selectedModelId
      : modelConfigSelector
        ? ((resolveConfigOptionValue(
            modelConfigSelector,
            configOptionValues?.[modelConfigSelector.configId]
          ) as string) ?? null)
        : null;
  const modelLabel =
    modelPickerOptions.find((opt) => opt.value === modelValue)?.label ?? modelValue;
  const handleModelSelect = (value: string) => {
    if (modelOptions.length > 0) {
      onModelChange?.(value);
    } else if (modelConfigSelector) {
      onConfigOptionChange?.(modelConfigSelector.configId, value as AcpConfigOptionValue);
    }
  };

  /* Reasoning (first thought-level select selector). */
  const thinkingSelector = useMemo(
    () =>
      thoughtLevelSelectors.find((s) => s.type === 'select') as
        | AcpSelectConfigOptionSelector
        | undefined,
    [thoughtLevelSelectors]
  );
  const thinkingValue = thinkingSelector
    ? ((resolveConfigOptionValue(
        thinkingSelector,
        configOptionValues?.[thinkingSelector.configId]
      ) as string) ?? null)
    : null;
  const thinkingLabel =
    thinkingSelector?.options.find((opt) => opt.value === thinkingValue)?.label ?? thinkingValue;

  /* Plan / Fast. */
  const planSelector = planModeSelectors[0];
  const planOn = planSelector
    ? resolvePlanModeSelectorEnabled(planSelector, configOptionValues?.[planSelector.configId])
    : false;
  const fastSelector = fastModeSelectors[0];
  const fastOn = fastSelector
    ? resolveOnOffConfigOptionEnabled(fastSelector, configOptionValues?.[fastSelector.configId])
    : false;

  const agentLabel = t('chat.agentSelector.placeholder', 'Agent');
  const modelRowLabel = t('chat.runConfig.modelLabel', 'Model');
  const reasoningLabel = t('chat.runConfig.reasoningLabel', 'Reasoning');
  const planRowLabel = t('chat.mobileNewChat.planModeLabel', 'Plan');
  const fastRowLabel = t('chat.runConfig.fastLabel', 'Fast');

  const hasAnyRow =
    agentOptions.length > 0 ||
    selectedAgentConfig != null ||
    modelPickerOptions.length > 0 ||
    thinkingSelector != null ||
    planSelector != null ||
    fastSelector != null;
  if (!hasAnyRow) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={TRIGGER_CLASS}
          aria-label={t('chat.runConfig.buttonAriaLabel', 'Run configuration')}
        >
          {selectedAgentConfig ? (
            <AgentIcon
              cliType={selectedAgentConfig.cliType}
              agentType={selectedAgentConfig.agentType}
              brandId={selectedAgentConfig.brandId}
              env={selectedAgentConfig.env}
              className="h-4 w-4 shrink-0"
            />
          ) : fallbackAgent?.cliType && fallbackAgent.agentType ? (
            <AgentIcon
              cliType={fallbackAgent.cliType}
              agentType={fallbackAgent.agentType}
              className="h-4 w-4 shrink-0"
            />
          ) : (
            <Bot className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          {showAgentNameInTrigger ? (
            <span className="block min-w-0 max-w-36 truncate text-left">
              {selectedAgentConfig?.name ?? emptyAgentLabel ?? agentLabel}
            </span>
          ) : null}
          {modelLabel ? (
            <>
              {showAgentNameInTrigger ? <FaceDot /> : null}
              <span className="block min-w-0 max-w-40 truncate text-left [direction:rtl]">
                <span dir="ltr">{modelLabel}</span>
              </span>
            </>
          ) : null}
          {thinkingLabel ? (
            <>
              <FaceDot />
              <span className="shrink-0">{thinkingLabel}</span>
            </>
          ) : null}
          {planOn ? (
            <>
              <FaceDot />
              <ListChecks className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
            </>
          ) : null}
          {fastOn ? (
            <>
              <FaceDot />
              <Zap className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
            </>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {agentOptions.length > 0 || selectedAgentConfig ? (
          isAgentLocked ? (
            <DropdownMenuItem disabled>
              <span className="min-w-0 flex-1 truncate">{agentLabel}</span>
              <span className="ml-4 flex max-w-36 items-center gap-1.5 text-xs text-muted-foreground">
                {selectedAgentConfig ? (
                  <AgentIcon
                    cliType={selectedAgentConfig.cliType}
                    agentType={selectedAgentConfig.agentType}
                    brandId={selectedAgentConfig.brandId}
                    env={selectedAgentConfig.env}
                    className="h-3 w-3 shrink-0"
                  />
                ) : null}
                <span className="truncate">{selectedAgentConfig?.name}</span>
              </span>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuSub>
              <ValueSubTrigger label={agentLabel} value={selectedAgentConfig?.name ?? null} />
              <DropdownMenuSubContent>
                {agentOptions.map(({ config, machineName }) => (
                  <OptionItem
                    key={`${config.id}:${config.machineId}`}
                    icon={
                      <AgentIcon
                        cliType={config.cliType}
                        agentType={config.agentType}
                        brandId={config.brandId}
                        env={config.env}
                        className="mt-0.5 h-4 w-4 shrink-0"
                      />
                    }
                    label={config.name}
                    description={allowedMachineIds ? undefined : machineName}
                    selected={
                      config.id === agentSelection?.agentId &&
                      config.machineId === agentSelection.machineId
                    }
                    onSelect={() =>
                      onAgentConfigChange?.({
                        agentId: config.id as AgentSelection['agentId'],
                        machineId: config.machineId as MachineId,
                      })
                    }
                  />
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        ) : null}

        {modelPickerOptions.length > 0 ? (
          <DropdownMenuSub>
            <ValueSubTrigger label={modelRowLabel} value={modelLabel} />
            <DropdownMenuSubContent
              className="max-w-80"
              // Cap the list so a long model list scrolls inside a compact menu
              // instead of running the full viewport height. Inline (not a max-h-*
              // class) so it reliably wins over the base content's max-h, and clamps
              // to the available height so it never overflows off-screen.
              style={{
                maxHeight: 'min(20rem, var(--radix-dropdown-menu-content-available-height, 20rem))',
              }}
            >
              {modelPickerOptions.map((opt) => (
                <OptionItem
                  key={opt.value}
                  label={opt.label}
                  description={opt.description}
                  selected={opt.value === modelValue}
                  disabled={opt.disabled}
                  onSelect={() => handleModelSelect(opt.value)}
                />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}

        {thinkingSelector ? (
          <DropdownMenuSub>
            <ValueSubTrigger label={reasoningLabel} value={thinkingLabel} />
            <DropdownMenuSubContent>
              {thinkingSelector.options.map((opt) => (
                <OptionItem
                  key={opt.value}
                  label={opt.label}
                  description={opt.description}
                  selected={opt.value === thinkingValue}
                  disabled={opt.disabled}
                  onSelect={() =>
                    onConfigOptionChange?.(
                      thinkingSelector.configId,
                      opt.value as AcpConfigOptionValue
                    )
                  }
                />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}

        {planSelector || fastSelector ? <DropdownMenuSeparator /> : null}
        {planSelector ? (
          <ToggleItem
            icon={<ListChecks className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />}
            label={planRowLabel}
            checked={planOn}
            onToggle={() =>
              onConfigOptionChange?.(
                planSelector.configId,
                togglePlanModeSelectorValue(
                  planSelector,
                  configOptionValues?.[planSelector.configId]
                )
              )
            }
          />
        ) : null}
        {fastSelector ? (
          <ToggleItem
            icon={<Zap className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />}
            label={fastRowLabel}
            checked={fastOn}
            onToggle={() =>
              onConfigOptionChange?.(
                fastSelector.configId,
                toggleOnOffConfigOptionValue(
                  fastSelector,
                  configOptionValues?.[fastSelector.configId]
                )
              )
            }
          />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FaceDot() {
  return (
    <span aria-hidden="true" className="shrink-0 select-none text-muted-foreground/60">
      ·
    </span>
  );
}

/* ── Permission mode (standalone button) ─────────────────────────────── */

/* Warning-tone modes (full access / skip permissions) share the amber shield
   with the mobile face; everything else keeps its neutral per-mode icon. */
function permissionModeIcon(modeId: string | null): ReactNode {
  const face = classifyPermissionModeFace(modeId);
  if (face.kind !== 'hidden' && face.tone === 'warning') {
    return <ShieldAlert className="h-4 w-4 shrink-0 text-status-warning" />;
  }
  return getPermissionModeIcon(modeId);
}

export type DesktopPermissionModeButtonProps = {
  modeOptions: ReadonlyArray<AcpSessionSelectOption>;
  selectedModeId: string | null;
  onModeChange?: (value: string) => void;
  configOptionSelectors?: AcpConfigOptionSelector[];
  configOptionValues?: Record<string, AcpConfigOptionValue>;
  onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
};

export function DesktopPermissionModeButton({
  modeOptions,
  selectedModeId,
  onModeChange,
  configOptionSelectors = [],
  configOptionValues,
  onConfigOptionChange,
}: DesktopPermissionModeButtonProps) {
  const { t } = useTranslation();
  const { modeSelectors } = useMemo(
    () => orderAcpConfigOptionSelectors(configOptionSelectors),
    [configOptionSelectors]
  );
  const modeConfigSelector: AcpSelectConfigOptionSelector | undefined = modeSelectors[0];
  const options = useMemo(
    () => (modeOptions.length > 0 ? modeOptions : (modeConfigSelector?.options ?? [])),
    [modeConfigSelector, modeOptions]
  );
  const value =
    modeOptions.length > 0
      ? selectedModeId
      : modeConfigSelector
        ? ((resolveConfigOptionValue(
            modeConfigSelector,
            configOptionValues?.[modeConfigSelector.configId]
          ) as string) ?? null)
        : null;
  const label = options.find((opt) => opt.value === value)?.label ?? null;
  const permissionLabel = t('chat.runConfig.permissionLabel', 'Permission');

  if (options.length === 0) return null;

  const handleSelect = (next: string) => {
    if (modeOptions.length > 0) {
      onModeChange?.(next);
    } else if (modeConfigSelector) {
      onConfigOptionChange?.(modeConfigSelector.configId, next as AcpConfigOptionValue);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={TRIGGER_CLASS} aria-label={permissionLabel}>
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {permissionModeIcon(value ?? null)}
          </span>
          {/* Full mode name on desktop; truncates when the row runs tight. */}
          <span className="min-w-0 max-w-36 truncate">{label ?? permissionLabel}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52 max-w-80">
        <DropdownMenuLabel className="px-2.5 pb-1 pt-1.5 text-[0.68rem] font-medium tracking-wide text-muted-foreground/70">
          {permissionLabel}
        </DropdownMenuLabel>
        {options.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            disabled={opt.disabled}
            onSelect={() => handleSelect(opt.value)}
            className="items-start"
          >
            <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              {permissionModeIcon(opt.value)}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn('truncate', opt.value === value && 'font-medium')}>
                {opt.label}
              </span>
              {opt.description ? (
                // Safety copy (e.g. the Full-access warning) must stay readable
                // — wrap instead of truncating.
                <span className="text-xs leading-snug text-muted-foreground">
                  {opt.description}
                </span>
              ) : null}
            </span>
            {opt.value === value ? (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

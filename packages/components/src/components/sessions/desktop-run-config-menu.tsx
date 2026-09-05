import { AcpControlAvailability } from '../shared/acp-control-availability';
import { useMemo, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { Bot, Check, ListChecks, LockKeyhole, Monitor, Plus, ShieldAlert, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  classifyPermissionModeFace,
  getAgentRoleEmoji,
  type AgentConfigCliType,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
  type MachineViewMeta,
} from '@lody/shared';

import { getAllAgentConfigAtom } from '@/atoms';
import { getModeIcon as getPermissionModeIcon } from '@/components/chat/chat-landing-selectors';
import { AgentIcon } from '@/components/icons/agent-icon';
import { ComposerAgentRolePanel } from '@/components/sessions/composer-agent-role-panel';
import {
  RecentRunConfigMenuGroup,
  type RecentRunConfigItem,
} from '@/components/sessions/recent-run-config-menu-group';
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
import { MenuOptionSearchList } from '@/components/shared/menu-option-search-list';
import {
  DEEPSEEK_DELEGATION_DISCUSSION_URL,
  DeepSeekDelegationWarningContent,
  shouldShowDeepSeekDelegationWarning,
} from '@/components/shared/deepseek-delegation-warning';
import { orderAcpConfigOptionSelectors } from '@/lib/acp-selector-order';
import { openExternalUrl } from '@/lib/native-browser';
import { resolvePermissionModeFace } from '@/lib/permission-mode-face';
import {
  doesAgentRolePinPermissionMode,
  type ComposerAgentRoleItem,
} from '@/lib/composer-agent-roles';
import { cn } from '@/lib/utils';
import { useOnlineMachines } from '@/hooks/use-online-machines';
import { Badge } from '@/ui/badge';
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
 *   [ agent icon + model · reasoning (· plan/fast glyphs) ⌄ ]  [ permission icon + name ⌄ ]
 *
 * `DesktopRunConfigMenu` consolidates Agent / Model / Interaction / Reasoning
 * (side submenus) plus Plan / Fast (toggle rows) into one dropdown;
 * `DesktopPermissionModeButton` stays a separate button because permission is
 * the knob users flip most — its face shows the full permission name and opens
 * a flat permission list.
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
      {/* Center the icon/check on the label's first line box (text-[0.8rem] +
          leading-tight = 16px): vertically centered on single-line rows, and
          hugging the first line when a description wraps below. */}
      {icon ? <span className="flex h-4 shrink-0 items-center">{icon}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('truncate leading-tight', selected && 'font-medium')}>{label}</span>
        {description ? (
          <span className="text-xs leading-snug text-muted-foreground">{description}</span>
        ) : null}
      </span>
      {selected ? (
        <span className="flex h-4 shrink-0 items-center">
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      ) : null}
    </DropdownMenuItem>
  );
}

/* Submenu row: label left, current value + chevron right. */
function ValueSubTrigger({
  label,
  value,
  icon,
  disabled = false,
}: {
  label: string;
  value: string | null;
  /** Rides beside the value, for a row whose value has a mark of its own. */
  icon?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <DropdownMenuSubTrigger className="pr-1.5" disabled={disabled}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="ml-4 flex min-w-0 max-w-40 items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span className="min-w-0 truncate">{value}</span>
      </span>
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
  visibleLocalMachineId = null,
  selectedLabel,
  options,
  onChange,
  disabled = false,
  disabledReason,
  onAddMachine,
}: {
  value: MachineId | null;
  visibleLocalMachineId?: MachineId | null;
  selectedLabel?: string | null;
  options: ReadonlyArray<DesktopMachineMenuOption>;
  onChange: (machineId: MachineId) => void;
  disabled?: boolean;
  disabledReason?: string;
  onAddMachine?: () => void;
}) {
  const { t } = useTranslation();
  const selectedOption = options.find((option) => option.value === value);
  const selectedIsLocal = selectedOption?.value === visibleLocalMachineId;
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
          {selectedIsLocal ? (
            <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
              {t('chat.machineSelector.local', 'Local')}
            </Badge>
          ) : null}
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
            {option.value === visibleLocalMachineId ? (
              <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                {t('chat.machineSelector.local', 'Local')}
              </Badge>
            ) : null}
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
  /** Keep the whole run-config menu inert and explain why on hover/focus. */
  disabledReason?: string;
  agentLocked?: boolean;
  fallbackAgent?: {
    cliType?: AgentConfigCliType | null;
    agentType?: string | null;
  };
  onAgentConfigChange?: (selection: AgentSelection) => void;
  modelOptions: ReadonlyArray<AcpSessionSelectOption>;
  selectedModelId: string | null;
  onModelChange?: (value: string) => void;
  /**
   * Permission inputs, read-only here: the standalone
   * `DesktopPermissionModeButton` is still the control. They are needed because
   * a selected Role pins permission too, and its face states everything the
   * Role decided rather than leaving one knob's value somewhere else.
   */
  modeOptions?: ReadonlyArray<AcpSessionSelectOption>;
  selectedModeId?: string | null;
  configOptionSelectors?: AcpConfigOptionSelector[];
  configOptionValues?: Record<string, AcpConfigOptionValue>;
  onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
  /**
   * Whole run configurations the user recently started a chat with, already
   * filtered (current selection removed, unusable entries dropped) and capped
   * by the caller. Empty renders no section at all.
   */
  recentRunConfigs?: ReadonlyArray<RecentRunConfigItem>;
  onRecentRunConfigSelect?: (id: string) => void;
  /**
   * Agent Roles for the machine this chat starts on, as the row above Agent.
   *
   * Omit to leave the row out entirely: a surface where the agent cannot change
   * (an in-session composer, a settings preview) has nothing a Role could
   * apply, and offering one there would promise a switch that cannot happen.
   */
  agentRoles?: {
    items: ReadonlyArray<ComposerAgentRoleItem>;
    /** The Role the current configuration still IS, not merely the last picked. */
    selectedRoleId: AgentRoleId | null;
    /** `null` clears the Role and leaves the configuration exactly as it stands. */
    onSelect: (roleId: AgentRoleId | null) => void;
    /** Opens the Role editor seeded with what the composer is set to right now. */
    onCreate?: () => void;
    onEdit?: (roleId: AgentRoleId) => void;
    /** The machine those Roles are bound to, for resolving their stored ids. */
    machine?: MachineViewMeta | null;
  };
};

export function DesktopRunConfigMenu({
  agentSelection,
  allowedMachineIds,
  availableAgentConfigs,
  showAgentNameInTrigger = false,
  emptyAgentLabel,
  disabledReason,
  agentLocked = false,
  fallbackAgent,
  onAgentConfigChange,
  modelOptions,
  selectedModelId,
  onModelChange,
  modeOptions = [],
  selectedModeId = null,
  configOptionSelectors = [],
  configOptionValues,
  onConfigOptionChange,
  recentRunConfigs,
  onRecentRunConfigSelect,
  agentRoles,
}: DesktopRunConfigMenuProps) {
  const { t } = useTranslation();
  const executorConfigs = useAtomValue(getAllAgentConfigAtom);
  const onlineMachines = useOnlineMachines(allowedMachineIds);
  const selectableAgentConfigs = availableAgentConfigs ?? executorConfigs;
  const {
    modelSelectors,
    interactionModeSelectors,
    thoughtLevelSelectors,
    planModeSelectors,
    fastModeSelectors,
    otherSelectors,
  } = useMemo(() => orderAcpConfigOptionSelectors(configOptionSelectors), [configOptionSelectors]);
  const extraSelectSelectors = useMemo(
    () =>
      otherSelectors.filter(
        (selector): selector is AcpSelectConfigOptionSelector => selector.type === 'select'
      ),
    [otherSelectors]
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
  const showDeepSeekDelegationWarning = shouldShowDeepSeekDelegationWarning({
    cliType: selectedAgentConfig?.cliType ?? fallbackAgent?.cliType,
    agentType: selectedAgentConfig?.agentType ?? fallbackAgent?.agentType,
    modelId: modelValue,
  });
  const handleModelSelect = (value: string) => {
    if (modelOptions.length > 0) {
      onModelChange?.(value);
    } else if (modelConfigSelector) {
      onConfigOptionChange?.(modelConfigSelector.configId, value as AcpConfigOptionValue);
    }
  };

  /* Provider-specific interaction mode (for example Grok Agent / Plan / Ask). */
  const interactionSelector = interactionModeSelectors[0];
  const interactionValue = interactionSelector
    ? ((resolveConfigOptionValue(
        interactionSelector,
        configOptionValues?.[interactionSelector.configId]
      ) as string) ?? null)
    : null;
  const interactionLabel =
    interactionSelector?.options.find((opt) => opt.value === interactionValue)?.label ??
    interactionValue;

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

  /* The Role the composer currently IS: the caller only passes an id while the
     live configuration still matches that Role, so the face can name it. */
  const selectedRole: AgentRole | undefined = useMemo(
    () =>
      agentRoles?.selectedRoleId
        ? agentRoles.items.find((item) => item.role.id === agentRoles.selectedRoleId)?.role
        : undefined,
    [agentRoles]
  );

  /* The half of the face that describes the run configuration rather than what
     was picked. Built as parts so the separator dots can be placed by the
     caller: inside the trigger it continues the agent name, while a Role
     renders it OUTSIDE the trigger, where a leading dot would dangle. */
  const configFaceParts: ReactNode[] = [];
  if (modelLabel) {
    configFaceParts.push(
      <span key="model" className="block min-w-0 max-w-40 truncate text-left [direction:rtl]">
        <span dir="ltr">{modelLabel}</span>
      </span>
    );
  }
  if (thinkingLabel) {
    configFaceParts.push(
      <span key="thinking" className="shrink-0">
        {thinkingLabel}
      </span>
    );
  }
  if (planOn) {
    configFaceParts.push(
      <ListChecks key="plan" className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
    );
  }
  if (fastOn) {
    configFaceParts.push(
      <Zap key="fast" className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
    );
  }
  /* Permission joins the face ONLY behind a Role, and only one the Role pins:
     otherwise the standalone permission button is showing the same value a step
     to the right, and saying it twice is worse than saying it once. */
  const permissionFace = resolvePermissionModeFace({
    modeOptions,
    selectedModeId,
    configOptionSelectors,
    configOptionValues,
  });
  if (
    selectedRole &&
    permissionFace.label &&
    doesAgentRolePinPermissionMode(selectedRole, permissionFace.source)
  ) {
    // A warning-tone permission (full access / skip permissions) keeps its
    // amber shield here. The rest of the face is deliberately quiet because a
    // Role already decided it — but "this Role runs with full access" is not a
    // detail, and it is the one value that no longer has a button carrying it.
    const warning = classifyPermissionModeFace(permissionFace.value);
    configFaceParts.push(
      warning.kind !== 'hidden' && warning.tone === 'warning' ? (
        <span key="permission" className="flex shrink-0 items-center gap-1 text-status-warning">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {permissionFace.label}
        </span>
      ) : (
        <span key="permission" className="shrink-0">
          {permissionFace.label}
        </span>
      )
    );
  }
  const withFaceDots = (parts: ReactNode[], leadingDot: boolean): ReactNode[] =>
    parts.flatMap((part, index) =>
      index === 0 && !leadingDot ? [part] : [<FaceDot key={`dot-${index}`} />, part]
    );

  const agentLabel = t('chat.agentSelector.placeholder', 'Agent');
  const modelRowLabel = t('chat.runConfig.modelLabel', 'Model');
  const modelSearchPlaceholder = t('chat.runConfig.modelSearchPlaceholder', 'Search models');
  const modelSearchEmptyLabel = t('chat.runConfig.modelSearchEmpty', 'No models match');
  const reasoningLabel = t('chat.runConfig.reasoningLabel', 'Reasoning');
  const planRowLabel = t('chat.mobileNewChat.planModeLabel', 'Plan');
  const fastRowLabel = t('chat.runConfig.fastLabel', 'Fast');

  const roleLabel = t('chat.runConfig.roles.label', 'Role');
  const hasAnyRow =
    agentRoles != null ||
    agentOptions.length > 0 ||
    selectedAgentConfig != null ||
    modelPickerOptions.length > 0 ||
    extraSelectSelectors.length > 0 ||
    interactionSelector != null ||
    thinkingSelector != null ||
    planSelector != null ||
    fastSelector != null;
  if (!hasAnyRow) return null;

  const runConfigButtonAriaLabel = t('chat.runConfig.buttonAriaLabel', 'Run configuration');
  const triggerButton = (
    <button
      type="button"
      className={cn(
        TRIGGER_CLASS,
        disabledReason &&
          'cursor-default opacity-70 hover:bg-transparent hover:text-muted-foreground'
      )}
      aria-label={runConfigButtonAriaLabel}
      aria-disabled={disabledReason ? true : undefined}
    >
      {selectedRole ? (
        <span className="shrink-0 text-sm leading-none" aria-hidden="true">
          {getAgentRoleEmoji(selectedRole)}
        </span>
      ) : selectedAgentConfig ? (
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
      {/* A Role names itself and nothing else: it IS the whole run
          configuration, so its values belong beside the button rather than
          crowding the one thing there is to click. */}
      {selectedRole ? (
        <span className="block min-w-0 max-w-44 truncate text-left">{selectedRole.name}</span>
      ) : (
        <>
          {showAgentNameInTrigger ? (
            <span className="block min-w-0 max-w-36 truncate text-left">
              {selectedAgentConfig?.name ?? emptyAgentLabel ?? agentLabel}
            </span>
          ) : null}
          {withFaceDots(configFaceParts, showAgentNameInTrigger)}
        </>
      )}
    </button>
  );

  const menu = (
    <DropdownMenu>
      {disabledReason ? (
        <Tooltip delayDuration={300}>
          {/* A native disabled button cannot reliably trigger hover/focus events.
              Keep this focusable but outside DropdownMenuTrigger so it stays inert. */}
          <TooltipTrigger asChild>{triggerButton}</TooltipTrigger>
          <TooltipContent side="top">{disabledReason}</TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="start" className="min-w-56">
        {onRecentRunConfigSelect ? (
          <RecentRunConfigMenuGroup
            items={recentRunConfigs ?? []}
            onSelect={onRecentRunConfigSelect}
          />
        ) : null}
        {/* Above Agent, because a Role ANSWERS every row under it at once. With
            no Role to pick yet the row's value is the way to make one, seeded
            with whatever those rows are set to right now. */}
        {agentRoles ? (
          agentRoles.items.length === 0 ? (
            <DropdownMenuItem
              disabled={!agentRoles.onCreate}
              onSelect={() => agentRoles.onCreate?.()}
            >
              <span className="min-w-0 flex-1 truncate">{roleLabel}</span>
              <span className="ml-4 inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('chat.runConfig.roles.create', 'New role')}
              </span>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuSub>
              <ValueSubTrigger
                label={roleLabel}
                value={selectedRole?.name ?? t('chat.runConfig.roles.none', 'None')}
                icon={
                  selectedRole ? (
                    <span className="text-sm leading-none" aria-hidden="true">
                      {getAgentRoleEmoji(selectedRole)}
                    </span>
                  ) : null
                }
              />
              <DropdownMenuSubContent className="p-0">
                <ComposerAgentRolePanel
                  items={agentRoles.items}
                  machine={agentRoles.machine}
                  selectedRoleId={agentRoles.selectedRoleId}
                  onSelect={agentRoles.onSelect}
                  onCreate={agentRoles.onCreate}
                  onEdit={agentRoles.onEdit}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        ) : null}
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
                        className="h-4 w-4 shrink-0"
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

        {extraSelectSelectors.map((selector) => {
          const selectedValue =
            (resolveConfigOptionValue(
              selector,
              configOptionValues?.[selector.configId]
            ) as string) ?? null;
          const selectedLabel =
            selector.options.find((option) => option.value === selectedValue)?.label ??
            selectedValue;
          const locked = selector.configId === 'agent_preset' && agentLocked;
          return (
            <DropdownMenuSub key={selector.configId}>
              <ValueSubTrigger label={selector.label} value={selectedLabel} disabled={locked} />
              <DropdownMenuSubContent>
                {selector.options.map((option) => (
                  <OptionItem
                    key={option.value}
                    label={option.label}
                    description={option.description}
                    selected={option.value === selectedValue}
                    disabled={option.disabled || locked}
                    onSelect={() =>
                      onConfigOptionChange?.(
                        selector.configId,
                        option.value as AcpConfigOptionValue
                      )
                    }
                  />
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}

        {modelPickerOptions.length > 0 ? (
          <DropdownMenuSub>
            <ValueSubTrigger label={modelRowLabel} value={modelLabel} />
            <DropdownMenuSubContent
              // `p-0` + column layout so the search row stays put while only the
              // options scroll; the padding it drops moves onto the list itself.
              className="flex max-w-80 flex-col overflow-y-hidden p-0"
              // Cap the list so a long model list scrolls inside a compact menu
              // instead of running the full viewport height. Inline (not a max-h-*
              // class) so it reliably wins over the base content's max-h, and clamps
              // to the available height so it never overflows off-screen.
              style={{
                maxHeight: 'min(20rem, var(--radix-dropdown-menu-content-available-height, 20rem))',
              }}
            >
              {/* A provider can publish dozens of models; past
                  `OPTION_SEARCH_MIN_OPTIONS` this list gains a fuzzy search row. */}
              <MenuOptionSearchList
                options={modelPickerOptions}
                onSelect={(opt) => handleModelSelect(opt.value)}
                searchPlaceholder={modelSearchPlaceholder}
                emptyText={modelSearchEmptyLabel}
                renderOption={(opt, select) => (
                  <OptionItem
                    key={opt.value}
                    label={opt.label}
                    description={opt.description}
                    selected={opt.value === modelValue}
                    disabled={opt.disabled}
                    onSelect={select}
                  />
                )}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}

        {showDeepSeekDelegationWarning ? (
          <DropdownMenuItem
            asChild
            className="mx-1 my-1 max-w-72 items-start gap-2 whitespace-normal border border-status-warning/30 bg-status-warning/[0.08] px-2.5 py-2 focus:bg-status-warning/[0.14]"
          >
            <a
              href={DEEPSEEK_DELEGATION_DISCUSSION_URL}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault();
                void openExternalUrl(DEEPSEEK_DELEGATION_DISCUSSION_URL);
              }}
            >
              <DeepSeekDelegationWarningContent />
            </a>
          </DropdownMenuItem>
        ) : null}

        {interactionSelector ? (
          <DropdownMenuSub>
            <ValueSubTrigger label={interactionSelector.label} value={interactionLabel} />
            <DropdownMenuSubContent>
              {interactionSelector.options.map((opt) => (
                <OptionItem
                  key={opt.value}
                  label={opt.label}
                  description={opt.description}
                  selected={opt.value === interactionValue}
                  disabled={opt.disabled}
                  onSelect={() =>
                    onConfigOptionChange?.(
                      interactionSelector.configId,
                      opt.value as AcpConfigOptionValue
                    )
                  }
                />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}

        {thinkingSelector?.availability ? (
          <AcpControlAvailability
            selector={thinkingSelector}
            value={configOptionValues?.[thinkingSelector.configId]}
          />
        ) : thinkingSelector ? (
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
        {fastSelector?.availability ? (
          <AcpControlAvailability
            selector={fastSelector}
            value={configOptionValues?.[fastSelector.configId]}
          />
        ) : fastSelector ? (
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

  /* The values a Role pins, stated but INERT: only the Role itself is a control,
     because changing one of these by hand is what stops the configuration being
     that Role — and a knob that silently unnames the thing beside it is a trap.
     The Detailed tab is where they are changed. */
  const roleConfigFace =
    selectedRole && configFaceParts.length > 0 ? (
      <span className="pointer-events-none flex min-w-0 select-none items-center gap-1 text-[11px] leading-tight text-muted-foreground/60">
        {withFaceDots(configFaceParts, false)}
      </span>
    ) : null;

  return roleConfigFace ? (
    <>
      {menu}
      {roleConfigFace}
    </>
  ) : (
    menu
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
  const { options, value, label, source } = useMemo(
    () =>
      resolvePermissionModeFace({
        modeOptions,
        selectedModeId,
        configOptionSelectors,
        configOptionValues,
      }),
    [configOptionSelectors, configOptionValues, modeOptions, selectedModeId]
  );
  const permissionLabel = t('chat.runConfig.permissionLabel', 'Permission');

  if (options.length === 0) return null;

  const handleSelect = (next: string) => {
    if (source?.kind === 'configOption') {
      onConfigOptionChange?.(source.configId, next as AcpConfigOptionValue);
    } else if (source?.kind === 'modeId') {
      onModeChange?.(next);
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

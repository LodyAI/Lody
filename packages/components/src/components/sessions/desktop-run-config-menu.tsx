import { useMemo, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
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
import { composerSurface as surface } from '@/components/shared/composer-surface';
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
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Switch } from '@lody/ui/switch';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { Tooltip } from '@lody/ui/tooltip';
import { Menu } from '@/ui/menu';

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

const styles = stylex.create({
  /** A row's current value, after its name: the secondary label, truncating. */
  rowValue: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '10rem',
    marginInlineStart: 'auto',
    paddingInlineStart: space[4],
    color: colors.secondaryLabel,
    fontWeight: 400,
  },
  agentValue: { maxWidth: '9rem' },
  machineName: { maxWidth: '8rem' },
  roleName: { maxWidth: '11rem' },
  agentName: { maxWidth: '9rem' },
  permissionName: { maxWidth: '9rem' },
  /** The model keeps its tail when it truncates: `provider/model` loses the prefix. */
  modelName: { maxWidth: '10rem', direction: 'rtl' },
  /** The "create a Role" mark at the end of the empty Role row. */
  createMark: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '20px',
    height: '20px',
    color: colors.tertiaryLabel,
  },
  /** A note in a menu: it wraps, so it is not a row's one line. */
  note: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    maxWidth: '18rem',
    paddingBlock: space[1.5],
    whiteSpace: 'normal',
    fontWeight: 400,
  },
});

/* Option-only submenus hug the longest label instead of inheriting the
   200px surface floor. 108px is the floor so a short name is not a sliver;
   `max-w-80` still caps a long provider list. */
const COMPACT_OPTION_SUBMENU_CLASS = 'w-max min-w-[108px] max-w-80';

/* Option row with a trailing check. Title only — no description — so submenus
   stay as compact as the parent. Selecting keeps the menu OPEN. */
function OptionItem({
  icon,
  label,
  selected,
  disabled,
  onSelect,
}: {
  icon?: ReactNode;
  label: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <Menu.Item
      disabled={disabled}
      role="menuitemradio"
      aria-checked={selected}
      closeOnClick={false}
      onClick={onSelect}
      icon={icon}
      endContent={selected ? <Check {...stylex.props(surface.glyph14)} aria-hidden="true" /> : null}
    >
      {label}
    </Menu.Item>
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
    <Menu.SubmenuTrigger disabled={disabled}>
      {label}
      <span {...stylex.props(styles.rowValue)}>
        {icon}
        <span {...stylex.props(surface.truncate)}>{value}</span>
      </span>
    </Menu.SubmenuTrigger>
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
    <Menu.Item
      role="menuitemcheckbox"
      aria-checked={checked}
      closeOnClick={false}
      onClick={onToggle}
      icon={icon}
      endContent={
        <Switch
          checked={checked}
          aria-hidden="true"
          tabIndex={-1}
          className="pointer-events-none shrink-0"
        />
      }
    >
      {label}
    </Menu.Item>
  );
}

/* Shared trigger chrome for both footer buttons: the composer's ghost trigger.
   Its compact (label-hidden) face is a 28px square so plus / model / mode share
   the same hit box and gap. */
const triggerClassName = (state: { open: boolean }) =>
  stylex.props(surface.trigger, surface.triggerCompact, state.open && surface.triggerOpen)
    .className ?? '';

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
    <Menu.Root>
      <Menu.Trigger
        disabled={isDisabled}
        title={disabledReason}
        aria-label={t('chat.machineSelector.placeholder', 'Machine')}
        render={<Button type="button" variant="secondary" size="mini" />}
      >
        <Monitor {...stylex.props(surface.glyph14)} aria-hidden="true" />
        <span {...stylex.props(surface.truncate, styles.machineName)}>{label}</span>
        {selectedIsLocal ? <Badge>{t('chat.machineSelector.local', 'Local')}</Badge> : null}
        {selectedOption?.isPrivate ? (
          <LockKeyhole {...stylex.props(surface.glyph12, surface.hint)} aria-hidden="true" />
        ) : null}
      </Menu.Trigger>
      <Menu.Content
        side="top"
        align="start"
        collisionAvoidance={{ side: 'none', align: 'none', fallbackAxisSide: 'none' }}
        className="min-w-52 max-w-72"
      >
        <Menu.GroupLabel>{t('chat.machineSelector.placeholder', 'Machine')}</Menu.GroupLabel>
        {options.map((option) => (
          <Menu.Item
            key={option.value}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            icon={<Monitor {...stylex.props(surface.glyph16)} aria-hidden="true" />}
            endContent={
              option.value === value ? (
                <Check {...stylex.props(surface.glyph14)} aria-hidden="true" />
              ) : null
            }
          >
            {option.label}
            {option.value === visibleLocalMachineId ? (
              <Badge>{t('chat.machineSelector.local', 'Local')}</Badge>
            ) : null}
            {option.isPrivate ? (
              <Tooltip.Root>
                <Tooltip.Trigger
                  delay={250}
                  render={
                    <Badge icon={<LockKeyhole size="100%" aria-hidden="true" />}>
                      {t('sharing.private', 'Private')}
                    </Badge>
                  }
                />
                <Tooltip.Content side="right" className="max-w-64">
                  {t(
                    'sharing.machinePrivateHelp',
                    'Only you can use this machine. Share it from machine settings so teammates can see its shared projects and conversations.'
                  )}
                </Tooltip.Content>
              </Tooltip.Root>
            ) : null}
          </Menu.Item>
        ))}
        {onAddMachine ? (
          <>
            {options.length > 0 ? <Menu.Separator /> : null}
            <Menu.Item
              onClick={onAddMachine}
              icon={<Plus {...stylex.props(surface.glyph16)} aria-hidden="true" />}
            >
              {t('machinePairing.addMachine', 'Add machine')}
            </Menu.Item>
          </>
        ) : null}
      </Menu.Content>
    </Menu.Root>
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
      <span key="model" {...stylex.props(surface.faceText, styles.modelName)}>
        <span dir="ltr">{modelLabel}</span>
      </span>
    );
  }
  if (thinkingLabel) {
    configFaceParts.push(
      <span key="thinking" {...stylex.props(surface.faceFixed)}>
        {thinkingLabel}
      </span>
    );
  }
  if (planOn) {
    configFaceParts.push(
      <ListChecks key="plan" {...stylex.props(surface.faceLive)} aria-hidden="true" />
    );
  }
  if (fastOn) {
    configFaceParts.push(<Zap key="fast" {...stylex.props(surface.faceLive)} aria-hidden="true" />);
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
        <span key="permission" {...stylex.props(surface.faceGroup, surface.faceWarning)}>
          <ShieldAlert {...stylex.props(surface.glyph14)} aria-hidden="true" />
          {permissionFace.label}
        </span>
      ) : (
        <span key="permission" {...stylex.props(surface.faceFixed)}>
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
  /* The face, shared by the menu trigger and the inert (tooltip-only) button. */
  const triggerFace = (
    <>
      {selectedRole ? (
        <span {...stylex.props(surface.emoji)} aria-hidden="true">
          {getAgentRoleEmoji(selectedRole)}
        </span>
      ) : selectedAgentConfig ? (
        <AgentIcon
          cliType={selectedAgentConfig.cliType}
          agentType={selectedAgentConfig.agentType}
          brandId={selectedAgentConfig.brandId}
          env={selectedAgentConfig.env}
          className={stylex.props(surface.glyph16).className}
        />
      ) : fallbackAgent?.cliType && fallbackAgent.agentType ? (
        <AgentIcon
          cliType={fallbackAgent.cliType}
          agentType={fallbackAgent.agentType}
          className={stylex.props(surface.glyph16).className}
        />
      ) : (
        <Bot {...stylex.props(surface.glyph16)} strokeWidth={1.5} aria-hidden="true" />
      )}
      {/* A Role names itself and nothing else: it IS the whole run
          configuration, so its values belong beside the button rather than
          crowding the one thing there is to click. */}
      {selectedRole ? (
        <span {...stylex.props(surface.faceText, styles.roleName)}>{selectedRole.name}</span>
      ) : (
        <>
          {showAgentNameInTrigger ? (
            <span {...stylex.props(surface.faceText, styles.agentName)}>
              {selectedAgentConfig?.name ?? emptyAgentLabel ?? agentLabel}
            </span>
          ) : null}
          {withFaceDots(configFaceParts, showAgentNameInTrigger)}
        </>
      )}
    </>
  );

  const menu = (
    <Menu.Root>
      {disabledReason ? (
        <Tooltip.Root>
          {/* A native disabled button cannot reliably trigger hover/focus events.
              Keep this focusable but outside DropdownMenuTrigger so it stays inert. */}
          <Tooltip.Trigger
            delay={300}
            render={
              <button
                type="button"
                aria-label={runConfigButtonAriaLabel}
                aria-disabled
                {...stylex.props(surface.trigger, surface.triggerCompact, surface.triggerInert)}
              >
                {triggerFace}
              </button>
            }
          />
          <Tooltip.Content side="top">{disabledReason}</Tooltip.Content>
        </Tooltip.Root>
      ) : (
        <Menu.Trigger
          aria-label={runConfigButtonAriaLabel}
          className={triggerClassName}
          render={<button type="button" />}
        >
          {triggerFace}
        </Menu.Trigger>
      )}
      <Menu.Content align="start" className="min-w-48">
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
            <Menu.Item
              disabled={!agentRoles.onCreate}
              onClick={() => agentRoles.onCreate?.()}
              endContent={
                <Tooltip.Root>
                  <Tooltip.Trigger
                    delay={300}
                    render={
                      <span
                        {...stylex.props(styles.createMark)}
                        aria-label={t(
                          'chat.runConfig.roles.createFromSettings',
                          'Create role from current settings'
                        )}
                      >
                        <Plus {...stylex.props(surface.glyph14)} aria-hidden="true" />
                      </span>
                    }
                  />
                  <Tooltip.Content side="right">
                    {t(
                      'chat.runConfig.roles.createFromSettings',
                      'Create role from current settings'
                    )}
                  </Tooltip.Content>
                </Tooltip.Root>
              }
            >
              {roleLabel}
            </Menu.Item>
          ) : (
            <Menu.Submenu>
              <ValueSubTrigger
                label={roleLabel}
                value={selectedRole?.name ?? t('chat.runConfig.roles.none', 'None')}
                icon={
                  selectedRole ? (
                    <span {...stylex.props(surface.emoji)} aria-hidden="true">
                      {getAgentRoleEmoji(selectedRole)}
                    </span>
                  ) : null
                }
              />
              <Menu.Content className="max-w-[min(29.5rem,var(--radix-popper-available-width,29.5rem))] overflow-x-hidden">
                <ComposerAgentRolePanel
                  items={agentRoles.items}
                  machine={agentRoles.machine}
                  selectedRoleId={agentRoles.selectedRoleId}
                  onSelect={agentRoles.onSelect}
                  onCreate={agentRoles.onCreate}
                  onEdit={agentRoles.onEdit}
                />
              </Menu.Content>
            </Menu.Submenu>
          )
        ) : null}
        {agentOptions.length > 0 || selectedAgentConfig ? (
          isAgentLocked ? (
            <Menu.Item disabled>
              {agentLabel}
              <span {...stylex.props(styles.rowValue, styles.agentValue)}>
                {selectedAgentConfig ? (
                  <AgentIcon
                    cliType={selectedAgentConfig.cliType}
                    agentType={selectedAgentConfig.agentType}
                    brandId={selectedAgentConfig.brandId}
                    env={selectedAgentConfig.env}
                    className={stylex.props(surface.glyph12).className}
                  />
                ) : null}
                <span {...stylex.props(surface.truncate)}>{selectedAgentConfig?.name}</span>
              </span>
            </Menu.Item>
          ) : (
            <Menu.Submenu>
              <ValueSubTrigger label={agentLabel} value={selectedAgentConfig?.name ?? null} />
              <Menu.Content className={COMPACT_OPTION_SUBMENU_CLASS}>
                {agentOptions.map(({ config }) => (
                  <OptionItem
                    key={`${config.id}:${config.machineId}`}
                    icon={
                      <AgentIcon
                        cliType={config.cliType}
                        agentType={config.agentType}
                        brandId={config.brandId}
                        env={config.env}
                        className={stylex.props(surface.glyph16).className}
                      />
                    }
                    label={config.name}
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
              </Menu.Content>
            </Menu.Submenu>
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
            <Menu.Submenu key={selector.configId}>
              <ValueSubTrigger label={selector.label} value={selectedLabel} disabled={locked} />
              <Menu.Content className={COMPACT_OPTION_SUBMENU_CLASS}>
                {selector.options.map((option) => (
                  <OptionItem
                    key={option.value}
                    label={option.label}
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
              </Menu.Content>
            </Menu.Submenu>
          );
        })}

        {modelPickerOptions.length > 0 ? (
          <Menu.Submenu>
            <ValueSubTrigger label={modelRowLabel} value={modelLabel} />
            <Menu.Content
              // The popup is already a column: holding its own overflow keeps the
              // search row put while only the options under it scroll.
              className={cn(COMPACT_OPTION_SUBMENU_CLASS, 'overflow-y-hidden')}
              // Cap the list so a long model list scrolls inside a compact menu
              // instead of running the full viewport height. Inline (not a max-h-*
              // class) so it reliably wins over the base content's max-h, and clamps
              // to the available height so it never overflows off-screen.
              style={{
                maxHeight: 'min(20rem, var(--available-height, 20rem))',
              }}
            >
              {/* A provider can publish dozens of models; past
                  `OPTION_SEARCH_MIN_OPTIONS` this list gains a fuzzy search row. */}
              <MenuOptionSearchList
                options={modelPickerOptions}
                onSelect={(opt) => handleModelSelect(opt.value)}
                searchAnalyticsPicker="model"
                searchPlaceholder={modelSearchPlaceholder}
                emptyText={modelSearchEmptyLabel}
                renderOption={(opt, select) => (
                  <OptionItem
                    key={opt.value}
                    label={opt.label}
                    selected={opt.value === modelValue}
                    disabled={opt.disabled}
                    onSelect={select}
                  />
                )}
              />
            </Menu.Content>
          </Menu.Submenu>
        ) : null}

        {showDeepSeekDelegationWarning ? (
          <Menu.Item
            render={
              <a
                href={DEEPSEEK_DELEGATION_DISCUSSION_URL}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  void openExternalUrl(DEEPSEEK_DELEGATION_DISCUSSION_URL);
                }}
              >
                <span {...stylex.props(styles.note)}>
                  <DeepSeekDelegationWarningContent />
                </span>
              </a>
            }
          />
        ) : null}

        {interactionSelector ? (
          <Menu.Submenu>
            <ValueSubTrigger label={interactionSelector.label} value={interactionLabel} />
            <Menu.Content className={COMPACT_OPTION_SUBMENU_CLASS}>
              {interactionSelector.options.map((opt) => (
                <OptionItem
                  key={opt.value}
                  label={opt.label}
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
            </Menu.Content>
          </Menu.Submenu>
        ) : null}

        {thinkingSelector ? (
          <Menu.Submenu>
            <ValueSubTrigger label={reasoningLabel} value={thinkingLabel} />
            <Menu.Content className={COMPACT_OPTION_SUBMENU_CLASS}>
              {thinkingSelector.options.map((opt) => (
                <OptionItem
                  key={opt.value}
                  label={opt.label}
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
            </Menu.Content>
          </Menu.Submenu>
        ) : null}

        {planSelector || fastSelector ? <Menu.Separator /> : null}
        {planSelector ? (
          <ToggleItem
            icon={
              <ListChecks {...stylex.props(surface.glyph16)} strokeWidth={1.8} aria-hidden="true" />
            }
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
            icon={<Zap {...stylex.props(surface.glyph16)} strokeWidth={1.8} aria-hidden="true" />}
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
      </Menu.Content>
    </Menu.Root>
  );

  /* The values a Role pins, stated but INERT: only the Role itself is a control,
     because changing one of these by hand is what stops the configuration being
     that Role — and a knob that silently unnames the thing beside it is a trap.
     The Detailed tab is where they are changed. */
  const roleConfigFace =
    selectedRole && configFaceParts.length > 0 ? (
      <span {...stylex.props(surface.faceInert)}>{withFaceDots(configFaceParts, false)}</span>
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
    <span aria-hidden="true" {...stylex.props(surface.faceDot)}>
      ·
    </span>
  );
}

/* ── Permission mode (standalone button) ─────────────────────────────── */

function PermissionModeItem({
  option,
  selected,
  onSelect,
}: {
  option: AcpSessionSelectOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const item = (
    <Menu.Item
      disabled={option.disabled}
      onClick={onSelect}
      icon={permissionModeIcon(option.value)}
      endContent={selected ? <Check {...stylex.props(surface.glyph14)} aria-hidden="true" /> : null}
    >
      {option.label}
    </Menu.Item>
  );
  if (!option.description) return item;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger delay={300} render={item} />
      <Tooltip.Content side="right" align="start" className="max-w-72 whitespace-pre-wrap">
        {option.description}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

/* Warning-tone modes (full access / skip permissions) share the amber shield
   with the mobile face; everything else keeps its neutral per-mode icon. */
function permissionModeIcon(modeId: string | null): ReactNode {
  const face = classifyPermissionModeFace(modeId);
  if (face.kind !== 'hidden' && face.tone === 'warning') {
    return (
      <ShieldAlert
        {...stylex.props(surface.glyph14, surface.faceWarning)}
        strokeWidth={1.5}
        aria-hidden="true"
      />
    );
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
    <Menu.Root>
      <Menu.Trigger
        aria-label={permissionLabel}
        className={triggerClassName}
        render={<button type="button" />}
      >
        <span {...stylex.props(surface.glyph)}>{permissionModeIcon(value ?? null)}</span>
        <span {...stylex.props(surface.faceText, styles.permissionName)}>
          {label ?? permissionLabel}
        </span>
      </Menu.Trigger>
      <Menu.Content align="start" className="w-max min-w-44 max-w-64">
        <Menu.GroupLabel>{permissionLabel}</Menu.GroupLabel>
        {options.map((opt) => (
          <PermissionModeItem
            key={opt.value}
            option={opt}
            selected={opt.value === value}
            onSelect={() => handleSelect(opt.value)}
          />
        ))}
      </Menu.Content>
    </Menu.Root>
  );
}

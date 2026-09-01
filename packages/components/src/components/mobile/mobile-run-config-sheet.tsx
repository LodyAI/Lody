import { useMemo, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { ListChecks, Plus, ShieldAlert, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getAllAgentConfigAtom } from '@/atoms';
import { AgentIcon } from '@/components/icons/agent-icon';
import { getModeIcon as getPermissionModeIcon } from '@/components/chat/chat-landing-selectors';
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
import {
  DEEPSEEK_DELEGATION_DISCUSSION_URL,
  DeepSeekDelegationWarningContent,
  shouldShowDeepSeekDelegationWarning,
} from '@/components/shared/deepseek-delegation-warning';
import { orderAcpConfigOptionSelectors } from '@/lib/acp-selector-order';
import {
  AGENT_ROLE_UNAVAILABLE_REASON_KEYS,
  type ComposerAgentRoleItem,
} from '@/lib/composer-agent-roles';
import { shouldOfferOptionSearch } from '@/lib/fuzzy-option-filter';
import { openExternalUrl } from '@/lib/native-browser';
import { useKeyboardAwareSheet } from '@/hooks/use-keyboard-aware-scroll-into-view';
import { cn } from '@/lib/utils';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { Switch } from '@/ui/switch';
import {
  classifyPermissionModeFace,
  getAgentRoleEmoji,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';
import {
  MobileInlinePicker,
  MobileInlinePickerCoordinator,
  MobileInlinePickerRowSlot,
  type MobileInlinePickerOption,
} from './mobile-inline-picker';

/**
 * Expanded "run config" bottom sheet for the mobile composer. Opened by
 * `MobileRunConfigButton`, it consolidates the run knobs that used to be
 * split across the composer footer + below rows into one vertical form:
 *
 *   Agent · Model · Interaction · Reasoning · Permission · Plan · Fast
 *
 * Shared by the in-session composer and the mobile new-chat sheet so both
 * surfaces pick models the same way. Rows derive options from the same
 * `orderAcpConfigOptionSelectors` buckets + mode/model fallbacks the button
 * face uses, so values stay in lock-step with the collapsed control.
 *
 * - Agent: read-only when `agentLocked` (mid-session); a picker while empty
 *   or on new-chat. Options are scoped by `allowedMachineIds` when set.
 * - Model / Interaction / Reasoning / Permission: inline pickers (full names
 *   live here — the button face only shows an icon / short label).
 * - Plan / Fast: labelled switch rows.
 */
export type MobileRunConfigSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentSelection: AgentSelection | null;
  /**
   * Restrict agent options to these machines. Empty array → no agents.
   * Omit to list every cached agent config (rare).
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
  /**
   * Agent Roles for the machine this chat starts on, as the row above Agent.
   *
   * Omit to leave the row out: a surface where the agent cannot change has
   * nothing a Role could apply. Mobile deliberately has no detail pane and no
   * create action — this is the picker, and a Role's full binding is read on
   * desktop or in Settings.
   */
  agentRoles?: {
    items: ReadonlyArray<ComposerAgentRoleItem>;
    /** The Role the current configuration still IS, not merely the last picked. */
    selectedRoleId: AgentRoleId | null;
    /** `null` clears the Role and leaves the configuration exactly as it stands. */
    onSelect: (roleId: AgentRoleId | null) => void;
    /** Opens the Role editor seeded with what the composer is set to right now. */
    onCreate?: () => void;
  };
};

export function MobileRunConfigSheet({
  open,
  onOpenChange,
  ...contentProps
}: MobileRunConfigSheetProps) {
  const { t } = useTranslation();
  const title = t('chat.runConfig.title', 'Run configuration');

  /* This sheet's rows OPEN pickers with search fields (Model above all, which a
     provider can fill with dozens of entries). Tapping one puts the caret at the
     bottom of the screen, exactly where the soft keyboard lands. */
  const keyboard = useKeyboardAwareSheet();

  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <DrawerContent
        className={cn(
          'h-auto! max-h-[85dvh]! rounded-t-2xl border-border/60',
          keyboard.contentClassName
        )}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DrawerTitle className="sr-only">{title}</DrawerTitle>
        <DrawerDescription className="sr-only">{title}</DrawerDescription>
        <header className="px-4 pb-1 pt-2">
          <h2 className="select-none text-center text-[0.95rem] font-semibold tracking-tight">
            {title}
          </h2>
        </header>
        <div
          ref={keyboard.scrollRef}
          className="min-h-0 flex-1 overflow-y-auto px-4 pt-2"
          style={keyboard.scrollStyle}
        >
          <MobileInlinePickerCoordinator>
            <MobileRunConfigSheetRows {...contentProps} />
          </MobileInlinePickerCoordinator>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/* Icon for a permission mode inside the sheet. Warning-tone modes (Full
   access) get the amber `ShieldAlert` used by the button face
   (`PermissionModeFaceIndicator`), so the collapsed button and the expanded
   picker agree; every other mode keeps its neutral per-mode icon. */
function permissionModeIcon(modeId: string | null): ReactNode {
  const face = classifyPermissionModeFace(modeId);
  if (face.kind !== 'hidden' && face.tone === 'warning') {
    return <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-status-warning" />;
  }
  return getPermissionModeIcon(modeId);
}

/* The picker carries strings, so "no Role" needs a value of its own. Not the
   empty string: an option with a falsy value is indistinguishable from "nothing
   selected" in the picker's own comparisons. `__create__` is the same trick for
   the one row that is an ACTION rather than a value — the desktop submenu ends
   with the same entry. */
const ROLE_NONE_VALUE = '__none__';
const ROLE_CREATE_VALUE = '__create__';

type MobileRunConfigSheetRowsProps = Omit<MobileRunConfigSheetProps, 'open' | 'onOpenChange'>;

function MobileRunConfigSheetRows({
  agentSelection,
  allowedMachineIds,
  agentLocked = false,
  onAgentConfigChange,
  modelOptions,
  selectedModelId,
  onModelChange,
  modeOptions,
  selectedModeId,
  onModeChange,
  configOptionSelectors = [],
  configOptionValues,
  onConfigOptionChange,
  agentRoles,
}: MobileRunConfigSheetRowsProps) {
  const { t } = useTranslation();
  const executorConfigs = useAtomValue(getAllAgentConfigAtom);

  const {
    modelSelectors,
    interactionModeSelectors,
    permissionModeSelectors,
    modeSelectors,
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

  /* ── Role (the row above Agent, because a Role ANSWERS every row under it) ──
     `None` leads the list: leaving a Role clears the NAME, not the
     configuration, and that is not the same gesture as picking one. An
     non-available Role stays listed and disabled, carrying its reason/status,
     so a Role that cannot run is visibly broken rather than missing. */
  const roleNoneLabel = t('chat.runConfig.roles.none', 'None');
  const roleOptions = useMemo<MobileInlinePickerOption<string>[]>(() => {
    if (!agentRoles) return [];
    return [
      {
        value: ROLE_NONE_VALUE,
        label: roleNoneLabel,
        searchText: roleNoneLabel,
        // An EMPTY glyph, not a missing one: the picker only renders its
        // fixed-size icon box when an option has an icon, so without this the
        // one row with no emoji would start its label further left than every
        // Role under it.
        icon: <span aria-hidden="true" />,
      },
      ...agentRoles.items.map(({ role, availability }) => {
        // Listed either way, so the reason is what makes a disabled row
        // readable rather than broken-looking.
        const reason =
          availability.kind === 'unavailable'
            ? t(AGENT_ROLE_UNAVAILABLE_REASON_KEYS[availability.reason])
            : availability.kind === 'unknown'
              ? t('settings.agentRoles.status.checking')
              : null;
        return {
          value: role.id as string,
          label: role.name,
          searchText: role.name,
          icon: (
            <span className="text-base leading-none" aria-hidden="true">
              {getAgentRoleEmoji(role)}
            </span>
          ),
          disabled: reason !== null,
          ...(reason ? { description: reason, disabledReason: reason } : {}),
        };
      }),
      ...(agentRoles.onCreate
        ? [
            {
              value: ROLE_CREATE_VALUE,
              label: t('chat.runConfig.roles.create', 'New role'),
              searchText: t('chat.runConfig.roles.create', 'New role'),
              icon: <Plus className="h-3.5 w-3.5" aria-hidden="true" />,
            },
          ]
        : []),
    ];
  }, [agentRoles, roleNoneLabel, t]);
  const selectedRole = agentRoles?.selectedRoleId
    ? agentRoles.items.find((item) => item.role.id === agentRoles.selectedRoleId)?.role
    : undefined;

  /* ── Agent (options scoped by allowedMachineIds when provided) ── */
  const agentOptions = useMemo<MobileInlinePickerOption<string>[]>(() => {
    const scoped =
      allowedMachineIds === undefined
        ? executorConfigs
        : executorConfigs.filter((cfg) => allowedMachineIds.includes(cfg.machineId as MachineId));
    return scoped.map((cfg) => ({
      value: `${cfg.id}:${cfg.machineId}`,
      label: cfg.name,
      searchText: cfg.name,
      icon: (
        <AgentIcon
          cliType={cfg.cliType}
          agentType={cfg.agentType}
          brandId={cfg.brandId}
          env={cfg.env}
          className="h-4 w-4"
        />
      ),
    }));
  }, [allowedMachineIds, executorConfigs]);
  const selectedAgentKey =
    agentSelection?.agentId && agentSelection.machineId
      ? `${agentSelection.agentId}:${agentSelection.machineId}`
      : null;
  const selectedAgentConfig = useMemo(
    () =>
      agentSelection
        ? executorConfigs.find(
            (cfg) => cfg.id === agentSelection.agentId && cfg.machineId === agentSelection.machineId
          )
        : null,
    [agentSelection, executorConfigs]
  );
  const agentRowLocked = agentLocked || onAgentConfigChange == null;
  const showAgent = agentOptions.length > 0 || selectedAgentConfig != null;

  /* ── Model (free-text modelOptions first, else the model selector) ── */
  const modelConfigSelector: AcpSelectConfigOptionSelector | undefined = modelSelectors[0];
  const modelPickerOptions = useMemo<MobileInlinePickerOption<string>[]>(() => {
    const source = modelOptions.length > 0 ? modelOptions : (modelConfigSelector?.options ?? []);
    return source.map((opt) => ({
      value: opt.value,
      label: opt.label,
      searchText: opt.label,
      description: opt.description,
      disabled: opt.disabled,
    }));
  }, [modelConfigSelector, modelOptions]);
  const modelValue: string | null =
    modelOptions.length > 0
      ? selectedModelId
      : modelConfigSelector
        ? ((resolveConfigOptionValue(
            modelConfigSelector,
            configOptionValues?.[modelConfigSelector.configId]
          ) as string) ?? null)
        : null;
  const modelLabel = useMemo(
    () => modelPickerOptions.find((opt) => opt.value === modelValue)?.label ?? modelValue,
    [modelPickerOptions, modelValue]
  );
  const showDeepSeekDelegationWarning = shouldShowDeepSeekDelegationWarning({
    cliType: selectedAgentConfig?.cliType,
    agentType: selectedAgentConfig?.agentType,
    modelId: modelValue,
  });

  /* ── Provider-specific interaction mode (for example Grok Agent / Plan / Ask) ── */
  const interactionSelector = interactionModeSelectors[0];
  const interactionValue = interactionSelector
    ? ((resolveConfigOptionValue(
        interactionSelector,
        configOptionValues?.[interactionSelector.configId]
      ) as string) ?? null)
    : null;
  const interactionOptions = useMemo<MobileInlinePickerOption<string>[]>(
    () =>
      (interactionSelector?.options ?? []).map((option) => ({
        value: option.value,
        label: option.label,
        searchText: option.label,
        description: option.description,
        disabled: option.disabled,
      })),
    [interactionSelector]
  );
  const interactionLabel = useMemo(
    () =>
      interactionOptions.find((option) => option.value === interactionValue)?.label ??
      interactionValue,
    [interactionOptions, interactionValue]
  );

  /* ── Reasoning / thought level (first thought-level select selector) ── */
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
  const thinkingOptions = useMemo<MobileInlinePickerOption<string>[]>(
    () =>
      (thinkingSelector?.options ?? []).map((option) => ({
        value: option.value,
        label: option.label,
        searchText: option.label,
        description: option.description,
        disabled: option.disabled,
      })),
    [thinkingSelector]
  );
  const thinkingLabel = useMemo(
    () => thinkingOptions.find((option) => option.value === thinkingValue)?.label ?? thinkingValue,
    [thinkingOptions, thinkingValue]
  );

  /* ── Permission / mode (modeOptions first, else the mode selector) ── */
  const explicitPermissionSelector = permissionModeSelectors[0];
  const modeConfigSelector: AcpSelectConfigOptionSelector | undefined =
    explicitPermissionSelector ?? modeSelectors[0];
  const permissionOptions = useMemo<MobileInlinePickerOption<string>[]>(() => {
    const source = explicitPermissionSelector
      ? explicitPermissionSelector.options
      : modeOptions.length > 0
        ? modeOptions
        : (modeConfigSelector?.options ?? []);
    return source.map((opt) => ({
      value: opt.value,
      label: opt.label,
      searchText: opt.label,
      description: opt.description,
      disabled: opt.disabled,
      icon: permissionModeIcon(opt.value),
    }));
  }, [explicitPermissionSelector, modeConfigSelector, modeOptions]);
  const permissionValue =
    explicitPermissionSelector || modeOptions.length === 0
      ? modeConfigSelector
        ? ((resolveConfigOptionValue(
            modeConfigSelector,
            configOptionValues?.[modeConfigSelector.configId]
          ) as string) ?? null)
        : null
      : selectedModeId;
  const permissionLabel = useMemo(
    () => permissionOptions.find((opt) => opt.value === permissionValue)?.label ?? null,
    [permissionOptions, permissionValue]
  );

  /* ── Plan / Fast toggles ── */
  const planSelector = planModeSelectors[0];
  const planOn = planSelector
    ? resolvePlanModeSelectorEnabled(planSelector, configOptionValues?.[planSelector.configId])
    : false;
  const fastSelector = fastModeSelectors[0];
  const fastOn = fastSelector
    ? resolveOnOffConfigOptionEnabled(fastSelector, configOptionValues?.[fastSelector.configId])
    : false;

  const roleRowLabel = t('chat.runConfig.roles.label', 'Role');
  const agentLabel = t('chat.agentSelector.placeholder', 'Agent');
  const modelRowLabel = t('chat.runConfig.modelLabel', 'Model');
  const modelSearchPlaceholder = t('chat.runConfig.modelSearchPlaceholder', 'Search models');
  const modelSearchEmptyLabel = t('chat.runConfig.modelSearchEmpty', 'No models match');
  const reasoningLabel = t('chat.runConfig.reasoningLabel', 'Reasoning');
  const permissionRowLabel = t('chat.runConfig.permissionLabel', 'Permission');
  const planRowLabel = t('chat.mobileNewChat.planModeLabel', 'Plan');
  const fastRowLabel = t('chat.runConfig.fastLabel', 'Fast');

  return (
    <div className="flex flex-col gap-1">
      {/* Rendered whenever the caller offers Roles at all, even with none to
          list: the row then reads `None` and its list is the way to make the
          first one, which is what the desktop row does too. */}
      {agentRoles ? (
        <RunConfigRow label={roleRowLabel}>
          <MobileInlinePicker<string>
            id="run-config-role"
            value={agentRoles.selectedRoleId ?? ROLE_NONE_VALUE}
            onChange={(value) => {
              if (value === ROLE_CREATE_VALUE) {
                agentRoles.onCreate?.();
                return;
              }
              agentRoles.onSelect(value === ROLE_NONE_VALUE ? null : (value as AgentRoleId));
            }}
            options={roleOptions}
            ariaLabel={roleRowLabel}
            searchable={shouldOfferOptionSearch(roleOptions.length)}
            triggerContent={
              <>
                {/* No reserved slot here: the trigger is one value, not a list,
                    so `None` reads better flush against the row than indented
                    past an empty box. The OPTIONS keep the slot, because there
                    the labels are read as a column. */}
                {selectedRole ? (
                  <span className="text-base leading-none" aria-hidden="true">
                    {getAgentRoleEmoji(selectedRole)}
                  </span>
                ) : null}
                <span className="truncate">{selectedRole?.name ?? roleNoneLabel}</span>
              </>
            }
          />
        </RunConfigRow>
      ) : null}

      {showAgent ? (
        <RunConfigRow label={agentLabel}>
          <MobileInlinePicker<string>
            id="run-config-agent"
            value={selectedAgentKey}
            onChange={(key) => {
              if (agentRowLocked) return;
              const [agentId, machineId] = key.split(':');
              if (!agentId || !machineId) return;
              onAgentConfigChange?.({
                agentId: agentId as AgentSelection['agentId'],
                machineId: machineId as MachineId,
              });
            }}
            options={agentOptions}
            ariaLabel={agentLabel}
            searchable={shouldOfferOptionSearch(agentOptions.length)}
            disabled={agentRowLocked}
            triggerContent={
              <>
                {selectedAgentConfig ? (
                  <AgentIcon
                    cliType={selectedAgentConfig.cliType}
                    agentType={selectedAgentConfig.agentType}
                    brandId={selectedAgentConfig.brandId}
                    env={selectedAgentConfig.env}
                    className="h-4 w-4 shrink-0 opacity-80"
                  />
                ) : null}
                <span className="truncate">{selectedAgentConfig?.name ?? agentLabel}</span>
              </>
            }
          />
        </RunConfigRow>
      ) : null}

      {extraSelectSelectors.map((selector) => {
        const selectedValue =
          (resolveConfigOptionValue(selector, configOptionValues?.[selector.configId]) as string) ??
          null;
        const pickerOptions: MobileInlinePickerOption<string>[] = selector.options.map(
          (option) => ({
            value: option.value,
            label: option.label,
            searchText: option.label,
            description: option.description,
            disabled: option.disabled,
          })
        );
        const selectedLabel =
          pickerOptions.find((option) => option.value === selectedValue)?.label ?? selectedValue;
        const locked = selector.configId === 'agent_preset' && agentLocked;
        return (
          <RunConfigRow key={selector.configId} label={selector.label}>
            <MobileInlinePicker<string>
              id={`run-config-${selector.configId}`}
              value={selectedValue}
              onChange={(nextValue) =>
                onConfigOptionChange?.(selector.configId, nextValue as AcpConfigOptionValue)
              }
              options={pickerOptions}
              ariaLabel={selector.label}
              searchable={shouldOfferOptionSearch(pickerOptions.length)}
              disabled={locked}
              triggerContent={<span className="truncate">{selectedLabel ?? selector.label}</span>}
            />
          </RunConfigRow>
        );
      })}

      {modelPickerOptions.length > 0 ? (
        <RunConfigRow label={modelRowLabel}>
          <MobileInlinePicker<string>
            id="run-config-model"
            value={modelValue}
            onChange={(value) => {
              if (modelOptions.length > 0) {
                onModelChange(value);
              } else if (modelConfigSelector) {
                onConfigOptionChange?.(modelConfigSelector.configId, value as AcpConfigOptionValue);
              }
            }}
            options={modelPickerOptions}
            ariaLabel={modelRowLabel}
            /* A provider can publish dozens of models, so this row is the one
               that most needs typing at — name the search and say when nothing
               matched rather than leaving an unlabelled field and a dash. */
            searchable={shouldOfferOptionSearch(modelPickerOptions.length)}
            searchPlaceholder={modelSearchPlaceholder}
            emptyText={modelSearchEmptyLabel}
            triggerContent={<span className="truncate">{modelLabel ?? modelRowLabel}</span>}
          />
        </RunConfigRow>
      ) : null}

      {showDeepSeekDelegationWarning ? (
        <a
          href={DEEPSEEK_DELEGATION_DISCUSSION_URL}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            event.preventDefault();
            void openExternalUrl(DEEPSEEK_DELEGATION_DISCUSSION_URL);
          }}
          className="flex items-start gap-2 rounded-xl border border-status-warning/30 bg-status-warning/[0.08] px-3 py-2.5 active:bg-status-warning/[0.14]"
        >
          <DeepSeekDelegationWarningContent />
        </a>
      ) : null}

      {interactionSelector && interactionOptions.length > 0 ? (
        <RunConfigRow label={interactionSelector.label}>
          <MobileInlinePicker<string>
            id="run-config-interaction"
            value={interactionValue}
            onChange={(value) =>
              onConfigOptionChange?.(interactionSelector.configId, value as AcpConfigOptionValue)
            }
            options={interactionOptions}
            ariaLabel={interactionSelector.label}
            triggerContent={
              <span className="truncate">{interactionLabel ?? interactionSelector.label}</span>
            }
          />
        </RunConfigRow>
      ) : null}

      {thinkingSelector && thinkingOptions.length > 0 ? (
        <RunConfigRow label={reasoningLabel}>
          <MobileInlinePicker<string>
            id="run-config-reasoning"
            value={thinkingValue}
            onChange={(value) =>
              onConfigOptionChange?.(thinkingSelector.configId, value as AcpConfigOptionValue)
            }
            options={thinkingOptions}
            ariaLabel={reasoningLabel}
            triggerContent={<span className="truncate">{thinkingLabel ?? reasoningLabel}</span>}
          />
        </RunConfigRow>
      ) : null}

      {permissionOptions.length > 0 ? (
        <RunConfigRow label={permissionRowLabel}>
          <MobileInlinePicker<string>
            id="run-config-permission"
            value={permissionValue}
            onChange={(value) => {
              if (explicitPermissionSelector || modeOptions.length === 0) {
                if (!modeConfigSelector) return;
                onConfigOptionChange?.(modeConfigSelector.configId, value as AcpConfigOptionValue);
              } else {
                onModeChange(value);
              }
            }}
            options={permissionOptions}
            ariaLabel={permissionRowLabel}
            triggerContent={
              <>
                <span className="flex h-4 w-4 shrink-0 items-center justify-center opacity-80">
                  {permissionModeIcon(permissionValue ?? null)}
                </span>
                <span className="truncate">{permissionLabel ?? permissionRowLabel}</span>
              </>
            }
          />
        </RunConfigRow>
      ) : null}

      {planSelector ? (
        <ToggleRow
          icon={<ListChecks className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />}
          label={planRowLabel}
          checked={planOn}
          ariaLabel={planSelector.label}
          onCheckedChange={() =>
            onConfigOptionChange?.(
              planSelector.configId,
              togglePlanModeSelectorValue(planSelector, configOptionValues?.[planSelector.configId])
            )
          }
        />
      ) : null}

      {fastSelector ? (
        <ToggleRow
          icon={<Zap className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />}
          label={fastRowLabel}
          checked={fastOn}
          ariaLabel={fastSelector.label}
          onCheckedChange={() =>
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
    </div>
  );
}

/* Labelled card row — mirrors the new-chat sheet's `Row` chrome
   (`bg-card` + `ring-border/60`, fixed label column) so the two sheets
   read as the same family. Labels are sentence case, not uppercase.
   Picker rows wrap in `MobileInlinePickerRowSlot` so the picker's inline
   expansion drops directly below the card (the coordinator keeps one open
   at a time). */
function RunConfigRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  const inner = (
    <div className="flex min-w-0 items-center gap-3 rounded-xl bg-card px-3 py-2 ring-1 ring-border/60">
      <span className="w-20 shrink-0 self-center text-[0.72rem] font-semibold text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
  return <MobileInlinePickerRowSlot>{inner}</MobileInlinePickerRowSlot>;
}

/* Labelled switch card for Plan / Fast — label + on-state icon on the
   left, a Switch pinned right. Reuses the same on/off config helpers as
   the composer's icon toggles, just a sheet-friendly presentation. */
function ToggleRow({
  icon,
  label,
  checked,
  ariaLabel,
  onCheckedChange,
}: {
  icon: ReactNode;
  label: ReactNode;
  checked: boolean;
  ariaLabel: string;
  onCheckedChange: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl bg-card px-3 py-2 ring-1 ring-border/60">
      <span className="w-20 shrink-0 self-center text-[0.72rem] font-semibold text-muted-foreground">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center justify-between">
        <span
          className={cn('flex items-center', checked ? 'text-foreground' : 'text-muted-foreground')}
        >
          {icon}
        </span>
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          aria-label={ariaLabel}
          className="shrink-0"
        />
      </div>
    </div>
  );
}

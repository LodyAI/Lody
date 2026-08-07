import { useMemo, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { ListChecks, ShieldAlert, Zap } from 'lucide-react';
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
import { orderAcpConfigOptionSelectors } from '@/lib/acp-selector-order';
import { cn } from '@/lib/utils';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { Switch } from '@/ui/switch';
import { classifyPermissionModeFace, type MachineId } from '@lody/shared';
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
 *   Agent · Model · Reasoning · Permission · Plan · Fast
 *
 * Shared by the in-session composer and the mobile new-chat sheet so both
 * surfaces pick models the same way. Rows derive options from the same
 * `orderAcpConfigOptionSelectors` buckets + mode/model fallbacks the button
 * face uses, so values stay in lock-step with the collapsed control.
 *
 * - Agent: read-only when `agentLocked` (mid-session); a picker while empty
 *   or on new-chat. Options are scoped by `allowedMachineIds` when set.
 * - Model / Reasoning / Permission: inline pickers (full names live here —
 *   the button face only shows an icon / short label).
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
};

export function MobileRunConfigSheet({
  open,
  onOpenChange,
  ...contentProps
}: MobileRunConfigSheetProps) {
  const { t } = useTranslation();
  const title = t('chat.runConfig.title', 'Run configuration');
  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <DrawerContent
        className="h-auto! max-h-[85dvh]! rounded-t-2xl border-border/60"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DrawerTitle className="sr-only">{title}</DrawerTitle>
        <DrawerDescription className="sr-only">{title}</DrawerDescription>
        <header className="px-4 pb-1 pt-2">
          <h2 className="select-none text-center text-[0.95rem] font-semibold tracking-tight">
            {title}
          </h2>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(16px+var(--safe-area-bottom,0px))] pt-2">
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
}: MobileRunConfigSheetRowsProps) {
  const { t } = useTranslation();
  const executorConfigs = useAtomValue(getAllAgentConfigAtom);

  const {
    modelSelectors,
    modeSelectors,
    thoughtLevelSelectors,
    planModeSelectors,
    fastModeSelectors,
  } = useMemo(() => orderAcpConfigOptionSelectors(configOptionSelectors), [configOptionSelectors]);

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
            (cfg) =>
              cfg.id === agentSelection.agentId && cfg.machineId === agentSelection.machineId
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
  const modeConfigSelector: AcpSelectConfigOptionSelector | undefined = modeSelectors[0];
  const permissionOptions = useMemo<MobileInlinePickerOption<string>[]>(() => {
    const source = modeOptions.length > 0 ? modeOptions : (modeConfigSelector?.options ?? []);
    return source.map((opt) => ({
      value: opt.value,
      label: opt.label,
      searchText: opt.label,
      description: opt.description,
      disabled: opt.disabled,
      icon: permissionModeIcon(opt.value),
    }));
  }, [modeConfigSelector, modeOptions]);
  const permissionValue =
    modeOptions.length > 0
      ? selectedModeId
      : modeConfigSelector
        ? ((resolveConfigOptionValue(
            modeConfigSelector,
            configOptionValues?.[modeConfigSelector.configId]
          ) as string) ?? null)
        : null;
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

  const agentLabel = t('chat.agentSelector.placeholder', 'Agent');
  const modelRowLabel = t('chat.runConfig.modelLabel', 'Model');
  const reasoningLabel = t('chat.runConfig.reasoningLabel', 'Reasoning');
  const permissionRowLabel = t('chat.runConfig.permissionLabel', 'Permission');
  const planRowLabel = t('chat.mobileNewChat.planModeLabel', 'Plan');
  const fastRowLabel = t('chat.runConfig.fastLabel', 'Fast');

  return (
    <div className="flex flex-col gap-1">
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
            searchable={agentOptions.length > 5}
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
            searchable={modelPickerOptions.length > 5}
            triggerContent={<span className="truncate">{modelLabel ?? modelRowLabel}</span>}
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
              if (modeOptions.length > 0) {
                onModeChange(value);
              } else if (modeConfigSelector) {
                onConfigOptionChange?.(modeConfigSelector.configId, value as AcpConfigOptionValue);
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

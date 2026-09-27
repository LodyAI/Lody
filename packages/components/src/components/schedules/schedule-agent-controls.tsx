import { useTranslation } from 'react-i18next';
import type {
  AcpConfigOptionValue,
  AgentConfigMeta,
  MachineLegacyMetaFields,
  MachineMeta,
} from '@lody/shared';
import { useAcpSelectorOptions } from '@/hooks/use-acp-selector-options';
import type { AgentRunRef } from '@/components/shared/agent-run-ref';
import {
  DesktopPermissionModeButton,
  DesktopRunConfigMenu,
} from '@/components/sessions/desktop-run-config-menu';
import { seedScheduleAgentRunRef } from './schedule-agent-defaults';

/**
 * Stored schedule option values are strings (the definition schema); the
 * composer's selectors speak `AcpConfigOptionValue`, so booleans cross back.
 */
const toSelectorValues = (
  values: Record<string, string> | undefined
): Record<string, AcpConfigOptionValue> | undefined =>
  values
    ? Object.fromEntries(
        Object.entries(values).map(([id, value]) => [
          id,
          value === 'true' ? true : value === 'false' ? false : value,
        ])
      )
    : undefined;

/**
 * The composer's own Agent controls — the run-config menu (Agent, model,
 * reasoning, plan, fast) and the permission button — bound to a schedule's
 * `AgentRunRef` on one machine.
 *
 * Picking an Agent seeds it the way the chat landing does
 * (`seedScheduleAgentRunRef`): the controls show a complete choice, permission
 * included, which the person can read and change before saving.
 */
export function ScheduleAgentControls({
  machine,
  agentConfigs,
  value,
  onChange,
  disabledReason,
}: {
  machine: (MachineMeta & MachineLegacyMetaFields) | undefined;
  /** Agents on `machine`, the only ones a schedule there can run. */
  agentConfigs: readonly AgentConfigMeta[];
  value: AgentRunRef | null;
  onChange: (next: AgentRunRef) => void;
  /** Read-only schedule, or no machine chosen yet. */
  disabledReason?: string;
}) {
  const { t } = useTranslation();
  const selected = agentConfigs.find((config) => config.id === value?.agentConfigId);
  const optionValues = toSelectorValues(value?.configOptionValues);
  const options = useAcpSelectorOptions(
    selected
      ? {
          configId: selected.id,
          cliType: selected.cliType,
          agentType: selected.agentType,
          selectedModeId: value?.modeId,
          selectedModelId: value?.modelId,
          configOptionValues: optionValues,
          runtimeOverrides: selected.runtimeOverrides,
          machine: machine ?? null,
        }
      : undefined
  );
  const patch = (next: Partial<AgentRunRef>) => {
    if (value) onChange({ ...value, ...next });
  };
  const patchOption = (configId: string, optionValue: AcpConfigOptionValue) =>
    patch({
      configOptionValues: { ...(value?.configOptionValues ?? {}), [configId]: String(optionValue) },
    });
  const editable = !disabledReason;

  return (
    <>
      <DesktopRunConfigMenu
        agentSelection={
          selected && machine ? { agentId: selected.id, machineId: machine.id } : null
        }
        allowedMachineIds={machine ? [machine.id] : []}
        availableAgentConfigs={agentConfigs}
        showAgentNameInTrigger
        emptyAgentLabel={t('agentRunConfig.chooseAgent', 'Choose agent')}
        disabledReason={disabledReason}
        onAgentConfigChange={
          editable
            ? (selection) => {
                const config = agentConfigs.find((entry) => entry.id === selection.agentId);
                // Like the chat landing, a newly picked Agent arrives with its
                // remembered model, options and permission.
                if (config) onChange(seedScheduleAgentRunRef(config, machine));
              }
            : undefined
        }
        modelOptions={options.modelOptions}
        selectedModelId={value?.modelId ?? options.defaultModelId ?? null}
        onModelChange={editable ? (modelId) => patch({ modelId }) : undefined}
        configOptionSelectors={options.configOptionSelectors}
        configOptionValues={optionValues}
        onConfigOptionChange={editable ? patchOption : undefined}
        modeOptions={options.modeOptions}
        selectedModeId={value?.modeId ?? null}
      />
      {selected ? (
        <DesktopPermissionModeButton
          modeOptions={options.modeOptions}
          selectedModeId={value?.modeId ?? null}
          onModeChange={editable ? (modeId) => patch({ modeId }) : undefined}
          configOptionSelectors={options.configOptionSelectors}
          configOptionValues={optionValues}
          onConfigOptionChange={editable ? patchOption : undefined}
        />
      ) : null}
    </>
  );
}

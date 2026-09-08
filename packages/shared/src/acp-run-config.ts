import { LODY_PLAN_MODE_CONFIG_ID } from 'acp-extension-core';
export { LODY_PLAN_MODE_CONFIG_ID } from 'acp-extension-core';
/**
 * Semantic run-config selection (model / reasoning effort / fast mode / plan mode)
 * resolved against an agent's ACP capabilities.
 *
 * ACP agents express these as arbitrary `configOptions` whose ids differ per
 * agent (Codex uses `reasoning_effort` + `fast-mode` + `plan_mode`, Claude Code
 * uses `effort` + `fast` and expresses planning as a permission mode). Callers
 * that only know the semantics — the MCP session tools — describe what they want
 * here and let this module map it onto the concrete option ids the target agent
 * actually advertises.
 */

import type { AcpCapabilityCacheEntry, AcpConfigOptionSummary, AcpConfigOptionValue } from './ai';

/**
 * Config option ids that carry the agent's "fast mode" toggle: Codex publishes
 * `fast-mode`, Claude Code publishes `fast`.
 */
export const ACP_FAST_MODE_CONFIG_IDS = ['fast-mode', 'fast'] as const;

/** Legacy config option id that carries reasoning effort without a category. */
export const ACP_REASONING_EFFORT_CONFIG_ID = 'reasoning_effort';

/** Category agents use for the reasoning-effort/thinking-level option. */
export const ACP_THOUGHT_LEVEL_CATEGORY = 'thought_level';

export const ACP_CONFIG_OPTION_ON_VALUE = 'on';
export const ACP_CONFIG_OPTION_OFF_VALUE = 'off';

/** Permission mode id that means "plan without editing" across builtin agents. */
export const ACP_PLAN_PERMISSION_MODE_ID = 'plan';

export const isAcpFastModeConfigId = (configId: string): boolean =>
  (ACP_FAST_MODE_CONFIG_IDS as readonly string[]).includes(configId);

type ConfigOptionIdentity = Pick<AcpConfigOptionSummary, 'id' | 'category'>;

export const isAcpThoughtLevelConfigOption = (option: ConfigOptionIdentity): boolean =>
  option.id === ACP_REASONING_EFFORT_CONFIG_ID || option.category === ACP_THOUGHT_LEVEL_CATEGORY;

/** Shared boolean planning option; Claude continues to use its permission mode. */
export const isAcpPlanModeConfigOption = (option: ConfigOptionIdentity): boolean =>
  option.id === LODY_PLAN_MODE_CONFIG_ID;

/** Semantic run-config selection, independent of any agent's option ids. */
export type AgentRunConfigSelection = {
  modelId?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  planMode?: boolean;
};

/** What the target agent supports, for callers that must pick a valid value. */
export type AgentRunConfigCapabilities = {
  /**
   * `reasoningEffortValues` is per model when the agent publishes that
   * breakdown; otherwise it is absent and only the snapshot below applies.
   */
  models: Array<{ id: string; name: string; reasoningEffortValues?: string[] }>;
  /**
   * Effort values the agent reported for `measuredForModelId`. Agents rebuild
   * this list on every model switch, so it only describes that one model.
   */
  reasoningEffortValues: string[];
  /** The model `reasoningEffortValues` and `fastMode` were measured under. */
  measuredForModelId?: string;
  fastMode: boolean;
  planMode: boolean;
};

/** Concrete ACP selection: what the CLI dispatches for the turn. */
export type AgentRunConfigResolution = {
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
  /**
   * Config option ids this module already validated against the TARGET model.
   * The caller must skip them in its snapshot-based validation, which only
   * knows the probed model's option list and would otherwise reject a value
   * that is valid for the model actually being selected.
   */
  validatedConfigIds?: string[];
  /**
   * Requested controls that could not be verified offline because the agent
   * publishes no per-model breakdown for them. They are dispatched as
   * requested; the runtime reports a visible warning if the agent rejects them.
   */
  unverifiedSelections?: string[];
};

type RunConfigCapabilitySource = Pick<
  AcpCapabilityCacheEntry,
  'modes' | 'models' | 'configOptions' | 'modelReasoningEfforts'
>;

/**
 * Recovers the per-model effort breakdown from a legacy `model[effort]` model
 * list (Codex publishes every model/effort combination there, while its ACP
 * `configOptions` only describe the current model).
 */
export const deriveModelReasoningEffortsFromLegacyModelIds = (
  modelIds: readonly string[]
): Record<string, string[]> | undefined => {
  const efforts: Record<string, string[]> = {};
  for (const modelId of modelIds) {
    const match = /^(?<model>.+?)\[(?<effort>[^[\]]+)\]$/.exec(modelId);
    const model = match?.groups?.['model'];
    const effort = match?.groups?.['effort'];
    if (!model || !effort) {
      continue;
    }
    const existing = efforts[model];
    if (existing) {
      if (!existing.includes(effort)) {
        existing.push(effort);
      }
    } else {
      efforts[model] = [effort];
    }
  }
  return Object.keys(efforts).length > 0 ? efforts : undefined;
};

export const hasAgentRunConfigSelection = (
  selection: AgentRunConfigSelection | undefined
): selection is AgentRunConfigSelection =>
  selection !== undefined &&
  (selection.modelId !== undefined ||
    selection.reasoningEffort !== undefined ||
    selection.fastMode !== undefined ||
    selection.planMode !== undefined);

const findConfigOption = (
  capability: RunConfigCapabilitySource | undefined,
  predicate: (option: AcpConfigOptionSummary) => boolean
): AcpConfigOptionSummary | undefined => capability?.configOptions?.find(predicate);

const isOnOffSelect = (option: AcpConfigOptionSummary): boolean =>
  option.type === 'select' &&
  option.options.some((value) => value.value === ACP_CONFIG_OPTION_ON_VALUE) &&
  option.options.some((value) => value.value === ACP_CONFIG_OPTION_OFF_VALUE);

const isToggleOption = (option: AcpConfigOptionSummary): boolean =>
  option.type === 'boolean' || isOnOffSelect(option);

const toggleValue = (option: AcpConfigOptionSummary, enabled: boolean): AcpConfigOptionValue =>
  option.type === 'boolean'
    ? enabled
    : enabled
      ? ACP_CONFIG_OPTION_ON_VALUE
      : ACP_CONFIG_OPTION_OFF_VALUE;

const findFastModeOption = (
  capability: RunConfigCapabilitySource | undefined
): AcpConfigOptionSummary | undefined =>
  findConfigOption(
    capability,
    (option) => isAcpFastModeConfigId(option.id) && isToggleOption(option)
  );

const findReasoningEffortOption = (
  capability: RunConfigCapabilitySource | undefined
): AcpConfigOptionSummary | undefined =>
  findConfigOption(
    capability,
    (option) => option.type === 'select' && isAcpThoughtLevelConfigOption(option)
  );

const findPlanModeOption = (
  capability: RunConfigCapabilitySource | undefined
): AcpConfigOptionSummary | undefined =>
  findConfigOption(
    capability,
    (option) => isAcpPlanModeConfigOption(option) && option.type === 'boolean'
  );

/**
 * Permission mode that means "plan only", for agents (Claude Code) that
 * express planning as a mode instead of a dedicated toggle.
 */
const findPlanPermissionModeId = (
  capability: RunConfigCapabilitySource | undefined
): string | undefined => {
  const modeOption = findConfigOption(
    capability,
    (option) => option.category === 'mode' && option.type === 'select'
  );
  const fromConfigOption = modeOption?.options.find(
    (value) => value.value === ACP_PLAN_PERMISSION_MODE_ID
  )?.value;
  if (fromConfigOption) {
    return fromConfigOption;
  }
  return capability?.modes?.find((mode) => mode.id === ACP_PLAN_PERMISSION_MODE_ID)?.id;
};

/** The model the agent had selected when these capabilities were captured. */
const findCurrentModelId = (
  capability: RunConfigCapabilitySource | undefined
): string | undefined => {
  const modelOption = findConfigOption(
    capability,
    (option) => option.category === 'model' && option.type === 'select'
  );
  return typeof modelOption?.currentValue === 'string' ? modelOption.currentValue : undefined;
};

const listModels = (
  capability: RunConfigCapabilitySource | undefined
): Array<{ id: string; name: string }> => {
  const modelOption = findConfigOption(
    capability,
    (option) => option.category === 'model' && option.type === 'select'
  );
  if (modelOption) {
    return modelOption.options.map((value) => ({ id: value.value, name: value.name }));
  }
  return (capability?.models ?? []).map((model) => ({ id: model.modelId, name: model.name }));
};

/**
 * Summarizes the run-config choices an agent offers. Used by discovery surfaces
 * (MCP `lody_session_create_options`) so callers can pick valid values instead
 * of guessing option ids.
 */
export const summarizeAgentRunConfigCapabilities = (
  capability: RunConfigCapabilitySource | undefined
): AgentRunConfigCapabilities => {
  const perModelEfforts = capability?.modelReasoningEfforts;
  const measuredForModelId = findCurrentModelId(capability);
  return {
    models: listModels(capability).map((model) => {
      const efforts = perModelEfforts?.[model.id];
      return { ...model, ...(efforts ? { reasoningEffortValues: efforts } : {}) };
    }),
    reasoningEffortValues: (findReasoningEffortOption(capability)?.options ?? []).map(
      (value) => value.value
    ),
    ...(measuredForModelId ? { measuredForModelId } : {}),
    fastMode: findFastModeOption(capability) !== undefined,
    planMode:
      findPlanModeOption(capability) !== undefined ||
      findPlanPermissionModeId(capability) !== undefined,
  };
};

/**
 * Maps a semantic selection onto the target agent's concrete ACP ids.
 *
 * Throws when the agent does not offer the requested control, so an unsupported
 * request fails loudly instead of silently running with different settings.
 *
 * Reasoning effort and fast mode are per MODEL: an agent rebuilds those options
 * every time the model changes, and `configOptions` only ever describes the
 * model that was current at probe time. So effort is validated against the
 * model actually being selected whenever the agent published that breakdown
 * (`modelReasoningEfforts`); the ids validated that way come back in
 * `validatedConfigIds` for the caller to exclude from its snapshot check.
 * What cannot be checked offline is reported in `unverifiedSelections` and
 * dispatched as requested — the runtime surfaces a visible warning if the agent
 * rejects it, rather than silently running with different settings.
 */
export const resolveAgentRunConfigSelection = (
  selection: AgentRunConfigSelection | undefined,
  capability: RunConfigCapabilitySource | undefined
): AgentRunConfigResolution => {
  if (!hasAgentRunConfigSelection(selection)) {
    return {};
  }
  if (!capability) {
    throw new Error(
      'ACP capabilities are unavailable for the selected agent, so model, reasoning effort, fast mode, and plan mode cannot be selected.'
    );
  }

  const configOptionValues: Record<string, AcpConfigOptionValue> = {};
  const validatedConfigIds: string[] = [];
  const unverifiedSelections: string[] = [];
  const probedModelId = findCurrentModelId(capability);
  const targetModelId = selection.modelId ?? probedModelId;
  const switchesModel = targetModelId !== undefined && targetModelId !== probedModelId;
  let modeId: string | undefined;

  if (selection.reasoningEffort !== undefined) {
    const option = findReasoningEffortOption(capability);
    const targetModelEfforts = targetModelId
      ? capability.modelReasoningEfforts?.[targetModelId]
      : undefined;
    if (!option && !targetModelEfforts) {
      throw new Error('The selected agent does not offer a reasoning effort option.');
    }
    const configId = option?.id ?? ACP_REASONING_EFFORT_CONFIG_ID;
    if (targetModelEfforts) {
      if (!targetModelEfforts.includes(selection.reasoningEffort)) {
        throw new Error(
          `Invalid reasoning effort for model ${targetModelId}: ${selection.reasoningEffort}. Allowed values: ${targetModelEfforts.join(', ')}.`
        );
      }
      // Validated against the target model; the caller's snapshot check knows
      // only the probed model's list and could reject a legitimate value.
      validatedConfigIds.push(configId);
    } else if (switchesModel) {
      unverifiedSelections.push(`reasoningEffort=${selection.reasoningEffort}`);
      validatedConfigIds.push(configId);
    }
    configOptionValues[configId] = selection.reasoningEffort;
  }

  if (selection.fastMode !== undefined) {
    const option = findFastModeOption(capability);
    if (!option) {
      throw new Error('The selected agent does not offer a fast mode option.');
    }
    configOptionValues[option.id] = toggleValue(option, selection.fastMode);
    if (switchesModel) {
      // Agents drop the fast toggle entirely for models that lack fast support,
      // and no agent publishes which models those are.
      unverifiedSelections.push(`fastMode=${selection.fastMode}`);
    }
  }

  if (selection.planMode !== undefined) {
    const option = findPlanModeOption(capability);
    if (option) {
      configOptionValues[option.id] = selection.planMode;
    } else if (selection.planMode) {
      const planModeId = findPlanPermissionModeId(capability);
      if (!planModeId) {
        throw new Error('The selected agent does not offer a plan mode.');
      }
      modeId = planModeId;
    }
  }

  return {
    ...(modeId ? { modeId } : {}),
    ...(selection.modelId !== undefined ? { modelId: selection.modelId } : {}),
    ...(Object.keys(configOptionValues).length > 0 ? { configOptionValues } : {}),
    ...(validatedConfigIds.length > 0 ? { validatedConfigIds } : {}),
    ...(unverifiedSelections.length > 0 ? { unverifiedSelections } : {}),
  };
};

/** Read pre-plan_mode persisted selections only when the target advertises the new contract. */
export function migrateLegacyPlanSelection<
  T extends {
    modeId?: string | null;
    configOptionValues?: Record<string, AcpConfigOptionValue>;
  },
>(
  selection: T,
  options: readonly {
    id: string;
    type: string;
    options?: readonly ({ value: string } | { options: readonly { value: string }[] })[];
  }[]
): T {
  if (
    !options.some((option) => option.id === LODY_PLAN_MODE_CONFIG_ID && option.type === 'boolean')
  )
    return selection;
  const values = { ...selection.configOptionValues };
  let modeId = selection.modeId;
  let changed = false;
  const setPlan = (enabled: boolean): void => {
    if (values[LODY_PLAN_MODE_CONFIG_ID] === undefined) values[LODY_PLAN_MODE_CONFIG_ID] = enabled;
    changed = true;
  };
  const legacyCollaboration = values.collaboration_mode;
  if (legacyCollaboration === 'default' || legacyCollaboration === 'plan') {
    setPlan(legacyCollaboration === 'plan');
    delete values.collaboration_mode;
  }
  const legacyInteraction = values.interaction_mode;
  if (
    legacyInteraction === 'agent' ||
    legacyInteraction === 'plan' ||
    legacyInteraction === 'ask'
  ) {
    setPlan(legacyInteraction !== 'agent');
    delete values.interaction_mode;
  }
  const permission = options.find((option) => option.id === 'permission_mode');
  const permissionOptions =
    permission?.options?.flatMap((option) =>
      'value' in option ? [option] : [...option.options]
    ) ?? [];
  const legacyMode = modeId ?? values.mode;
  // Kimi's old combined selector becomes independent Plan + permission; Claude has no boolean.
  if (
    permissionOptions.some((option) => option.value === 'yolo') &&
    typeof legacyMode === 'string'
  ) {
    if (legacyMode === 'plan' || permissionOptions.some((option) => option.value === legacyMode)) {
      setPlan(legacyMode === 'plan');
      values.permission_mode ??= legacyMode === 'plan' ? 'default' : legacyMode;
      delete values.mode;
      modeId = null;
    }
  } else if (permission && (legacyMode === 'plan' || legacyMode === 'default')) {
    setPlan(legacyMode === 'plan');
    delete values.mode;
    modeId = null;
  }
  return changed ? { ...selection, modeId, configOptionValues: values } : selection;
}

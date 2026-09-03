/**
 * Semantic run-config selection (model / reasoning effort / fast mode / plan mode)
 * resolved against an agent's ACP capabilities.
 *
 * ACP agents express these as arbitrary `configOptions` whose ids differ per
 * agent (Codex uses `reasoning_effort` + `fast-mode` + `collaboration_mode`, Claude Code
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

/** Upstream Codex config option id for default/plan collaboration mode. */
export const ACP_COLLABORATION_MODE_CONFIG_ID = 'collaboration_mode';
export const ACP_COLLABORATION_MODE_DEFAULT_VALUE = 'default';
export const ACP_COLLABORATION_MODE_PLAN_VALUE = 'plan';

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

/**
 * Codex is the only agent that carries plan mode as a config option, and it
 * publishes exactly one shape: `collaboration_mode`, a select over
 * `default` / `plan`. Claude expresses planning as the `plan` PERMISSION mode
 * instead (see `findPlanPermissionModeId`), so it never matches here.
 */
export const isAcpPlanModeConfigOption = (option: ConfigOptionIdentity): boolean =>
  option.id === ACP_COLLABORATION_MODE_CONFIG_ID ||
  option.category === ACP_COLLABORATION_MODE_CONFIG_ID;

/**
 * How much a permission mode lets the agent do without asking a human, for the
 * builtin modes Lody adapts. Higher is wider.
 *
 * Deliberately partial: an id not listed here — a third-party or newly added
 * mode — has NO rank, and an unranked mode can never be judged wider than
 * another. Blocking a turn on a guess about an unknown mode would be the same
 * mistake as blocking it on a stale snapshot.
 */
const ACP_PERMISSION_MODE_RANKS: Record<string, number> = {
  // Cannot modify anything.
  'read-only': 0,
  plan: 0,
  // Asks a human before acting.
  agent: 1,
  default: 1,
  ask: 1,
  // Routes approval to a reviewing model instead of a human.
  'agent-auto-review': 2,
  auto: 2,
  // Auto-approves edits inside the workspace.
  acceptEdits: 3,
  'workspace-write': 3,
  // Skips approval entirely.
  dontAsk: 4,
  bypassPermissions: 4,
  'agent-full-access': 4,
  'danger-full-access': 4,
  yolo: 4,
  'always-approve': 4,
};

export const findAcpPermissionModeRank = (modeId: string | null | undefined): number | undefined =>
  typeof modeId === 'string' ? ACP_PERMISSION_MODE_RANKS[modeId] : undefined;

/**
 * Whether the agent ended up with MORE permission than the turn asked for.
 *
 * Both sides must be ranked and the effective one must be strictly wider. Equal,
 * narrower, unranked, or unknown all answer `false`: this decides whether to
 * stop a turn before it runs, so it may only fire on a contradiction the agent's
 * own reported state establishes.
 */
export const isAcpPermissionWiderThanRequested = (
  requestedModeId: string | null | undefined,
  effectiveModeId: string | null | undefined
): boolean => {
  const requested = findAcpPermissionModeRank(requestedModeId);
  const effective = findAcpPermissionModeRank(effectiveModeId);
  return requested !== undefined && effective !== undefined && effective > requested;
};

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
   * Requested controls that could not be verified offline because the agent
   * publishes no per-model breakdown for them. They are dispatched as
   * requested; the runtime reports a visible warning if the agent rejects them.
   */
  unverifiedSelections?: string[];
};

type RunConfigCapabilitySource = Pick<
  AcpCapabilityCacheEntry,
  'modes' | 'models' | 'configOptions' | 'modelReasoningEfforts'
> &
  Partial<Pick<AcpCapabilityCacheEntry, 'agentType'>>;

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

const isCollaborationModeSelect = (option: AcpConfigOptionSummary): boolean =>
  option.type === 'select' &&
  option.options.some((value) => value.value === ACP_COLLABORATION_MODE_DEFAULT_VALUE) &&
  option.options.some((value) => value.value === ACP_COLLABORATION_MODE_PLAN_VALUE);

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

/**
 * Wire spelling per agent for the controls a snapshot can legitimately omit.
 *
 * A binding answers "how would THIS agent spell it", never "does this model
 * support it". It is needed exactly when the captured model lacked the control,
 * because then the snapshot carries no option to read the id off. There is no
 * default: the ids differ per agent (Codex `reasoning_effort` / `fast-mode`,
 * Claude `effort` / `fast`), so falling back to one agent's spelling would send
 * another agent an id it has never heard of — a silent no-op, which is worse
 * than saying the request cannot be encoded.
 */
const AGENT_PER_MODEL_BINDINGS: Record<
  string,
  { fastModeConfigId?: string; reasoningEffortConfigId?: string }
> = {
  codex: { fastModeConfigId: 'fast-mode', reasoningEffortConfigId: ACP_REASONING_EFFORT_CONFIG_ID },
  claude: { fastModeConfigId: 'fast', reasoningEffortConfigId: 'effort' },
  grok: { reasoningEffortConfigId: ACP_REASONING_EFFORT_CONFIG_ID },
  kimi: { reasoningEffortConfigId: 'thinking' },
};

const findAgentPerModelBinding = (capability: RunConfigCapabilitySource | undefined) =>
  capability?.agentType ? AGENT_PER_MODEL_BINDINGS[capability.agentType.toLowerCase()] : undefined;

/**
 * Ids Lody knows name a PER-MODEL control for some agent. Such an id missing
 * from a capability snapshot means the captured model lacked the control, not
 * that the option is gone — so a stored value for one must survive a snapshot
 * that does not list it. Any other unknown id has no such excuse.
 */
export const isAcpPerModelConfigId = (configId: string): boolean =>
  isAcpFastModeConfigId(configId) ||
  configId === ACP_REASONING_EFFORT_CONFIG_ID ||
  Object.values(AGENT_PER_MODEL_BINDINGS).some(
    (binding) =>
      binding.fastModeConfigId === configId || binding.reasoningEffortConfigId === configId
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
    (option) => isAcpPlanModeConfigOption(option) && isCollaborationModeSelect(option)
  );

const planModeValue = (enabled: boolean): AcpConfigOptionValue =>
  enabled ? ACP_COLLABORATION_MODE_PLAN_VALUE : ACP_COLLABORATION_MODE_DEFAULT_VALUE;

/**
 * Permission mode that means "plan only", for agents (Claude Code, Kimi) that
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
 * INVARIANT: a capability snapshot never rejects a selection. `configOptions`
 * only ever describes the model that was current when it was captured — agents
 * rebuild those options on every model switch — so neither a missing option nor
 * a value outside its list says anything about the model this turn selects.
 * Everything it cannot confirm is dispatched as requested and reported in
 * `unverifiedSelections`; the runtime compares what the agent actually applied
 * and surfaces a visible warning when they differ.
 *
 * The one thing that still throws is a missing BINDING: when neither the
 * snapshot nor the agent's own convention says how to spell a control on the
 * wire, there is no request to send, and inventing an id would be a silent
 * no-op. That is a different statement from "the agent does not support it".
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
    // The published per-model breakdown speaks for the selected model; the
    // snapshot's own list speaks only for the model it was captured under.
    const confirmed = targetModelEfforts
      ? targetModelEfforts.includes(selection.reasoningEffort)
      : !switchesModel &&
        option?.options.some((value) => value.value === selection.reasoningEffort) === true;
    const configId = option?.id ?? findAgentPerModelBinding(capability)?.reasoningEffortConfigId;
    if (!configId) {
      throw new Error(
        'Reasoning effort cannot be encoded for the selected agent: it publishes no reasoning effort option and Lody knows no binding for it.'
      );
    }
    if (!confirmed) {
      unverifiedSelections.push(`reasoningEffort=${selection.reasoningEffort}`);
    }
    configOptionValues[configId] = selection.reasoningEffort;
  }

  if (selection.fastMode !== undefined) {
    // Binding, not support: the snapshot may omit the toggle simply because the
    // model it was captured under had no fast tier, so its absence cannot
    // decide anything. What it CAN decide is the wire shape, and when it does
    // not know that either the agent's own convention does.
    const option = findFastModeOption(capability);
    const configId = option?.id ?? findAgentPerModelBinding(capability)?.fastModeConfigId;
    if (!configId) {
      throw new Error(
        'Fast mode cannot be encoded for the selected agent: it publishes no fast mode option and Lody knows no binding for it.'
      );
    }
    // Both builtin agents publish the toggle as a boolean while the client
    // advertises boolean config options, which Lody always does.
    configOptionValues[configId] = option
      ? toggleValue(option, selection.fastMode)
      : selection.fastMode;
    if (!option || switchesModel) {
      unverifiedSelections.push(`fastMode=${selection.fastMode}`);
    }
  }

  if (selection.planMode !== undefined) {
    const option = findPlanModeOption(capability);
    if (option) {
      configOptionValues[option.id] = planModeValue(selection.planMode);
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
    ...(unverifiedSelections.length > 0 ? { unverifiedSelections } : {}),
  };
};

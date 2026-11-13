import {
  ACP_CONFIG_OPTION_OFF_VALUE,
  ACP_CONFIG_OPTION_ON_VALUE,
  ACP_COLLABORATION_MODE_CONFIG_ID,
  ACP_COLLABORATION_MODE_DEFAULT_VALUE,
  ACP_COLLABORATION_MODE_PLAN_VALUE,
  getReadableAcpCapabilityCacheEntryForRuntimeOverrides,
  isAcpFastModeConfigId,
  isAcpThoughtLevelConfigOption,
  getAcpCapabilityCacheKey,
  getAcpCapabilityCacheEntryAuthority,
  getBuiltinDefaultModeId,
  getStaticBuiltinAcpCapabilities,
  type AcpCapabilityAuthority,
  type AgentConfigId,
  type AgentConfigCliType,
  type MachineViewMeta,
  type AcpConfigOptionSummary,
  type AcpConfigOptionValue as SharedAcpConfigOptionValue,
  type BuiltinRuntimeOverrides,
  type AcpModelControls,
  ACP_THOUGHT_LEVEL_CATEGORY,
  defaultEffortValue,
  getBuiltinModelControlBinding,
  getDeclaredModelControls,
  resolveAcpConfigOptionsForModel,
  resolveDeclaredEffortSupport,
  type AcpModelConfigOptionsSource,
} from '@lody/shared';
import type { AcpSessionSelectOption } from './acp-session-select';

export type AcpConfigOptionValue = SharedAcpConfigOptionValue;

/**
 * A dynamic selector derived from a SessionConfigOption.
 * Used for registry agents that return configOptions in NewSessionResponse.
 */
type AcpConfigOptionSelectorBase = {
  configId: string;
  label: string;
  description?: string;
  /** Semantic category for icon selection: 'mode' | 'model' | 'thought_level' | custom. */
  category?: string;
};

export type AcpSelectConfigOptionSelector = AcpConfigOptionSelectorBase & {
  type: 'select';
  options: AcpSessionSelectOption[];
  currentValue: string;
};

export type AcpBooleanConfigOptionSelector = AcpConfigOptionSelectorBase & {
  type: 'boolean';
  options: [];
  currentValue: boolean;
};

export type AcpConfigOptionSelector =
  | AcpSelectConfigOptionSelector
  | AcpBooleanConfigOptionSelector;
export type AcpFastModeConfigOptionSelector = AcpConfigOptionSelector;

export const CODEX_FAST_MODE_CONFIG_ID = 'fast-mode';
export const CLAUDE_FAST_MODE_CONFIG_ID = 'fast';
export const CODEX_COLLABORATION_MODE_CONFIG_ID = ACP_COLLABORATION_MODE_CONFIG_ID;
export const CODEX_COLLABORATION_MODE_DEFAULT_VALUE = ACP_COLLABORATION_MODE_DEFAULT_VALUE;
export const CODEX_COLLABORATION_MODE_PLAN_VALUE = ACP_COLLABORATION_MODE_PLAN_VALUE;
export const CONFIG_OPTION_ON_VALUE = ACP_CONFIG_OPTION_ON_VALUE;
export const CONFIG_OPTION_OFF_VALUE = ACP_CONFIG_OPTION_OFF_VALUE;

const isOnOffSelectSelector = (selector: AcpSelectConfigOptionSelector): boolean => {
  const values = new Set(selector.options.map((option) => option.value));
  return values.has(CONFIG_OPTION_ON_VALUE) && values.has(CONFIG_OPTION_OFF_VALUE);
};

/**
 * Classifies a selector as a "fast mode" toggle so it renders in the dedicated
 * fast-mode position with the Zap icon. The ids that carry the toggle live in
 * `@lody/shared` because the CLI resolves the same semantics for MCP callers.
 */
export const isFastModeSelector = (selector: AcpConfigOptionSelector): boolean =>
  isAcpFastModeConfigId(selector.configId) &&
  (selector.type === 'boolean' || isOnOffSelectSelector(selector));

export const isOnOffConfigOptionValue = (
  value: AcpConfigOptionValue | undefined
): value is typeof CONFIG_OPTION_ON_VALUE | typeof CONFIG_OPTION_OFF_VALUE =>
  value === CONFIG_OPTION_ON_VALUE || value === CONFIG_OPTION_OFF_VALUE;

export const resolveOnOffConfigOptionEnabled = (
  selector: AcpConfigOptionSelector,
  value: AcpConfigOptionValue | undefined
): boolean => {
  const resolved = resolveConfigOptionValue(selector, value);
  return selector.type === 'boolean' ? resolved === true : resolved === CONFIG_OPTION_ON_VALUE;
};

export const toggleOnOffConfigOptionValue = (
  selector: AcpConfigOptionSelector,
  value: AcpConfigOptionValue | undefined
): AcpConfigOptionValue => {
  const enabled = resolveOnOffConfigOptionEnabled(selector, value);
  return selector.type === 'boolean'
    ? !enabled
    : enabled
      ? CONFIG_OPTION_OFF_VALUE
      : CONFIG_OPTION_ON_VALUE;
};

export const isConfigOptionValueValid = (
  selector: AcpConfigOptionSelector,
  value: AcpConfigOptionValue | undefined
): value is AcpConfigOptionValue => {
  if (selector.type === 'boolean') {
    return typeof value === 'boolean';
  }
  return typeof value === 'string' && selector.options.some((option) => option.value === value);
};

export const resolveConfigOptionValue = (
  selector: AcpConfigOptionSelector,
  value: AcpConfigOptionValue | undefined
): AcpConfigOptionValue =>
  isConfigOptionValueValid(selector, value) ? value : selector.currentValue;

export const resolveFastModeSelectorEnabled = (
  selector: AcpFastModeConfigOptionSelector,
  value: AcpConfigOptionValue | undefined
): boolean => resolveOnOffConfigOptionEnabled(selector, value);

export const toggleFastModeSelectorValue = (
  selector: AcpFastModeConfigOptionSelector,
  value: AcpConfigOptionValue | undefined
): AcpConfigOptionValue => toggleOnOffConfigOptionValue(selector, value);

/**
 * Core plan_mode uses booleans. Legacy collaboration_mode uses default/plan;
 * preserve the advertised value shape when reading or toggling either option.
 */
export const resolvePlanModeSelectorEnabled = (
  selector: AcpConfigOptionSelector,
  value: AcpConfigOptionValue | undefined
): boolean =>
  resolveConfigOptionValue(selector, value) ===
  (selector.type === 'boolean' ? true : CODEX_COLLABORATION_MODE_PLAN_VALUE);

export const togglePlanModeSelectorValue = (
  selector: AcpConfigOptionSelector,
  value: AcpConfigOptionValue | undefined
): AcpConfigOptionValue =>
  selector.type === 'boolean'
    ? !resolvePlanModeSelectorEnabled(selector, value)
    : resolvePlanModeSelectorEnabled(selector, value)
      ? CODEX_COLLABORATION_MODE_DEFAULT_VALUE
      : CODEX_COLLABORATION_MODE_PLAN_VALUE;

/**
 * Classifies a selector as a "thought level" (reasoning effort) control. Registry agents
 * may surface this either via the `thought_level` category or the legacy `reasoning_effort`
 * configId, so both are accepted here.
 */
export const isThoughtLevelSelector = (selector: AcpConfigOptionSelector): boolean =>
  isAcpThoughtLevelConfigOption({ id: selector.configId, category: selector.category });

export type AcpSelectorOptions = {
  capabilityAuthority: AcpCapabilityAuthority;
  modeOptions: AcpSessionSelectOption[];
  modelOptions: AcpSessionSelectOption[];
  defaultModeId: string | null;
  defaultModelId: string | null;
  /** Dynamic config option selectors for agents with configOptions (e.g. thought_level). */
  configOptionSelectors: AcpConfigOptionSelector[];
  /** Probed controls before per-model filtering; lets generic model validation restore hidden controls. */
  unnormalizedConfigOptionSelectors?: AcpConfigOptionSelector[];
  /** Per-model reasoning-effort ladders when the capability source publishes them. */
  modelReasoningEfforts: Record<string, string[]> | undefined;
  /** Per-model effort and Fast support the adapter declared, when stored. */
  declaredModelControls?: Record<string, AcpModelControls>;
  /**
   * Where the selected model's options came from. `borrowed` means neither the
   * snapshot nor a recorded answer describes that model, so the controls shown
   * belong to another model until the agent answers for this one.
   */
  modelConfigOptionsSource?: AcpModelConfigOptionsSource;
};

export type AcpSelectorTarget = {
  configId?: AgentConfigId | null;
  cliType?: AgentConfigCliType | null;
  agentType?: string | null;
  selectedModeId?: string | null;
  selectedModelId?: string | null;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
  runtimeOverrides?: BuiltinRuntimeOverrides;
  machine?: Pick<MachineViewMeta, 'acpCapabilities'> | null;
};

/**
 * Resolves config options from the target agent.
 * Machine cache wins; default built-in Codex/Claude fall back to static UI
 * capabilities so first render does not require a runtime probe.
 */
type ResolvedConfigOptions = {
  authority: AcpCapabilityAuthority;
  configOptions?: AcpConfigOptionSummary[];
  modelReasoningEfforts: Record<string, string[]> | undefined;
  /** Per-model effort and Fast support the adapter declared, when stored. */
  declaredModelControls?: Record<string, AcpModelControls>;
  /** Each model's own option list, recorded from the agent's answers. */
  observedModelConfigOptions?: Record<string, AcpConfigOptionSummary[]>;
};

/**
 * The snapshot describes one model. Replace its options with the selected
 * model's own recorded list when there is one; the model selector stays.
 */
const resolveConfigOptionsForSelectedModel = (
  target?: AcpSelectorTarget
): ResolvedConfigOptions & { source: AcpModelConfigOptionsSource } => {
  const resolved = resolveConfigOptions(target);
  const selectedModelId = target
    ? resolveSelectedModelId(resolved.configOptions, target)
    : undefined;
  const forModel = resolveAcpConfigOptionsForModel(
    resolved.configOptions,
    resolved.observedModelConfigOptions,
    selectedModelId
  );
  const declared = selectedModelId
    ? getDeclaredModelControls(resolved, selectedModelId) !== undefined ||
      resolved.modelReasoningEfforts?.[selectedModelId] !== undefined
    : false;
  return {
    ...resolved,
    configOptions: forModel.configOptions,
    // A declaration describes the controls Lody normalizes, so it is not borrowed.
    source: forModel.source === 'borrowed' && declared ? 'snapshot' : forModel.source,
  };
};

const resolveConfigOptions = (target?: AcpSelectorTarget): ResolvedConfigOptions => {
  if (!target?.cliType || !target.agentType) {
    return { authority: 'unavailable', modelReasoningEfforts: undefined };
  }

  if (target.configId) {
    const key = getAcpCapabilityCacheKey(target.configId);
    const capability = getReadableAcpCapabilityCacheEntryForRuntimeOverrides(
      target.machine?.acpCapabilities?.[key],
      target.runtimeOverrides
    );
    if (
      capability &&
      capability.cliType === target.cliType &&
      capability.agentType === target.agentType
    ) {
      const authority = getAcpCapabilityCacheEntryAuthority(capability, target.runtimeOverrides);
      const modelReasoningEfforts = capability.modelReasoningEfforts;
      const declaredModelControls = capability.declaredModelControls;
      const observedModelConfigOptions = capability.observedModelConfigOptions;
      if (capability.configOptions?.length) {
        return {
          authority,
          configOptions: capability.configOptions,
          modelReasoningEfforts,
          declaredModelControls,
          observedModelConfigOptions,
        };
      }
      // Fallback: synthesize configOptions from legacy modes/models.
      const synthesized: AcpConfigOptionSummary[] = [];
      if (capability.modes && capability.modes.length > 0) {
        synthesized.push({
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: capability.modes[0]?.id ?? '',
          options: capability.modes.map((m) => ({
            value: m.id,
            name: m.name,
            description: m.description ?? undefined,
          })),
        });
      }
      if (capability.models && capability.models.length > 0) {
        synthesized.push({
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: capability.models[0]?.modelId ?? '',
          options: capability.models.map((m) => ({
            value: m.modelId,
            name: m.name ?? m.modelId,
          })),
        });
      }
      return {
        authority,
        configOptions: synthesized.length > 0 ? synthesized : undefined,
        modelReasoningEfforts,
        declaredModelControls,
      };
    }
  }

  const staticCapabilities = getStaticBuiltinAcpCapabilities(
    target.cliType,
    target.agentType,
    target.runtimeOverrides
  );
  return staticCapabilities
    ? {
        authority: 'provisional',
        configOptions: staticCapabilities.configOptions,
        modelReasoningEfforts: staticCapabilities.modelReasoningEfforts,
      }
    : { authority: 'unavailable', modelReasoningEfforts: undefined };
};

export const stripRecommended = (text: string): string => text.replace(/\s*\(recommended\)/gi, '');

const formatModelLabel = (text: string, target?: AcpSelectorTarget): string => {
  const label = stripRecommended(text);
  return target?.agentType?.toLowerCase() === 'codex' ? label.replace(/^gpt-/i, '') : label;
};

const formatModeLabel = (value: string, text: string, target?: AcpSelectorTarget): string => {
  if (target?.cliType === 'builtin' && target.agentType?.toLowerCase() === 'codex') {
    if (value === 'agent-full-access') {
      return 'Full access';
    }
    if (value === 'agent-auto-review') {
      return 'Auto review';
    }
  }
  return stripRecommended(text);
};

/**
 * Builds config option selectors from AcpConfigOptionSummary[].
 */
const buildConfigOptionSelectors = (
  configOptions: AcpConfigOptionSummary[] | undefined,
  target?: AcpSelectorTarget,
  authority: AcpCapabilityAuthority = 'unavailable'
): AcpConfigOptionSelector[] => {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }
  return configOptions.map((opt) => {
    if (opt.type === 'boolean') {
      return {
        configId: opt.id,
        label: opt.name,
        description: opt.description,
        category: opt.category,
        type: 'boolean' as const,
        currentValue: opt.currentValue === true,
        options: [],
      };
    }

    const currentValue = typeof opt.currentValue === 'string' ? opt.currentValue : '';
    const selectedValue = target?.configOptionValues?.[opt.id];
    const optionValues =
      authority !== 'authoritative' &&
      typeof selectedValue === 'string' &&
      !opt.options.some((option) => option.value === selectedValue)
        ? [...opt.options, { value: selectedValue, name: selectedValue }]
        : opt.options;

    return {
      configId: opt.id,
      label: opt.name,
      description: opt.description,
      category: opt.category,
      type: 'select' as const,
      currentValue,
      options: optionValues.map((v) => ({
        value: v.value,
        label:
          opt.category === 'model'
            ? formatModelLabel(v.name, target)
            : opt.category === 'mode'
              ? formatModeLabel(v.value, v.name, target)
              : stripRecommended(v.name),
        description: v.description,
      })),
    };
  });
};

const resolveSelectedModelId = (
  configOptions: AcpConfigOptionSummary[] | undefined,
  target?: AcpSelectorTarget
): string | undefined => {
  const isAcpProbed = target?.cliType === 'registry' || target?.cliType === 'custom';
  if (!isAcpProbed && target?.selectedModelId) return target.selectedModelId;
  const modelOption = configOptions?.find(
    (option) => option.category === 'model' && option.type === 'select'
  );
  const selectedValue = isAcpProbed && modelOption && target?.configOptionValues?.[modelOption.id];
  if (typeof selectedValue === 'string') return selectedValue;
  return typeof modelOption?.currentValue === 'string' ? modelOption.currentValue : undefined;
};

const reasoningEffortOptionLabel = (value: string): string =>
  value === 'xhigh' ? 'X-High' : value.charAt(0).toUpperCase() + value.slice(1);

/** What the per-model normalizers need to know about the target and its model. */
export type PerModelSelectorContext = {
  cliType?: AcpSelectorTarget['cliType'];
  agentType?: AcpSelectorTarget['agentType'];
  modelReasoningEfforts?: Record<string, string[]>;
  declaredModelControls?: Record<string, AcpModelControls>;
  selectedModelId?: string | null;
};

/**
 * Rebuilds a thought-level selector's options from the selected model's own
 * effort ladder. The selectors already come from the selected model's
 * recorded options when a refresh read them; on top of that the adapter's
 * per-model declaration decides, then the per-model map an agent publishes
 * (`modelReasoningEfforts`, LodyAI/Lody#149). A model none of these cover keeps
 * the list it has: the adapter owns the wire and rejects unsupported efforts
 * with a visible warning, so the UI does not duplicate that guard. No
 * provider's per-model tiers are hard-coded here.
 */
export const normalizeReasoningEffortSelectors = (
  selectors: AcpConfigOptionSelector[],
  options: PerModelSelectorContext
): AcpConfigOptionSelector[] => {
  // The adapter's own per-model declaration is authoritative for the models it
  // covers, for every agent. An undeclared model keeps the paths below.
  const declared = resolveDeclaredEffortSupport(options, options.selectedModelId);
  if (declared.state === 'unsupported') {
    return selectors.filter(
      (selector) => selector.type !== 'select' || !isThoughtLevelSelector(selector)
    );
  }
  if (declared.state === 'supported') {
    const hasEffort = selectors.some(
      (selector) => selector.type === 'select' && isThoughtLevelSelector(selector)
    );
    const binding = getBuiltinModelControlBinding(options);
    // The probe ran on a model without effort, so there is no control to
    // relabel. Add a built-in adapter's own one; never guess an id otherwise.
    const withEffort: AcpConfigOptionSelector[] =
      hasEffort || !binding
        ? selectors
        : [
            ...selectors,
            {
              configId: binding.effortConfigId,
              label: binding.effortLabel,
              category: ACP_THOUGHT_LEVEL_CATEGORY,
              type: 'select',
              options: [],
              currentValue: declared.fallbackValue,
            },
          ];
    return applyEffortLadder(withEffort, declared.values, declared.fallbackValue);
  }
  const map = options.modelReasoningEfforts;
  const selectedModelId = options.selectedModelId;
  if (!map || !selectedModelId) {
    return selectors;
  }
  const targetEfforts = map[selectedModelId];
  if (!targetEfforts || targetEfforts.length === 0) {
    return selectors;
  }
  return applyEffortLadder(selectors, targetEfforts);
};

const applyEffortLadder = (
  selectors: AcpConfigOptionSelector[],
  efforts: readonly string[],
  fallbackValue: string = defaultEffortValue(efforts)
): AcpConfigOptionSelector[] =>
  selectors.map((selector) => {
    if (selector.type !== 'select' || !isThoughtLevelSelector(selector)) {
      return selector;
    }
    return {
      ...selector,
      options: efforts.map((value) => ({
        value,
        label: reasoningEffortOptionLabel(value),
        description: undefined,
      })),
      currentValue: efforts.includes(selector.currentValue) ? selector.currentValue : fallbackValue,
    };
  });

/**
 * Shows the Fast toggle for exactly the models that have it. The probed options
 * describe one model, so the toggle can be missing for a model that has Fast or
 * present for one that lacks it. A declared `fastMode` decides; an undeclared
 * model keeps what the probe showed.
 */
const normalizeFastModeSelectors = (
  selectors: AcpConfigOptionSelector[],
  options: PerModelSelectorContext
): AcpConfigOptionSelector[] => {
  const fastMode = getDeclaredModelControls(options, options.selectedModelId)?.fastMode;
  if (fastMode === undefined) return selectors;
  const hasFast = selectors.some(isFastModeSelector);
  if (!fastMode) {
    return hasFast ? selectors.filter((selector) => !isFastModeSelector(selector)) : selectors;
  }
  const configId = getBuiltinModelControlBinding(options)?.fastConfigId;
  if (hasFast || !configId) return selectors;
  return [
    ...selectors,
    {
      configId,
      label: 'Fast mode',
      category: 'model_config',
      type: 'boolean',
      currentValue: false,
      options: [],
    },
  ];
};

/**
 * Fits the effort ladder and the Fast toggle to the selected model. Every
 * surface that shows or validates model-dependent selectors goes through this
 * one entry point.
 */
export const normalizePerModelSelectors = (
  selectors: AcpConfigOptionSelector[],
  context: PerModelSelectorContext
): AcpConfigOptionSelector[] =>
  normalizeFastModeSelectors(normalizeReasoningEffortSelectors(selectors, context), context);

/**
 * Extracts mode options from configOptions (category: 'mode').
 */
const buildModeOptions = (
  configOptions: AcpConfigOptionSummary[] | undefined,
  target?: AcpSelectorTarget,
  authority: AcpCapabilityAuthority = 'unavailable'
): AcpSessionSelectOption[] => {
  const modeOption = configOptions?.find(
    (opt) => opt.category === 'mode' && opt.type === 'select' && opt.id !== 'interaction_mode'
  );
  if (!modeOption) {
    return [];
  }
  const options = modeOption.options.map((opt) => ({
    value: opt.value,
    label: formatModeLabel(opt.value, opt.name, target),
    description: opt.description,
  }));
  if (
    authority !== 'authoritative' &&
    target?.selectedModeId &&
    !options.some((option) => option.value === target.selectedModeId)
  ) {
    options.push({
      value: target.selectedModeId,
      label: formatModeLabel(target.selectedModeId, target.selectedModeId, target),
      description: undefined,
    });
  }
  return options;
};

/**
 * Extracts model options from configOptions (category: 'model').
 */
const buildModelOptions = (
  configOptions: AcpConfigOptionSummary[] | undefined,
  target?: AcpSelectorTarget,
  authority: AcpCapabilityAuthority = 'unavailable'
): AcpSessionSelectOption[] => {
  const modelOption = configOptions?.find(
    (opt) => opt.category === 'model' && opt.type === 'select'
  );
  if (!modelOption) {
    return [];
  }
  const options = modelOption.options.map((opt) => ({
    value: opt.value,
    label: formatModelLabel(opt.name, target),
    description: opt.description,
  }));
  if (
    authority !== 'authoritative' &&
    target?.selectedModelId &&
    !options.some((option) => option.value === target.selectedModelId)
  ) {
    options.push({
      value: target.selectedModelId,
      label: formatModelLabel(target.selectedModelId, target),
      description: undefined,
    });
  }
  return options;
};

/**
 * Categories that are rendered as dedicated selectors (mode, model)
 * and should not appear as generic configOption selectors.
 */
const dedicatedCategories = new Set(['mode', 'model']);

/**
 * First-run default mode for the selector when the user has no persisted
 * selection yet. Builtin agents prefer Lody's automatic approval mode over
 * the adapter-reported currentValue; adapters that do not offer it fall back
 * to the capability's currentValue.
 */
const resolveDefaultModeId = (
  target: AcpSelectorTarget | undefined,
  modeConfigOption: AcpConfigOptionSummary | undefined
): string | null => {
  const currentValue =
    typeof modeConfigOption?.currentValue === 'string' ? modeConfigOption.currentValue : null;
  const builtinDefaultModeId = getBuiltinDefaultModeId(target?.cliType, target?.agentType);
  if (
    builtinDefaultModeId &&
    modeConfigOption?.options.some((option) => option.value === builtinDefaultModeId)
  ) {
    return builtinDefaultModeId;
  }
  return currentValue;
};

/**
 * Builds ACP selector options without i18n translation.
 * Use this for non-React contexts or when you need raw config values.
 * For React components, prefer useAcpSelectorOptions hook instead.
 */
export const buildAcpSelectorOptions = (target?: AcpSelectorTarget): AcpSelectorOptions => {
  const resolved = resolveConfigOptionsForSelectedModel(target);
  const {
    authority: capabilityAuthority,
    configOptions,
    modelReasoningEfforts,
    declaredModelControls,
  } = resolved;
  // Custom providers are arbitrary ACP agents just like registry agents: their
  // modes/models come from the capability probe (configOptions), not the
  // builtin tables.
  const isAcpProbed = target?.cliType === 'registry' || target?.cliType === 'custom';
  const modeConfigOption = configOptions?.find(
    (opt) => opt.category === 'mode' && opt.type === 'select' && opt.id !== 'interaction_mode'
  );
  const shouldUseDedicatedModeOptions = !isAcpProbed || !modeConfigOption;

  const modeOptions = shouldUseDedicatedModeOptions
    ? buildModeOptions(configOptions, target, capabilityAuthority)
    : [];
  const modelOptions = isAcpProbed
    ? []
    : buildModelOptions(configOptions, target, capabilityAuthority);
  const modelConfigOption = configOptions?.find(
    (option) => option.category === 'model' && option.type === 'select'
  );

  const allSelectors = buildNormalizedSelectors(target, resolved);
  const configOptionSelectors = allSelectors.filter((selector) => {
    const category = selector.category ?? '';
    if (selector.configId === 'interaction_mode') {
      return true;
    }
    if (category === 'mode' && modeOptions.length > 0) {
      return false;
    }
    return isAcpProbed || !dedicatedCategories.has(category);
  });

  return {
    capabilityAuthority,
    modeOptions,
    modelOptions,
    defaultModeId: resolveDefaultModeId(target, modeConfigOption),
    defaultModelId:
      typeof modelConfigOption?.currentValue === 'string' ? modelConfigOption.currentValue : null,
    configOptionSelectors,
    ...(isAcpProbed
      ? {
          unnormalizedConfigOptionSelectors: buildConfigOptionSelectors(
            configOptions,
            target,
            capabilityAuthority
          ),
        }
      : {}),
    modelReasoningEfforts,
    declaredModelControls,
    modelConfigOptionsSource: resolved.source,
  };
};

/**
 * Builds ALL config option selectors (mode, model, and others) without separating them.
 * Used for title generation settings where all options need uniform dropdowns.
 */
export const buildAllConfigOptionSelectors = (
  target?: AcpSelectorTarget
): AcpConfigOptionSelector[] =>
  buildNormalizedSelectors(target, resolveConfigOptionsForSelectedModel(target));

const buildNormalizedSelectors = (
  target: AcpSelectorTarget | undefined,
  resolved: ResolvedConfigOptions
): AcpConfigOptionSelector[] =>
  normalizePerModelSelectors(
    buildConfigOptionSelectors(resolved.configOptions, target, resolved.authority),
    {
      cliType: target?.cliType,
      agentType: target?.agentType,
      modelReasoningEfforts: resolved.modelReasoningEfforts,
      declaredModelControls: resolved.declaredModelControls,
      selectedModelId: target ? resolveSelectedModelId(resolved.configOptions, target) : undefined,
    }
  );

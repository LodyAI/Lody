import {
  ACP_CONFIG_OPTION_OFF_VALUE,
  ACP_CONFIG_OPTION_ON_VALUE,
  ACP_COLLABORATION_MODE_CONFIG_ID,
  ACP_COLLABORATION_MODE_DEFAULT_VALUE,
  ACP_COLLABORATION_MODE_PLAN_VALUE,
  isAcpFastModeConfigId,
  isAcpThoughtLevelConfigOption,
  getAcpCapabilityCacheKey,
  getAcpCapabilityCacheEntryAuthority,
  getBuiltinDefaultModeId,
  getStaticBuiltinAcpCapabilities,
  isAcpCapabilityCacheEntryCurrentForRuntimeOverrides,
  type AcpCapabilityAuthority,
  type AgentConfigId,
  type AgentConfigCliType,
  type MachineViewMeta,
  type AcpConfigOptionSummary,
  type AcpConfigOptionValue as SharedAcpConfigOptionValue,
  type BuiltinRuntimeOverrides,
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

// Keep model-specific support aligned with the Codex ACP model catalog.
const CODEX_EXTENDED_REASONING_BY_MODEL = new Map<string, readonly string[]>([
  ['gpt-6-astra', ['max', 'ultra']],
  ['gpt-5.6-sol', ['max', 'ultra']],
  ['gpt-5.6-terra', ['max', 'ultra']],
  ['gpt-5.6-luna', ['max']],
]);
const CODEX_EXTENDED_REASONING_OPTIONS: AcpSessionSelectOption[] = [
  {
    value: 'max',
    label: 'Max',
    description: 'Maximum reasoning depth for the hardest problems',
  },
  {
    value: 'ultra',
    label: 'Ultra',
    description: 'Maximum reasoning with automatic task delegation',
  },
];
const CODEX_EXTENDED_REASONING_VALUES = new Set(
  CODEX_EXTENDED_REASONING_OPTIONS.map((option) => option.value)
);

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
 * Plan mode is NOT an on/off toggle. Codex — the only agent that carries plan
 * mode as a config option — publishes `collaboration_mode`, a select over
 * `default` / `plan`. (Claude expresses planning as the `plan` PERMISSION mode,
 * so it reaches the UI through the mode selector, never through these.)
 *
 * Plan surfaces must use these two helpers rather than the on/off pair: reading
 * `collaboration_mode` with `resolveOnOffConfigOptionEnabled` always reports
 * "off", and writing `on` produces a value the selector rejects, so
 * `resolveConfigOptionValue` falls back to `currentValue` and the control
 * silently never changes.
 */
export const resolvePlanModeSelectorEnabled = (
  selector: AcpConfigOptionSelector,
  value: AcpConfigOptionValue | undefined
): boolean => resolveConfigOptionValue(selector, value) === CODEX_COLLABORATION_MODE_PLAN_VALUE;

export const togglePlanModeSelectorValue = (
  selector: AcpConfigOptionSelector,
  value: AcpConfigOptionValue | undefined
): AcpConfigOptionValue =>
  resolvePlanModeSelectorEnabled(selector, value)
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
};

const resolveConfigOptions = (target?: AcpSelectorTarget): ResolvedConfigOptions => {
  if (!target?.cliType || !target.agentType) {
    return { authority: 'unavailable' };
  }

  if (target.configId) {
    const key = getAcpCapabilityCacheKey(target.configId);
    const capability = target.machine?.acpCapabilities?.[key];
    if (isAcpCapabilityCacheEntryCurrentForRuntimeOverrides(capability, target.runtimeOverrides)) {
      const authority = getAcpCapabilityCacheEntryAuthority(capability, target.runtimeOverrides);
      if (capability.configOptions?.length) {
        return { authority, configOptions: capability.configOptions };
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
      };
    }
  }

  const staticCapabilities = getStaticBuiltinAcpCapabilities(
    target.cliType,
    target.agentType,
    target.runtimeOverrides
  );
  return staticCapabilities
    ? { authority: 'provisional', configOptions: staticCapabilities.configOptions }
    : { authority: 'unavailable' };
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
  if (target?.selectedModelId) return target.selectedModelId;
  const modelOption = configOptions?.find(
    (option) => option.category === 'model' && option.type === 'select'
  );
  return typeof modelOption?.currentValue === 'string' ? modelOption.currentValue : undefined;
};

export const normalizeCodexReasoningEffortSelectors = (
  selectors: AcpConfigOptionSelector[],
  target?: Pick<AcpSelectorTarget, 'cliType' | 'agentType' | 'selectedModelId'>
): AcpConfigOptionSelector[] => {
  if (
    target?.cliType !== 'builtin' ||
    target.agentType?.toLowerCase() !== 'codex' ||
    !target.selectedModelId
  ) {
    return selectors;
  }
  const supportedValues = CODEX_EXTENDED_REASONING_BY_MODEL.get(target.selectedModelId) ?? [];

  return selectors.map((selector) => {
    if (selector.type !== 'select' || selector.configId !== 'reasoning_effort') {
      return selector;
    }

    const visibleOptions = selector.options.filter(
      (option) =>
        !CODEX_EXTENDED_REASONING_VALUES.has(option.value) || supportedValues.includes(option.value)
    );
    const existingValues = new Set(visibleOptions.map((option) => option.value));
    const missingOptions = CODEX_EXTENDED_REASONING_OPTIONS.filter(
      (option) => supportedValues.includes(option.value) && !existingValues.has(option.value)
    );
    const options =
      visibleOptions.length === selector.options.length && missingOptions.length === 0
        ? selector.options
        : [...visibleOptions, ...missingOptions];

    const currentValue = options.some((option) => option.value === selector.currentValue)
      ? selector.currentValue
      : (options.find((option) => option.value === 'medium')?.value ?? options[0]?.value ?? '');
    if (options === selector.options && currentValue === selector.currentValue) {
      return selector;
    }
    return { ...selector, options, currentValue };
  });
};

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
  const { authority: capabilityAuthority, configOptions } = resolveConfigOptions(target);
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

  const allSelectors = normalizeCodexReasoningEffortSelectors(
    buildConfigOptionSelectors(configOptions, target, capabilityAuthority),
    target
      ? {
          cliType: target.cliType,
          agentType: target.agentType,
          selectedModelId: resolveSelectedModelId(configOptions, target),
        }
      : undefined
  );
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
  };
};

/**
 * Builds ALL config option selectors (mode, model, and others) without separating them.
 * Used for title generation settings where all options need uniform dropdowns.
 */
export const buildAllConfigOptionSelectors = (
  target?: AcpSelectorTarget
): AcpConfigOptionSelector[] => {
  const { authority, configOptions } = resolveConfigOptions(target);
  return normalizeCodexReasoningEffortSelectors(
    buildConfigOptionSelectors(configOptions, target, authority),
    target
      ? {
          cliType: target.cliType,
          agentType: target.agentType,
          selectedModelId: resolveSelectedModelId(configOptions, target),
        }
      : undefined
  );
};

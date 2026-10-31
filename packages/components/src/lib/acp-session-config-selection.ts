import {
  isPerModelControlConfigId,
  type AcpCapabilityAuthority,
  type AcpConfigOptionValue,
  type AcpModelControls,
} from '@lody/shared';
import {
  isConfigOptionValueValid,
  isThoughtLevelSelector,
  normalizePerModelSelectors,
  type AcpConfigOptionSelector,
  type AcpSelectorTarget,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';

/**
 * Selection is pure: unsent user edits override the execution owner's snapshot.
 * Only creation drafts seed defaults. Existing sessions inherit unreported
 * values at dispatch. Capability validation reports errors without rewriting
 * a concrete choice; history and queued inputs never establish current state.
 */

export type AcpSessionConfigPreferences = {
  modeId?: string | null;
  modelId?: string | null;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
};

/**
 * The user's unsent edits — the ONLY stored selection state. `mode`/`model`
 * wrap their value so an explicit `null` choice stays distinguishable from
 * "untouched".
 */
export type AcpSessionUserConfigEdits = {
  mode?: { value: string | null };
  model?: { value: string | null };
  configOptions: Record<string, AcpConfigOptionValue>;
};

export const EMPTY_ACP_SESSION_USER_CONFIG_EDITS: AcpSessionUserConfigEdits = {
  configOptions: {},
};

/**
 * Carry unsent edits across a preference-revision boundary (a turn was
 * accepted / a Role re-seeded the composer). An edit the new preference
 * captured is dropped — it is the preference now, so the runtime baseline may
 * move that field again — while a still-diverging edit survives. A target
 * change (different session/agent) or a caller that does not preserve edits
 * clears everything.
 */
export const fenceAcpSessionUserEdits = (
  edits: AcpSessionUserConfigEdits,
  options: {
    targetChanged: boolean;
    preserveUnsentUserEdits: boolean;
    preferences: AcpSessionConfigPreferences;
  }
): AcpSessionUserConfigEdits => {
  if (options.targetChanged || !options.preserveUnsentUserEdits) {
    return EMPTY_ACP_SESSION_USER_CONFIG_EDITS;
  }
  const configOptions: Record<string, AcpConfigOptionValue> = {};
  for (const [configId, value] of Object.entries(edits.configOptions)) {
    if (options.preferences.configOptionValues?.[configId] !== value) {
      configOptions[configId] = value;
    }
  }
  const mode =
    edits.mode && edits.mode.value !== (options.preferences.modeId ?? null)
      ? edits.mode
      : undefined;
  const model =
    edits.model && edits.model.value !== (options.preferences.modelId ?? null)
      ? edits.model
      : undefined;
  if (!mode && !model && Object.keys(configOptions).length === 0) {
    return EMPTY_ACP_SESSION_USER_CONFIG_EDITS;
  }
  return { ...(mode ? { mode } : {}), ...(model ? { model } : {}), configOptions };
};

/**
 * Value equality for preference inputs. The reducer this derivation replaced
 * returned the SAME state object for a no-op reconcile, which doubled as a
 * value-level debounce: session-doc merge frames rebuild `history` (and thus
 * the resolved preference/runtime object literals) with unchanged values many
 * times per second while an agent streams. The selection hook uses this to
 * keep its output identities stable across such frames, so the selector
 * catalog and the memoized composer subtree are not rebuilt per frame.
 *
 * An absent `configOptionValues` is NOT equal to an empty one: for the runtime
 * baseline, `undefined` means "no snapshot" (selector fallbacks seed) while
 * `{}` is a full snapshot that owns — and empties — the non-user table.
 */
export const areAcpSessionConfigPreferencesEqual = (
  left: AcpSessionConfigPreferences | null | undefined,
  right: AcpSessionConfigPreferences | null | undefined
): boolean => {
  if (left === right) return true;
  if (!left || !right) return false;
  if ((left.modeId ?? null) !== (right.modeId ?? null)) return false;
  if ((left.modelId ?? null) !== (right.modelId ?? null)) return false;
  const leftValues = left.configOptionValues;
  const rightValues = right.configOptionValues;
  if (leftValues === rightValues) return true;
  if (!leftValues || !rightValues) return false;
  const leftKeys = Object.keys(leftValues);
  if (leftKeys.length !== Object.keys(rightValues).length) return false;
  return leftKeys.every((key) => key in rightValues && leftValues[key] === rightValues[key]);
};

export type AcpSessionConfigSelectionInputs = {
  edits: AcpSessionUserConfigEdits;
  preferences: AcpSessionConfigPreferences;
  runtimePreferences?: AcpSessionConfigPreferences | null;
  /** Existing sessions inherit unreported values from the agent at dispatch. */
  inheritDefaults?: boolean;
};

export type AcpSessionConfigCandidates = {
  modeId: string | null;
  modelId: string | null;
  configOptionValues: Record<string, AcpConfigOptionValue>;
};

/**
 * Stage 1 — the UNVALIDATED head of each priority chain, computed without any
 * capability knowledge. This is what feeds capability lookups
 * (`useSessionAcpSelectorContext`): the selector catalog may depend on the
 * candidate model (Codex reasoning tiers) and enrich menus with an
 * out-of-catalog candidate, and taking candidates instead of the validated
 * result is what keeps that dependency ACYCLIC — options never feed back into
 * the values they were derived from.
 */
export const buildAcpSessionConfigCandidates = (
  inputs: AcpSessionConfigSelectionInputs
): AcpSessionConfigCandidates => {
  const { edits, preferences, runtimePreferences } = inputs;
  const baseTable = runtimePreferences?.configOptionValues ?? preferences.configOptionValues ?? {};
  return {
    modeId: edits.mode
      ? edits.mode.value
      : (runtimePreferences?.modeId ?? preferences.modeId ?? null),
    modelId: edits.model
      ? edits.model.value
      : (runtimePreferences?.modelId ?? preferences.modelId ?? null),
    configOptionValues: { ...baseTable, ...edits.configOptions },
  };
};

export type AcpSessionSelectorOptionsInput = {
  capabilityAuthority: AcpCapabilityAuthority;
  modeOptions: AcpSessionSelectOption[];
  modelOptions: AcpSessionSelectOption[];
  defaultModeId: string | null;
  defaultModelId: string | null;
  configOptionSelectors: AcpConfigOptionSelector[];
  allConfigOptionSelectors?: AcpConfigOptionSelector[];
  /** Generic agents retain the probed controls so model validation can restore hidden selectors. */
  unnormalizedConfigOptionSelectors?: AcpConfigOptionSelector[];
  /** Per-model reasoning-effort ladders when the capability source publishes them. */
  modelReasoningEfforts: Record<string, string[]> | undefined;
  /** Per-model effort and Fast support the adapter declared, when stored. */
  declaredModelControls?: Record<string, AcpModelControls>;
};

export type ResolvedAcpSessionConfigSelection = {
  selectedModeId: string | null;
  selectedModelId: string | null;
  configOptionValues: Record<string, AcpConfigOptionValue>;
  validationErrors: string[];
  /** Selectors re-normalized for the RESOLVED model; dispatch filtering must use these, not the candidate-model input ones. */
  configOptionSelectors: AcpConfigOptionSelector[];
};

const isSelectValueValid = (
  options: AcpSessionSelectOption[],
  value: string | null | undefined
): value is string => Boolean(value && options.some((option) => option.value === value));

const resolveSelectField = (
  edit: { value: string | null } | undefined,
  runtimeValue: string | null | undefined,
  preferredValue: string | null | undefined,
  defaultValue: string | null
): string | null => edit ? edit.value : runtimeValue ?? preferredValue ?? defaultValue;

const resolveConfigOptionValues = (
  inputs: AcpSessionConfigSelectionInputs,
  selectors: AcpConfigOptionSelector[],
  _capabilityAuthority: AcpCapabilityAuthority
): Record<string, AcpConfigOptionValue> => {
  const table = inputs.runtimePreferences?.configOptionValues;
  const values = { ...(table ?? inputs.preferences.configOptionValues ?? {}) };
  if (table === undefined && !inputs.inheritDefaults) {
    for (const selector of selectors) {
      if (!(selector.configId in values)) values[selector.configId] = selector.currentValue;
    }
  }
  return { ...values, ...inputs.edits.configOptions };
};

/** Resolve candidates and report invalid concrete values without substitution. */
export const resolveAcpSessionConfigSelection = (
  inputs: AcpSessionConfigSelectionInputs,
  selectorOptions: AcpSessionSelectorOptionsInput,
  target?: Pick<AcpSelectorTarget, 'cliType' | 'agentType'>
): ResolvedAcpSessionConfigSelection => {
  const { edits, preferences, runtimePreferences } = inputs;
  const {
    capabilityAuthority,
    modeOptions,
    modelOptions,
    defaultModeId,
    defaultModelId,
    configOptionSelectors,
    modelReasoningEfforts,
    declaredModelControls,
  } = selectorOptions;

  const selectedModeId = modeOptions.length === 0 && configOptionSelectors.some((option) => option.category === 'mode') ? null : resolveSelectField(
    edits.mode,
    runtimePreferences?.modeId,
    preferences.modeId,
    inputs.inheritDefaults || modeOptions.length === 0 ? null : defaultModeId
  );
  const selectedModelId = modelOptions.length === 0 && configOptionSelectors.some((option) => option.category === 'model') ? null : resolveSelectField(
    edits.model,
    runtimePreferences?.modelId,
    preferences.modelId,
    inputs.inheritDefaults || modelOptions.length === 0 ? null : defaultModelId
  );
  // Generic agents send the model through its category-bound config id, never
  // the dedicated modelId field. Validate it with the same table rules first;
  // a full runtime snapshot must not resurrect preference keys it omitted.
  const genericModel =
    modelOptions.length === 0
      ? configOptionSelectors.find(
          (selector) => selector.category === 'model' && selector.type === 'select'
        )
      : undefined;
  const modelValues = genericModel
    ? resolveConfigOptionValues(inputs, [genericModel], capabilityAuthority)
    : undefined;
  const modelValue = genericModel && modelValues?.[genericModel.configId];
  const effectiveModelId = genericModel
    ? typeof modelValue === 'string'
      ? modelValue
      : typeof genericModel.currentValue === 'string'
        ? genericModel.currentValue
        : null
    : selectedModelId;
  let selectors = configOptionSelectors;
  if (target) {
    selectors = normalizePerModelSelectors(
      selectorOptions.unnormalizedConfigOptionSelectors ?? selectors,
      {
        cliType: target.cliType,
        agentType: target.agentType,
        modelReasoningEfforts,
        declaredModelControls,
        selectedModelId: effectiveModelId,
      }
    );
  }

  const configOptionValues = resolveConfigOptionValues(inputs, selectors, capabilityAuthority);

  const validationErrors: string[] = [];
  if (capabilityAuthority === 'authoritative') {
    if (selectedModeId !== null && !isSelectValueValid(modeOptions, selectedModeId)) validationErrors.push('mode');
    if (selectedModelId !== null && !isSelectValueValid(modelOptions, selectedModelId)) validationErrors.push('model');
    for (const [id, value] of Object.entries(configOptionValues)) {
      const selector = selectors.find((entry) => entry.configId === id)
        ?? selectorOptions.allConfigOptionSelectors?.find((entry) => entry.configId === id && (entry.category === 'mode' || entry.category === 'model'));
      if (selector?.category === 'mode' && selectedModeId !== null) continue;
      if (selector?.category === 'model' && selectedModelId !== null) continue;
      if (!selector || !isConfigOptionValueValid(selector, value)) validationErrors.push(id);
    }
  }
  return {
    validationErrors,
    selectedModeId,
    selectedModelId,
    configOptionValues,
    configOptionSelectors: selectors,
  };
};

/**
 * Keeps the values the given selectors still offer.
 *
 * `switchesModel` says the caller applies these values together with a new
 * model. Reasoning effort and Fast are per model and the selectors still
 * describe the OUTGOING one: validating against them would drop a value the
 * incoming model does offer (Grok 4.5 has no `xhigh`, Grok 4.6 does), and a
 * control the outgoing model lacks entirely (no Fast toggle on model A) would
 * drop the incoming model's value outright. Those keys pass through, and the
 * selection resolution re-validates them against the resolved model.
 */
export const filterAcpSessionConfigOptionValues = (
  values: Record<string, AcpConfigOptionValue> | undefined,
  selectors: readonly AcpConfigOptionSelector[],
  options: { switchesModel?: boolean } = {}
): Record<string, AcpConfigOptionValue> => {
  const filtered: Record<string, AcpConfigOptionValue> = {};
  for (const selector of selectors) {
    const value = values?.[selector.configId];
    if (value === undefined) {
      continue;
    }
    if (options.switchesModel === true && isThoughtLevelSelector(selector)) {
      filtered[selector.configId] = value;
      continue;
    }
    if (isConfigOptionValueValid(selector, value)) {
      filtered[selector.configId] = value;
    }
  }
  if (options.switchesModel === true) {
    for (const [configId, value] of Object.entries(values ?? {})) {
      if (!(configId in filtered) && isPerModelControlConfigId(configId)) {
        filtered[configId] = value;
      }
    }
  }
  return filtered;
};

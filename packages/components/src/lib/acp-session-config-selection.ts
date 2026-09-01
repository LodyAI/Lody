import type { AcpCapabilityAuthority, AcpConfigOptionValue } from '@lody/shared';
import {
  isConfigOptionValueValid,
  type AcpConfigOptionSelector,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';

type SelectionOrigin = 'preference' | 'fallback' | 'user';

type SelectionField<T> = {
  value: T;
  origin: SelectionOrigin;
};

export type AcpSessionConfigPreferences = {
  modeId?: string | null;
  modelId?: string | null;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
};

export type AcpSessionConfigSelectionState = {
  targetKey: string | null;
  preferenceRevision: string | null;
  capabilityAuthority: AcpCapabilityAuthority;
  mode: SelectionField<string | null>;
  model: SelectionField<string | null>;
  configOptions: Record<string, SelectionField<AcpConfigOptionValue>>;
};

export const createEmptyAcpSessionConfigSelectionState = (): AcpSessionConfigSelectionState => ({
  targetKey: null,
  preferenceRevision: null,
  capabilityAuthority: 'unavailable',
  mode: { value: null, origin: 'fallback' },
  model: { value: null, origin: 'fallback' },
  configOptions: {},
});

export type AcpSessionConfigSelectionAction =
  | {
      type: 'reconcile';
      targetKey: string | null;
      preferenceRevision: string;
      preferences: AcpSessionConfigPreferences;
      capabilityAuthority: AcpCapabilityAuthority;
      modeOptions: AcpSessionSelectOption[];
      modelOptions: AcpSessionSelectOption[];
      defaultModeId: string | null;
      defaultModelId: string | null;
      configOptionSelectors: AcpConfigOptionSelector[];
      preserveUnsentUserEdits?: boolean;
      /**
       * The agent's own reported baseline for the accepted turn, folded in by
       * the SAME action rather than a second dispatch. The two rules disagree
       * by design — stored preferences seed keys the runtime never mentions,
       * and a runtime snapshot owns the key set for the turn it is based on —
       * so applying them alternately makes the selection alternate too: one
       * pass re-adds a preference-only option, the next drops it again. One
       * pass, resolved in a fixed order, has a fixed point.
       */
      runtimePreferences?: AcpSessionConfigPreferences | null;
    }
  | { type: 'select-mode'; value: string | null }
  | { type: 'select-model'; value: string | null }
  | { type: 'select-config-option'; configId: string; value: AcpConfigOptionValue }
  | { type: 'replace-config-options'; values: Record<string, AcpConfigOptionValue> };

const isSelectValueValid = (
  options: AcpSessionSelectOption[],
  value: string | null | undefined
): value is string => Boolean(value && options.some((option) => option.value === value));

const resolveAuthoritativeSelectField = (
  previous: SelectionField<string | null>,
  preferredValue: string | null | undefined,
  options: AcpSessionSelectOption[],
  defaultValue: string | null,
  authorityChanged: boolean
): SelectionField<string | null> => {
  if (options.length === 0) {
    return { value: null, origin: 'fallback' };
  }
  const fallback = isSelectValueValid(options, defaultValue)
    ? defaultValue
    : (options[0]?.value ?? null);
  if (
    isSelectValueValid(options, previous.value) &&
    !(authorityChanged && previous.origin === 'fallback')
  ) {
    return previous;
  }
  if (isSelectValueValid(options, preferredValue)) {
    return { value: preferredValue, origin: 'preference' };
  }
  return { value: fallback, origin: 'fallback' };
};

const seedSelectField = (
  preferredValue: string | null | undefined,
  defaultValue: string | null
): SelectionField<string | null> =>
  preferredValue
    ? { value: preferredValue, origin: 'preference' }
    : { value: defaultValue, origin: 'fallback' };

const seedConfigOptions = (
  preferences: AcpSessionConfigPreferences,
  selectors: AcpConfigOptionSelector[],
  authority: AcpCapabilityAuthority
): Record<string, SelectionField<AcpConfigOptionValue>> => {
  const next: Record<string, SelectionField<AcpConfigOptionValue>> = {};
  if (authority !== 'authoritative') {
    for (const [configId, value] of Object.entries(preferences.configOptionValues ?? {})) {
      next[configId] = { value, origin: 'preference' };
    }
  }
  for (const selector of selectors) {
    const preferredValue = preferences.configOptionValues?.[selector.configId];
    // Non-authoritative capabilities preserve any stored preference verbatim;
    // authoritative ones only accept a preference that is valid for the selector.
    if (
      (authority !== 'authoritative' && preferredValue !== undefined) ||
      isConfigOptionValueValid(selector, preferredValue)
    ) {
      next[selector.configId] = { value: preferredValue, origin: 'preference' };
    } else {
      next[selector.configId] = { value: selector.currentValue, origin: 'fallback' };
    }
  }
  return next;
};

const reconcileConfigOptions = (
  previous: AcpSessionConfigSelectionState,
  action: Extract<AcpSessionConfigSelectionAction, { type: 'reconcile' }>,
  authorityChanged: boolean
): Record<string, SelectionField<AcpConfigOptionValue>> => {
  if (action.capabilityAuthority !== 'authoritative') {
    const next = { ...previous.configOptions };
    for (const [configId, value] of Object.entries(action.preferences.configOptionValues ?? {})) {
      next[configId] ??= { value, origin: 'preference' };
    }
    for (const selector of action.configOptionSelectors) {
      next[selector.configId] ??= {
        value: selector.currentValue,
        origin: 'fallback',
      };
    }
    return next;
  }

  const next: Record<string, SelectionField<AcpConfigOptionValue>> = {};
  for (const selector of action.configOptionSelectors) {
    const previousField = previous.configOptions[selector.configId];
    const preferredValue = action.preferences.configOptionValues?.[selector.configId];
    if (
      previousField &&
      isConfigOptionValueValid(selector, previousField.value) &&
      !(authorityChanged && previousField.origin === 'fallback')
    ) {
      next[selector.configId] = previousField;
    } else if (isConfigOptionValueValid(selector, preferredValue)) {
      next[selector.configId] = { value: preferredValue, origin: 'preference' };
    } else {
      next[selector.configId] = { value: selector.currentValue, origin: 'fallback' };
    }
  }
  return next;
};

const areSelectionFieldsEqual = <T>(left: SelectionField<T>, right: SelectionField<T>): boolean =>
  left.value === right.value && left.origin === right.origin;

const areConfigOptionFieldsEqual = (
  left: Record<string, SelectionField<AcpConfigOptionValue>>,
  right: Record<string, SelectionField<AcpConfigOptionValue>>
): boolean => {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => right[key] && areSelectionFieldsEqual(left[key]!, right[key]!))
  );
};

const applyRuntimeSelectPreference = (
  previous: SelectionField<string | null>,
  value: string | null | undefined,
  options: AcpSessionSelectOption[],
  authority: AcpCapabilityAuthority
): SelectionField<string | null> => {
  if (
    previous.origin === 'user' ||
    !value ||
    (authority === 'authoritative' && !isSelectValueValid(options, value))
  ) {
    return previous;
  }
  return { value, origin: 'preference' };
};

const applyRuntimeConfigPreferences = (
  previous: Record<string, SelectionField<AcpConfigOptionValue>>,
  preferences: AcpSessionConfigPreferences,
  selectors: AcpConfigOptionSelector[],
  authority: AcpCapabilityAuthority
): Record<string, SelectionField<AcpConfigOptionValue>> => {
  if (!preferences.configOptionValues) {
    return previous;
  }
  const selectorsById = new Map(selectors.map((selector) => [selector.configId, selector]));
  const next: Record<string, SelectionField<AcpConfigOptionValue>> = {};
  for (const [configId, field] of Object.entries(previous)) {
    if (field.origin === 'user') {
      next[configId] = field;
    }
  }
  for (const [configId, value] of Object.entries(preferences.configOptionValues)) {
    if (previous[configId]?.origin === 'user') {
      continue;
    }
    const selector = selectorsById.get(configId);
    if (
      authority === 'authoritative' &&
      (!selector || !isConfigOptionValueValid(selector, value))
    ) {
      continue;
    }
    next[configId] = { value, origin: 'preference' };
  }
  return areConfigOptionFieldsEqual(previous, next) ? previous : next;
};

const preserveUnsentUserEdits = (
  previous: AcpSessionConfigSelectionState,
  next: AcpSessionConfigSelectionState,
  preferences: AcpSessionConfigPreferences
): AcpSessionConfigSelectionState => {
  const mode =
    previous.mode.origin === 'user' && previous.mode.value !== preferences.modeId
      ? previous.mode
      : next.mode;
  const model =
    previous.model.origin === 'user' && previous.model.value !== preferences.modelId
      ? previous.model
      : next.model;
  const configOptions = { ...next.configOptions };
  for (const [configId, field] of Object.entries(previous.configOptions)) {
    if (field.origin === 'user' && field.value !== preferences.configOptionValues?.[configId]) {
      configOptions[configId] = field;
    }
  }
  return { ...next, mode, model, configOptions };
};

type AcpSelectorCapabilities = {
  capabilityAuthority: AcpCapabilityAuthority;
  modeOptions: AcpSessionSelectOption[];
  modelOptions: AcpSessionSelectOption[];
  configOptionSelectors: AcpConfigOptionSelector[];
};

const applyRuntimePreferences = (
  state: AcpSessionConfigSelectionState,
  preferences: AcpSessionConfigPreferences,
  capabilities: AcpSelectorCapabilities
): AcpSessionConfigSelectionState => {
  if (!state.targetKey) {
    return state;
  }
  const mode = applyRuntimeSelectPreference(
    state.mode,
    preferences.modeId,
    capabilities.modeOptions,
    capabilities.capabilityAuthority
  );
  const model = applyRuntimeSelectPreference(
    state.model,
    preferences.modelId,
    capabilities.modelOptions,
    capabilities.capabilityAuthority
  );
  const configOptions = applyRuntimeConfigPreferences(
    state.configOptions,
    preferences,
    capabilities.configOptionSelectors,
    capabilities.capabilityAuthority
  );
  return areSelectionFieldsEqual(state.mode, mode) &&
    areSelectionFieldsEqual(state.model, model) &&
    state.configOptions === configOptions
    ? state
    : { ...state, mode, model, configOptions };
};

const areSelectionStatesEqual = (
  left: AcpSessionConfigSelectionState,
  right: AcpSessionConfigSelectionState
): boolean =>
  left === right ||
  (left.targetKey === right.targetKey &&
    left.preferenceRevision === right.preferenceRevision &&
    left.capabilityAuthority === right.capabilityAuthority &&
    areSelectionFieldsEqual(left.mode, right.mode) &&
    areSelectionFieldsEqual(left.model, right.model) &&
    areConfigOptionFieldsEqual(left.configOptions, right.configOptions));

const reconcileSelection = (
  state: AcpSessionConfigSelectionState,
  action: Extract<AcpSessionConfigSelectionAction, { type: 'reconcile' }>
): AcpSessionConfigSelectionState => {
  if (!action.targetKey) {
    const empty = createEmptyAcpSessionConfigSelectionState();
    return state.targetKey === null && state.preferenceRevision === action.preferenceRevision
      ? state
      : { ...empty, preferenceRevision: action.preferenceRevision };
  }

  const preferencesChanged =
    state.targetKey !== action.targetKey || state.preferenceRevision !== action.preferenceRevision;
  if (preferencesChanged) {
    const seeded: AcpSessionConfigSelectionState = {
      targetKey: action.targetKey,
      preferenceRevision: action.preferenceRevision,
      capabilityAuthority: action.capabilityAuthority,
      mode: seedSelectField(action.preferences.modeId, action.defaultModeId),
      model: seedSelectField(action.preferences.modelId, action.defaultModelId),
      configOptions: seedConfigOptions(
        action.preferences,
        action.configOptionSelectors,
        action.capabilityAuthority
      ),
    };
    const validated =
      action.capabilityAuthority !== 'authoritative'
        ? seeded
        : {
            ...seeded,
            mode: resolveAuthoritativeSelectField(
              seeded.mode,
              action.preferences.modeId,
              action.modeOptions,
              action.defaultModeId,
              false
            ),
            model: resolveAuthoritativeSelectField(
              seeded.model,
              action.preferences.modelId,
              action.modelOptions,
              action.defaultModelId,
              false
            ),
          };
    return action.preserveUnsentUserEdits && state.targetKey === action.targetKey
      ? preserveUnsentUserEdits(state, validated, action.preferences)
      : validated;
  }

  if (action.capabilityAuthority !== 'authoritative') {
    const configOptions = reconcileConfigOptions(state, action, false);
    const next: AcpSessionConfigSelectionState = {
      ...state,
      capabilityAuthority: action.capabilityAuthority,
      mode:
        state.mode.value === null
          ? seedSelectField(action.preferences.modeId, action.defaultModeId)
          : state.mode,
      model:
        state.model.value === null
          ? seedSelectField(action.preferences.modelId, action.defaultModelId)
          : state.model,
      configOptions,
    };
    return areSelectionFieldsEqual(state.mode, next.mode) &&
      areSelectionFieldsEqual(state.model, next.model) &&
      state.capabilityAuthority === next.capabilityAuthority &&
      areConfigOptionFieldsEqual(state.configOptions, next.configOptions)
      ? state
      : next;
  }

  const authorityChanged = state.capabilityAuthority !== 'authoritative';
  const mode = resolveAuthoritativeSelectField(
    state.mode,
    action.preferences.modeId,
    action.modeOptions,
    action.defaultModeId,
    authorityChanged
  );
  const model = resolveAuthoritativeSelectField(
    state.model,
    action.preferences.modelId,
    action.modelOptions,
    action.defaultModelId,
    authorityChanged
  );
  const configOptions = reconcileConfigOptions(state, action, authorityChanged);
  if (
    state.capabilityAuthority === 'authoritative' &&
    areSelectionFieldsEqual(state.mode, mode) &&
    areSelectionFieldsEqual(state.model, model) &&
    areConfigOptionFieldsEqual(state.configOptions, configOptions)
  ) {
    return state;
  }
  return {
    ...state,
    capabilityAuthority: 'authoritative',
    mode,
    model,
    configOptions,
  };
};

export function reduceAcpSessionConfigSelection(
  state: AcpSessionConfigSelectionState,
  action: AcpSessionConfigSelectionAction
): AcpSessionConfigSelectionState {
  if (action.type === 'select-mode') {
    return { ...state, mode: { value: action.value, origin: 'user' } };
  }
  if (action.type === 'select-model') {
    return { ...state, model: { value: action.value, origin: 'user' } };
  }
  if (action.type === 'select-config-option') {
    return {
      ...state,
      configOptions: {
        ...state.configOptions,
        [action.configId]: { value: action.value, origin: 'user' },
      },
    };
  }
  if (action.type === 'replace-config-options') {
    return {
      ...state,
      configOptions: Object.fromEntries(
        Object.entries(action.values).map(([configId, value]) => [
          configId,
          { value, origin: 'user' as const },
        ])
      ),
    };
  }
  const reconciled = reconcileSelection(state, action);
  const next = action.runtimePreferences
    ? applyRuntimePreferences(reconciled, action.runtimePreferences, action)
    : reconciled;
  // A reconcile applied to its own result must return the SAME state object.
  // The composer feeds this selection back into the selector options it
  // reconciles against, so a reconcile that keeps producing a new state keeps
  // re-running the layout effect that dispatched it, until React gives up with
  // "Maximum update depth exceeded".
  return areSelectionStatesEqual(state, next) ? state : next;
}

export const getAcpSessionConfigOptionValues = (
  state: AcpSessionConfigSelectionState
): Record<string, AcpConfigOptionValue> =>
  Object.fromEntries(
    Object.entries(state.configOptions).map(([configId, field]) => [configId, field.value])
  );

export const filterAcpSessionConfigOptionValues = (
  values: Record<string, AcpConfigOptionValue> | undefined,
  selectors: readonly AcpConfigOptionSelector[]
): Record<string, AcpConfigOptionValue> => {
  const filtered: Record<string, AcpConfigOptionValue> = {};
  for (const selector of selectors) {
    const value = values?.[selector.configId];
    if (isConfigOptionValueValid(selector, value)) {
      filtered[selector.configId] = value;
    }
  }
  return filtered;
};

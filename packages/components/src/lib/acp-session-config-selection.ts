import type { AcpCapabilityAuthority, AcpConfigOptionValue } from '@lody/shared';
import {
  isConfigOptionValueValid,
  type AcpConfigOptionSelector,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';

/**
 * ACP run-config selection is a PURE DERIVATION, not reconciled state.
 *
 * The composer's effective mode/model/config values are a function of four
 * inputs: the user's unsent edits, the latest turn's preferences, the shared
 * runtime baseline the agent reported, and the capability catalog. The
 * previous design stored the RESULT in a reducer and pushed the inputs into it
 * with two layout-effect dispatches (`reconcile` + `apply-runtime`). Those two
 * writers disagreed about a preference key missing from a full runtime
 * snapshot — one re-seeded it, the other deleted it — so the state never
 * reached a fixed point, and because the selector options are themselves
 * rebuilt from the selection, the effect's deps changed every commit: a
 * synchronous nested-update loop that crashed the renderer with React #185
 * the moment such a session opened (0.89.x, session `51e236e0…`).
 *
 * Deriving instead of reconciling makes that loop unrepresentable: the only
 * state left is the user's unsent edits (fenced per target/turn by
 * `fenceAcpSessionUserEdits`), and every disagreement between inputs is
 * settled by ONE priority rule inside `resolveAcpSessionConfigSelection` —
 * user edit > runtime baseline > turn preference > capability default, with a
 * full runtime snapshot owning the whole non-user config table. There are no
 * effects, so there is nothing to oscillate.
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

export type AcpSessionConfigSelectionInputs = {
  edits: AcpSessionUserConfigEdits;
  preferences: AcpSessionConfigPreferences;
  runtimePreferences?: AcpSessionConfigPreferences | null;
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
};

export type ResolvedAcpSessionConfigSelection = {
  selectedModeId: string | null;
  selectedModelId: string | null;
  configOptionValues: Record<string, AcpConfigOptionValue>;
};

const isSelectValueValid = (
  options: AcpSessionSelectOption[],
  value: string | null | undefined
): value is string => Boolean(value && options.some((option) => option.value === value));

const resolveSelectField = (
  edit: { value: string | null } | undefined,
  runtimeValue: string | null | undefined,
  preferredValue: string | null | undefined,
  options: AcpSessionSelectOption[],
  defaultValue: string | null,
  authority: AcpCapabilityAuthority
): string | null => {
  if (authority !== 'authoritative') {
    // Non-authoritative capabilities take stored values at their word — an
    // edit wins even when it is an explicit null ("cleared").
    if (edit) return edit.value;
    return runtimeValue ?? preferredValue ?? defaultValue;
  }
  if (options.length === 0) {
    return null;
  }
  for (const candidate of [edit?.value, runtimeValue, preferredValue]) {
    if (isSelectValueValid(options, candidate)) {
      return candidate;
    }
  }
  return isSelectValueValid(options, defaultValue) ? defaultValue : (options[0]?.value ?? null);
};

/**
 * Stage 2 — resolve the effective selection against the capability catalog.
 *
 * Priority per field: user edit > runtime baseline > turn preference >
 * capability default. A present `runtimePreferences.configOptionValues` is a
 * FULL snapshot and owns the whole non-user config table (a preference key it
 * omits is gone, not re-seeded — the exact disagreement that used to
 * oscillate). Authoritative capabilities validate every value and give each
 * selector a concrete fallback; non-authoritative ones keep stored values
 * verbatim, unknown keys included.
 */
export const resolveAcpSessionConfigSelection = (
  inputs: AcpSessionConfigSelectionInputs,
  selectorOptions: AcpSessionSelectorOptionsInput
): ResolvedAcpSessionConfigSelection => {
  const { edits, preferences, runtimePreferences } = inputs;
  const {
    capabilityAuthority,
    modeOptions,
    modelOptions,
    defaultModeId,
    defaultModelId,
    configOptionSelectors,
  } = selectorOptions;

  const runtimeTable = runtimePreferences?.configOptionValues;
  const baseTable = runtimeTable ?? preferences.configOptionValues ?? {};

  const configOptionValues: Record<string, AcpConfigOptionValue> = {};
  if (capabilityAuthority !== 'authoritative') {
    Object.assign(configOptionValues, baseTable);
    for (const selector of configOptionSelectors) {
      if (!(selector.configId in configOptionValues)) {
        configOptionValues[selector.configId] = selector.currentValue;
      }
    }
    Object.assign(configOptionValues, edits.configOptions);
  } else {
    // Authoritative: only cataloged selectors exist, every one resolves to a
    // concrete value, and invalid stored values fall through the chain.
    for (const selector of configOptionSelectors) {
      const configId = selector.configId;
      const chain = [
        configId in edits.configOptions ? edits.configOptions[configId] : undefined,
        runtimeTable?.[configId],
        runtimeTable ? undefined : preferences.configOptionValues?.[configId],
      ];
      let resolved: AcpConfigOptionValue | undefined;
      for (const candidate of chain) {
        if (isConfigOptionValueValid(selector, candidate)) {
          resolved = candidate;
          break;
        }
      }
      configOptionValues[configId] = resolved ?? selector.currentValue;
    }
  }

  return {
    selectedModeId: resolveSelectField(
      edits.mode,
      runtimePreferences?.modeId,
      preferences.modeId,
      modeOptions,
      defaultModeId,
      capabilityAuthority
    ),
    selectedModelId: resolveSelectField(
      edits.model,
      runtimePreferences?.modelId,
      preferences.modelId,
      modelOptions,
      defaultModelId,
      capabilityAuthority
    ),
    configOptionValues,
  };
};

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

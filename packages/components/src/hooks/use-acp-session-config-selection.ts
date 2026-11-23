import { useCallback, useMemo, useRef, useState } from 'react';
import { isModelScopedSessionDefaultConfigId, type AcpConfigOptionValue } from '@lody/shared';
import {
  areAcpSessionConfigPreferencesEqual,
  buildAcpSessionConfigCandidates,
  EMPTY_ACP_SESSION_USER_CONFIG_EDITS,
  fenceAcpSessionUserEdits,
  isPerModelSelector,
  resolveAcpSessionConfigSelection,
  type AcpSessionConfigCandidates,
  type AcpSessionConfigPreferences,
  type AcpSessionConfigSelectionInputs,
  type AcpSessionSelectorOptionsInput,
  type AcpSessionUserConfigEdits,
  type ResolvedAcpSessionConfigSelection,
} from '@/lib/acp-session-config-selection';
import type { AcpSelectorTarget } from '@/components/shared/acp-selector-options';
import type { SessionRunConfigDraftScope } from '@/atoms/session-run-config-drafts';
import {
  useSessionRunConfigDraft,
  type SessionRunConfigModelContext,
} from './use-session-run-config-draft';

/**
 * ACP run-config selection remains a pure derivation. The only stored state is the
 * user's unsent edits; everything else derives per render
 * (`lib/acp-session-config-selection.ts` has the full story of the reconcile
 * loop this replaces — do not reintroduce a reducer that stores the resolved
 * selection or an effect that pushes inputs into it).
 *
 * Two stages, because the capability catalog itself depends on the selection
 * (Codex reasoning tiers follow the selected model; provisional menus are
 * enriched with an out-of-catalog value):
 *
 * 1. This hook returns UNVALIDATED `candidates` — feed those to
 *    `useSessionAcpSelectorContext`.
 * 2. `useResolvedAcpSessionConfigSelection(selection, selectorOptions)`
 *    validates the same inputs against the catalog those candidates produced.
 *
 * The fencing on (targetKey, preferenceRevision) happens as a render-phase
 * state adjustment: it depends only on those two inputs — never on anything
 * derived from the selection — so it settles in one extra render.
 */

type EditsFence = {
  targetKey: string | null;
  preferenceRevision: string | null;
  edits: AcpSessionUserConfigEdits;
};

type ResolvedSelectorHint = {
  resolvedModelId: string | null;
  modelConfigId: string | null;
  perModelConfigIds: ReadonlySet<string>;
};

const EMPTY_STRING_SET: ReadonlySet<string> = new Set();
const resolvedHintBySelection = new WeakMap<
  AcpSessionConfigSelectionInputs,
  { current: ResolvedSelectorHint }
>();

const isPerModelConfigOption = (configId: string, extra: ReadonlySet<string>): boolean =>
  isModelScopedSessionDefaultConfigId(configId) || extra.has(configId);

const resolveEditsModelId = (
  edits: AcpSessionUserConfigEdits,
  fallbackModelId: string | null,
  modelConfigId: string | null
): string | null => {
  if (edits.model) return edits.model.value;
  const key = modelConfigId ?? 'model';
  const configModel = edits.configOptions[key] ?? edits.configOptions.model;
  if (typeof configModel === 'string') return configModel;
  return fallbackModelId;
};

const migrateFlatPerModelEdits = (
  edits: AcpSessionUserConfigEdits,
  outgoingModelId: string | null,
  nextModelId: string | null,
  perModelConfigIds: ReadonlySet<string>
): Pick<AcpSessionUserConfigEdits, 'configOptions' | 'modelConfigOptions'> => {
  if (!outgoingModelId || outgoingModelId === nextModelId) {
    return {
      configOptions: edits.configOptions,
      ...(edits.modelConfigOptions ? { modelConfigOptions: edits.modelConfigOptions } : {}),
    };
  }
  let moved = false;
  const remainingCommon: Record<string, AcpConfigOptionValue> = {};
  const outgoingEntries: Record<string, AcpConfigOptionValue> = {
    ...edits.modelConfigOptions?.[outgoingModelId],
  };
  for (const [configId, value] of Object.entries(edits.configOptions)) {
    if (isPerModelConfigOption(configId, perModelConfigIds)) {
      if (!(configId in outgoingEntries)) {
        outgoingEntries[configId] = value;
      }
      moved = true;
    } else {
      remainingCommon[configId] = value;
    }
  }
  if (!moved) {
    return {
      configOptions: edits.configOptions,
      ...(edits.modelConfigOptions ? { modelConfigOptions: edits.modelConfigOptions } : {}),
    };
  }
  const nextModelMap = {
    ...edits.modelConfigOptions,
    ...(Object.keys(outgoingEntries).length > 0 ? { [outgoingModelId]: outgoingEntries } : {}),
  };
  return {
    configOptions: remainingCommon,
    ...(Object.keys(nextModelMap).length > 0 ? { modelConfigOptions: nextModelMap } : {}),
  };
};

export type UseAcpSessionConfigSelectionStateArgs = {
  /** While false the selection derives from empty inputs and no fencing runs. */
  enabled?: boolean;
  targetKey: string | null;
  preferenceRevision: string;
  preferences: AcpSessionConfigPreferences;
  runtimePreferences?: AcpSessionConfigPreferences | null;
  preserveUnsentUserEdits?: boolean;
  /** Existing-session intent: only local accepted sends consume captured edits. */
  draftScope?: SessionRunConfigDraftScope;
};

const EMPTY_PREFERENCES: AcpSessionConfigPreferences = {};

export type AcpSessionConfigSelectionHandle = {
  /** Inputs for `useResolvedAcpSessionConfigSelection`; treat as opaque. */
  selection: AcpSessionConfigSelectionInputs;
  /** Unvalidated chain heads for capability lookups. */
  candidates: AcpSessionConfigCandidates;
  /**
   * The (targetKey, preferenceRevision) the current edits are fenced for.
   * Multi-step flows (a recent-run-config entry switching the agent before
   * writing its model) wait for these to catch up with what they set.
   */
  appliedTargetKey: string | null;
  appliedPreferenceRevision: string | null;
  /** Whether the current run config contains an unsent user edit. */
  hasUserEdits: boolean;
  selectMode: (value: string | null) => void;
  selectModel: (value: string | null) => void;
  selectConfigOption: (configId: string, value: AcpConfigOptionValue) => void;
  replaceConfigOptions: (values: Record<string, AcpConfigOptionValue>) => void;
  captureForSend: (inputConfig: AcpSessionConfigPreferences) => (() => void) | undefined;
};

export function useAcpSessionConfigSelectionState({
  enabled = true,
  targetKey,
  preferenceRevision,
  preferences,
  runtimePreferences,
  preserveUnsentUserEdits = false,
  draftScope,
}: UseAcpSessionConfigSelectionStateArgs): AcpSessionConfigSelectionHandle {
  const resolvedHintRef = useRef<ResolvedSelectorHint>({
    resolvedModelId: null,
    modelConfigId: null,
    perModelConfigIds: EMPTY_STRING_SET,
  });
  const modelContextRef = useRef<SessionRunConfigModelContext>({
    fallbackModelId: null,
    resolvedModelId: null,
    modelConfigId: null,
    perModelConfigIds: EMPTY_STRING_SET,
  });
  const draft = useSessionRunConfigDraft(draftScope, enabled, modelContextRef);
  const [fence, setFence] = useState<EditsFence>({
    targetKey: null,
    preferenceRevision: null,
    edits: EMPTY_ACP_SESSION_USER_CONFIG_EDITS,
  });

  if (
    !draftScope &&
    enabled &&
    (fence.targetKey !== targetKey || fence.preferenceRevision !== preferenceRevision)
  ) {
    setFence({
      targetKey,
      preferenceRevision,
      edits: fenceAcpSessionUserEdits(fence.edits, {
        targetChanged: fence.targetKey !== targetKey,
        preserveUnsentUserEdits,
        preferences,
      }),
    });
  }

  /* VALUE-stabilize the preference inputs. `preferences`/`runtimePreferences`
     are object literals resolved from `sessionDoc.history`, and the doc mirror
     rebuilds `history` with unchanged values on every merge frame while an
     agent streams. The reducer this hook replaced absorbed that churn by
     returning the same state object; without this cache the frame-fresh
     identities would miss every downstream memo — selector catalog rebuild and
     a composer-subtree re-render per document frame on the conversation hot
     path. Ref writes during render are safe here: a replaced value is always
     value-equal to what it replaces. */
  const stablePreferencesRef = useRef(preferences);
  if (!areAcpSessionConfigPreferencesEqual(stablePreferencesRef.current, preferences)) {
    stablePreferencesRef.current = preferences;
  }
  const stableRuntimePreferencesRef = useRef(runtimePreferences ?? null);
  if (
    !areAcpSessionConfigPreferencesEqual(
      stableRuntimePreferencesRef.current,
      runtimePreferences ?? null
    )
  ) {
    stableRuntimePreferencesRef.current = runtimePreferences ?? null;
  }

  const effectivePreferences = enabled ? stablePreferencesRef.current : EMPTY_PREFERENCES;
  const effectiveRuntimePreferences = enabled ? stableRuntimePreferencesRef.current : null;
  const fallbackModelId =
    effectiveRuntimePreferences?.modelId ??
    effectivePreferences.modelId ??
    (typeof effectiveRuntimePreferences?.configOptionValues?.model === 'string'
      ? effectiveRuntimePreferences.configOptionValues.model
      : typeof effectivePreferences.configOptionValues?.model === 'string'
        ? effectivePreferences.configOptionValues.model
        : null);
  modelContextRef.current = {
    fallbackModelId,
    resolvedModelId: resolvedHintRef.current.resolvedModelId,
    modelConfigId: resolvedHintRef.current.modelConfigId,
    perModelConfigIds: resolvedHintRef.current.perModelConfigIds,
  };

  const edits = enabled
    ? draftScope
      ? draft.edits
      : fence.edits
    : EMPTY_ACP_SESSION_USER_CONFIG_EDITS;

  const selection = useMemo<AcpSessionConfigSelectionInputs>(() => {
    const inputs: AcpSessionConfigSelectionInputs = {
      edits,
      preferences: effectivePreferences,
      runtimePreferences: effectiveRuntimePreferences,
    };
    resolvedHintBySelection.set(inputs, resolvedHintRef);
    return inputs;
  }, [edits, effectivePreferences, effectiveRuntimePreferences]);
  const candidates = useMemo(() => buildAcpSessionConfigCandidates(selection), [selection]);

  const selectMode = useCallback((value: string | null) => {
    setFence((prev) => ({ ...prev, edits: { ...prev.edits, mode: { value } } }));
  }, []);
  const selectModel = useCallback((value: string | null) => {
    setFence((prev) => {
      const ctx = modelContextRef.current;
      const outgoingModelId = resolveEditsModelId(
        prev.edits,
        ctx.fallbackModelId ?? ctx.resolvedModelId,
        ctx.modelConfigId
      );
      const migrated = migrateFlatPerModelEdits(
        prev.edits,
        outgoingModelId,
        value,
        ctx.perModelConfigIds
      );
      return {
        ...prev,
        edits: {
          ...(prev.edits.mode ? { mode: prev.edits.mode } : {}),
          model: { value },
          configOptions: migrated.configOptions,
          ...(migrated.modelConfigOptions
            ? { modelConfigOptions: migrated.modelConfigOptions }
            : {}),
        },
      };
    });
  }, []);
  const selectConfigOption = useCallback((configId: string, value: AcpConfigOptionValue) => {
    setFence((prev) => {
      const ctx = modelContextRef.current;
      const modelOptionId = ctx.modelConfigId ?? 'model';
      if (configId === modelOptionId && typeof value === 'string') {
        const outgoingModelId = resolveEditsModelId(
          prev.edits,
          ctx.fallbackModelId ?? ctx.resolvedModelId,
          modelOptionId
        );
        const migrated = migrateFlatPerModelEdits(
          prev.edits,
          outgoingModelId,
          value,
          ctx.perModelConfigIds
        );
        return {
          ...prev,
          edits: {
            ...(prev.edits.mode ? { mode: prev.edits.mode } : {}),
            ...(prev.edits.model ? { model: prev.edits.model } : {}),
            configOptions: { ...migrated.configOptions, [configId]: value },
            ...(migrated.modelConfigOptions
              ? { modelConfigOptions: migrated.modelConfigOptions }
              : {}),
          },
        };
      }
      if (isPerModelConfigOption(configId, ctx.perModelConfigIds)) {
        const activeModelId = resolveEditsModelId(prev.edits, ctx.fallbackModelId, modelOptionId);
        if (activeModelId) {
          const nextCommon = { ...prev.edits.configOptions };
          delete nextCommon[configId];
          return {
            ...prev,
            edits: {
              ...prev.edits,
              configOptions: nextCommon,
              modelConfigOptions: {
                ...prev.edits.modelConfigOptions,
                [activeModelId]: {
                  ...prev.edits.modelConfigOptions?.[activeModelId],
                  [configId]: value,
                },
              },
            },
          };
        }
      }
      return {
        ...prev,
        edits: {
          ...prev.edits,
          configOptions: { ...prev.edits.configOptions, [configId]: value },
        },
      };
    });
  }, []);
  const replaceConfigOptions = useCallback((values: Record<string, AcpConfigOptionValue>) => {
    setFence((prev) => ({
      ...prev,
      edits: {
        ...(prev.edits.mode ? { mode: prev.edits.mode } : {}),
        ...(prev.edits.model ? { model: prev.edits.model } : {}),
        configOptions: { ...values },
      },
    }));
  }, []);

  return {
    selection,
    candidates,
    appliedTargetKey: draftScope ? targetKey : fence.targetKey,
    appliedPreferenceRevision: draftScope ? preferenceRevision : fence.preferenceRevision,
    hasUserEdits:
      edits.mode !== undefined ||
      edits.model !== undefined ||
      Object.keys(edits.configOptions).length > 0 ||
      Object.keys(edits.modelConfigOptions ?? {}).length > 0,
    selectMode: draftScope ? draft.selectMode : selectMode,
    selectModel: draftScope ? draft.selectModel : selectModel,
    selectConfigOption: draftScope ? draft.selectConfigOption : selectConfigOption,
    replaceConfigOptions: draftScope ? draft.replaceConfigOptions : replaceConfigOptions,
    captureForSend: draft.captureForSend,
  };
}

export function useResolvedAcpSessionConfigSelection(
  selection: AcpSessionConfigSelectionInputs,
  selectorOptions: AcpSessionSelectorOptionsInput,
  /**
   * Agent identity for model-dependent selector normalization (Codex reasoning
   * tiers follow the RESOLVED model, not the unvalidated candidate).
   */
  target?: Pick<AcpSelectorTarget, 'cliType' | 'agentType'>
): ResolvedAcpSessionConfigSelection {
  const cliType = target?.cliType ?? null;
  const agentType = target?.agentType ?? null;
  const resolved = useMemo(
    () => resolveAcpSessionConfigSelection(selection, selectorOptions, { cliType, agentType }),
    [agentType, cliType, selection, selectorOptions]
  );
  const hintSlot = resolvedHintBySelection.get(selection);
  if (hintSlot) {
    const genericModel =
      selectorOptions.modelOptions.length === 0
        ? selectorOptions.configOptionSelectors.find(
            (selector) => selector.category === 'model' && selector.type === 'select'
          )
        : undefined;
    const genericModelValue = genericModel
      ? resolved.configOptionValues[genericModel.configId]
      : undefined;
    const resolvedModelId = genericModel
      ? typeof genericModelValue === 'string'
        ? genericModelValue
        : typeof genericModel.currentValue === 'string'
          ? genericModel.currentValue
          : null
      : resolved.selectedModelId;
    const perModelIds = new Set<string>();
    for (const selector of selectorOptions.unnormalizedConfigOptionSelectors ??
      resolved.configOptionSelectors) {
      if (isPerModelSelector(selector)) perModelIds.add(selector.configId);
    }
    for (const selector of resolved.configOptionSelectors) {
      if (isPerModelSelector(selector)) perModelIds.add(selector.configId);
    }
    hintSlot.current = {
      resolvedModelId,
      modelConfigId: genericModel?.configId ?? null,
      perModelConfigIds: perModelIds,
    };
  }
  return resolved;
}

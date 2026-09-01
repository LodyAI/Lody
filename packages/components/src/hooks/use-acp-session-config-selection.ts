import { useCallback, useMemo, useRef, useState } from 'react';
import type { AcpConfigOptionValue } from '@lody/shared';
import {
  areAcpSessionConfigPreferencesEqual,
  buildAcpSessionConfigCandidates,
  EMPTY_ACP_SESSION_USER_CONFIG_EDITS,
  fenceAcpSessionUserEdits,
  resolveAcpSessionConfigSelection,
  type AcpSessionConfigCandidates,
  type AcpSessionConfigPreferences,
  type AcpSessionConfigSelectionInputs,
  type AcpSessionSelectorOptionsInput,
  type AcpSessionUserConfigEdits,
  type ResolvedAcpSessionConfigSelection,
} from '@/lib/acp-session-config-selection';

/**
 * ACP run-config selection with NO effects. The only stored state is the
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

export type UseAcpSessionConfigSelectionStateArgs = {
  /** While false the selection derives from empty inputs and no fencing runs. */
  enabled?: boolean;
  targetKey: string | null;
  preferenceRevision: string;
  preferences: AcpSessionConfigPreferences;
  runtimePreferences?: AcpSessionConfigPreferences | null;
  preserveUnsentUserEdits?: boolean;
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
  selectMode: (value: string | null) => void;
  selectModel: (value: string | null) => void;
  selectConfigOption: (configId: string, value: AcpConfigOptionValue) => void;
  replaceConfigOptions: (values: Record<string, AcpConfigOptionValue>) => void;
};

export function useAcpSessionConfigSelectionState({
  enabled = true,
  targetKey,
  preferenceRevision,
  preferences,
  runtimePreferences,
  preserveUnsentUserEdits = false,
}: UseAcpSessionConfigSelectionStateArgs): AcpSessionConfigSelectionHandle {
  const [fence, setFence] = useState<EditsFence>({
    targetKey: null,
    preferenceRevision: null,
    edits: EMPTY_ACP_SESSION_USER_CONFIG_EDITS,
  });

  if (
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
  const edits = enabled ? fence.edits : EMPTY_ACP_SESSION_USER_CONFIG_EDITS;

  const selection = useMemo<AcpSessionConfigSelectionInputs>(
    () => ({
      edits,
      preferences: effectivePreferences,
      runtimePreferences: effectiveRuntimePreferences,
    }),
    [edits, effectivePreferences, effectiveRuntimePreferences]
  );
  const candidates = useMemo(() => buildAcpSessionConfigCandidates(selection), [selection]);

  const selectMode = useCallback((value: string | null) => {
    setFence((prev) => ({ ...prev, edits: { ...prev.edits, mode: { value } } }));
  }, []);
  const selectModel = useCallback((value: string | null) => {
    setFence((prev) => ({ ...prev, edits: { ...prev.edits, model: { value } } }));
  }, []);
  const selectConfigOption = useCallback((configId: string, value: AcpConfigOptionValue) => {
    setFence((prev) => ({
      ...prev,
      edits: {
        ...prev.edits,
        configOptions: { ...prev.edits.configOptions, [configId]: value },
      },
    }));
  }, []);
  const replaceConfigOptions = useCallback((values: Record<string, AcpConfigOptionValue>) => {
    setFence((prev) => ({
      ...prev,
      edits: { ...prev.edits, configOptions: { ...values } },
    }));
  }, []);

  return {
    selection,
    candidates,
    appliedTargetKey: fence.targetKey,
    appliedPreferenceRevision: fence.preferenceRevision,
    selectMode,
    selectModel,
    selectConfigOption,
    replaceConfigOptions,
  };
}

export function useResolvedAcpSessionConfigSelection(
  selection: AcpSessionConfigSelectionInputs,
  selectorOptions: AcpSessionSelectorOptionsInput
): ResolvedAcpSessionConfigSelection {
  return useMemo(
    () => resolveAcpSessionConfigSelection(selection, selectorOptions),
    [selection, selectorOptions]
  );
}

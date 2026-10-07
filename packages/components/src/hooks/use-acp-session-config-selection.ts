import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { atom, useAtom } from 'jotai';
import { atomFamily } from 'jotai/utils';
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
import type { AcpSelectorTarget } from '@/components/shared/acp-selector-options';

/**
 * ACP run-config selection is derived. The only stored state is the
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
 * Existing-session drafts live in session-keyed app state, so navigation cannot
 * discard them. Fencing derives synchronously; an effect only commits consumed
 * user edits and observed Turn identities, never resolved selection values.
 */

type EditsFence = {
  targetKey: string | null;
  preferenceRevision: string | null;
  edits: AcpSessionUserConfigEdits;
  knownPreferenceRevisions: readonly string[];
};

const EMPTY_EDITS_FENCE: EditsFence = {
  targetKey: null,
  preferenceRevision: null,
  edits: EMPTY_ACP_SESSION_USER_CONFIG_EDITS,
  knownPreferenceRevisions: [],
};

// App-store scoped, like existing-session Role drafts. No storage or shared
// SessionDoc write: only sending a Turn publishes these private choices.
const sessionConfigEditsAtomFamily = atomFamily((_sessionKey: string) => atom(EMPTY_EDITS_FENCE));

function resolveEditsFence(
  fence: EditsFence,
  args: UseAcpSessionConfigSelectionStateArgs
): EditsFence {
  if (args.enabled === false) return fence;
  const targetChanged = fence.targetKey !== args.targetKey;
  const revisionChanged = fence.preferenceRevision !== args.preferenceRevision;
  const known = targetChanged ? [] : fence.knownPreferenceRevisions;
  const knownSet = new Set(known);
  const incoming = [...(args.knownPreferenceRevisions ?? []), args.preferenceRevision];
  const hasNewKnownRevision = incoming.some((revision) => !knownSet.has(revision));
  if (!targetChanged && !revisionChanged && !hasNewKnownRevision) return fence;
  return {
    targetKey: args.targetKey,
    preferenceRevision: args.preferenceRevision,
    knownPreferenceRevisions: args.knownPreferenceRevisions
      ? hasNewKnownRevision
        ? [...new Set([...known, ...incoming])]
        : known
      : [args.preferenceRevision],
    edits:
      targetChanged ||
      (revisionChanged &&
        (!args.knownPreferenceRevisions || !knownSet.has(args.preferenceRevision)))
        ? fenceAcpSessionUserEdits(fence.edits, {
            targetChanged,
            preserveUnsentUserEdits: args.preserveUnsentUserEdits ?? false,
            preferences: args.preferences,
          })
        : fence.edits,
  };
}

export type UseAcpSessionConfigSelectionStateArgs = {
  /** While false the selection derives from empty inputs and no fencing runs. */
  enabled?: boolean;
  targetKey: string | null;
  preferenceRevision: string;
  preferences: AcpSessionConfigPreferences;
  runtimePreferences?: AcpSessionConfigPreferences | null;
  preserveUnsentUserEdits?: boolean;
  /** Existing-session drafts survive composer remounts in this app store. */
  sessionKey?: string;
  /** Known logical Turns: promotion, rollback and backfill are not new input. */
  knownPreferenceRevisions?: readonly string[];
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
};

export function useAcpSessionConfigSelectionState({
  enabled = true,
  targetKey,
  preferenceRevision,
  preferences,
  runtimePreferences,
  preserveUnsentUserEdits = false,
  sessionKey,
  knownPreferenceRevisions,
}: UseAcpSessionConfigSelectionStateArgs): AcpSessionConfigSelectionHandle {
  const [localFenceAtom] = useState(() => atom(EMPTY_EDITS_FENCE));
  const [storedFence, setFence] = useAtom(
    sessionKey ? sessionConfigEditsAtomFamily(sessionKey) : localFenceAtom
  );

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

  const stableKnownRevisionsRef = useRef(knownPreferenceRevisions);
  if (
    stableKnownRevisionsRef.current?.length !== knownPreferenceRevisions?.length ||
    knownPreferenceRevisions?.some(
      (revision, index) => stableKnownRevisionsRef.current?.[index] !== revision
    )
  ) {
    stableKnownRevisionsRef.current = knownPreferenceRevisions;
  }
  const stableKnownRevisions = stableKnownRevisionsRef.current;

  const effectivePreferences = enabled ? stablePreferencesRef.current : EMPTY_PREFERENCES;
  const effectiveRuntimePreferences = enabled ? stableRuntimePreferencesRef.current : null;
  const fence = useMemo(
    () =>
      resolveEditsFence(storedFence, {
        enabled,
        targetKey,
        preferenceRevision,
        preferences: effectivePreferences,
        preserveUnsentUserEdits,
        knownPreferenceRevisions: stableKnownRevisions,
      }),
    [
      storedFence,
      enabled,
      targetKey,
      preferenceRevision,
      effectivePreferences,
      preserveUnsentUserEdits,
      stableKnownRevisions,
    ]
  );
  useEffect(() => {
    if (fence === storedFence) return;
    // Do not overwrite an edit made after this render (or by another mounted
    // surface). Resolved values never feed back into the draft atom.
    setFence((current) => (current === storedFence ? fence : current));
  }, [fence, setFence, storedFence]);
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

  const updateEdits = useCallback(
    (update: (edits: AcpSessionUserConfigEdits) => AcpSessionUserConfigEdits) => {
      setFence((previous) => {
        const current = resolveEditsFence(previous, {
          enabled,
          targetKey,
          preferenceRevision,
          preferences: effectivePreferences,
          preserveUnsentUserEdits,
          knownPreferenceRevisions: stableKnownRevisions,
        });
        return { ...current, edits: update(current.edits) };
      });
    },
    [
      enabled,
      targetKey,
      preferenceRevision,
      effectivePreferences,
      preserveUnsentUserEdits,
      stableKnownRevisions,
      setFence,
    ]
  );
  const selectMode = useCallback(
    (value: string | null) => {
      updateEdits((previousEdits) => ({ ...previousEdits, mode: { value } }));
    },
    [updateEdits]
  );
  const selectModel = useCallback(
    (value: string | null) => {
      updateEdits((previousEdits) => ({ ...previousEdits, model: { value } }));
    },
    [updateEdits]
  );
  const selectConfigOption = useCallback(
    (configId: string, value: AcpConfigOptionValue) => {
      updateEdits((previousEdits) => ({
        ...previousEdits,
        configOptions: { ...previousEdits.configOptions, [configId]: value },
      }));
    },
    [updateEdits]
  );
  const replaceConfigOptions = useCallback(
    (values: Record<string, AcpConfigOptionValue>) => {
      updateEdits((previousEdits) => ({ ...previousEdits, configOptions: { ...values } }));
    },
    [updateEdits]
  );

  return {
    selection,
    candidates,
    appliedTargetKey: fence.targetKey,
    appliedPreferenceRevision: fence.preferenceRevision,
    hasUserEdits:
      edits.mode !== undefined ||
      edits.model !== undefined ||
      Object.keys(edits.configOptions).length > 0,
    selectMode,
    selectModel,
    selectConfigOption,
    replaceConfigOptions,
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
  return useMemo(
    () => resolveAcpSessionConfigSelection(selection, selectorOptions, { cliType, agentType }),
    [agentType, cliType, selection, selectorOptions]
  );
}

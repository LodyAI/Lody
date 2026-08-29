import { useCallback, useLayoutEffect, useMemo, useReducer } from 'react';
import type { AcpConfigOptionValue } from '@lody/shared';
import type { AcpSelectorOptions } from '@/components/shared/acp-selector-options';
import {
  createEmptyAcpSessionConfigSelectionState,
  getAcpSessionConfigOptionValues,
  reduceAcpSessionConfigSelection,
  type AcpSessionConfigPreferences,
} from '@/lib/acp-session-config-selection';

export function useAcpSessionConfigSelectionState() {
  const [state, dispatch] = useReducer(
    reduceAcpSessionConfigSelection,
    undefined,
    createEmptyAcpSessionConfigSelectionState
  );
  const configOptionValues = useMemo(() => getAcpSessionConfigOptionValues(state), [state]);
  const selectMode = useCallback(
    (value: string | null) => dispatch({ type: 'select-mode', value }),
    []
  );
  const selectModel = useCallback(
    (value: string | null) => dispatch({ type: 'select-model', value }),
    []
  );
  const selectConfigOption = useCallback(
    (configId: string, value: AcpConfigOptionValue) =>
      dispatch({ type: 'select-config-option', configId, value }),
    []
  );
  const replaceConfigOptions = useCallback(
    (values: Record<string, AcpConfigOptionValue>) =>
      dispatch({ type: 'replace-config-options', values }),
    []
  );

  return {
    state,
    selectedModeId: state.mode.value,
    selectedModelId: state.model.value,
    configOptionValues,
    selectMode,
    selectModel,
    selectConfigOption,
    replaceConfigOptions,
    dispatch,
  };
}

export function useReconcileAcpSessionConfigSelection({
  enabled = true,
  targetKey,
  preferenceRevision,
  preferences,
  runtimePreferences,
  preserveUnsentUserEdits = false,
  selectorOptions,
  dispatch,
}: {
  enabled?: boolean;
  targetKey: string | null;
  preferenceRevision: string;
  preferences: AcpSessionConfigPreferences;
  runtimePreferences?: AcpSessionConfigPreferences | null;
  preserveUnsentUserEdits?: boolean;
  selectorOptions: AcpSelectorOptions;
  dispatch: ReturnType<typeof useAcpSessionConfigSelectionState>['dispatch'];
}) {
  useLayoutEffect(() => {
    if (!enabled) return;
    dispatch({
      type: 'reconcile',
      targetKey,
      preferenceRevision,
      preferences,
      preserveUnsentUserEdits,
      ...selectorOptions,
    });
    if (runtimePreferences) {
      dispatch({
        type: 'apply-runtime-preferences',
        preferences: runtimePreferences,
        ...selectorOptions,
      });
    }
  }, [
    dispatch,
    enabled,
    preferenceRevision,
    preferences,
    preserveUnsentUserEdits,
    runtimePreferences,
    selectorOptions,
    targetKey,
  ]);
}

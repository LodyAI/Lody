import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { AcpModelConfigOptionsSource, AcpModelControls } from '@lody/shared';
import {
  buildAcpSelectorOptions,
  type AcpConfigOptionSelector,
  type AcpSelectorOptions,
  type AcpSelectorTarget,
} from '@/components/shared/acp-selector-options';
import { localizeBuiltinGrokSelectorOptions } from '@/lib/grok-acp-selector-i18n';

/**
 * Hook that builds ACP selector options for the given target.
 *
 * Mode/model names and descriptions are taken verbatim from agent-reported
 * capabilities. The Lody-owned builtin Grok compatibility options are localized
 * because those strings are synthesized by Lody rather than authored upstream.
 */
export function useAcpSelectorOptions(target?: AcpSelectorTarget): AcpSelectorOptions {
  const { t } = useTranslation();
  const targetConfigId = target?.configId;
  const targetCliType = target?.cliType;
  const targetAgentType = target?.agentType;
  const targetSelectedModeId = target?.selectedModeId;
  const targetSelectedModelId = target?.selectedModelId;
  const targetConfigOptionValues = target?.configOptionValues;
  const targetRuntimeOverrides = target?.runtimeOverrides;
  const targetMachine = target?.machine;

  return useMemo(() => {
    const options = buildAcpSelectorOptions(
      targetCliType && targetAgentType
        ? {
            configId: targetConfigId,
            cliType: targetCliType,
            agentType: targetAgentType,
            selectedModeId: targetSelectedModeId,
            selectedModelId: targetSelectedModelId,
            configOptionValues: targetConfigOptionValues,
            runtimeOverrides: targetRuntimeOverrides,
            machine: targetMachine,
          }
        : undefined
    );
    return targetCliType === 'builtin' && targetAgentType?.toLowerCase() === 'grok'
      ? localizeBuiltinGrokSelectorOptions(options, t)
      : options;
  }, [
    targetConfigId,
    targetMachine,
    targetAgentType,
    targetCliType,
    targetConfigOptionValues,
    targetRuntimeOverrides,
    targetSelectedModeId,
    targetSelectedModelId,
    t,
  ]);
}

/**
 * Per-model selector lookup: the config options a model would show if it were
 * selected, without changing the selection. Used by pickers that compare
 * controls across models (the Devin Fusion builder). Falls back to empty
 * selectors when the target lacks an agent identity.
 */
export type AcpModelSelectorResolver = (modelId: string) => {
  selectors: AcpConfigOptionSelector[];
  source: AcpModelConfigOptionsSource | undefined;
  /** The adapter's own declaration for this model, when it published one. */
  declared?: AcpModelControls;
};

export function useAcpModelSelectorResolver(target?: AcpSelectorTarget): AcpModelSelectorResolver {
  const { t } = useTranslation();
  return useCallback(
    (modelId) => {
      const resolved =
        target?.cliType && target.agentType
          ? buildAcpSelectorOptions({ ...target, selectedModelId: modelId })
          : buildAcpSelectorOptions(undefined);
      const options =
        target?.cliType === 'builtin' && target.agentType?.toLowerCase() === 'grok'
          ? localizeBuiltinGrokSelectorOptions(resolved, t)
          : resolved;
      return {
        selectors: options.configOptionSelectors,
        source: options.modelConfigOptionsSource,
        declared: options.declaredModelControls?.[modelId],
      };
    },
    [target, t]
  );
}

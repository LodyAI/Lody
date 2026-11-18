import { useNativeMachineCatalogPublicReader } from './use-native-machine-catalog-public';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buildAcpSelectorOptions,
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
  const nativeReader = useNativeMachineCatalogPublicReader();
  const machineId = target?.machineId ?? target?.machine?.id;
  const native = machineId ? nativeReader(machineId) : undefined;
  const nativeSelected = target?.nativeSelected ?? native?.kind === 'native';
  const nativeCapability =
    target?.nativeCapability ??
    (native?.kind === 'native' && target?.configId && target.cliType && target.agentType
      ? native.capability({
          id: target.configId,
          machineId: machineId!,
          cliType: target.cliType,
          agentType: target.agentType,
        })
      : undefined);
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
            nativeSelected,
            nativeCapability,
          }
        : undefined
    );
    return targetCliType === 'builtin' && targetAgentType?.toLowerCase() === 'grok'
      ? localizeBuiltinGrokSelectorOptions(options, t)
      : options;
  }, [
    targetConfigId,
    targetMachine,
    nativeSelected,
    nativeCapability,
    targetAgentType,
    targetCliType,
    targetConfigOptionValues,
    targetRuntimeOverrides,
    targetSelectedModeId,
    targetSelectedModelId,
    t,
  ]);
}

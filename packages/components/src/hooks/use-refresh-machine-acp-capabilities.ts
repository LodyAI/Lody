import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { AgentConfigId, MachineAcpBinaryProgressMessage, MachineId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { resyncMachineFlockRows } from '@/hooks/use-machine-flock-rows';

/** The model a refresh is reading options for, `index` of `total` (1-based). */
export type AcpModelOptionsRefreshProgress = {
  modelId: string;
  modelName: string;
  index: number;
  total: number;
};

export const toAcpModelOptionsRefreshProgress = (
  progress: MachineAcpBinaryProgressMessage
): AcpModelOptionsRefreshProgress | null =>
  progress.status === 'reading-model-options' &&
  progress.modelId !== undefined &&
  progress.modelIndex !== undefined &&
  progress.modelCount !== undefined
    ? {
        modelId: progress.modelId,
        modelName: progress.modelName ?? progress.modelId,
        index: progress.modelIndex,
        total: progress.modelCount,
      }
    : null;

/**
 * Starts the agent on its machine to read its capabilities again, switching it
 * to every model to record that model's own options. A person asked for this,
 * so it has no overall deadline; `onModelOptionsProgress` names each model as
 * it is read. Machines that cannot read models refresh as before. A response
 * that only says authentication is required is returned, not thrown: for a
 * Provider without credentials that is the expected next step.
 */
export function useRefreshMachineAcpCapabilities() {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  return useCallback(
    async (args: {
      machineId: MachineId;
      configId: AgentConfigId;
      onModelOptionsProgress?: (progress: AcpModelOptionsRefreshProgress) => void;
    }) => {
      if (!runtime || !workspaceId) {
        throw new Error(t('chat.validation.missingContext', 'Missing workspace context'));
      }
      const response = await runtime.requestMachineAcpCapabilitiesRefresh(
        {
          type: 'machine/acp-capabilities-refresh',
          machineId: args.machineId,
          workspaceId,
          configId: args.configId,
          // A person pressed refresh because they changed something Lody cannot
          // see in the launch inputs, so this path always starts the agent.
          force: true,
          readModelOptions: true,
        },
        {
          onProgress: (progress) => {
            if (progress.configId !== undefined && progress.configId !== args.configId) return;
            const modelProgress = toAcpModelOptionsRefreshProgress(progress);
            if (modelProgress) args.onModelOptionsProgress?.(modelProgress);
          },
        }
      );
      if (!response) {
        throw new Error(
          t('agents.acpCapabilities.refreshTimeout', 'Refresh timed out, please try again')
        );
      }
      if (!response.success) {
        if (response.authRequired) {
          return response;
        }
        const errorMessage =
          typeof response.error === 'string' && response.error.length > 0
            ? response.error
            : t('agents.acpCapabilities.refreshError', 'Refresh failed');
        throw new Error(errorMessage);
      }
      // The CLI wrote the fresh capabilities to the machine flock doc, which the
      // web only syncs once per session; force a re-sync so chat landing and the
      // settings dialog reflect the new modes/models without a reload.
      await resyncMachineFlockRows(runtime, args.machineId, {
        refreshedCapability: response.capability
          ? { configId: response.configId, value: response.capability }
          : undefined,
      });
      return response;
    },
    [runtime, t, workspaceId]
  );
}

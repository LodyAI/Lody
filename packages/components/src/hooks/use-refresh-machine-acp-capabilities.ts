import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { resyncMachineFlockRows } from '@/hooks/use-machine-flock-rows';

/**
 * Starts the agent on its machine to read its capabilities again. A response that
 * only says authentication is required is returned, not thrown: for a Provider
 * without credentials that is the expected next step.
 */
export function useRefreshMachineAcpCapabilities() {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  return useCallback(
    async (args: { machineId: MachineId; configId: AgentConfigId }) => {
      if (!runtime || !workspaceId) {
        throw new Error(t('chat.validation.missingContext', 'Missing workspace context'));
      }
      const response = await runtime.requestMachineAcpCapabilitiesRefresh({
        type: 'machine/acp-capabilities-refresh',
        machineId: args.machineId,
        workspaceId,
        configId: args.configId,
        // A person pressed refresh because they changed something Lody cannot
        // see in the launch inputs, so this path always starts the agent.
        force: true,
      });
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

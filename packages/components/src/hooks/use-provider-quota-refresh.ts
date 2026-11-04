import { useCallback, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { onlineMachineIdsAtom } from '@/atoms/presence';

/** Visible consumers share the workspace transport and daemon's Provider request owner. */
export function useProviderQuotaRefresh(
  machineId: MachineId | null | undefined,
  configId: AgentConfigId | null | undefined,
  enabled: boolean
) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const online = useAtomValue(onlineMachineIdsAtom);
  const isOnline = !!machineId && online.has(machineId);
  const refresh = useCallback(() => {
    if (!enabled || !isOnline || !machineId || !configId || !runtime) return;
    void runtime.requestProviderRateLimitsRefresh?.(machineId, configId);
  }, [runtime, machineId, configId, enabled, isOnline]);
  useEffect(() => {
    if (!enabled) return undefined;
    const visibleRefresh = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    visibleRefresh();
    document.addEventListener('visibilitychange', visibleRefresh);
    return () => document.removeEventListener('visibilitychange', visibleRefresh);
  }, [enabled, refresh]);
  return refresh;
}

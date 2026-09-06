import type { MachineId } from '@lody/shared';
import { useAtomValue } from 'jotai';
import { useEffect, useState } from 'react';

import { localMachineIdAtom } from '@/atoms/local-probe';
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { getIpcServices } from '@/lib/electron-ipc-client';

/** Account controls use the same confirmed local route as their runtime requests. */
export function useLocalAccountProfilesRoute(machineId: MachineId, enabled = true): boolean {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const hasIpc = typeof window !== 'undefined' && !!window.__LODY_ELECTRON__ && !!getIpcServices();
  const [route, setRoute] = useState<{
    runtime: WorkspaceRuntime;
    machineId: MachineId;
    localMachineId: typeof localMachineId;
    local: boolean;
  } | null>(null);

  useEffect(() => {
    setRoute(null);
    if (!enabled || !hasIpc || !runtime) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const plane = await runtime.resolveMachineTargetPlane(machineId);
        if (!cancelled) {
          setRoute({ runtime, machineId, localMachineId, local: plane === 'local' });
        }
      } catch {
        // Pending or unavailable routes must never expose controls that cannot run locally.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, hasIpc, runtime, machineId, localMachineId]);

  return (
    enabled &&
    hasIpc &&
    route?.runtime === runtime &&
    route?.machineId === machineId &&
    route?.localMachineId === localMachineId &&
    route?.local === true
  );
}

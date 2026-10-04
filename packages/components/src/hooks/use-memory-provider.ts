import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { MachineId, MemoryCreateInput, MemoryProviderResponse } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';

/** Results belong to one runtime/machine/provider; late replies cannot retarget the UI. */
export function useMemoryProvider(
  machineId: MachineId | null,
  providerId: string,
  enabled: boolean
) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const generation = useRef(0);
  const [state, setState] = useState<{
    runtime: typeof runtime;
    machineId: MachineId | null;
    providerId: string;
    result?: MemoryProviderResponse;
    busy: boolean;
  }>();
  const request = useCallback(
    async (input?: MemoryCreateInput) => {
      if (!runtime || !machineId || !enabled) return undefined;
      const current = ++generation.current;
      setState({ runtime, machineId, providerId, busy: true });
      const result = await runtime.requestMemoryProvider(
        machineId,
        input ? { action: 'create', providerId, input } : { action: 'list', providerId }
      );
      if (generation.current === current)
        setState({ runtime, machineId, providerId, result, busy: false });
      return generation.current === current ? result : undefined;
    },
    [runtime, machineId, providerId, enabled]
  );
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    void request();
    return invalidate;
  }, [request, invalidate]);
  const current =
    enabled &&
    state?.runtime === runtime &&
    state.machineId === machineId &&
    state.providerId === providerId;
  return {
    result: current ? state.result : undefined,
    busy: current ? state.busy : false,
    refresh: () => request(),
    create: request,
  };
}

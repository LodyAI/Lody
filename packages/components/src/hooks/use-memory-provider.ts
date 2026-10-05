import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { MachineId, MemoryCreateInput, MemoryProviderResponse } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';

/** Results belong to one runtime/machine/provider; late replies cannot retarget the UI. */
export function useMemoryProvider(
  machineId: MachineId | null,
  providerId: string,
  enabled: boolean,
  refreshToken = 0
) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const generation = useRef(0);
  const pending = useRef(0);
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
      setState((previous) => ({
        runtime,
        machineId,
        providerId,
        busy: true,
        result:
          previous?.runtime === runtime &&
          previous.machineId === machineId &&
          previous.providerId === providerId
            ? previous.result
            : undefined,
      }));
      pending.current++;
      let result: MemoryProviderResponse;
      try {
        result = await runtime.requestMemoryProvider(
          machineId,
          input ? { action: 'create', providerId, input } : { action: 'list', providerId }
        );
      } catch {
        result = { type: 'machine/memory', status: 'error', memories: [] };
      } finally {
        pending.current--;
      }
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
    if (!enabled) return invalidate;
    const refreshVisible = () => {
      if (document.visibilityState === 'visible' && pending.current === 0) void request();
    };
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    const timer = window.setInterval(refreshVisible, 30_000);
    return () => {
      invalidate();
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.clearInterval(timer);
    };
  }, [enabled, request, invalidate, refreshToken]);
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

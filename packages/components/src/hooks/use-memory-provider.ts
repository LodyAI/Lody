import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import type {
  MachineId,
  MemoryCreateInput,
  MemoryProviderRequest,
  MemoryProviderResponse,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';

/** A request minus the provider the hook is already bound to. */
type MemoryProviderCommand =
  | { action: 'create' | 'update'; input: MemoryCreateInput }
  | { action: 'connect' | 'disconnect'; targets: string[] }
  | { action: 'signIn' | 'signInPoll' | 'install' | 'installPoll' };

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
    async (command?: MemoryProviderCommand) => {
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
      const params: MemoryProviderRequest = !command
        ? { action: 'list', providerId }
        : 'input' in command
          ? { action: command.action, providerId, input: command.input }
          : 'targets' in command
            ? { action: command.action, providerId, targets: command.targets }
            : { action: command.action, providerId };
      let result: MemoryProviderResponse;
      try {
        result = await runtime.requestMemoryProvider(machineId, params);
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
    create: (input?: MemoryCreateInput) => request(input ? { action: 'create', input } : undefined),
    update: (input: MemoryCreateInput) => request({ action: 'update', input }),
    /** Agent-connect providers only; the reply carries the refreshed inventory. */
    connect: (targets: string[]) => request({ action: 'connect', targets }),
    disconnect: (targets: string[]) => request({ action: 'disconnect', targets }),
    /** Opens a browser sign-in; `signInPoll` asks whether it has been approved. */
    signIn: () => request({ action: 'signIn' }),
    signInPoll: () => request({ action: 'signInPoll' }),
    /** Puts the provider on the machine; `installPoll` watches the job land. */
    install: () => request({ action: 'install' }),
    installPoll: () => request({ action: 'installPoll' }),
  };
}

import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import type {
  MachineId,
  MachineLifecycleCapability,
  ManagedDaemonUpdateStatus,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';

/**
 * `machine/status` probe and optional update observation for a single machine's remote
 * restart/upgrade capability. Shared by the mobile machine-detail pane and the
 * desktop machine accordion so both surfaces know whether the daemon can be
 * remotely restarted/updated without duplicating the request/response wiring.
 */
export function useMachineLifecycleCapability({
  machineId,
  enabled,
  onUpdateStatus,
}: {
  machineId: MachineId | null;
  enabled: boolean;
  onUpdateStatus?: (status: ManagedDaemonUpdateStatus | null | undefined) => void;
}): MachineLifecycleCapability | null {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const [capability, setCapability] = useState<MachineLifecycleCapability | null>(null);

  useEffect(() => {
    setCapability(null);
    if (!runtime || !workspaceId || !machineId || !enabled) {
      onUpdateStatus?.(undefined);
      return undefined;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (cancelled) return;
      try {
        const responsePromise = runtime.waitForMachineStatusResponse(machineId, {
          timeoutMs: 30000,
        });
        runtime.sendControl({
          type: 'machine/status',
          machineId,
          workspaceId,
          ...(onUpdateStatus ? { includeDaemonUpdate: true } : {}),
        });
        const response = await responsePromise;
        if (cancelled) return;
        setCapability(response?.success ? (response.lifecycle ?? null) : null);
        onUpdateStatus?.(response?.success ? response.daemonUpdate : undefined);
        if (onUpdateStatus)
          timer = setTimeout(
            () => void read(),
            response?.daemonUpdate &&
              !['applied', 'rolled-back', 'failed'].includes(response.daemonUpdate.phase)
              ? 2000
              : 10000
          );
      } catch {
        if (cancelled) return;
        setCapability(null);
        onUpdateStatus?.(undefined);
        if (onUpdateStatus) timer = setTimeout(() => void read(), 10000);
      }
    };
    void read();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [machineId, enabled, runtime, workspaceId, onUpdateStatus]);

  return capability;
}

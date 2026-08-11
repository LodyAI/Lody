import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { type MachineId, type MachineMonitorSnapshot } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';

export type MachineMonitorViewState = 'disabled' | 'active';

export function useMachineMonitor(args: {
  machineId: MachineId | null;
  enabled: boolean;
  online: boolean;
}): {
  snapshot: MachineMonitorSnapshot | null;
  state: MachineMonitorViewState;
  refresh: () => void;
} {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const [snapshot, setSnapshot] = useState<MachineMonitorSnapshot | null>(null);
  const snapshotCacheRef = useRef(new Map<MachineId, MachineMonitorSnapshot>());
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible'
  );

  useEffect(() => {
    const onVisibilityChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    setSnapshot(args.machineId ? (snapshotCacheRef.current.get(args.machineId) ?? null) : null);
    if (!runtime || !args.enabled || !args.online || !args.machineId || !visible) return undefined;
    return runtime.subscribeMachineMonitor(args.machineId, (next) => {
      setSnapshot((current) => {
        if (!next) return current;
        if (next.machineId !== args.machineId) return current;
        if (current && next.updatedAtMs < current.updatedAtMs) return current;
        snapshotCacheRef.current.set(args.machineId, next);
        return next;
      });
    });
  }, [args.enabled, args.machineId, args.online, runtime, visible]);

  const refresh = useCallback(() => {
    if (runtime && args.machineId) runtime.forceMachineMonitorSample(args.machineId);
  }, [args.machineId, runtime]);

  if (!args.enabled || !args.online || !visible) {
    return { snapshot: null, state: 'disabled', refresh };
  }
  const visibleSnapshot =
    snapshot?.machineId === args.machineId
      ? snapshot
      : args.machineId
        ? (snapshotCacheRef.current.get(args.machineId) ?? null)
        : null;
  return { snapshot: visibleSnapshot, state: 'active', refresh };
}

import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import {
  ACP_CAPABILITY_ROW_FAMILIES,
  type MachineFlockRowMap,
  type MachineId,
  type MachineViewMeta,
} from '@lody/shared';

import { getMachineMetaByIdAtomFamily } from '@/atoms';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { nativeMachineCatalogSettingsAtom } from '@/atoms/native-machine-catalog';
import {
  mergeMachineFlockMachineMeta,
  replaceNativeMachineCatalogMeta,
} from '@/lib/machine-flock-machine-meta-overlay';
import { useMachineFlockRows } from '@/hooks/use-machine-flock-rows';

const RESOLVED_MACHINE_FLOCK_REMOTE_SYNC_DELAY_MS = 1000;

export type ResolvedMachineMeta = {
  machine: MachineViewMeta | null;
  machineFlockRows: MachineFlockRowMap;
};

export function useResolvedMachineMeta(
  machineId: MachineId | null | undefined
): ResolvedMachineMeta {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const nativeSnapshot = useAtomValue(nativeMachineCatalogSettingsAtom);
  const rawMachine = useAtomValue(getMachineMetaByIdAtomFamily(machineId ?? undefined));
  const machineFlockRows = useMachineFlockRows(machineId, {
    families: [
      'dotlodyPath',
      'localProject',
      'deleteLocalProjectCommand',
      ...ACP_CAPABILITY_ROW_FAMILIES,
      'rateLimit',
    ],
    remoteSyncDelayMs: RESOLVED_MACHINE_FLOCK_REMOTE_SYNC_DELAY_MS,
  });
  const machine = useMemo(() => {
    if (!rawMachine || !machineId) return null;
    return (
      replaceNativeMachineCatalogMeta(
        mergeMachineFlockMachineMeta(
          new Map([[machineId, rawMachine]]),
          new Map([[machineId, machineFlockRows]])
        ),
        runtime
      ).get(machineId) ?? rawMachine
    );
  }, [machineFlockRows, machineId, rawMachine, runtime, nativeSnapshot]);

  return { machine, machineFlockRows };
}

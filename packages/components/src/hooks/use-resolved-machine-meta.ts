import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import {
  ACP_CAPABILITY_ROW_FAMILIES,
  type MachineFlockRowMap,
  type MachineId,
  type MachineViewMeta,
} from '@lody/shared';

import { getMachineMetaByIdAtomFamily } from '@/atoms';
import { mergeMachineFlockMachineMeta } from '@/lib/machine-flock-machine-meta-overlay';
import { useMachineFlockRows } from '@/hooks/use-machine-flock-rows';

const RESOLVED_MACHINE_FLOCK_REMOTE_SYNC_DELAY_MS = 1000;

export type ResolvedMachineMeta = {
  machine: MachineViewMeta | null;
  machineFlockRows: MachineFlockRowMap;
};

export function useResolvedMachineMeta(
  machineId: MachineId | null | undefined
): ResolvedMachineMeta {
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
      mergeMachineFlockMachineMeta(
        new Map([[machineId, rawMachine]]),
        new Map([[machineId, machineFlockRows]])
      ).get(machineId) ?? rawMachine
    );
  }, [machineFlockRows, machineId, rawMachine]);

  return { machine, machineFlockRows };
}

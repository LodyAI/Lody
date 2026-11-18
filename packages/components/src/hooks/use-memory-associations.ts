import { nativeMachineCatalogSettingsAtom } from '@/atoms/native-machine-catalog';
import { useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  getMachineFlockMemories,
  machineFlockKeys,
  type MachineId,
  type MemoryAssociation,
  type MemoryBinding,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { applyMachineFlockRowEventsForMachineAtom } from '@/atoms/machine-flock';
import { useMachineFlockRowsByMachineIds } from './use-machine-flock-rows';
import { useMachineOnlineStatus } from './use-machine-online-status';
import {
  editMemoryAssociation,
  linkMemoryAssociation,
  unlinkMemoryAssociation,
} from '@/lib/memory-association-write';

export function useMemoryAssociations(machineId: MachineId) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  useAtomValue(nativeMachineCatalogSettingsAtom);
  const native = runtime?.ownsNativeMachineCatalog?.(machineId) === true;
  const nativeState = native
    ? runtime?.nativeMachineCatalogSource?.readProjection(machineId)
    : undefined;
  const publish = useSetAtom(applyMachineFlockRowEventsForMachineAtom);
  const online = useMachineOnlineStatus(machineId) === 'online';
  const rowsByMachineId = useMachineFlockRowsByMachineIds([machineId], {
    families: ['memory'],
    readLocal: true,
    syncRemote: true,
    remoteMachineIds: online ? [machineId] : [],
  });
  const entries = useMemo(
    () =>
      (native
        ? nativeState?.synced
          ? [...nativeState.projection.memories]
          : []
        : getMachineFlockMemories(rowsByMachineId.get(machineId) ?? {}, machineId)
      ).sort((a, b) => a.name.localeCompare(b.name)),
    [rowsByMachineId, machineId, native, nativeState]
  );
  const save = async (entry: MemoryAssociation, edit: boolean) => {
    if (!runtime || entry.machineId !== machineId)
      throw new Error('Memory workspace is unavailable');
    const saved = await (edit ? editMemoryAssociation : linkMemoryAssociation)(runtime, entry);
    if (!native)
      publish({
        workspaceId: runtime.workspaceId,
        machineId,
        events: [{ key: machineFlockKeys.memory(saved.providerId, saved.memoryId), value: saved }],
      });
  };
  return {
    entries,
    link: (entry: MemoryAssociation) => save(entry, false),
    edit: (entry: MemoryAssociation) => save(entry, true),
    remove: async (binding: MemoryBinding) => {
      if (!runtime) throw new Error('Memory workspace is unavailable');
      await unlinkMemoryAssociation(runtime, machineId, binding);
      if (!native)
        publish({
          workspaceId: runtime.workspaceId,
          machineId,
          events: [{ key: machineFlockKeys.memory(binding.providerId, binding.memoryId) }],
        });
    },
  };
}

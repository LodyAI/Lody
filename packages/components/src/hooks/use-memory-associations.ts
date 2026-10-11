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
      getMachineFlockMemories(rowsByMachineId.get(machineId) ?? {}, machineId).sort((a, b) =>
        a.name.localeCompare(b.name)
      ),
    [rowsByMachineId, machineId]
  );
  const save = async (entry: MemoryAssociation, edit: boolean) => {
    if (!runtime || entry.machineId !== machineId)
      throw new Error('Memory workspace is unavailable');
    const saved = await (edit ? editMemoryAssociation : linkMemoryAssociation)(runtime, entry);
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
      publish({
        workspaceId: runtime.workspaceId,
        machineId,
        events: [{ key: machineFlockKeys.memory(binding.providerId, binding.memoryId) }],
      });
    },
  };
}

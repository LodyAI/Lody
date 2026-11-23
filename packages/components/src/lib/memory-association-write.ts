import {
  getMachineFlockDocId,
  machineFlockKeys,
  MemoryAssociationSchema,
  type MachineId,
  type MemoryAssociation,
  type MemoryBinding,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';

type Runtime = Pick<WorkspaceRuntime, 'workspaceId' | 'writer' | 'repo'>;

function upload(runtime: Runtime, docId: string) {
  void runtime.repo
    .openFlockDoc(docId)
    .then((handle) => handle.syncOnce())
    .catch(() => {
      // The association is already locally durable. Its room will retry upload.
    });
}

/** Stable provider/identity keys deduplicate concurrent links without overwriting local edits. */
export async function linkMemoryAssociation(runtime: Runtime, input: MemoryAssociation) {
  const value = MemoryAssociationSchema.parse(input);
  const docId = getMachineFlockDocId(runtime.workspaceId, value.machineId as MachineId);
  const result = await runtime.writer.flockRowPutIfAbsent(
    docId,
    machineFlockKeys.memory(value.providerId, value.memoryId),
    value
  );
  const saved = MemoryAssociationSchema.parse(result.value);
  if (
    saved.machineId !== value.machineId ||
    saved.providerId !== value.providerId ||
    saved.memoryId !== value.memoryId
  )
    throw new Error('Invalid memory association');
  upload(runtime, docId);
  return saved;
}

export async function editMemoryAssociation(runtime: Runtime, input: MemoryAssociation) {
  const value = MemoryAssociationSchema.parse(input);
  const docId = getMachineFlockDocId(runtime.workspaceId, value.machineId as MachineId);
  const changed = await runtime.writer.flockRowUpdate(
    docId,
    machineFlockKeys.memory(value.providerId, value.memoryId),
    (current) => {
      const parsed = MemoryAssociationSchema.safeParse(current);
      if (
        !parsed.success ||
        parsed.data.machineId !== value.machineId ||
        parsed.data.providerId !== value.providerId ||
        parsed.data.memoryId !== value.memoryId
      )
        return undefined;
      return { ...parsed.data, name: value.name, description: value.description };
    }
  );
  if (!changed) throw new Error('Memory association no longer exists');
  upload(runtime, docId);
  return value;
}

/** Removing an association never deletes memories from its provider. */
export async function unlinkMemoryAssociation(
  runtime: Runtime,
  machineId: MachineId,
  binding: MemoryBinding
) {
  const docId = getMachineFlockDocId(runtime.workspaceId, machineId);
  await runtime.writer.flockRowDelete(
    docId,
    machineFlockKeys.memory(binding.providerId, binding.memoryId)
  );
  upload(runtime, docId);
}

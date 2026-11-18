import { nativeMachineCatalogSettingsForWrite } from './native-machine-catalog-public';
import {
  getMachineFlockDocId,
  machineFlockKeys,
  MemoryAssociationSchema,
  planMemoryAssociationWrite,
  type MachineId,
  type MemoryAssociation,
  type MemoryBinding,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';

type Runtime = Pick<WorkspaceRuntime, 'workspaceId' | 'writer' | 'repo'> &
  Partial<Pick<WorkspaceRuntime, 'ownsNativeMachineCatalog' | 'nativeMachineCatalogSource'>>;

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
  const catalog = nativeMachineCatalogSettingsForWrite(runtime, value.machineId as MachineId);
  if (catalog) {
    const receipt = await catalog.execute(value.machineId as MachineId, {
      kind: 'link-memory',
      association: value,
    });
    if (!receipt.association) throw new Error('Memory association acknowledgement is unavailable');
    return MemoryAssociationSchema.parse(receipt.association);
  }
  const docId = getMachineFlockDocId(runtime.workspaceId, value.machineId as MachineId);
  const result = await runtime.writer.flockRowPutIfAbsent(
    docId,
    machineFlockKeys.memory(value.providerId, value.memoryId),
    value
  );
  const saved = planMemoryAssociationWrite(result.value, value, 'link').association;
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
  const catalog = nativeMachineCatalogSettingsForWrite(runtime, value.machineId as MachineId);
  if (catalog) {
    const receipt = await catalog.execute(value.machineId as MachineId, {
      kind: 'edit-memory',
      association: value,
    });
    if (!receipt.association) throw new Error('Memory association acknowledgement is unavailable');
    return MemoryAssociationSchema.parse(receipt.association);
  }
  const docId = getMachineFlockDocId(runtime.workspaceId, value.machineId as MachineId);
  let saved: MemoryAssociation | undefined;
  const changed = await runtime.writer.flockRowUpdate(
    docId,
    machineFlockKeys.memory(value.providerId, value.memoryId),
    (current) => {
      if (current === undefined) throw new Error('Memory association no longer exists');
      const plan = planMemoryAssociationWrite(current, value, 'edit');
      saved = plan.association;
      return plan.value;
    }
  );
  if (!saved) throw new Error('Memory association no longer exists');
  if (changed) upload(runtime, docId);
  return saved;
}

/** Removing an association never deletes memories from its provider. */
export async function unlinkMemoryAssociation(
  runtime: Runtime,
  machineId: MachineId,
  binding: MemoryBinding
) {
  const catalog = nativeMachineCatalogSettingsForWrite(runtime, machineId);
  if (catalog) {
    await catalog.execute(machineId, {
      kind: 'remove-memory',
      providerId: binding.providerId,
      memoryId: binding.memoryId,
    });
    return;
  }
  const docId = getMachineFlockDocId(runtime.workspaceId, machineId);
  await runtime.writer.flockRowDelete(
    docId,
    machineFlockKeys.memory(binding.providerId, binding.memoryId)
  );
  upload(runtime, docId);
}

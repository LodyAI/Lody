import { collectScheduleIds, getScheduleRegistryFlockDocId, type WorkspaceId } from '@lody/shared';
import type { LoroDocumentManager } from '../loro/doc';
import { listAliveRoomIds } from '../command-runtime';

/** Discovery only. Never reconstruct an enabled Registry row from an orphan document. */
export async function listWorkspaceScheduleIds(
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId
): Promise<string[]> {
  const registry = await manager.repo.openFlockDoc(getScheduleRegistryFlockDocId(workspaceId));
  return collectScheduleIds(await listAliveRoomIds(manager, () => true), registry.flock.scan());
}

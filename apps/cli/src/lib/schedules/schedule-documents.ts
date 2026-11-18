import { collectScheduleIds, type WorkspaceId } from '@lody/shared';
import type { LoroDocumentManager } from '../loro/doc';
import { listAliveRoomIds } from '../command-runtime';

/** Discovery only. Never reconstruct an enabled Registry row from an orphan document. */
export async function listWorkspaceScheduleIds(
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId
): Promise<string[]> {
  if (workspaceId !== manager.scheduleRegistry.workspaceId)
    throw new Error('Schedule registry binding mismatch');
  const registry = await manager.scheduleRegistry.read();
  return [
    ...new Set([
      ...collectScheduleIds(await listAliveRoomIds(manager, () => true), []),
      ...registry.discoveryIds,
    ]),
  ].sort();
}

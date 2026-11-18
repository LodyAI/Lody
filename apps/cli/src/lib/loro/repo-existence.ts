import type { LoroDocumentManager } from './doc';
import {
  createLegacyWorkspaceDirectoryReader,
  type WorkspaceDirectoryReader,
} from '@lody/shared/workspace-directory';

type RepoExistenceManager = Pick<LoroDocumentManager, 'repo'> & {
  workspaceDirectory?: WorkspaceDirectoryReader;
};

export async function listAliveRoomIds(
  manager: RepoExistenceManager,
  predicate: (roomId: string) => boolean
): Promise<string[]> {
  // `e/<docId>` is loro-repo's authoritative existence index. Reading it also
  // avoids materializing every application metadata value under `m/<docId>/*`.
  const directory =
    manager.workspaceDirectory ?? createLegacyWorkspaceDirectoryReader(manager.repo);
  return (await directory.listActiveIds()).filter(predicate);
}

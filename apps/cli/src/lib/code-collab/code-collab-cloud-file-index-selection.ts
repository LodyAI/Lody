import type { LoroRepo } from 'loro-repo';
import type { WorkspaceId } from '@lody/shared';
import type { CodeCollabFileIndexBackend } from './code-collab-file-index-backend';
import { createLegacyCodeCollabPublicationStore } from './code-collab-publication-store';
export {
  cloudFileIndexAuthorityId,
  cloudFileIndexSelectionPath,
  readCloudFileIndexSelection,
  listCloudFileIndexSelections,
} from '@lody/shared/node/native-cloud-file-index-selection';

/** Failed FI recovery never blocks healthy Session/Meta work. Unknown corrupt
 * scope fences only this workspace's FI domain; known selection fences exactly
 * its persisted owners. No cloud requests, SDK host or mutation replay. */
export function unavailableCloudFileIndexBackend(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  owners: readonly string[] | null
): CodeCollabFileIndexBackend {
  const selected = owners === null ? null : new Set(owners);
  const owns = (room: string) =>
    [`${workspaceId}:fi:`, `${workspaceId}:fis:`].some(
      (prefix) =>
        room.startsWith(prefix) &&
        room.length > prefix.length &&
        (selected === null || selected.has(room.slice(prefix.length)))
    );
  const failed = () => new Error('Native Cloud FI/FIS backend recovery required');
  const open = repo.openFlockDoc.bind(repo);
  repo.openFlockDoc = (room, ...args) => {
    if (owns(room)) throw failed();
    return open(room, ...args);
  };
  const acquire = repo.acquireFlockDoc.bind(repo);
  repo.acquireFlockDoc = (room, ...args) => {
    if (owns(room)) throw failed();
    return acquire(room, ...args);
  };
  const joinRoom = repo.joinFlockDocRoom.bind(repo);
  repo.joinFlockDocRoom = (room, ...args) => {
    if (owns(room)) throw failed();
    return joinRoom(room, ...args);
  };
  const persist = repo.persistFlockDocNow.bind(repo);
  repo.persistFlockDocNow = (room, ...args) => {
    if (owns(room)) throw failed();
    return persist(room, ...args);
  };
  return {
    source: {
      async subscribe(owner, listener) {
        if (selected !== null && !selected.has(owner)) return null;
        listener({ status: 'error', code: 'native_cloud_index_recovery_required' });
        return { release: async () => {} };
      },
    },
    async ownsRoom(room) {
      return owns(room);
    },
    async store(owner) {
      if (selected === null || selected.has(owner)) throw failed();
      const legacy = createLegacyCodeCollabPublicationStore(repo);
      return {
        open(room, signal) {
          if (room !== `${workspaceId}:fi:${owner}` && room !== `${workspaceId}:fis:${owner}`)
            throw new Error('Cloud FI publication binding mismatch');
          return legacy.open(room, signal);
        },
      };
    },
    markPublished(owner) {
      if (selected === null || selected.has(owner)) throw failed();
    },
    async close() {},
  };
}

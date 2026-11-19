import type { JsonObject, LoroRepo } from 'loro-repo';
import type { BundleWorkspace } from './service';

type SyncingManager = {
  repo: LoroRepo<JsonObject>;
  syncMetaOrThrow(options: { reason?: string }): Promise<void>;
  syncDocOrThrow(docId: string, options: { reason?: string }): Promise<void>;
  syncFlockDocOrThrow(flockDocId: string, options: { reason?: string }): Promise<void>;
  getSessionHistorySnapshot(sessionId: string): Promise<readonly unknown[]>;
};

/** Adapts a workspace document manager; `sync` is false on the local platform. */
export function daemonBundleWorkspace(
  workspaceId: string,
  manager: SyncingManager,
  options: { sync: boolean }
): BundleWorkspace {
  const reason = 'workspace-bundle';
  return {
    id: workspaceId,
    repo: manager.repo,
    readRoostHistory: (sessionId) => manager.getSessionHistorySnapshot(sessionId),
    ...(options.sync
      ? {
          syncRoom: async (roomId: string, model: 'meta' | 'loro' | 'flock') => {
            if (model === 'meta') await manager.syncMetaOrThrow({ reason });
            else if (model === 'loro') await manager.syncDocOrThrow(roomId, { reason });
            else await manager.syncFlockDocOrThrow(roomId, { reason });
          },
        }
      : {}),
  };
}

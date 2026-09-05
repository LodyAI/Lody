import {
  applyPreviewVisualCommentMutation,
  getServerNow,
  getSessionRoomId,
  type MessageQueueItem,
  type PermissionOutcome,
  type PreviewVisualCommentDocInput,
  type SessionHistory,
} from '@lody/shared';
import type { SessionId } from '@lody/shared/ids';
import type { LoroRepo } from 'loro-repo';
import type {
  PreviewVisualCommentDocStore,
  SessionDocDraft,
  SessionDocStore,
} from '../atoms/runtime';
import type { WorkspaceWriter } from './workspace-writer';

// # WorkspaceWriter implementation
//
// Dual-author: every client authors the mutation against its own repo / session
// stores (identical for Web, Mobile, and Electron; see `workspace-writer.ts`).
// A pure factory with injected deps so hooks stay agnostic to the runtime.

/** Deps the writer needs from the runtime (repo + session stores). */
export type DirectWorkspaceWriterDeps = {
  repo: LoroRepo;
  acquireSessionStore: (sessionId: SessionId) => Promise<SessionDocStore>;
  releaseSessionStoreRef: (sessionId: SessionId) => void;
  acquirePreviewVisualCommentStore: (sessionId: SessionId) => Promise<PreviewVisualCommentDocStore>;
  releasePreviewVisualCommentStoreRef: (sessionId: SessionId) => void;
};

/**
 * Direct-mode writer (web/cloud): applies each mutation to the renderer's own
 * repo / session stores. This is exactly what the hooks did before the seam, so
 * there is zero behavior change in cloud mode.
 */
export function createDirectWorkspaceWriter(deps: DirectWorkspaceWriterDeps): WorkspaceWriter {
  const withSessionStore = async <T>(
    sessionId: string,
    fn: (store: SessionDocStore) => T | Promise<T>
  ): Promise<T> => {
    const id = sessionId as SessionId;
    const store = await deps.acquireSessionStore(id);
    try {
      return await fn(store);
    } finally {
      deps.releaseSessionStoreRef(id);
    }
  };

  // Renderer-side, every message-queue mutation also bumps `messageQueueUpdatedAt`
  // so the CLI dispatch watcher re-evaluates.
  const bumpMessageQueueWatermark = async (sessionId: string): Promise<void> => {
    await deps.repo.upsertDocMeta(getSessionRoomId(sessionId as SessionId), {
      messageQueueUpdatedAt: getServerNow(),
    });
  };

  const withPreviewVisualCommentStore = async <T>(
    sessionId: SessionId,
    fn: (store: PreviewVisualCommentDocStore) => T | Promise<T>
  ): Promise<T> => {
    const store = await deps.acquirePreviewVisualCommentStore(sessionId);
    try {
      return await fn(store);
    } finally {
      deps.releasePreviewVisualCommentStoreRef(sessionId);
    }
  };

  return {
    async upsertDocMeta(roomId, patch) {
      await deps.repo.upsertDocMeta(roomId, patch as Parameters<LoroRepo['upsertDocMeta']>[1]);
    },

    async startSession(sessionId, meta, entry, dispatch) {
      await Promise.all([
        deps.repo.upsertDocMeta(
          getSessionRoomId(sessionId as SessionId),
          meta as Parameters<LoroRepo['upsertDocMeta']>[1]
        ),
        withSessionStore(sessionId, (store) => {
          store.historyWriter.append(entry as unknown as SessionHistory);
        }),
      ]);
      void dispatch;
    },

    async deleteDoc(roomId) {
      await deps.repo.deleteDoc(roomId);
    },

    async flockRowPut(flockDocId, key, value) {
      const handle = await deps.repo.openFlockDoc(flockDocId);
      handle.flock.set([...key], value as Parameters<typeof handle.flock.set>[1]);
      handle.flock.commit();
    },

    async flockRowPutIfAbsent(
      flockDocId: string,
      key: readonly string[],
      value: unknown
    ): Promise<{ inserted: boolean; value: unknown }> {
      const handle = await deps.repo.openFlockDoc(flockDocId);
      return handle.flock.txn(() => {
        const existing = handle.flock.get([...key]);
        if (existing !== undefined) {
          return { inserted: false, value: existing };
        }

        handle.flock.put([...key], value as Parameters<typeof handle.flock.put>[1]);
        return { inserted: true, value };
      });
    },

    async flockRowDelete(flockDocId, key) {
      const handle = await deps.repo.openFlockDoc(flockDocId);
      handle.flock.delete([...key]);
      handle.flock.commit();
    },

    async appendSessionTurn(sessionId, entry, dispatch) {
      await withSessionStore(sessionId, (store) => {
        store.historyWriter.append(entry as unknown as SessionHistory);
      });
      // Dispatch stays the caller's sibling side effect (Machine RPC / durable
      // pointer), matching the send hot path.
      void dispatch;
    },

    async appendSessionHistory(sessionId, entry) {
      await withSessionStore(sessionId, (store) => {
        store.historyWriter.append(entry as unknown as SessionHistory);
      });
    },

    async updateSessionHistory(sessionId, entryId, entry) {
      await withSessionStore(sessionId, (store) => {
        // Unknown id is a no-op, as the Mirror findIndex short-circuit was.
        store.historyWriter.replace(entryId, entry as unknown as SessionHistory);
      });
    },

    async respondSessionPermission(sessionId, requestId, outcome, options) {
      await withSessionStore(sessionId, (store) => {
        store.historyWriter.respondPermission(requestId, outcome as unknown as PermissionOutcome, {
          turnId: options?.turnId,
        });
      });
    },

    async enqueueSessionMessage(sessionId, item) {
      await withSessionStore(sessionId, (store) => {
        store.setState((draft: SessionDocDraft) => {
          const mq = (draft.mq ?? []) as MessageQueueItem[];
          draft.mq = [...mq, item as MessageQueueItem];
        });
      });
      await bumpMessageQueueWatermark(sessionId);
    },

    async removeSessionMessage(sessionId, itemId) {
      await withSessionStore(sessionId, (store) => {
        store.setState((draft: SessionDocDraft) => {
          const mq = (draft.mq ?? []) as MessageQueueItem[];
          draft.mq = mq.filter((item) => item.$cid !== itemId);
        });
      });
      await bumpMessageQueueWatermark(sessionId);
    },

    async updateSessionMessage(sessionId, itemId, patch) {
      await withSessionStore(sessionId, (store) => {
        store.setState((draft: SessionDocDraft) => {
          const mq = (draft.mq ?? []) as MessageQueueItem[];
          draft.mq = mq.map((item) =>
            item.$cid === itemId
              ? ({ ...item, ...patch, $cid: item.$cid } as MessageQueueItem)
              : item
          );
        });
      });
      await bumpMessageQueueWatermark(sessionId);
    },

    async reorderSessionMessages(sessionId, orderedItemIds) {
      await withSessionStore(sessionId, (store) => {
        store.setState((draft: SessionDocDraft) => {
          const mq = (draft.mq ?? []) as MessageQueueItem[];
          const byCid = new Map(mq.map((item) => [item.$cid, item] as const));
          const ordered: MessageQueueItem[] = [];
          for (const cid of orderedItemIds) {
            const item = byCid.get(cid);
            if (item) {
              ordered.push(item);
              byCid.delete(cid);
            }
          }
          for (const item of mq) {
            if (item.$cid !== undefined && byCid.has(item.$cid)) {
              ordered.push(item);
            }
          }
          draft.mq = ordered;
        });
      });
      await bumpMessageQueueWatermark(sessionId);
    },

    async mutatePreviewVisualComments(sessionId, mutation) {
      await withPreviewVisualCommentStore(sessionId, (store) => {
        store.setState((draft: PreviewVisualCommentDocInput) => {
          applyPreviewVisualCommentMutation(draft, mutation);
        });
      });
    },
  };
}

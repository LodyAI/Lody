import {
  applyPreviewVisualCommentMutation,
  getServerNow,
  getSessionRoomId,
  HistoryWriteError,
  type MessageQueueItem,
  type PreviewVisualCommentDocInput,
} from '@lody/shared';
import type { SessionId } from '@lody/shared/ids';
import type { SessionCommandResult } from '@lody/shared/session-data';
import type { LoroRepo } from 'loro-repo';
import type {
  PreviewVisualCommentDocStore,
  SessionDocDraft,
  SessionDocStore,
} from '../atoms/runtime';
import type { WorkspaceWriter } from './workspace-writer';

/** Fail the caller when a domain command did not apply; never silently drop a write. */
function requireAccepted(result: SessionCommandResult): void {
  if (result.status === 'accepted') return;
  if (result.status === 'indeterminate') throw result.cause;
  // Preserve the shared writer's content-free validation diagnostic.
  if (result.reason.issues) throw new HistoryWriteError(result.reason.issues);
  throw new Error(`Session command rejected: ${result.reason.code}`);
}

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
        withSessionStore(sessionId, async (store) => {
          requireAccepted(await store.sessionData.commands.appendTurn(entry));
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

    async flockRowUpdate(flockDocId, key, update) {
      const handle = await deps.repo.openFlockDoc(flockDocId);
      return handle.flock.txn(() => {
        const next = update(handle.flock.get([...key]));
        if (next === undefined) return false;
        handle.flock.set([...key], next as Parameters<typeof handle.flock.set>[1]);
        return true;
      });
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
      await withSessionStore(sessionId, async (store) => {
        requireAccepted(await store.sessionData.commands.appendTurn(entry));
      });
      // Dispatch stays the caller's sibling side effect (Machine RPC / durable
      // pointer), matching the send hot path.
      void dispatch;
    },

    async appendSessionHistory(sessionId, entry) {
      await withSessionStore(sessionId, async (store) => {
        requireAccepted(await store.sessionData.commands.appendTurn(entry));
      });
    },

    async updateSessionHistory(sessionId, entryId, entry) {
      await withSessionStore(sessionId, async (store) => {
        requireAccepted(await store.sessionData.commands.replaceTurn(entryId, entry));
      });
    },

    async resolveSessionTaskProposal(sessionId, entryId, proposalId, resolution) {
      await withSessionStore(sessionId, async (store) => {
        const result = await store.sessionData.commands.resolveTaskProposal(
          entryId,
          proposalId,
          resolution
        );
        // The UI decision is best-effort: a proposal removed by a peer is not an
        // error, matching the previous silent no-op. A malformed decision still
        // throws the writer's validation diagnostic.
        if (result.status === 'rejected' && result.reason.code === 'not_found') return;
        requireAccepted(result);
      });
    },

    async respondSessionPermission(sessionId, requestId, outcome, options) {
      await withSessionStore(sessionId, async (store) => {
        requireAccepted(
          await store.sessionData.commands.respondPermission(requestId, outcome, options)
        );
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

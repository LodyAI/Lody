import { observeRoom } from '@lody/shared/room-observation';
import {
  NATIVE_PREVIEW_CHANNEL,
  type NativeCommentRow,
} from '@lody/shared/native-preview-comments';
import type { PreviewVisualCommentMutation } from '@lody/shared';
import type { PreviewVisualComment, PreviewVisualCommentDocState, SessionId } from '@lody/shared';
import type { PreviewVisualCommentDocStore } from '@/atoms/runtime';
import { getIpcServices, onIpcEvent } from '@/lib/electron-ipc-client';
import type { RoomSyncState } from '@/lib/room-sync-state';

/** IPC adapter and domain projection; ownership is entirely observeRoom's. */
export async function openNativePreviewCommentStore(
  workspaceId: string,
  sessionId: SessionId
): Promise<PreviewVisualCommentDocStore | null> {
  const api = getIpcServices()?.nativePreviewComments;
  if (!api || !(await api.available({ workspaceId, sessionId }))) return null;
  const observationId = crypto.randomUUID();
  const rows = new Map<string, PreviewVisualComment>();
  let state = { meta: { sessionId }, turns: {} } as PreviewVisualCommentDocState;
  let sync: RoomSyncState = 'connecting';
  const listeners = new Set<(state: PreviewVisualCommentDocState) => void>();
  const syncListeners = new Set<(state: RoomSyncState) => void>();
  const observation = observeRoom<NativeCommentRow>(
    {
      begin(listener) {
        const stop = onIpcEvent(NATIVE_PREVIEW_CHANNEL, (message) => {
          if (message.observationId === observationId) listener(message.event);
        });
        return {
          ready: api.open({ workspaceId, sessionId, observationId }),
          handle: {
            release: async () => {
              const result = await api.release({ observationId });
              stop();
              return result;
            },
          },
        };
      },
    },
    (event) => {
      sync = event.kind === 'invalidated' ? 'reconnecting' : 'synced';
      if (event.kind !== 'invalidated') {
        if (event.kind === 'snapshot') rows.clear();
        for (const row of event.entries) {
          if (row.comment) rows.set(row.id, row.comment);
          else rows.delete(row.id);
        }
        const turns: Record<string, { turnId: string; comments: PreviewVisualComment[] }> =
          Object.create(null);
        for (const comment of rows.values()) {
          const turn = (turns[comment.turnId] ??= { turnId: comment.turnId, comments: [] });
          turn.comments.push(comment);
        }
        state = { meta: { sessionId }, turns } as PreviewVisualCommentDocState;
        for (const listener of listeners) listener(state);
      }
      for (const listener of syncListeners) listener(sync);
    }
  );
  try {
    await observation.ready;
  } catch (error) {
    await observation.release();
    throw error;
  }
  return {
    backend: 'native',
    sessionId,
    roomId: `native-preview-comment-${sessionId}`,
    firstSynced: observation.ready.then(() => undefined),
    getState: () => state,
    getSyncState: () => sync,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeSyncState: (listener) => {
      syncListeners.add(listener);
      return () => {
        syncListeners.delete(listener);
      };
    },
    setState: () => {
      throw new Error('native_preview_requires_domain_command');
    },
    mutate: async (mutation: PreviewVisualCommentMutation) => {
      if (sync !== 'synced') throw new Error('native_preview_view_invalid');
      await api.mutate({ workspaceId, sessionId, mutation });
    },
    waitUntilSynced: async () => {
      if (sync !== 'synced') throw new Error('native_preview_view_invalid');
    },
    dispose: async () => {
      await observation.release();
      listeners.clear();
      syncListeners.clear();
    },
  };
}

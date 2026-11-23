import type { MessageContent, SessionHistory, SessionId } from '@lody/shared';
import { createConversationViewFromHistory } from '../../lib/conversation-view/create-conversation-view-from-history';
import type { ConversationView } from '../../lib/conversation-view/types';
import { normalizeMessageContent } from '../ai-gui/message-content-guards';
import {
  buildChatStreamItems,
  type BuildChatStreamItemsCache,
} from '../ai-gui/build-chat-stream-items';

/** Page-local rendering cache over immutable, read-only share snapshots. */
export function createSharedChatStreamBuilder() {
  let view: ConversationView | undefined;
  let history: readonly SessionHistory[] = [];
  let cache: BuildChatStreamItemsCache | undefined;
  let refresh: (() => void) | undefined;
  let normalized = new WeakMap<SessionHistory, SessionHistory>();

  const dispose = () => {
    view?.dispose();
    view = undefined;
    history = [];
    cache = undefined;
    normalized = new WeakMap();
  };

  return {
    build(snapshot: readonly SessionHistory[], sessionId: SessionId) {
      if (view && view.sessionId !== sessionId) dispose();
      history = snapshot.map((entry) => {
        let next = normalized.get(entry);
        if (!next) {
          // Preserve the shared renderer's invalid-item filtering before the
          // adapter derives summaries. Stored history is never changed.
          const items = (Array.isArray(entry.items) ? entry.items : [])
            .map(normalizeMessageContent)
            .filter((item): item is MessageContent => item !== null);
          next = { ...entry, items };
          normalized.set(entry, next);
        }
        return next;
      });
      if (!view) {
        view = createConversationViewFromHistory({
          sessionId,
          getHistory: () => history,
          // Snapshot publication already belongs to the share reader. This
          // callback stays local; it subscribes to no transport or workspace.
          subscribe: (listener) => {
            refresh = listener;
            return () => {
              refresh = undefined;
            };
          },
        });
      } else {
        refresh?.();
      }
      const result = buildChatStreamItems(view, sessionId, cache);
      cache = result.cache;
      return result;
    },
    // A later build may recreate the adapter, including after StrictMode cleanup.
    dispose,
  };
}

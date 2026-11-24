import type { SessionId } from '@lody/shared';
import type { WorkspaceRuntime } from '../atoms/runtime';
import { inQuestionFirstOrder, type ConversationView } from './conversation-view';

/**
 * Export reads retain the same view as the selected, runtime-owned conversation
 * and return it in display order, so copy ranges and share selection match the chat.
 */
export async function readConversationCopySource(
  runtime: Pick<WorkspaceRuntime, 'withSessionStore'>,
  sessionId: SessionId,
  view: ConversationView
) {
  const history = await runtime.withSessionStore(sessionId, (store) => {
    if (store.history !== view) throw new DOMException('Copy source changed', 'AbortError');
    return view.readAll();
  });
  return inQuestionFirstOrder(history);
}

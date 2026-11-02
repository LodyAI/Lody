import type { SessionId } from '@lody/shared';
import type { WorkspaceRuntime } from '../atoms/runtime';
import type { ConversationView } from './conversation-view';

/** Export reads retain the same view as the selected, runtime-owned conversation. */
export async function readConversationCopySource(
  runtime: Pick<WorkspaceRuntime, 'withSessionStore'>,
  sessionId: SessionId,
  view: ConversationView
) {
  return runtime.withSessionStore(sessionId, (store) => {
    if (store.history !== view) throw new DOMException('Copy source changed', 'AbortError');
    return view.readAll();
  });
}

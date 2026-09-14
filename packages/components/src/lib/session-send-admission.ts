import type { SessionHistory, SessionId, SessionMeta } from '@lody/shared';
import type { WorkspaceRuntime } from '../atoms/runtime';
import type { SessionSendRecord } from './session-send-journal';

/** Every user-message entrypoint shares the same durable admission and FIFO. */
export async function acceptSessionUserTurn(
  runtime: WorkspaceRuntime,
  sessionId: SessionId,
  entry: SessionHistory,
  delivery: SessionSendRecord['delivery'],
  creation?: SessionMeta,
  queue?: Record<string, unknown>
): Promise<void> {
  const journal = runtime.sendJournal;
  if (!journal || !runtime.accountId)
    throw new Error('Message recovery is not ready for this account');
  if (entry.role !== 'user' || entry.userId !== runtime.accountId)
    throw new Error('Message account does not match the active workspace');
  await journal.accept({
    id: entry.id,
    sessionId,
    accountId: runtime.accountId,
    workspaceId: runtime.workspaceId,
    sourceReplica: runtime.sourceReplica,
    entry,
    creation,
    delivery,
    queue,
  });
  // The saved input belongs to the workspace now. A later failure remains
  // visible in its recovery list; it cannot invite a fresh composer resend.
  try {
    await journal.submit(sessionId);
    const committed = journal.getSnapshot().find((record) => record.id === entry.id);
    if (committed?.stage === 'committed') {
      void journal.deliver(committed).catch((error: unknown) => {
        console.warn('Message delivery remains pending', { sessionId, turnId: entry.id, error });
      });
    }
  } catch (error) {
    console.warn('Saved message remains pending', { sessionId, turnId: entry.id, error });
  }
}

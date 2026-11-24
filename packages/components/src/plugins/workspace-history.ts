import { type SessionId } from '@lody/shared';
import type { WorkspaceRuntime } from '../atoms/runtime';
import type { SessionSummary } from '@lody/plugin-sdk';
import { readPluginSubagentRun, readPluginTurnPage } from '@lody/shared/plugins/history';
export async function readPluginHistory(
  runtime: WorkspaceRuntime,
  s: SessionSummary,
  id: string,
  input: unknown,
  signal: AbortSignal
) {
  const args = (input ?? {}) as { limit?: number; recentTurnLimit?: number; cursor?: string };
  const limit = args.recentTurnLimit ?? args.limit ?? 20,
    offset = Number(args.cursor ?? 0);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw Error('Invalid history page');
  const sid = s.session.sessionId as SessionId;
  signal.throwIfAborted();
  const store = await runtime.acquireSessionStore(sid);
  try {
    signal.throwIfAborted();
    const reader = store.sessionData.history;
    const check = () => signal.throwIfAborted();
    if (id === 'subagentRun')
      return await readPluginSubagentRun(reader, (input as { runId: string }).runId, check);
    const { items, pendingInteraction, nextCursor } = await readPluginTurnPage(
      reader,
      limit,
      offset,
      check
    );
    if (id === 'sessionTurns') return { items, ...(nextCursor ? { nextCursor } : {}) };
    return {
      ...s,
      pendingInteraction,
      queuedCount: store.getState().mq?.length ?? 0,
      recentTurns: limit
        ? items.map(({ turnId, role, userTurnId, previewText, createdAt, finished }) => ({
            turnId,
            role,
            userTurnId,
            previewText,
            createdAt,
            finished,
          }))
        : [],
    };
  } finally {
    runtime.releaseSessionStoreRef(sid);
  }
}

import { isAskUserQuestionPermissionMeta, type SessionId } from '@lody/shared';
import type { WorkspaceRuntime } from '../atoms/runtime';
import type {
  SessionSummary,
  SessionTurnRecord,
  SubagentRunSummary,
  PendingInteractionSummary,
} from '@lody/plugin-sdk';
import { toolFact } from './session-events';
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
  if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(offset) || offset < 0)
    throw Error('Invalid history page');
  const sid = s.session.sessionId as SessionId;
  signal.throwIfAborted();
  const store = await runtime.acquireSessionStore(sid);
  try {
    signal.throwIfAborted();
    const h = store.history;
    await h.ready;
    signal.throwIfAborted();
    if (id === 'subagentRun') {
      const { runId } = input as { runId: string };
      const history = await h.readAll();
      signal.throwIfAborted();
      for (const turn of history.toReversed())
        for (const task of turn.items ?? []) {
          if (task.type !== 'subagent_task' || task.taskId !== runId) continue;
          const summary = runSummary(task);
          const run = task.run;
          if (!run) return { ...summary, turns: [] };
          const records = new Map<string, SessionTurnRecord>();
          for (const item of run.items) {
            const turnId = item.nativeTurnId ?? item.messageId ?? task.taskId;
            const prior = records.get(turnId);
            const prose = (prior?.proseMarkdown ?? '') + (item.type === 'text' ? item.text : '');
            records.set(turnId, {
              turnId,
              role: 'assistant',
              createdAt:
                (run.snapshot.startedAtEpochSeconds ?? Date.parse(turn.timestamp) / 1000) * 1000,
              finished: summary.status !== 'running',
              proseMarkdown: prose,
              previewText: prose.slice(0, 256),
              thoughtMarkdown:
                (prior?.thoughtMarkdown ?? '') + (item.type === 'thought' ? item.text : ''),
              toolCalls:
                item.type === 'tool_call'
                  ? [...(prior?.toolCalls ?? []), toolFact(item)]
                  : (prior?.toolCalls ?? []),
              subagentRuns: [],
            });
          }
          return { ...summary, turns: [...records.values()] };
        }
      return null;
    }
    const end = Math.max(0, h.turnCount - offset),
      start = Math.max(0, end - Math.max(1, limit));
    const range = h.acquireRange(start, end);
    try {
      await range.ready;
      signal.throwIfAborted();
      const items: SessionTurnRecord[] = [];
      let pendingInteraction: PendingInteractionSummary | undefined;
      for (let i = start; i < end; i++) {
        const turn = h.turn(i);
        if (!turn || (turn.role !== 'assistant' && turn.role !== 'user')) continue;
        const content = turn.items ?? [];
        const proseMarkdown = content
          .flatMap((x) => (x.type === 'text' ? [x.text] : []))
          .join('\n');
        const tools = content.flatMap((x) => (x.type === 'tool_call' ? [x] : []));
        const finished = turn.role === 'user' || !!turn.finished || turn.endedAt != null;
        for (const tool of tools) {
          const req = tool.permissionRequest;
          if (!finished && req && !req.outcome)
            pendingInteraction = {
              requestId: req.requestId,
              turnId: turn.id,
              kind: isAskUserQuestionPermissionMeta(req._meta) ? 'elicitation' : 'permission',
              title: tool.title ?? undefined,
              options: req.options.map((o) => ({
                optionId: o.optionId,
                name: o.name,
                kind: o.kind ?? undefined,
              })),
            };
        }
        items.push({
          turnId: turn.id,
          role: turn.role,
          userTurnId: turn.userTurnId,
          previewText: proseMarkdown.slice(0, 256),
          createdAt: Date.parse(turn.timestamp),
          finished,
          proseMarkdown,
          thoughtMarkdown:
            content.flatMap((x) => (x.type === 'thought' ? [x.text] : [])).join('\n') || undefined,
          toolCalls: tools.map(toolFact),
          endedAt: turn.endedAt ?? undefined,
          stopReason:
            finished && turn.role === 'assistant'
              ? turn.status === 'canceled'
                ? 'cancelled'
                : turn.status === 'failed'
                  ? 'error'
                  : 'end_turn'
              : undefined,
          planMarkdown: content
            .flatMap((x) => (x.type === 'proposed_plan' ? [x.markdown] : []))
            .at(-1),
          subagentRuns: content.flatMap((x) => (x.type === 'subagent_task' ? [runSummary(x)] : [])),
        });
      }
      if (id === 'sessionTurns')
        return {
          items: limit ? items : [],
          ...(start > 0 ? { nextCursor: String(offset + end - start) } : {}),
        };
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
      range.release();
    }
  } finally {
    runtime.releaseSessionStoreRef(sid);
  }
}

function runSummary(
  task: Extract<import('@lody/shared').MessageContent, { type: 'subagent_task' }>
): SubagentRunSummary {
  const state = task.run?.snapshot.state ?? task.status;
  return {
    runId: task.taskId,
    title: task.run?.snapshot.name ?? task.description ?? task.taskId,
    status: state === 'pending' || state === 'in_progress' ? 'running' : state,
    latestStepPreview: task.run?.progress?.summary ?? task.summary,
  };
}

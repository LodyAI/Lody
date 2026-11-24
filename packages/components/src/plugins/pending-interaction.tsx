import { useEffect, useMemo } from 'react';
import { isAskUserQuestionPermissionMeta, type SessionHistory, type SessionId } from '@lody/shared';
import type { PendingInteractionSummary } from '@lody/plugin-sdk';
import { useConversationVersion, useTurnRange } from '../hooks/use-conversation-view';
import { useSessionDoc } from '../hooks/use-session-doc';
export function pendingInteraction(
  turn: SessionHistory | undefined
): PendingInteractionSummary | undefined {
  if (!turn || turn.role !== 'assistant' || turn.finished || turn.endedAt != null) return;
  for (const tool of turn.items ?? []) {
    if (tool.type !== 'tool_call' || !tool.permissionRequest || tool.permissionRequest.outcome)
      continue;
    const req = tool.permissionRequest;
    return {
      requestId: req.requestId,
      turnId: turn.id,
      title: tool.title ?? undefined,
      kind: isAskUserQuestionPermissionMeta(req._meta) ? 'elicitation' : 'permission',
      options: req.options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind ?? undefined,
      })),
    };
  }
}
export function PendingInteractionObserver({
  sessionId,
  publish,
}: {
  sessionId: SessionId;
  publish: (id: string, pending?: PendingInteractionSummary) => void;
}) {
  const { history } = useSessionDoc(sessionId);
  const version = useConversationVersion(history),
    end = history?.turnCount ?? 0,
    start = Math.max(0, end - 8);
  const ready = useTurnRange(history, start, end);
  const pending = useMemo(() => {
    if (!ready) return;
    for (let i = end - 1; i >= start; i--) {
      const x = pendingInteraction(history?.turn(i));
      if (x) return x;
    }
  }, [version, ready, history, start, end]);
  useEffect(() => {
    publish(sessionId, pending);
    return () => publish(sessionId);
  }, [sessionId, pending, publish]);
  return null;
}

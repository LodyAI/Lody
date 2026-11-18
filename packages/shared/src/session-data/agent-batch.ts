import type { HistoryWriter } from '../history-writer';
import { HistoryWriteError } from '../history-write-schema';
import {
  applyMessageContentsBatch,
  applyNotificationOnHistory,
  targetLocalHistoryTargets,
} from '../acp/history-apply';
import { selectAgentHistoryRows } from './history-selection';
import type { SessionHistoryInput } from '../schema';
import type { AcpSessionNotification, MessageContent, ModelInfo } from '../index';

export type AgentHistoryBatchInput = {
  readonly notifications?: readonly AcpSessionNotification[];
  readonly contents?: readonly MessageContent[];
  readonly operationIds?: readonly string[];
  readonly targetAssistantEntryId?: string;
  readonly entryBound?: boolean;
  readonly model?: ModelInfo;
  readonly createId?: () => string;
  readonly now?: () => string;
};

/** Shared CLI/native selection and reducer policy; all writes stay with its caller. */
export function applySessionAgentBatch(
  writer: Pick<HistoryWriter, 'updateTail' | 'updateEntry' | 'updateSelected'>,
  input: AgentHistoryBatchInput
): void {
  const notifications = input.notifications ?? [];
  const contents = input.contents ?? [];
  const targetId = input.targetAssistantEntryId;
  if (notifications.length === 0 && contents.length === 0) {
    return;
  }
  const applyTo = (turns: SessionHistoryInput[]): SessionHistoryInput[] => {
    let next = turns;
    if (notifications.length > 0) {
      next = applyNotificationOnHistory(next, notifications as never, input.model, {
        ...(input.createId ? { createId: input.createId } : {}),
        ...(input.now ? { now: input.now } : {}),
        ...(targetId ? { targetAssistantEntryId: targetId } : {}),
      });
    }
    if (contents.length > 0) {
      next = applyMessageContentsBatch(next, contents as never, {
        ...(input.createId ? { createId: input.createId } : {}),
        ...(input.now ? { now: input.now } : {}),
        ...(targetId ? { targetAssistantEntryId: targetId } : {}),
        ...(input.model ? { model: input.model } : {}),
      });
    }
    return next;
  };
  if (input.entryBound && targetId === undefined)
    throw new HistoryWriteError([{ path: ['targetAssistantEntryId'], code: 'invalid_input' }]);
  // Resolve tools and subagents in their original turns, including nested child
  // output. Mixed batches use the same sparse write and preserve event order.
  const targets =
    targetId !== undefined && contents.length === 0
      ? targetLocalHistoryTargets(notifications)
      : undefined;
  if (targets && writer.updateTail(targetId!, targets, applyTo)) return;
  // A bound batch whose target does not exist yet still creates it with the
  // caller's id, matching the historical targeted-then-create fallthrough.
  if (
    input.entryBound &&
    writer.updateEntry(targetId!, (entry) => {
      const next = applyTo([entry as unknown as SessionHistoryInput]);
      return (next[0] ?? entry) as unknown as SessionHistoryInput;
    })
  )
    return;
  writer.updateSelected(
    (rows) => {
      const dependencies = notifications.flatMap(
        (notification) => targetLocalHistoryTargets([notification]) ?? []
      );
      const tools = new Set(dependencies.flatMap((target) => target.toolCallIds));
      const tasks = new Set(dependencies.flatMap((target) => target.taskIds));
      for (const notification of notifications) {
        const update = notification.update;
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
          tools.add(update.toolCallId);
      }
      for (const content of contents) {
        if (content.type === 'tool_call') tools.add(content.toolCallId);
        if (content.type === 'subagent_task') tasks.add(content.taskId);
      }
      return selectAgentHistoryRows(rows, {
        targetId,
        toolCallIds: tools,
        taskIds: tasks,
        runs: dependencies.flatMap((target) => target.runs),
      });
    },
    (turns) => applyTo(turns)
  );
  return;
}

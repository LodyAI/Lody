import type { z } from 'zod';
import type { HistoryWriter, SessionHistory, SessionHistoryInput } from '@lody/shared';
import { HistoryEntryWriteSchema, HistoryWriteError, parseHistoryWrite } from '@lody/shared';
import {
  applyMessageContentsBatch,
  applyNotificationOnHistory,
  targetLocalHistoryTargets,
} from '@lody/shared';
import {
  applyMarkTurnSeen,
  markTurnSeenBlocked,
  applyOpenAssistantTurn,
  createAssistantTurn,
  selectAgentHistoryRows,
} from '@lody/shared/session-data';
import type {
  SessionFieldChange,
  SessionWritableField,
  SessionTurnWritableValues,
  OpenAssistantTurnInput,
} from '@lody/shared/session-data';
import type { MessageContent, ModelInfo, AcpSessionNotification } from '@lody/shared';

/**
 * One bound batch of agent output. The target assistant turn is part of the
 * input, never re-selected at flush time. `entryBound` means the caller has
 * already proved every message belongs to `targetAssistantEntryId` (text/thought
 * chunks). Independently, notification batches (text, plans, tools and subagents
 * matched by their stored ownership) write through `HistoryWriter.updateTail`. The remaining updates select their owners through
 * a shallow directory before the shared reducer runs.
 */
export type ApplyAgentBatchInput = {
  readonly notifications?: readonly AcpSessionNotification[];
  readonly contents?: readonly MessageContent[];
  /** Stable per-item retry identities; the Loro writer applies a batch atomically. */
  readonly operationIds?: readonly string[];
  readonly targetAssistantEntryId?: string;
  readonly entryBound?: boolean;
  readonly model?: ModelInfo;
  /** Deterministic identity for tests; production derives the target id. */
  readonly createId?: () => string;
  readonly now?: () => string;
};

/** CLI execution policy over the one writer; not part of the UI reader port. */
export interface SessionAgentWrites {
  setTurnField<K extends SessionWritableField>(
    turnId: string,
    key: K,
    change: SessionFieldChange<SessionTurnWritableValues[K]>
  ): Promise<void>;
  markTurnSeen(turnId: string): boolean;
  openAssistantTurn(input: OpenAssistantTurnInput): Promise<void>;
  applyAgentBatch(input: ApplyAgentBatchInput): Promise<void>;
}
export function createSessionAgentWrites(writer: HistoryWriter): SessionAgentWrites {
  return {
    async setTurnField<K extends SessionWritableField>(
      turnId: string,
      key: K,
      change: SessionFieldChange<SessionTurnWritableValues[K]>
    ) {
      if (change.kind === 'set')
        parseHistoryWrite(HistoryEntryWriteSchema.shape[key] as z.ZodType, change.value);
      if (
        !writer.setField(
          turnId,
          key,
          (change.kind === 'set' ? change.value : undefined) as SessionHistoryInput[typeof key]
        )
      )
        throw new HistoryWriteError([{ path: ['history'], code: 'not_found' }]);
    },
    markTurnSeen(turnId) {
      let blocked = false;
      const found = writer.updateEntry(turnId, (turn) => {
        if (markTurnSeenBlocked(turn as unknown as Record<string, unknown>)) {
          blocked = true;
          return turn;
        }
        applyMarkTurnSeen(turn as unknown as Record<string, unknown>);
        return turn;
      });
      return found && !blocked;
    },
    async openAssistantTurn(input) {
      if (
        writer.updateEntry(input.turnId, (turn) => {
          if (turn.role !== 'assistant')
            throw new HistoryWriteError([{ path: ['role'], code: 'invalid_input' }]);
          applyOpenAssistantTurn(turn as unknown as Record<string, unknown>, input);
          return turn;
        })
      )
        return;
      writer.append(createAssistantTurn(input) as unknown as SessionHistory);
    },
    async applyAgentBatch(input) {
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
    },
  };
}

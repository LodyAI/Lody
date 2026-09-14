import type { z } from 'zod';
import type { HistoryWriter, SessionHistory, SessionHistoryInput } from '@lody/shared';
import { HistoryEntryWriteSchema, HistoryWriteError, parseHistoryWrite } from '@lody/shared';
import { applyMessageContentsBatch, applyNotificationOnHistory } from '@lody/shared';
import {
  applyMarkTurnSeen,
  markTurnSeenBlocked,
  applyOpenAssistantTurn,
  createAssistantTurn,
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
 * chunks); the adapter then rewrites only that located turn. Otherwise the
 * adapter routes through the whole history because a tool/subagent update can
 * belong to an older turn.
 */
export type ApplyAgentBatchInput = {
  readonly notifications?: readonly AcpSessionNotification[];
  readonly contents?: readonly MessageContent[];
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
      if (input.entryBound) {
        if (targetId === undefined)
          throw new HistoryWriteError([
            { path: ['targetAssistantEntryId'], code: 'invalid_input' },
          ]);
        // A bound batch whose target does not exist yet still creates it with the
        // caller's id, matching the historical targeted-then-create fallthrough.
        if (writer.read(targetId)) {
          writer.updateEntry(targetId, (entry) => {
            const next = applyTo([entry as unknown as SessionHistoryInput]);
            return (next[0] ?? entry) as unknown as SessionHistoryInput;
          });
          return;
        }
      }
      writer.update((turns) => applyTo(turns));
      return;
    },
  };
}

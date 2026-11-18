import type { z } from 'zod';
import type { HistoryWriter, SessionHistory, SessionHistoryInput } from '@lody/shared';
import { HistoryEntryWriteSchema, HistoryWriteError, parseHistoryWrite } from '@lody/shared';
import {
  applyMarkTurnSeen,
  markTurnSeenBlocked,
  applyOpenAssistantTurn,
  createAssistantTurn,
  applySessionAgentBatch,
} from '@lody/shared/session-data';
import type {
  SessionFieldChange,
  SessionWritableField,
  SessionTurnWritableValues,
  OpenAssistantTurnInput,
} from '@lody/shared/session-data';

/**
 * Agent output for the assistant bound to the accepted input.
 * `entryBound` identifies text/thought chunks assigned to that assistant.
 * Tool, plan and subagent batches use stored ownership with `updateTail`;
 * other updates select owners before running the reducer.
 */
export type ApplyAgentBatchInput = import('@lody/shared/session-data').AgentHistoryBatchInput;

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
      applySessionAgentBatch(writer, input);
    },
  };
}

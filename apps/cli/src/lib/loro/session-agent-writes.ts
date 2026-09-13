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
  SessionCommandResult,
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
  ): Promise<SessionCommandResult>;
  markTurnSeen(turnId: string): Promise<SessionCommandResult>;
  openAssistantTurn(input: OpenAssistantTurnInput): Promise<SessionCommandResult>;
  applyAgentBatch(input: ApplyAgentBatchInput): Promise<SessionCommandResult>;
}
export function createSessionAgentWrites(writer: HistoryWriter): SessionAgentWrites {
  const rejected = (
    code: 'invalid_input' | 'not_found' | 'conflict' | 'unsupported',
    issues?: readonly { readonly path: readonly PropertyKey[]; readonly code: string }[]
  ): SessionCommandResult => ({
    status: 'rejected',
    reason: { code, ...(issues ? { issues } : {}) },
  });
  const indeterminate = (
    cause: unknown
  ): Extract<SessionCommandResult, { status: 'indeterminate' }> => ({
    status: 'indeterminate',
    cause,
  });
  const issuesOf = (error: unknown) =>
    (error as HistoryWriteError).issues ?? [{ path: [], code: 'invalid_input' }];

  const accepted = async (): Promise<SessionCommandResult> => ({ status: 'accepted' });

  return {
    async setTurnField<K extends SessionWritableField>(
      turnId: string,
      key: K,
      change: SessionFieldChange<SessionTurnWritableValues[K]>
    ) {
      if (change.kind === 'set') {
        try {
          parseHistoryWrite(HistoryEntryWriteSchema.shape[key] as z.ZodType, change.value);
        } catch (error) {
          return rejected('invalid_input', issuesOf(error));
        }
      }
      let updated: boolean;
      try {
        updated = writer.setField(
          turnId,
          key,
          (change.kind === 'set' ? change.value : undefined) as SessionHistoryInput[typeof key]
        );
      } catch (cause) {
        return indeterminate(cause);
      }
      // `setField` locates by id and diffs only this field; `false` means the
      // turn is absent, without materializing the turn body as a preflight.
      if (!updated) return rejected('not_found');
      return accepted();
    },
    async markTurnSeen(turnId) {
      let updated: boolean;
      let blocked = false;
      try {
        updated = writer.updateEntry(turnId, (turn) => {
          // Re-check the business condition inside the commit: a status advanced
          // by a concurrent writer since the caller's read is never regressed.
          if (markTurnSeenBlocked(turn as unknown as Record<string, unknown>)) {
            blocked = true;
            return turn;
          }
          applyMarkTurnSeen(turn as unknown as Record<string, unknown>);
          return turn;
        });
      } catch (cause) {
        return indeterminate(cause);
      }
      if (!updated) return rejected('not_found');
      if (blocked) return rejected('conflict');
      return accepted();
    },
    async openAssistantTurn(input) {
      let roleMismatch = false;
      let updated: boolean;
      try {
        updated = writer.updateEntry(input.turnId, (turn) => {
          if (turn.role !== 'assistant') {
            roleMismatch = true;
            return turn;
          }
          applyOpenAssistantTurn(turn as unknown as Record<string, unknown>, input);
          return turn;
        });
      } catch (cause) {
        return indeterminate(cause);
      }
      if (updated) {
        if (roleMismatch) return rejected('invalid_input');
        return accepted();
      }
      const entry = createAssistantTurn(input);
      try {
        parseHistoryWrite(HistoryEntryWriteSchema, entry);
      } catch (error) {
        return rejected('invalid_input', issuesOf(error));
      }
      try {
        writer.append(entry as unknown as SessionHistory);
      } catch (cause) {
        return indeterminate(cause);
      }
      return accepted();
    },
    async applyAgentBatch(input) {
      const notifications = input.notifications ?? [];
      const contents = input.contents ?? [];
      const targetId = input.targetAssistantEntryId;
      if (notifications.length === 0 && contents.length === 0) {
        return accepted();
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
        if (targetId === undefined) return rejected('invalid_input');
        // A bound batch whose target does not exist yet still creates it with the
        // caller's id, matching the historical targeted-then-create fallthrough.
        if (writer.read(targetId)) {
          try {
            writer.updateEntry(targetId, (entry) => {
              const next = applyTo([entry as unknown as SessionHistoryInput]);
              return (next[0] ?? entry) as unknown as SessionHistoryInput;
            });
          } catch (cause) {
            return indeterminate(cause);
          }
          return accepted();
        }
      }
      try {
        writer.update((turns) => applyTo(turns));
      } catch (cause) {
        return indeterminate(cause);
      }
      return accepted();
    },
  };
}

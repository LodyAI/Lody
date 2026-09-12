import { isContainer, type LoroDoc, type LoroList, type LoroMap } from 'loro-crdt';
import type { SessionId } from '../ids';
import type { SessionHistory, SessionHistoryInput } from '../schema';
import { HistoryWriteError, parseHistoryWrite } from '../history-write-schema';
import { PermissionOutcomeSchema } from '../message-schemas';
import { createHistoryWriter, type HistoryWriter } from '../history-writer';
import { resolveTaskProposalOnEntry } from './task-proposal';
import type {
  SessionCommandResult,
  SessionData,
  SessionFieldChange,
  SessionHistoryCommands,
  SessionHistoryReader,
  SessionTurnRead,
  SessionVisiblePage,
  SessionVisiblePageRequest,
  SessionWritableField,
  SessionWriteReceipt,
} from './types';

// # Loro-backed SessionData
//
// The one place that knows the `history` root list is a Loro list and that a
// turn is a Loro map. Commands delegate to the *same* shared `HistoryWriter`
// used by the renderer; this adapter never re-implements parsing, container
// diffing, rollback or stored-copy rules. Reads answer from storage directly so
// a bounded query does not materialize the whole document.
//
// Acceptance is synchronous in Loro, so a command can never be
// `indeterminate` here; it is either applied (`accepted`) or pre-write rejected.
// Local durability is a separate step exposed through `waitDurable`.

const HISTORY_ROOT_KEY = 'history';

export type LoroSessionDataOptions = {
  sessionId: SessionId;
  doc: LoroDoc;
  /**
   * The already-owned shared writer for this doc. The session entrypoint passes
   * the Mirror's `historyWriter` so exactly one writer instance owns local
   * history writes; omit it only in tests that build a standalone adapter.
   */
  writer?: HistoryWriter;
  /** Awaited by `waitDurable`; e.g. `repo.persistPendingChanges`. */
  flushLocal?: () => Promise<void>;
  /** Awaited after a change is accepted, before the command resolves. */
  afterAccept?: (receipt: SessionWriteReceipt) => void | Promise<void>;
};

export type LoroSessionData = SessionData & {
  /** The shared writer, for storage-owned capabilities (capture/copy/rollback). */
  readonly writer: HistoryWriter;
};

const asStoredTurn = (value: unknown): SessionHistory | undefined => {
  if (isContainer(value)) {
    if (value.kind() !== 'Map') return undefined;
    const json = (value as LoroMap).toJSON();
    return json && typeof json === 'object' ? (json as SessionHistory) : undefined;
  }
  // Legacy plain-JSON rows are still valid readable history.
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as SessionHistory;
  return undefined;
};

const readSlot = (list: LoroList, index: number): SessionTurnRead => {
  if (index < 0 || index >= list.length) return { state: 'missing' };
  const turn = asStoredTurn(list.get(index));
  return turn ? { state: 'ready', turn } : { state: 'invalid' };
};

const cursorToIndex = (cursor: string | undefined, length: number): number => {
  if (cursor === undefined) return length;
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed)) return length;
  return Math.max(0, Math.min(length, parsed));
};

export function createLoroSessionData(options: LoroSessionDataOptions): LoroSessionData {
  const { sessionId, doc } = options;
  const writer = options.writer ?? createHistoryWriter(doc);
  const list = doc.getList(HISTORY_ROOT_KEY);

  const finish = async (
    kind: SessionWriteReceipt['kind'],
    turnIds: readonly string[]
  ): Promise<SessionCommandResult> => {
    const receipt: SessionWriteReceipt = { sessionId, kind, turnIds };
    await options.afterAccept?.(receipt);
    return { status: 'accepted', receipt };
  };

  const rejected = (
    code: 'invalid_input' | 'not_found' | 'conflict' | 'unsupported',
    issues?: readonly { readonly path: readonly PropertyKey[]; readonly code: string }[]
  ): SessionCommandResult => ({
    status: 'rejected',
    reason: { code, ...(issues ? { issues } : {}) },
  });

  const history: SessionHistoryReader = {
    count: () => list.length,
    async readTurn(turnId) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const read = readSlot(list, index);
        if (read.state === 'missing') break;
        if (read.state === 'ready' && read.turn.id === turnId) return read;
      }
      return { state: 'missing' };
    },
    async readRange(from, to) {
      const lo = Math.max(0, Math.min(from, list.length));
      const hi = Math.max(lo, Math.min(to, list.length));
      const out: SessionTurnRead[] = [];
      for (let index = lo; index < hi; index += 1) out.push(readSlot(list, index));
      return out;
    },
    async readVisiblePage(request: SessionVisiblePageRequest): Promise<SessionVisiblePage> {
      const limit = Math.max(0, Math.floor(request.limit));
      if (limit === 0) return { turns: [], positions: [], hasMore: false };
      let index = cursorToIndex(request.cursor, list.length) - 1;
      const page: Array<{ index: number; turn: SessionHistory }> = [];
      let hasMore = false;
      for (; index >= 0; index -= 1) {
        const read = readSlot(list, index);
        if (read.state !== 'ready' || !request.isVisible(read.turn)) continue;
        if (page.length >= limit) {
          hasMore = true;
          break;
        }
        page.push({ index, turn: read.turn });
      }
      const nextCursor = index + 1 > 0 ? String(index + 1) : undefined;
      const ordered = page.reverse();
      return {
        turns: ordered.map((entry) => entry.turn),
        positions: ordered.map((entry) => entry.index),
        ...(nextCursor !== undefined ? { nextCursor } : {}),
        hasMore: hasMore && nextCursor !== undefined,
      };
    },
  };

  const commands: SessionHistoryCommands = {
    async appendTurn(turn) {
      // The shared writer parses before it touches a container, so invalid input
      // is rejected here with no partial write.
      try {
        writer.append(turn);
      } catch (error) {
        return rejected('invalid_input', (error as HistoryWriteError).issues);
      }
      return finish('append', [turn.id]);
    },
    async replaceTurn(turnId, turn) {
      if (turn.id !== turnId)
        return rejected('invalid_input', [{ path: ['id'], code: 'immutable_id' }]);
      try {
        const replaced = writer.replace(turnId, turn);
        if (!replaced) return rejected('not_found');
      } catch (error) {
        return rejected('invalid_input', (error as HistoryWriteError).issues);
      }
      return finish('replace', [turnId]);
    },
    async setTurnField<K extends SessionWritableField>(
      turnId: string,
      key: K,
      change: SessionFieldChange<SessionHistoryInput[K]>
    ) {
      try {
        // `set` validates the field in the writer before diffing; `clear` is an
        // explicit delete, never an implicit `undefined` contract.
        const updated = writer.setField(
          turnId,
          key,
          change.kind === 'set' ? change.value : undefined
        );
        if (!updated) return rejected('not_found');
      } catch (error) {
        return rejected('invalid_input', (error as HistoryWriteError).issues);
      }
      return finish('set-field', [turnId]);
    },
    async resumeAssistant(turnId) {
      const target = writer.read(turnId);
      if (!target) return rejected('not_found');
      if (target.role !== 'assistant') return rejected('invalid_input');
      // One conditional commit: the target is re-located inside `updateEntry`.
      // Reopen sets an explicit non-terminal `finished` and removes the two end
      // markers; unknown fields survive because the draft starts from storage.
      writer.updateEntry(turnId, (turn) => {
        turn.finished = false;
        delete turn.endedAt;
        delete turn.permissionWaitMs;
        return turn;
      });
      return finish('resume-assistant', [turnId]);
    },
    async openAssistantTurn(input) {
      const existing = writer.read(input.turnId);
      if (existing) {
        if (existing.role !== 'assistant') return rejected('invalid_input');
        try {
          // One conditional commit: reopen sets an explicit non-terminal
          // `finished`, removes the end markers, and fills provenance only where
          // the stored turn has none.
          writer.updateEntry(input.turnId, (turn) => {
            turn.finished = false;
            delete turn.endedAt;
            delete turn.permissionWaitMs;
            if (turn.userTurnId === undefined && input.userTurnId !== undefined)
              turn.userTurnId = input.userTurnId;
            if (input.modelInfo !== undefined) turn.modelInfo = input.modelInfo;
            return turn;
          });
        } catch (error) {
          return rejected('invalid_input', (error as HistoryWriteError).issues);
        }
        return finish('open-assistant-turn', [input.turnId]);
      }
      try {
        writer.append({
          id: input.turnId,
          role: 'assistant',
          timestamp: input.timestamp,
          ...(input.userTurnId !== undefined ? { userTurnId: input.userTurnId } : {}),
          ...(input.modelInfo !== undefined ? { modelInfo: input.modelInfo } : {}),
          items: [] as unknown as SessionHistoryInput['items'],
          fileDiff: [],
        });
      } catch (error) {
        return rejected('invalid_input', (error as HistoryWriteError).issues);
      }
      return finish('open-assistant-turn', [input.turnId]);
    },
    async resolveTaskProposal(entryId, proposalId, resolution) {
      let found = false;
      try {
        const updated = writer.updateEntry(entryId, (entry) => {
          found = resolveTaskProposalOnEntry(entry, proposalId, resolution);
          return entry;
        });
        if (!updated) return rejected('not_found');
      } catch (error) {
        return rejected('invalid_input', (error as HistoryWriteError).issues);
      }
      if (!found) return rejected('not_found');
      return finish('resolve-task-proposal', [entryId]);
    },
    async respondPermission(requestId, outcome, respondOptions) {
      try {
        parseHistoryWrite(PermissionOutcomeSchema, outcome);
      } catch (error) {
        return rejected('invalid_input', (error as HistoryWriteError).issues);
      }
      const answered = writer.respondPermission(requestId, outcome, respondOptions);
      if (!answered) return rejected('not_found');
      return finish('respond-permission', respondOptions?.turnId ? [respondOptions.turnId] : []);
    },
  };

  const durability = {
    async waitDurable() {
      await options.flushLocal?.();
    },
  };

  return { sessionId, history, commands, durability, writer };
}

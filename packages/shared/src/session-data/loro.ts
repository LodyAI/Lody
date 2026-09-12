import { isContainer, type LoroDoc, type LoroList, type LoroMap } from 'loro-crdt';
import type { z } from 'zod';
import type { SessionId } from '../ids';
import type { SessionHistory, SessionHistoryInput } from '../schema';
import {
  HistoryEntryWriteSchema,
  HistoryWriteError,
  parseHistoryWrite,
} from '../history-write-schema';
import { PermissionOutcomeSchema } from '../message-schemas';
import { createHistoryWriter, type HistoryWriter } from '../history-writer';
import {
  applyOpenAssistantTurn,
  applyResumeAssistant,
  createAssistantTurn,
  hasTaskProposal,
  parseTaskProposalResolution,
  resolveTaskProposalOnEntry,
} from './planner';
import {
  SessionDurabilityError,
  type SessionCommandResult,
  type SessionData,
  type SessionFieldChange,
  type SessionHistoryCommands,
  type SessionHistoryReader,
  type SessionTurnRead,
  type SessionVisiblePage,
  type SessionVisiblePageRequest,
  type SessionWritableField,
  type SessionWriteReceipt,
} from './types';

// # Loro-backed SessionData
//
// The one place that knows the `history` root list is a Loro list and that a
// turn is a Loro map. Commands apply the shared planners (`./planner`) inside
// the shared `HistoryWriter`'s conditional commit, so no business rule is
// restated here and the write path stays the single writer used by the renderer.
//
// Phase discipline: input is validated and the target located *before* any
// mutation, so a `rejected` result proves nothing was applied. Once the writer
// is invoked, a throw is reported as `indeterminate` (a partial write cannot be
// ruled out) rather than as a pre-write rejection. `postAcceptError` reports an
// accepted write whose post-accept side effect failed.

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
  /**
   * Local durability barrier (e.g. `repo.flush`). When omitted, `waitDurable`
   * rejects with `SessionDurabilityError('unavailable')` instead of pretending
   * the accepted change is persisted.
   */
  durable?: () => Promise<void>;
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

  // Receipts are capabilities this store issued, not caller-shaped objects.
  const issuedReceipts = new WeakSet<object>();

  const issueReceipt = (
    kind: SessionWriteReceipt['kind'],
    turnIds: readonly string[]
  ): SessionWriteReceipt => {
    const receipt = { sessionId, kind, turnIds } as unknown as SessionWriteReceipt;
    issuedReceipts.add(receipt);
    return receipt;
  };

  const rejected = (
    code: 'invalid_input' | 'not_found' | 'conflict' | 'unsupported',
    issues?: readonly { readonly path: readonly PropertyKey[]; readonly code: string }[]
  ): SessionCommandResult => ({
    status: 'rejected',
    reason: { code, ...(issues ? { issues } : {}) },
  });
  const indeterminate = (cause: unknown): SessionCommandResult => ({
    status: 'indeterminate',
    cause,
  });
  const issuesOf = (error: unknown) =>
    (error as HistoryWriteError).issues ?? [{ path: [], code: 'invalid_input' }];

  const accepted = async (
    kind: SessionWriteReceipt['kind'],
    turnIds: readonly string[]
  ): Promise<SessionCommandResult> => {
    const receipt = issueReceipt(kind, turnIds);
    try {
      await options.afterAccept?.(receipt);
    } catch (postAcceptError) {
      // The change is applied; only its side effect failed. Never report this as
      // a pre-write rejection, which would invite a duplicate append.
      return { status: 'accepted', receipt, postAcceptError };
    }
    return { status: 'accepted', receipt };
  };

  const history: SessionHistoryReader = {
    count: () => list.length,
    async readTurn(turnId) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const value = list.get(index);
        if (isContainer(value)) {
          if (value.kind() !== 'Map') continue;
          const map = value as LoroMap;
          // Identity is a scalar. Read it shallowly so finding a turn never
          // materializes an unrelated turn's body on the way to the target.
          if (map.get('id') !== turnId) continue;
          const json = map.toJSON();
          return json && typeof json === 'object'
            ? { state: 'ready', turn: json as SessionHistory }
            : { state: 'invalid' };
        }
        // Legacy plain-JSON rows are already detached and cheap to inspect.
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          (value as { id?: unknown }).id === turnId
        ) {
          return { state: 'ready', turn: value as SessionHistory };
        }
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
      try {
        parseHistoryWrite(HistoryEntryWriteSchema, turn);
      } catch (error) {
        return rejected('invalid_input', issuesOf(error));
      }
      try {
        writer.append(turn);
      } catch (cause) {
        return indeterminate(cause);
      }
      return accepted('append', [turn.id]);
    },
    async replaceTurn(turnId, turn) {
      if (turn.id !== turnId)
        return rejected('invalid_input', [{ path: ['id'], code: 'immutable_id' }]);
      if (!writer.read(turnId)) return rejected('not_found');
      try {
        parseHistoryWrite(HistoryEntryWriteSchema, turn);
      } catch (error) {
        return rejected('invalid_input', issuesOf(error));
      }
      try {
        writer.replace(turnId, turn);
      } catch (cause) {
        return indeterminate(cause);
      }
      return accepted('replace', [turnId]);
    },
    async setTurnField<K extends SessionWritableField>(
      turnId: string,
      key: K,
      change: SessionFieldChange<SessionHistoryInput[K]>
    ) {
      if (!writer.read(turnId)) return rejected('not_found');
      if (change.kind === 'set') {
        try {
          parseHistoryWrite(HistoryEntryWriteSchema.shape[key] as z.ZodType, change.value);
        } catch (error) {
          return rejected('invalid_input', issuesOf(error));
        }
      }
      try {
        writer.setField(turnId, key, change.kind === 'set' ? change.value : undefined);
      } catch (cause) {
        return indeterminate(cause);
      }
      return accepted('set-field', [turnId]);
    },
    async resumeAssistant(turnId) {
      const target = writer.read(turnId);
      if (!target) return rejected('not_found');
      if (target.role !== 'assistant') return rejected('invalid_input');
      try {
        writer.updateEntry(turnId, (turn) => {
          applyResumeAssistant(turn as unknown as Record<string, unknown>);
          return turn;
        });
      } catch (cause) {
        return indeterminate(cause);
      }
      return accepted('resume-assistant', [turnId]);
    },
    async openAssistantTurn(input) {
      const existing = writer.read(input.turnId);
      if (existing) {
        if (existing.role !== 'assistant') return rejected('invalid_input');
        try {
          writer.updateEntry(input.turnId, (turn) => {
            applyOpenAssistantTurn(turn as unknown as Record<string, unknown>, input);
            return turn;
          });
        } catch (cause) {
          return indeterminate(cause);
        }
        return accepted('open-assistant-turn', [input.turnId]);
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
      return accepted('open-assistant-turn', [input.turnId]);
    },
    async resolveTaskProposal(entryId, proposalId, resolution) {
      try {
        parseTaskProposalResolution(resolution);
      } catch (error) {
        return rejected('invalid_input', issuesOf(error));
      }
      const target = writer.read(entryId);
      if (!target) return rejected('not_found');
      if (!hasTaskProposal(target, proposalId)) return rejected('not_found');
      try {
        writer.updateEntry(entryId, (entry) => {
          resolveTaskProposalOnEntry(entry, proposalId, resolution);
          return entry;
        });
      } catch (cause) {
        return indeterminate(cause);
      }
      return accepted('resolve-task-proposal', [entryId]);
    },
    async respondPermission(requestId, outcome, respondOptions) {
      try {
        parseHistoryWrite(PermissionOutcomeSchema, outcome);
      } catch (error) {
        return rejected('invalid_input', issuesOf(error));
      }
      let answered: boolean;
      try {
        answered = writer.respondPermission(requestId, outcome, respondOptions);
      } catch (cause) {
        return indeterminate(cause);
      }
      if (!answered) return rejected('not_found');
      return accepted('respond-permission', respondOptions?.turnId ? [respondOptions.turnId] : []);
    },
  };

  const durability = {
    async waitDurable(receipt?: SessionWriteReceipt) {
      if (receipt !== undefined && !issuedReceipts.has(receipt)) {
        throw new SessionDurabilityError(
          'invalid_receipt',
          'The receipt was not issued by this session store.'
        );
      }
      if (!options.durable) {
        throw new SessionDurabilityError(
          'unavailable',
          'This session store has no local durability barrier.'
        );
      }
      await options.durable();
    },
  };

  return { sessionId, history, commands, durability, writer };
}

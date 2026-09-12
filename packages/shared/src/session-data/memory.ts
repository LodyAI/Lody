import type { z } from 'zod';
import type { SessionId } from '../ids';
import type { SessionHistory, SessionHistoryInput } from '../schema';
import {
  HistoryEntryWriteSchema,
  parseHistoryWrite,
  type HistoryWriteError,
} from '../history-write-schema';
import { PermissionOutcomeSchema } from '../message-schemas';
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

// # Independent in-memory SessionData
//
// Proves the consumer contracts do not depend on Loro, Mirror, CIDs or storage
// offsets: a plain array of detached JSON turns plus a Map index. It uses the
// same *pure* shared validator (`history-write-schema`) as the Loro adapter, so
// input rejection is a shared rule, not a re-implementation.
//
// Test-only control (never a product seam):
//  - `beforeCommit` / `afterCommit` let a test pin the exact interleaving of a
//    peer edit against an in-flight command.
//  - `failDurability` makes `waitDurable` reject, modelling "accepted locally
//    but not yet persisted" without turning that into a write rejection.

export type MemoryCommitPlan = {
  readonly kind: SessionWriteReceipt['kind'];
  readonly turnIds: readonly string[];
};

export type MemorySessionDataOptions = {
  sessionId: SessionId;
  initialTurns?: readonly SessionHistory[];
  /** Awaited after validation, before the store mutates. Test-only. */
  beforeCommit?: (plan: MemoryCommitPlan) => void | Promise<void>;
  /** Awaited after the store mutates, before the command resolves. Test-only. */
  afterCommit?: (plan: MemoryCommitPlan) => void | Promise<void>;
  /** When set, `waitDurable` rejects with this after the store has accepted. */
  failDurability?: unknown;
  /**
   * When true, accepted changes stay pending until `markDurable()` is called.
   * Default false: this double is locally durable as soon as it accepts.
   */
  manualDurability?: boolean;
};

export type MemorySessionData = SessionData & {
  /** Snapshot of stored turns; detached JSON, newest last. */
  readStored(): SessionHistory[];
  /** Mark every accepted change locally durable. */
  markDurable(): void;
  /** Number of accepted changes not yet marked durable. */
  pendingDurableCount(): number;
  /** Mutate storage as a peer would, bypassing this instance's commands. */
  applyPeerMutation(mutate: (turns: SessionHistory[]) => void): void;
};

const clone = <T>(value: T): T =>
  typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));

const withoutUndefined = <T extends Record<string, unknown>>(value: T): T => {
  const result = { ...value };
  for (const key of Object.keys(result)) if (result[key] === undefined) delete result[key];
  return result;
};

const rejected = (
  code: 'invalid_input' | 'not_found' | 'conflict' | 'unsupported',
  issues?: readonly { readonly path: readonly PropertyKey[]; readonly code: string }[]
): SessionCommandResult => ({
  status: 'rejected',
  reason: { code, ...(issues ? { issues } : {}) },
});

const toRejection = (error: HistoryWriteError): SessionCommandResult =>
  rejected(
    'invalid_input',
    error.issues.map(({ path, code }) => ({ path, code }))
  );

const cursorToIndex = (cursor: string | undefined, length: number): number => {
  if (cursor === undefined) return length;
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed)) return length;
  return Math.max(0, Math.min(length, parsed));
};

export function createMemorySessionData(options: MemorySessionDataOptions): MemorySessionData {
  const sessionId = options.sessionId;
  let turns: SessionHistory[] = (options.initialTurns ?? []).map(clone);
  let acceptedSerial = 0;
  let durableSerial = 0;
  const receiptSerial = new WeakMap<SessionWriteReceipt, number>();
  const durableWaiters = new Set<() => void>();

  const storedTurns = () => turns.map((turn) => withoutUndefined({ ...turn }));

  // Match the Loro writer's `locate`: the newest row with this id wins.
  const findIndex = (turnId: string) => {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index]!.id === turnId) return index;
    }
    return -1;
  };

  const mutating = async (
    kind: SessionWriteReceipt['kind'],
    turnIds: readonly string[],
    mutation: (plan: MemoryCommitPlan) => boolean
  ): Promise<SessionCommandResult> => {
    const plan: MemoryCommitPlan = { kind, turnIds };
    await options.beforeCommit?.(plan);
    const applied = mutation(plan);
    await options.afterCommit?.(plan);
    if (!applied) return rejected('conflict');
    acceptedSerial += 1;
    if (!options.manualDurability) durableSerial = acceptedSerial;
    const receipt: SessionWriteReceipt = { sessionId, kind, turnIds: plan.turnIds.slice() };
    receiptSerial.set(receipt, acceptedSerial);
    return { status: 'accepted', receipt };
  };

  const reader: SessionHistoryReader = {
    count: () => turns.length,
    async readTurn(turnId) {
      const index = findIndex(turnId);
      if (index < 0) return { state: 'missing' };
      return { state: 'ready', turn: clone(turns[index]!) };
    },
    async readRange(from, to) {
      const lo = Math.max(0, Math.min(from, turns.length));
      const hi = Math.max(lo, Math.min(to, turns.length));
      const out: SessionTurnRead[] = [];
      for (let i = lo; i < hi; i += 1) out.push({ state: 'ready', turn: clone(turns[i]!) });
      return out;
    },
    async readVisiblePage(request: SessionVisiblePageRequest): Promise<SessionVisiblePage> {
      const limit = Math.max(0, Math.floor(request.limit));
      if (limit === 0) return { turns: [], positions: [], hasMore: false };
      let index = cursorToIndex(request.cursor, turns.length) - 1;
      const page: Array<{ index: number; turn: SessionHistory }> = [];
      let hasMore = false;
      for (; index >= 0; index -= 1) {
        const turn = turns[index]!;
        if (!request.isVisible(turn)) continue;
        if (page.length >= limit) {
          hasMore = true;
          break;
        }
        page.push({ index, turn: clone(turn) });
      }
      // The cursor is the raw boundary, not the visible-count boundary: the next
      // page starts strictly below the lowest raw row this page settled on.
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
        return toRejection(error as HistoryWriteError);
      }
      return mutating('append', [turn.id], () => {
        turns = [...turns, withoutUndefined({ ...turn }) as SessionHistory];
        return true;
      });
    },
    async replaceTurn(turnId, turn) {
      if (turn.id !== turnId)
        return rejected('invalid_input', [{ path: ['id'], code: 'immutable_id' }]);
      try {
        parseHistoryWrite(HistoryEntryWriteSchema, turn);
      } catch (error) {
        return toRejection(error as HistoryWriteError);
      }
      if (findIndex(turnId) < 0) return rejected('not_found');
      return mutating('replace', [turnId], () => {
        // Re-locate at commit time: a peer edit between the precondition and the
        // mutation cannot redirect this write to a stale position.
        const index = findIndex(turnId);
        if (index < 0) return false;
        const next = turns.slice();
        next[index] = withoutUndefined({ ...turn }) as SessionHistory;
        turns = next;
        return true;
      });
    },
    async setTurnField<K extends SessionWritableField>(
      turnId: string,
      key: K,
      change: SessionFieldChange<SessionHistoryInput[K]>
    ) {
      if (findIndex(turnId) < 0) return rejected('not_found');
      let value: unknown;
      if (change.kind === 'set') {
        try {
          value = parseHistoryWrite(HistoryEntryWriteSchema.shape[key] as z.ZodType, change.value);
        } catch (error) {
          return toRejection(error as HistoryWriteError);
        }
      }
      return mutating('set-field', [turnId], () => {
        const index = findIndex(turnId);
        if (index < 0) return false;
        const next = turns.slice();
        const updated = { ...next[index]! } as Record<string, unknown>;
        if (change.kind === 'clear') delete updated[key];
        else updated[key] = value;
        next[index] = withoutUndefined(updated) as SessionHistory;
        turns = next;
        return true;
      });
    },
    async resumeAssistant(turnId) {
      const initial = findIndex(turnId);
      if (initial < 0) return rejected('not_found');
      if (turns[initial]!.role !== 'assistant') return rejected('invalid_input');
      return mutating('resume-assistant', [turnId], () => {
        const index = findIndex(turnId);
        if (index < 0) return false;
        if (turns[index]!.role !== 'assistant') return false;
        const next = turns.slice();
        const updated = { ...next[index]! } as Record<string, unknown>;
        // Reopen: explicitly non-terminal, and the two end markers are removed
        // rather than passed as `undefined`. Every unknown stored field rides
        // along untouched.
        updated.finished = false;
        delete updated.endedAt;
        delete updated.permissionWaitMs;
        next[index] = withoutUndefined(updated) as SessionHistory;
        turns = next;
        return true;
      });
    },
    async openAssistantTurn(input) {
      try {
        if (input.userTurnId !== undefined)
          parseHistoryWrite(HistoryEntryWriteSchema.shape.userTurnId, input.userTurnId);
        if (input.modelInfo !== undefined)
          parseHistoryWrite(HistoryEntryWriteSchema.shape.modelInfo, input.modelInfo);
      } catch (error) {
        return toRejection(error as HistoryWriteError);
      }
      const initial = findIndex(input.turnId);
      if (initial < 0) {
        const entry = withoutUndefined({
          id: input.turnId,
          role: 'assistant' as const,
          timestamp: input.timestamp,
          userTurnId: input.userTurnId,
          modelInfo: input.modelInfo,
          items: [],
          fileDiff: [],
        }) as unknown as SessionHistory;
        return mutating('open-assistant-turn', [input.turnId], () => {
          turns = [...turns, entry];
          return true;
        });
      }
      if (turns[initial]!.role !== 'assistant') return rejected('invalid_input');
      return mutating('open-assistant-turn', [input.turnId], () => {
        const index = findIndex(input.turnId);
        if (index < 0 || turns[index]!.role !== 'assistant') return false;
        const next = turns.slice();
        const updated = { ...next[index]! } as Record<string, unknown>;
        updated.finished = false;
        delete updated.endedAt;
        delete updated.permissionWaitMs;
        // Never overwrite provenance the stored turn already has.
        if (updated.userTurnId === undefined && input.userTurnId !== undefined)
          updated.userTurnId = input.userTurnId;
        if (input.modelInfo !== undefined) updated.modelInfo = input.modelInfo;
        next[index] = withoutUndefined(updated) as SessionHistory;
        turns = next;
        return true;
      });
    },
    async resolveTaskProposal(entryId, proposalId, resolution) {
      const initial = findIndex(entryId);
      if (initial < 0) return rejected('not_found');
      const probe = structuredClone(turns[initial]!) as { items?: unknown };
      if (!resolveTaskProposalOnEntry(probe, proposalId, resolution)) return rejected('not_found');
      return mutating('resolve-task-proposal', [entryId], () => {
        const index = findIndex(entryId);
        if (index < 0) return false;
        const entry = structuredClone(turns[index]!) as { items?: unknown };
        if (!resolveTaskProposalOnEntry(entry, proposalId, resolution)) return false;
        const next = turns.slice();
        next[index] = withoutUndefined(entry as Record<string, unknown>) as SessionHistory;
        turns = next;
        return true;
      });
    },
    async respondPermission(requestId, outcome, permissionOptions) {
      try {
        parseHistoryWrite(PermissionOutcomeSchema, outcome);
      } catch (error) {
        return toRejection(error as HistoryWriteError);
      }
      const locateIn = (index: number) => {
        const turn = turns[index];
        if (!turn) return undefined;
        const items = Array.isArray(turn.items) ? turn.items : [];
        const at = items.findIndex(
          (item) => item?.type === 'tool_call' && item.permissionRequest?.requestId === requestId
        );
        return at >= 0 ? { index, at } : undefined;
      };
      const locate = () => {
        // A supplied turn id restricts the lookup to that turn, never a scan
        // back through older turns.
        if (permissionOptions?.turnId) return locateIn(findIndex(permissionOptions.turnId));
        for (let index = turns.length - 1; index >= 0; index -= 1) {
          const found = locateIn(index);
          if (found) return found;
        }
        return undefined;
      };
      const found = locate();
      if (!found) return rejected('not_found');
      return mutating('respond-permission', [turns[found.index]!.id], () => {
        const current = locate();
        if (!current) return false;
        const next = turns.slice();
        const updated = { ...next[current.index]! };
        const nextItems = Array.isArray(updated.items) ? updated.items.slice() : [];
        const item = { ...(nextItems[current.at] as Record<string, unknown>) } as Record<
          string,
          unknown
        >;
        const request = { ...(item.permissionRequest as Record<string, unknown>) };
        request.outcome = outcome;
        item.permissionRequest = request;
        nextItems[current.at] = item as (typeof nextItems)[number];
        updated.items = nextItems;
        next[current.index] = updated;
        turns = next;
        return true;
      });
    },
  };

  const durability = {
    async waitDurable(receipt?: SessionWriteReceipt) {
      if (options.failDurability !== undefined) throw options.failDurability;
      const serial = receipt ? (receiptSerial.get(receipt) ?? acceptedSerial) : acceptedSerial;
      if (serial <= durableSerial) return;
      await new Promise<void>((resolve) => durableWaiters.add(resolve));
    },
  };

  return {
    sessionId,
    history: reader,
    commands,
    durability,
    readStored: storedTurns,
    markDurable() {
      durableSerial = acceptedSerial;
      for (const resolve of durableWaiters) resolve();
      durableWaiters.clear();
    },
    pendingDurableCount: () => acceptedSerial - durableSerial,
    applyPeerMutation(mutate) {
      const draft = turns.map(clone);
      mutate(draft);
      turns = draft;
    },
  };
}

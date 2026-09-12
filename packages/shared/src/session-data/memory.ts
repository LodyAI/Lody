import type { z } from 'zod';
import type { SessionId } from '../ids';
import type { SessionHistoryInput } from '../schema';
import { HistoryEntryWriteSchema, parseHistoryWrite } from '../history-write-schema';
import { prepareReplacement } from '../history-writer';
import { PermissionOutcomeSchema } from '../message-schemas';
import { applyMessageContentsBatch, applyNotificationOnHistory } from '../acp/history-apply';
import { pickDirectoryInputConfig, pickDirectoryScalars } from './directory';
import {
  checkSessionSnapshot,
  mintSessionSnapshot,
  sessionSnapshotContext,
  SessionSnapshotError,
  type SessionSnapshotService,
} from './snapshot';
import {
  applyMarkTurnSeen,
  applyOpenAssistantTurn,
  applyRespondPermission,
  applyResumeAssistant,
  createAssistantTurn,
  hasTaskProposal,
  markTurnSeenBlocked,
  parseTaskProposalResolution,
  resolveTaskProposalOnEntry,
} from './planner';
import {
  SessionDurabilityError,
  type SessionCommandResult,
  type SessionData,
  type SessionDataChangeListener,
  type SessionDirectoryRow,
  type SessionFieldChange,
  type SessionHistoryCommands,
  type SessionHistoryReader,
  type SessionObservation,
  type SessionRollbackCommandResult,
  type SessionTurn,
  type SessionTurnRead,
  type SessionTurnWritableValues,
  type SessionWritableField,
  type SessionWriteReceipt,
} from './types';

// # Independent in-memory SessionData
//
// Proves the consumer contracts do not depend on Loro, Mirror, CIDs or storage
// offsets: a plain array of detached domain turns. Business rules are NOT
// restated here; every command applies the same shared planner as the Loro
// adapter, and input validation uses the same pure shared validator, so the two
// backends can only differ in how they persist.
//
// Test-only control (never a product seam):
//  - `beforeCommit` / `afterCommit` pin the exact interleaving of a peer edit or
//    a post-accept failure against an in-flight command.
//  - `failDurability` makes `waitDurable` reject, modelling a local durability
//    barrier that failed without turning that into a write rejection.

export type MemoryCommitPlan = {
  readonly kind: SessionWriteReceipt['kind'];
  readonly turnIds: readonly string[];
};

export type MemorySessionDataOptions = {
  sessionId: SessionId;
  initialTurns?: readonly SessionTurn[];
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
  /** Snapshot of stored turns; detached, newest last. */
  readStored(): SessionTurn[];
  /** Mark every accepted change locally durable. */
  markDurable(): void;
  /** Number of accepted changes not yet marked durable. */
  pendingDurableCount(): number;
  /** Mutate storage as a peer would, bypassing this instance's commands. */
  applyPeerMutation(mutate: (turns: SessionTurn[]) => void): void;
  /**
   * An honest snapshot service for this store: capture/release are real and
   * handle validation matches the Loro backend, but `capabilities.copy` is
   * `false` and `copyFrom` returns `rejected('unsupported')` — this double
   * never claims stored-copy support it does not implement.
   */
  readonly snapshots: SessionSnapshotService;
};

const clone = <T>(value: T): T =>
  typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));

const withoutUndefined = <T>(value: T): T => {
  const result = { ...(value as Record<string, unknown>) };
  for (const key of Object.keys(result)) if (result[key] === undefined) delete result[key];
  return result as T;
};

const rejected = (
  code: 'invalid_input' | 'not_found' | 'conflict' | 'unsupported',
  issues?: readonly { readonly path: readonly PropertyKey[]; readonly code: string }[]
): SessionCommandResult => ({
  status: 'rejected',
  reason: { code, ...(issues ? { issues } : {}) },
});

const issuesOf = (
  error: unknown
): readonly { readonly path: readonly PropertyKey[]; readonly code: string }[] =>
  (
    error as {
      issues?: readonly { readonly path: readonly PropertyKey[]; readonly code: string }[];
    }
  ).issues ?? [{ path: [], code: 'invalid_input' }];

const toRejection = (error: unknown): SessionCommandResult =>
  rejected('invalid_input', issuesOf(error));

export function createMemorySessionData(options: MemorySessionDataOptions): MemorySessionData {
  const sessionId = options.sessionId;
  let turns: SessionTurn[] = (options.initialTurns ?? []).map(clone);
  let acceptedSerial = 0;
  let durableSerial = 0;
  const issuedReceipts = new WeakSet<object>();
  const receiptSerial = new WeakMap<object, number>();
  const durableWaiters = new Set<() => void>();
  const listeners = new Set<SessionDataChangeListener>();

  const storedTurns = () => turns.map((turn) => withoutUndefined({ ...turn }));

  // Match the Loro writer's `locate`: the newest row with this id wins.
  const findIndex = (turnId: string) => {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index]!.id === turnId) return index;
    }
    return -1;
  };

  const notify = (range?: { from: number; to: number; structural?: boolean }) => {
    for (const listener of listeners)
      listener(
        range
          ? {
              kind: 'changed',
              from: range.from,
              to: range.to,
              ...(range.structural ? { structural: true } : {}),
            }
          : { kind: 'changed' }
      );
  };

  const directory = (from: number, to: number): readonly SessionDirectoryRow[] => {
    const lo = Math.max(0, Math.min(from, turns.length));
    const hi = Math.max(lo, Math.min(to, turns.length));
    const rows: SessionDirectoryRow[] = [];
    for (let position = lo; position < hi; position += 1) {
      const turn = turns[position];
      if (!turn) {
        rows.push({ position, state: 'invalid' });
        continue;
      }
      const scalars = pickDirectoryScalars(turn);
      if (!scalars) {
        rows.push({ position, state: 'invalid' });
        continue;
      }
      rows.push({
        position,
        state: 'ready',
        turnId: turn.id,
        scalars,
        ...(scalars.role === 'user'
          ? { inputConfig: pickDirectoryInputConfig(turn.inputConfig) }
          : {}),
        itemCount: Array.isArray(turn.items) ? turn.items.length : 0,
        planCount: Array.isArray(turn.plan) ? turn.plan.length : 0,
      });
    }
    return rows;
  };

  const issueReceipt = (
    kind: SessionWriteReceipt['kind'],
    turnIds: readonly string[]
  ): SessionWriteReceipt => {
    const receipt = { sessionId, kind, turnIds } as unknown as SessionWriteReceipt;
    acceptedSerial += 1;
    issuedReceipts.add(receipt);
    receiptSerial.set(receipt, acceptedSerial);
    if (!options.manualDurability) durableSerial = acceptedSerial;
    return receipt;
  };

  const mutating = async (
    kind: SessionWriteReceipt['kind'],
    turnIds: readonly string[],
    mutation: (plan: MemoryCommitPlan) => boolean
  ): Promise<SessionCommandResult> => {
    const plan: MemoryCommitPlan = { kind, turnIds };
    await options.beforeCommit?.(plan);
    const beforeLength = turns.length;
    const applied = mutation(plan);
    if (!applied) return rejected('conflict');
    const changedId = plan.turnIds[0];
    const from = changedId !== undefined ? findIndex(changedId) : -1;
    const structural = turns.length !== beforeLength;
    // A structural mutation reports the tail from the first touched row; a
    // scalar write reports only its own turn.
    if (from >= 0)
      notify({ from, to: structural ? turns.length : from + 1, structural });
    else notify();
    const receipt = issueReceipt(kind, plan.turnIds.slice());
    try {
      await options.afterCommit?.(plan);
    } catch (postAcceptError) {
      return { status: 'accepted', receipt, postAcceptError };
    }
    return { status: 'accepted', receipt };
  };

  const reader: SessionHistoryReader = {
    async count() {
      return turns.length;
    },
    async readAt(position) {
      const turn = turns[position];
      if (!turn)
        return position >= 0 && position < turns.length
          ? { state: 'invalid' }
          : { state: 'missing' };
      return { state: 'ready', turn: clone(turn) };
    },
    async readTurn(turnId) {
      const index = findIndex(turnId);
      if (index < 0) return { state: 'missing' };
      return { state: 'ready', turn: clone(turns[index]!) };
    },
    async readRange(from, to) {
      const lo = Math.max(0, Math.min(from, turns.length));
      const hi = Math.max(lo, Math.min(to, turns.length));
      const out: SessionTurnRead[] = [];
      for (let position = lo; position < hi; position += 1) {
        const turn = turns[position];
        out.push(turn ? { state: 'ready', turn: clone(turn) } : { state: 'invalid' });
      }
      return out;
    },
    async readDirectory(from, to) {
      return directory(from, to);
    },
    async readAll() {
      // Detached clone of the whole store in one read.
      return turns.map((turn) => clone(turn));
    },
    observe(listener) {
      // The listener is registered before the snapshot is taken in the same
      // synchronous block, so no change can fall between the two.
      listeners.add(listener);
      const initial = Promise.resolve(directory(0, turns.length));
      let active = true;
      return {
        initial,
        unsubscribe() {
          if (!active) return;
          active = false;
          listeners.delete(listener);
        },
      } satisfies SessionObservation;
    },
  };

  const commands: SessionHistoryCommands = {
    async appendTurn(turn) {
      try {
        parseHistoryWrite(HistoryEntryWriteSchema, turn);
      } catch (error) {
        return toRejection(error);
      }
      return mutating('append', [turn.id], () => {
        turns = [...turns, clone(turn)];
        return true;
      });
    },
    async replaceTurn(turnId, turn) {
      if (turn.id !== turnId)
        return rejected('invalid_input', [{ path: ['id'], code: 'immutable_id' }]);
      const initial = turns[findIndex(turnId)];
      if (!initial) return rejected('not_found');
      // Same changed-only rule as the Loro adapter: validate changed fields and
      // items, retaining unchanged opaque stored content.
      let prepared: SessionTurn;
      try {
        prepared = withoutUndefined(
          clone(prepareReplacement(initial, turn))
        ) as unknown as SessionTurn;
      } catch (error) {
        return toRejection(error);
      }
      return mutating('replace', [turnId], () => {
        // Re-locate at commit time: a peer edit between the precondition and the
        // mutation cannot redirect this write to a stale position.
        const index = findIndex(turnId);
        if (index < 0) return false;
        const next = turns.slice();
        next[index] = clone(prepared);
        turns = next;
        return true;
      });
    },
    async setTurnField<K extends SessionWritableField>(
      turnId: string,
      key: K,
      change: SessionFieldChange<SessionTurnWritableValues[K]>
    ) {
      if (findIndex(turnId) < 0) return rejected('not_found');
      let value: unknown;
      if (change.kind === 'set') {
        try {
          value = parseHistoryWrite(HistoryEntryWriteSchema.shape[key] as z.ZodType, change.value);
        } catch (error) {
          return toRejection(error);
        }
      }
      return mutating('set-field', [turnId], () => {
        const index = findIndex(turnId);
        if (index < 0) return false;
        const next = turns.slice();
        const updated = { ...(next[index] as Record<string, unknown>) };
        if (change.kind === 'clear') delete updated[key];
        else updated[key] = value;
        next[index] = withoutUndefined(updated) as SessionTurn;
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
        if (index < 0 || turns[index]!.role !== 'assistant') return false;
        const next = turns.slice();
        const updated = { ...(next[index] as Record<string, unknown>) };
        applyResumeAssistant(updated);
        next[index] = withoutUndefined(updated) as SessionTurn;
        turns = next;
        return true;
      });
    },
    async markTurnSeen(turnId) {
      if (findIndex(turnId) < 0) return rejected('not_found');
      return mutating('mark-seen', [turnId], () => {
        const index = findIndex(turnId);
        if (index < 0) return false;
        const next = turns.slice();
        const updated = { ...(next[index] as Record<string, unknown>) };
        // Same commit-time guard as the Loro adapter: never regress a status a
        // concurrent writer advanced; a blocked write is `rejected('conflict')`.
        if (markTurnSeenBlocked(updated)) return false;
        const changed = applyMarkTurnSeen(updated);
        if (!changed) return true;
        next[index] = withoutUndefined(updated) as SessionTurn;
        turns = next;
        return true;
      });
    },
    async openAssistantTurn(input) {
      const initial = findIndex(input.turnId);
      if (initial < 0) {
        const entry = withoutUndefined(createAssistantTurn(input)) as unknown as SessionTurn;
        try {
          parseHistoryWrite(HistoryEntryWriteSchema, entry);
        } catch (error) {
          return toRejection(error);
        }
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
        const updated = { ...(next[index] as Record<string, unknown>) };
        applyOpenAssistantTurn(updated, input);
        next[index] = withoutUndefined(updated) as SessionTurn;
        turns = next;
        return true;
      });
    },
    async resolveTaskProposal(entryId, proposalId, resolution) {
      try {
        parseTaskProposalResolution(resolution);
      } catch (error) {
        return toRejection(error);
      }
      const initial = findIndex(entryId);
      if (initial < 0) return rejected('not_found');
      if (!hasTaskProposal(turns[initial] as unknown as { items?: unknown }, proposalId))
        return rejected('not_found');
      return mutating('resolve-task-proposal', [entryId], () => {
        const index = findIndex(entryId);
        if (index < 0) return false;
        const updated = { ...(turns[index] as Record<string, unknown>) };
        if (!resolveTaskProposalOnEntry(updated, proposalId, resolution)) return false;
        const next = turns.slice();
        next[index] = withoutUndefined(updated) as SessionTurn;
        turns = next;
        return true;
      });
    },
    async respondPermission(requestId, outcome, permissionOptions) {
      try {
        parseHistoryWrite(PermissionOutcomeSchema, outcome);
      } catch (error) {
        return toRejection(error);
      }
      const locate = (): number | undefined => {
        const candidates = permissionOptions?.turnId
          ? [findIndex(permissionOptions.turnId)]
          : Array.from({ length: turns.length }, (_unused, offset) => turns.length - 1 - offset);
        for (const index of candidates) {
          if (index < 0 || !turns[index]) continue;
          if (applyRespondPermission(clone(turns[index]!) as never, requestId, outcome))
            return index;
        }
        return undefined;
      };
      const found = locate();
      if (found === undefined) return rejected('not_found');
      return mutating('respond-permission', [turns[found]!.id], () => {
        const index = locate();
        if (index === undefined) return false;
        const updated = { ...(turns[index] as Record<string, unknown>) };
        if (!applyRespondPermission(updated, requestId, outcome)) return false;
        const next = turns.slice();
        next[index] = withoutUndefined(updated) as SessionTurn;
        turns = next;
        return true;
      });
    },
    async applyAgentBatch(input) {
      const notifications = input.notifications ?? [];
      const contents = input.contents ?? [];
      const targetId = input.targetAssistantEntryId;
      const touched = targetId !== undefined ? [targetId] : [];
      if (notifications.length === 0 && contents.length === 0) {
        return mutating('apply-agent-batch', touched, () => true);
      }
      const applyTo = (history: SessionHistoryInput[]): SessionHistoryInput[] => {
        let next = history;
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
        // Missing target falls through to the routed path, which creates it.
        if (findIndex(targetId) >= 0) {
          return mutating('apply-agent-batch', touched, () => {
            const index = findIndex(targetId);
            if (index < 0) return false;
            const entry = clone(turns[index]!) as unknown as SessionHistoryInput;
            const next = applyTo([entry]);
            const nextTurns = turns.slice();
            nextTurns[index] = withoutUndefined(next[0] ?? entry) as SessionTurn;
            turns = nextTurns;
            return true;
          });
        }
      }
      return mutating('apply-agent-batch', touched, () => {
        const draft = turns.map((turn) => clone(turn)) as unknown as SessionHistoryInput[];
        turns = applyTo(draft) as unknown as SessionTurn[];
        return true;
      });
    },
    // The double never claims writer-owned guarded operations it cannot perform
    // honestly: rollback compensation and the no-gap import binding are storage
    // rules, so both are explicit `unsupported` rejections.
    async updateHistoryWithRollback() {
      return rejected('unsupported') as SessionRollbackCommandResult;
    },
    async applyHistoryImport() {
      return rejected('unsupported');
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
      if (acceptedSerial === 0) {
        throw new SessionDurabilityError(
          'invalid_receipt',
          'No accepted change exists to await durability for.'
        );
      }
      if (options.failDurability !== undefined) throw options.failDurability;
      const serial = receipt ? (receiptSerial.get(receipt) ?? acceptedSerial) : acceptedSerial;
      if (serial <= durableSerial) return;
      await new Promise<void>((resolve) => durableWaiters.add(resolve));
    },
  };

  // # Honest snapshot service
  //
  // This double captures a real detached copy of its own store and enforces the
  // same handle scoping as the Loro backend (forged/foreign/released handles
  // throw the matching `SessionSnapshotError`). It does not implement stored
  // copy, so `capabilities.copy` is `false` and `copyFrom` always returns
  // `rejected('unsupported')` after handle validation.
  const snapshotToken = {};
  const issuedSnapshots = new WeakSet<object>();

  const snapshots: SessionSnapshotService = {
    capabilities: { copy: false },
    capture() {
      // One consistent capture: a single detached clone of the whole store.
      const captured = turns.map(clone);
      const snapshot = mintSessionSnapshot(
        {
          token: snapshotToken,
          backend: 'memory',
          payload: captured,
          issued: issuedSnapshots,
          isClosed: () => false,
        },
        sessionId,
        () => {
          if (!issuedSnapshots.has(snapshot))
            throw new SessionSnapshotError('released', 'The snapshot was released.');
          return captured.map(clone);
        }
      );
      issuedSnapshots.add(snapshot);
      return snapshot;
    },
    release(snapshot) {
      const issuer = sessionSnapshotContext(snapshot);
      if (issuer === undefined)
        throw new SessionSnapshotError(
          'invalid_snapshot',
          'Not a snapshot capability of any store.'
        );
      if (issuer.token !== snapshotToken)
        throw new SessionSnapshotError(
          'cross_store',
          'The snapshot was issued by a different store.'
        );
      // Idempotent: releasing an already-released handle is a no-op.
      issuedSnapshots.delete(snapshot);
    },
    copyFrom(snapshot) {
      // Handle validation first: a bad handle throws, only a valid one reports
      // the honest `unsupported` result.
      checkSessionSnapshot(snapshot, snapshotToken, false);
      return rejected('unsupported');
    },
  };

  return {
    sessionId,
    history: reader,
    commands,
    durability,
    snapshots,
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
      notify();
    },
  };
}

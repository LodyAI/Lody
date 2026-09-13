import { selectTurnOutput } from './read';
import { HistoryActionRefused } from './task-proposal';
import { applyHistoryAction, historyActionTarget } from './history-actions';
import {
  HistoryImportCursorSchema,
  HistoryImportRefused,
  planHistoryImport,
  createImportCursor,
  hashHistoryEntry,
  resolveImportedTurnHashes,
} from './history-import';
import { isSessionHistoryPendingForDispatch } from '../schema';
import {
  isContainer,
  type LoroDoc,
  type LoroEventBatch,
  type LoroList,
  type LoroMap,
} from 'loro-crdt';
import type { SessionId } from '../ids';
import type { SessionHistory, SessionHistoryInput } from '../schema';
import {
  HistoryEntryWriteSchema,
  HistoryWriteError,
  parseHistoryWrite,
} from '../history-write-schema';
import { PermissionOutcomeSchema } from '../message-schemas';
import { pickDirectoryInputConfig, pickDirectoryScalars } from './directory';
import { createHistoryWriter, type HistoryWriter } from '../history-writer';
import type { SessionSnapshotService } from './snapshot';
import {
  EditableTailRefusedError,
  hasTaskProposal,
  parseTaskProposalResolution,
  planEditableTailReplacement,
  resolveTaskProposalOnEntry,
  type EditableTailPlan,
} from './planner';
import {
  type SessionCommandResult,
  type SessionData,
  type SessionDirectoryRow,
  type SessionEditableTailResult,
  type SessionImportResult,
  type SessionHistoryCommands,
  type SessionHistoryReader,
  type SessionObservation,
  type SessionTurn,
  type SessionTurnRead,
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
// ruled out) rather than as a pre-write rejection.

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
   * Control-plane cursor access for the composed history import: the adapter
   * reads the current cursor and writes the new one inside the same synchronous
   * block as the history write, so there is no await gap between them. The
   * session entrypoint supplies the Mirror-backed accessors; tests may omit it
   * (imports reject before writing without this accessor).
   */
  historyImportCursor?: {
    readonly read: () => unknown;
    readonly write: (cursor: unknown) => void;
  };
};

export type LoroSessionData = SessionData & {
  /** The shared writer, for storage-owned capabilities (capture/copy/rollback). */
  readonly writer: HistoryWriter;
  dispose(): void;
};

const asStoredTurn = (value: unknown): SessionTurn | undefined => {
  if (isContainer(value)) {
    if (value.kind() !== 'Map') return undefined;
    const json = (value as LoroMap).toJSON();
    return json && typeof json === 'object' ? (json as SessionTurn) : undefined;
  }
  // Legacy plain-JSON rows are still valid readable history.
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as SessionTurn;
  return undefined;
};

/** Shallow identity of one raw slot: never reads the turn's body. */
const readIdentity = (value: unknown): { turnId?: string } | undefined => {
  if (isContainer(value)) {
    if (value.kind() !== 'Map') return undefined;
    const id = (value as LoroMap).get('id');
    return { ...(typeof id === 'string' ? { turnId: id } : {}) };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as { id?: unknown }).id;
    return { ...(typeof id === 'string' ? { turnId: id } : {}) };
  }
  return undefined;
};

const readSlot = (list: LoroList, position: number): SessionTurnRead => {
  if (position < 0 || position >= list.length) return { state: 'missing' };
  const turn = asStoredTurn(list.get(position));
  return turn ? { state: 'ready', turn } : { state: 'invalid' };
};

export function createLoroSessionData(options: LoroSessionDataOptions): LoroSessionData {
  const { sessionId, doc } = options;
  const writer = options.writer ?? createHistoryWriter(doc);
  const list = doc.getList(HISTORY_ROOT_KEY);

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

  /** Shallow send config for a user turn: small collections only, never the body. */
  const shallowInputConfig = (map: LoroMap): unknown => {
    const config = map.get('inputConfig');
    if (!isContainer(config)) return pickDirectoryInputConfig(config);
    if (config.kind() !== 'Map') return undefined;
    const configMap = config as LoroMap;
    const value = { ...configMap.getShallowValue() } as Record<string, unknown>;
    for (const key of ['mcpServerIds', 'configOptionValues'] as const) {
      if (value[key] === undefined) continue;
      const field = configMap.get(key);
      value[key] = isContainer(field) ? (field as LoroList).toJSON() : field;
    }
    return pickDirectoryInputConfig(value);
  };

  const readDirectoryRow = (position: number): SessionDirectoryRow => {
    const value = list.get(position);
    if (isContainer(value)) {
      if (value.kind() !== 'Map') return { position, state: 'invalid' };
      const map = value as LoroMap;
      const scalars = pickDirectoryScalars(map.getShallowValue());
      if (!scalars) return { position, state: 'invalid' };
      return {
        position,
        state: 'ready',
        turnId: scalars.id,
        scalars,
        // Send config is eager for user turns; counts are deliberately omitted
        // here (one container crossing each) and arrive with a summary or a
        // hydration read.
        ...(scalars.role === 'user' ? { inputConfig: shallowInputConfig(map) } : {}),
      };
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const scalars = pickDirectoryScalars(record);
      if (!scalars) return { position, state: 'invalid' };
      const itemCount = Array.isArray(record.items) ? record.items.length : undefined;
      const planCount = Array.isArray(record.plan) ? record.plan.length : undefined;
      return {
        position,
        state: 'ready',
        turnId: scalars.id,
        scalars,
        ...(scalars.role === 'user'
          ? { inputConfig: pickDirectoryInputConfig(record.inputConfig) }
          : {}),
        ...(itemCount !== undefined ? { itemCount } : {}),
        ...(planCount !== undefined ? { planCount } : {}),
      };
    }
    return { position, state: 'invalid' };
  };

  const directory = (from: number, to: number): readonly SessionDirectoryRow[] => {
    const lo = Math.max(0, Math.min(from, list.length));
    const hi = Math.max(lo, Math.min(to, list.length));
    const rows: SessionDirectoryRow[] = [];
    for (let position = lo; position < hi; position += 1) {
      rows.push(readDirectoryRow(position));
    }
    return rows;
  };

  /**
   * The raw positions a batch touched, for a consumer that re-reads only the
   * affected window. Structural list edits report `[structuralFrom, length)`
   * because later positions shifted; child edits report their own turn.
   */
  const changeRangeOf = (
    batch: LoroEventBatch
  ): { from: number; to: number; structural: boolean } | undefined => {
    let from = Number.POSITIVE_INFINITY;
    let to = -1;
    let structuralFrom = Number.POSITIVE_INFINITY;
    let structural = false;
    for (const event of batch.events) {
      if (event.target === list.id && event.diff.type === 'list') {
        structural = true;
        let cursor = 0;
        for (const delta of event.diff.diff) {
          if (delta.retain !== undefined) {
            cursor += delta.retain;
          } else if (delta.delete !== undefined) {
            structuralFrom = Math.min(structuralFrom, cursor);
          } else if (delta.insert !== undefined) {
            structuralFrom = Math.min(structuralFrom, cursor);
            cursor += delta.insert.length;
          }
        }
        continue;
      }
      if (event.path[0] !== HISTORY_ROOT_KEY) continue;
      const index = event.path[1];
      if (typeof index === 'number') {
        from = Math.min(from, index);
        to = Math.max(to, index + 1);
      } else {
        from = 0;
        to = list.length;
      }
    }
    if (structural) {
      // A mixed batch can carry an earlier child edit (a content change) plus a
      // list insert/delete. Keep the earlier content position too, so the
      // consumer re-reads every affected identity, not just the shifted suffix.
      const contentFrom = Number.isFinite(from) ? from : structuralFrom;
      const lo = Number.isFinite(structuralFrom)
        ? Math.min(structuralFrom, contentFrom)
        : contentFrom;
      return { from: Math.max(0, Math.min(lo, list.length)), to: list.length, structural: true };
    }
    if (to < 0) return undefined;
    return {
      from: Math.max(0, Math.min(from, list.length)),
      to: Math.max(0, Math.min(to, list.length)),
      structural: false,
    };
  };

  // One shallow identity scan per structural/identity change, never per body.
  const positions = new Map<string, number>();
  let identityDirty = true;
  let indexedLength = -1;
  const unsubscribeIdentity = doc.subscribe((batch) => {
    if (
      batch.events.some(
        (event) =>
          (event.target === list.id && event.diff.type === 'list') ||
          (event.path[0] === HISTORY_ROOT_KEY &&
            event.path.length === 2 &&
            event.diff.type === 'map' &&
            Object.hasOwn(event.diff.updated, 'id'))
      )
    )
      identityDirty = true;
  });
  const ensureIdentityIndex = () => {
    if (!identityDirty && indexedLength === list.length && doc.getPendingTxnLength() === 0) return;
    positions.clear();
    for (let i = 0; i < list.length; i++) {
      const id = readIdentity(list.get(i))?.turnId;
      if (id !== undefined) positions.set(id, i); // newest duplicate wins, like writer.locate
    }
    indexedLength = list.length;
    identityDirty = false;
  };

  const history: SessionHistoryReader = {
    async readTurnOutput(userTurnId) {
      return selectTurnOutput(
        list.length,
        userTurnId,
        (index) => {
          const value = list.get(index);
          return pickDirectoryScalars(
            isContainer(value) && value.kind() === 'Map'
              ? (value as LoroMap).getShallowValue()
              : value
          );
        },
        (index) => {
          const read = readSlot(list, index);
          return read.state === 'ready'
            ? (read.turn as import('./domain').SessionEntry)
            : undefined;
        }
      );
    },
    async count() {
      return list.length;
    },
    async readAt(position) {
      return readSlot(list, position);
    },
    async readTurn(turnId) {
      ensureIdentityIndex();
      const position = positions.get(turnId);
      return position === undefined ? { state: 'missing' } : readSlot(list, position);
    },
    async readRange(from, to) {
      const lo = Math.max(0, Math.min(from, list.length));
      const hi = Math.max(lo, Math.min(to, list.length));
      const out: SessionTurnRead[] = [];
      for (let position = lo; position < hi; position += 1) out.push(readSlot(list, position));
      return out;
    },
    async readDirectory(from, to) {
      return directory(from, to);
    },
    async readAll() {
      // One detached synchronous read of the stored list: a single consistent
      // snapshot, never a stitched count + paginated read.
      return writer.readStored();
    },
    observe(listener) {
      // Subscribe first, then snapshot in the same synchronous block: a change
      // can neither be missed between the two nor delivered before `initial`.
      const unsubscribeDoc = doc.subscribe((batch) => {
        const range = changeRangeOf(batch);
        // A batch that does not touch `history` (e.g. a control root) is not a
        // history change; unrelated roots never invalidate the display cache.
        if (!range) return;
        listener({
          kind: 'changed',
          from: range.from,
          to: range.to,
          ...(range.structural ? { structural: true } : {}),
        });
      });
      const initial = Promise.resolve(directory(0, list.length));
      let active = true;
      return {
        initial,
        unsubscribe() {
          if (!active) return;
          active = false;
          unsubscribeDoc();
        },
      } satisfies SessionObservation;
    },
  };

  const commands: SessionHistoryCommands = {
    async applyHistoryAction(action) {
      let matched = action.kind === 'user-status' && action.requeueUndelivered === true;
      let proposal: import('./task-proposal').TaskProposalPublishResult | undefined;
      const apply = (entries: SessionHistoryInput[]) => {
        const result = applyHistoryAction(entries, action);
        matched = result.matched;
        proposal = result.proposal;
        return result.turns;
      };
      try {
        if (action.kind === 'operation-progress' || action.kind === 'task-proposal') {
          const current = writer.readStored();
          const preview = applyHistoryAction(current, action);
          if (!preview.matched)
            return {
              ...(await accepted()),
              matched: false,
              proposal: preview.proposal,
            };
        }
        const target = historyActionTarget(action);
        if (target !== undefined) writer.updateEntry(target, (entry) => apply([entry])[0] ?? entry);
        else writer.update(apply);
      } catch (error) {
        if (error instanceof HistoryActionRefused) return rejected('conflict');
        if (error instanceof HistoryWriteError) return rejected('invalid_input', issuesOf(error));
        return indeterminate(error);
      }
      return { ...(await accepted()), matched, proposal };
    },
    async appendTurn(turn) {
      try {
        parseHistoryWrite(HistoryEntryWriteSchema, turn);
      } catch (error) {
        return rejected('invalid_input', issuesOf(error));
      }
      try {
        writer.append(turn as unknown as SessionHistory);
      } catch (cause) {
        return indeterminate(cause);
      }
      return accepted();
    },
    async replaceTurn(turnId, turn) {
      if (turn.id !== turnId)
        return rejected('invalid_input', [{ path: ['id'], code: 'immutable_id' }]);
      // Stage through the writer's prepare/commit boundary: only changed fields
      // and items are validated, so unchanged opaque stored content survives.
      let commit: (() => void) | undefined;
      try {
        commit = writer.prepareReplace(turnId, turn as unknown as SessionHistory);
      } catch (error) {
        if (error instanceof HistoryWriteError) return rejected('invalid_input', issuesOf(error));
        return indeterminate(error);
      }
      if (!commit) return rejected('not_found');
      try {
        commit();
      } catch (cause) {
        return indeterminate(cause);
      }
      return accepted();
    },
    async resolveTaskProposal(entryId, proposalId, resolution) {
      try {
        parseTaskProposalResolution(resolution);
      } catch (error) {
        return rejected('invalid_input', issuesOf(error));
      }
      let found = false;
      let updated: boolean;
      try {
        updated = writer.updateEntry(entryId, (entry) => {
          if (!hasTaskProposal(entry, proposalId)) return entry;
          resolveTaskProposalOnEntry(entry, proposalId, resolution);
          found = true;
          return entry;
        });
      } catch (cause) {
        return indeterminate(cause);
      }
      if (!updated) return rejected('not_found');
      if (!found) return rejected('not_found');
      return accepted();
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
      return accepted();
    },
    async replaceEditableTail(input): Promise<SessionEditableTailResult> {
      let plan: EditableTailPlan | undefined;
      let restoreRange: () => void;
      try {
        // The shared planner runs inside the writer's conditional commit, so the
        // eligibility/goal re-check and the write are one atomic step.
        restoreRange = writer.updateWithRollback((turns) => {
          const next = planEditableTailReplacement(
            turns as unknown as readonly SessionTurn[],
            input
          );
          plan = next;
          return next.turns as unknown as SessionHistoryInput[];
        });
      } catch (error) {
        // A domain refusal proves nothing was written; a `HistoryWriteError` is a
        // validated pre-write refusal. Both are safe to report as `rejected`.
        if (error instanceof EditableTailRefusedError) {
          return { status: 'rejected', reason: { code: error.code } };
        }
        if (error instanceof HistoryWriteError) {
          return { status: 'rejected', reason: { code: 'invalid_input', issues: issuesOf(error) } };
        }
        return { status: 'indeterminate', cause: error };
      }
      const previousUserTurnId = plan?.previousUserTurnId;
      return {
        status: 'accepted',
        // The writer's rule is still one synchronous conditional restore. It is
        // exposed as awaitable so a caller cannot persist follow-up state before
        // the compensation finished; a synchronous throw rejects the promise.
        rollback: async () => {
          restoreRange();
        },
        ...(previousUserTurnId !== undefined ? { previousUserTurnId } : {}),
      };
    },
    async applyHistoryImport(input): Promise<SessionImportResult> {
      if (!options.historyImportCursor)
        return { status: 'rejected', reason: { code: 'unsupported' } };
      let appended = 0;
      let writing = false;
      let historyWritten = false;
      try {
        const cursor = HistoryImportCursorSchema.optional().parse(
          options.historyImportCursor.read()
        );
        const importedHashes =
          input.mode === 'refresh'
            ? resolveImportedTurnHashes(input.externalHistory, cursor?.importedTurnHashes)
            : [];
        const projectedHashes = [
          ...importedHashes,
          ...input.replay.history
            .slice(importedHashes.length)
            .map((entry) => hashHistoryEntry(parseHistoryWrite(HistoryEntryWriteSchema, entry))),
        ];
        writer.update((turns) => {
          const plan = planHistoryImport(
            input,
            turns,
            cursor,
            projectedHashes,
            turns.some(isSessionHistoryPendingForDispatch)
          );
          appended = plan.appended;
          // Writer preflights authored changes before its first storage mutation.
          writing = true;
          return [...plan.turns] as SessionHistoryInput[];
        });
        historyWritten = true;
        const nextCursor = createImportCursor(input.replay.turnHashes, writer.readStored());
        options.historyImportCursor.write(nextCursor);
        return { status: 'accepted', appended };
      } catch (error) {
        if (historyWritten) return indeterminate(error);
        if (error instanceof HistoryImportRefused)
          return { status: 'rejected', reason: { code: error.code } };
        if (!historyWritten && error instanceof HistoryWriteError)
          return { status: 'rejected', reason: { code: 'invalid_input', issues: issuesOf(error) } };
        if (!writing) return { status: 'rejected', reason: { code: 'invalid_input' } };
        return { status: 'indeterminate', cause: error };
      }
    },
  };

  // # Storage-owned snapshot service
  const snapshots: SessionSnapshotService = {
    async capture() {
      return writer.capture();
    },
    async copyFrom(snapshot, selection) {
      try {
        writer.copyFrom(snapshot, selection as unknown as SessionHistoryInput[]);
      } catch (error) {
        // The writer validates colliding ids and prepares every authored change
        // before any mutation, so a HistoryWriteError here is a pre-write
        // rejection; anything else is an indeterminate post-invocation throw.
        if (error instanceof HistoryWriteError) {
          if (error.issues?.some((issue) => issue.code === 'copy_target_conflict'))
            return rejected('conflict', issuesOf(error));
          return rejected('invalid_input', issuesOf(error));
        }
        return indeterminate(error);
      }
      return {
        status: 'accepted',
      };
    },
  };

  const dispose = () => {
    unsubscribeIdentity();
    positions.clear();
    identityDirty = true;
  };

  return { sessionId, history, commands, writer, snapshots, dispose };
}

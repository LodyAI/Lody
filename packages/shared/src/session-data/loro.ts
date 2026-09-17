import { selectTurnOutput } from './read';
import { applyHistoryAction, historyActionTarget } from './history-actions';
import {
  HistoryImportCursorSchema,
  HistoryImportRefused,
  planHistoryImport,
  createImportCursor,
  hashHistoryEntryForVersion,
  resolveImportHashVersion,
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
import type {
  SessionEditableTailResult,
  SessionImportResult,
  SessionHistoryCommands,
  SessionHistoryReader,
  SessionObservation,
} from './types';
import type { SessionDirectoryRow, SessionTurn, SessionTurnRead } from './domain';

// Loro reads and shared HistoryWriter commands. Import and tail replacement
// distinguish a validated pre-write refusal from an unknown commit outcome.

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

export type LoroSessionData = ReturnType<typeof createLoroSessionData>;

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

export function createLoroSessionData(options: LoroSessionDataOptions) {
  const { sessionId, doc } = options;
  const writer = options.writer ?? createHistoryWriter(doc);
  const list = doc.getList(HISTORY_ROOT_KEY);

  const issuesOf = (error: HistoryWriteError) => error.issues;
  /**
   * Shallow send config source for a user turn: small collections only, never
   * the body. The container crossings here are cheap; the projection is not.
   */
  const shallowInputConfigSource = (map: LoroMap): unknown => {
    const config = map.get('inputConfig');
    if (!isContainer(config)) return config;
    if (config.kind() !== 'Map') return undefined;
    const configMap = config as LoroMap;
    const value = { ...configMap.getShallowValue() } as Record<string, unknown>;
    for (const key of ['mcpServerIds', 'configOptionValues'] as const) {
      if (value[key] === undefined) continue;
      const field = configMap.get(key);
      value[key] = isContainer(field) ? (field as LoroList).toJSON() : field;
    }
    return value;
  };

  /**
   * Attach the row's send configuration as a deferred, memoized projection.
   *
   * `pickDirectoryInputConfig` runs a schema parse. A directory read covers
   * every user turn in the conversation, while its consumers resolve sticky
   * configuration from the newest turn or two — so opening a long session paid
   * thousands of parses to answer a question about its tail.
   */
  const withDeferredInputConfig = <T extends object>(row: T, source: unknown): T => {
    let projected: unknown;
    let done = false;
    Object.defineProperty(row, 'inputConfig', {
      enumerable: true,
      configurable: true,
      get: () => {
        if (!done) {
          done = true;
          projected = pickDirectoryInputConfig(source);
        }
        return projected;
      },
    });
    return row;
  };

  const readDirectoryRow = (position: number): SessionDirectoryRow => {
    const value = list.get(position);
    if (isContainer(value)) {
      if (value.kind() !== 'Map') return { position, state: 'invalid' };
      const map = value as LoroMap;
      const scalars = pickDirectoryScalars(map.getShallowValue());
      if (!scalars) return { position, state: 'invalid' };
      const row: SessionDirectoryRow = { position, state: 'ready', turnId: scalars.id, scalars };
      // Send config is present for user turns but projected on first read;
      // counts are deliberately omitted here (one container crossing each) and
      // arrive with a summary or a hydration read.
      return scalars.role === 'user'
        ? withDeferredInputConfig(row, shallowInputConfigSource(map))
        : row;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const scalars = pickDirectoryScalars(record);
      if (!scalars) return { position, state: 'invalid' };
      const itemCount = Array.isArray(record.items) ? record.items.length : undefined;
      const planCount = Array.isArray(record.plan) ? record.plan.length : undefined;
      const row: SessionDirectoryRow = {
        position,
        state: 'ready',
        turnId: scalars.id,
        scalars,
        ...(itemCount !== undefined ? { itemCount } : {}),
        ...(planCount !== undefined ? { planCount } : {}),
      };
      return scalars.role === 'user' ? withDeferredInputConfig(row, record.inputConfig) : row;
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

  const isTurnIdentityEdit = (event: LoroEventBatch['events'][number]) =>
    event.path[0] === HISTORY_ROOT_KEY &&
    event.path.length === 2 &&
    event.diff.type === 'map' &&
    Object.hasOwn(event.diff.updated, 'id');

  /**
   * What a batch touched, for a consumer that re-reads only the affected turns.
   *
   * Structural list edits report `[structuralFrom, length)` because later
   * positions shifted. In-place turn ID edits are structural for the same
   * reason: a consumer still keyed by the old ID cannot resolve the new (or
   * missing) one.
   *
   * A content batch reports the EXACT positions it touched, never the span
   * between the lowest and highest of them. One synced batch routinely carries
   * an early turn's status write alongside the streaming tail; reporting the
   * span made the display cache re-read every row and re-materialize every
   * hydrated body between the two.
   */
  const changeScopeOf = (
    batch: LoroEventBatch
  ):
    | { structural: true; from: number; to: number }
    | { structural: false; positions: readonly number[] }
    | undefined => {
    const positions = new Set<number>();
    let wholeDirectory = false;
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
        if (isTurnIdentityEdit(event)) {
          structural = true;
          structuralFrom = Math.min(structuralFrom, index);
        }
        positions.add(index);
      } else {
        // An edit that does not resolve to a slot: the whole directory is the
        // only safe answer.
        wholeDirectory = true;
      }
    }
    if (structural) {
      // A mixed batch can carry an earlier child edit (a content change) plus a
      // list insert/delete. Keep the earlier content position too, so the
      // consumer re-reads every affected identity, not just the shifted suffix.
      let contentFrom = wholeDirectory ? 0 : Number.POSITIVE_INFINITY;
      for (const position of positions) contentFrom = Math.min(contentFrom, position);
      if (!Number.isFinite(contentFrom)) contentFrom = structuralFrom;
      const lo = Number.isFinite(structuralFrom)
        ? Math.min(structuralFrom, contentFrom)
        : contentFrom;
      return { structural: true, from: Math.max(0, Math.min(lo, list.length)), to: list.length };
    }
    if (wholeDirectory) {
      return {
        structural: false,
        positions: Array.from({ length: list.length }, (_, index) => index),
      };
    }
    if (positions.size === 0) return undefined;
    const inRange = [...positions]
      .filter((position) => position >= 0 && position < list.length)
      .sort((left, right) => left - right);
    return inRange.length > 0 ? { structural: false, positions: inRange } : undefined;
  };

  // One shallow identity scan per structural/identity change, never per body.
  const positions = new Map<string, number>();
  let identityDirty = true;
  let indexedLength = -1;
  let indexedOpCount = -1;
  const unsubscribeIdentity = doc.subscribe((batch) => {
    if (
      batch.events.some(
        (event) =>
          (event.target === list.id && event.diff.type === 'list') || isTurnIdentityEdit(event)
      )
    )
      identityDirty = true;
  });
  const ensureIdentityIndex = () => {
    // Pending writes are readable before subscription delivery. Reuse the scan
    // until another op arrives; merely having a pending transaction is not a change.
    // opCount includes pending ops and does not restart at commit, unlike pending length.
    if (!identityDirty && indexedLength === list.length) {
      if (doc.getPendingTxnLength() === 0 || indexedOpCount === doc.opCount()) return;
    }
    positions.clear();
    for (let i = 0; i < list.length; i++) {
      const id = readIdentity(list.get(i))?.turnId;
      if (id !== undefined) positions.set(id, i); // newest duplicate wins, like writer.locate
    }
    indexedLength = list.length;
    indexedOpCount = doc.opCount();
    identityDirty = false;
  };

  const history = {
    readTurnOutput(userTurnId: string) {
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
    count() {
      return list.length;
    },
    readAt(position: number) {
      return readSlot(list, position);
    },
    readTurn(turnId: string): SessionTurnRead {
      ensureIdentityIndex();
      const position = positions.get(turnId);
      return position === undefined ? { state: 'missing' } : readSlot(list, position);
    },
    readRange(from: number, to: number) {
      const lo = Math.max(0, Math.min(from, list.length));
      const hi = Math.max(lo, Math.min(to, list.length));
      const out: SessionTurnRead[] = [];
      for (let position = lo; position < hi; position += 1) out.push(readSlot(list, position));
      return out;
    },
    readDirectory(from: number, to: number) {
      return directory(from, to);
    },
    readAll() {
      // One detached synchronous read of the stored list: a single consistent
      // snapshot, never a stitched count + paginated read.
      return writer.readStored();
    },
    observe(listener: import('./types').SessionDataChangeListener) {
      // Subscribe first, then snapshot in the same synchronous block: a change
      // can neither be missed between the two nor delivered before `initial`.
      const unsubscribeDoc = doc.subscribe((batch) => {
        const scope = changeScopeOf(batch);
        // A batch that does not touch `history` (e.g. a control root) is not a
        // history change; unrelated roots never invalidate the display cache.
        if (!scope) return;
        if (scope.structural) {
          listener({ kind: 'structure', from: scope.from, to: scope.to });
        } else {
          const ids: string[] = [];
          for (const position of scope.positions) {
            const id = readIdentity(list.get(position))?.turnId;
            if (id !== undefined) ids.push(id);
          }
          listener({ kind: 'changed', ids });
        }
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
  } satisfies SessionHistoryReader;

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
      if (action.kind === 'operation-progress' || action.kind === 'task-proposal') {
        const preview = applyHistoryAction(writer.readStored(), action);
        if (!preview.matched) return { matched: false, proposal: preview.proposal };
      }
      const target = historyActionTarget(action);
      if (target !== undefined) writer.updateEntry(target, (entry) => apply([entry])[0] ?? entry);
      else writer.update(apply);
      return { matched, proposal };
    },
    async appendTurn(turn) {
      writer.append(turn as unknown as SessionHistory);
    },
    async replaceTurn(turnId, turn) {
      if (turn.id !== turnId) throw new HistoryWriteError([{ path: ['id'], code: 'immutable_id' }]);
      const commit = writer.prepareReplace(turnId, turn as unknown as SessionHistory);
      if (!commit) throw new HistoryWriteError([{ path: ['history'], code: 'not_found' }]);
      commit();
    },
    async resolveTaskProposal(entryId, proposalId, resolution) {
      parseTaskProposalResolution(resolution);
      let found = false;
      writer.updateEntry(entryId, (entry) => {
        if (!hasTaskProposal(entry, proposalId)) return entry;
        resolveTaskProposalOnEntry(entry, proposalId, resolution);
        found = true;
        return entry;
      });
      return found;
    },
    async respondPermission(requestId, outcome, respondOptions) {
      parseHistoryWrite(PermissionOutcomeSchema, outcome);
      return writer.respondPermission(requestId, outcome, respondOptions);
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
        // The projected suffix must be expressed in the stored cursor's own version:
        // it is compared against stored-version hashes inside the planner.
        const storedHashVersion =
          input.mode === 'refresh'
            ? resolveImportHashVersion(input.externalHistory, cursor)
            : input.replay.hashVersion;
        const projectedHashes = [
          ...importedHashes,
          ...input.replay.history
            .slice(importedHashes.length)
            .map((entry) =>
              hashHistoryEntryForVersion(
                parseHistoryWrite(HistoryEntryWriteSchema, entry),
                storedHashVersion
              )
            ),
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
        const nextCursor = createImportCursor(
          input.replay.turnHashes,
          writer.readStored(),
          input.replay.hashVersion
        );
        options.historyImportCursor.write(nextCursor);
        return { status: 'accepted', appended };
      } catch (error) {
        if (historyWritten) return { status: 'indeterminate', cause: error };
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
      writer.copyFrom(snapshot, selection as unknown as SessionHistoryInput[]);
    },
  };

  const dispose = () => {
    unsubscribeIdentity();
    positions.clear();
    identityDirty = true;
  };

  return { sessionId, history, commands, writer, snapshots, dispose };
}

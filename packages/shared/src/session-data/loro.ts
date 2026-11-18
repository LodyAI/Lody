import { createLoroSessionHistoryReader } from './loro-reader';
import { selectHistoryActionRows } from './history-selection';
import { applyHistoryAction, historyActionTarget } from './history-actions';
import {
  HistoryImportRefused,
  planHistoryImport,
  createImportCursor,
  prepareHistoryImportCursor,
} from './history-import';
import { isSessionHistoryPendingForDispatch } from '../schema';
import type { LoroDoc } from 'loro-crdt';
import type { SessionId } from '../ids';
import type { SessionHistory, SessionHistoryInput } from '../schema';
import { HistoryWriteError, parseHistoryWrite } from '../history-write-schema';
import { PermissionOutcomeSchema } from '../message-schemas';

import { createHistoryWriter, type HistoryWriter } from '../history-writer';
import type { SessionSnapshotService } from './snapshot';
import {
  EditableTailRefusedError,
  planEditableTailReplacement,
  type EditableTailPlan,
} from './planner';
import type {
  SessionEditableTailResult,
  SessionImportResult,
  SessionHistoryCommands,
} from './types';
import type { SessionTurn } from './domain';

// Loro reads and shared HistoryWriter commands. Import and tail replacement
// distinguish a validated pre-write refusal from an unknown commit outcome.

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

export function createLoroSessionData(options: LoroSessionDataOptions) {
  const { sessionId, doc } = options;
  const writer = options.writer ?? createHistoryWriter(doc);
  const { history, readLatestGoal, readLatestUserId, dispose } =
    createLoroSessionHistoryReader(doc);

  const issuesOf = (error: HistoryWriteError) => error.issues;
  const commands: SessionHistoryCommands = {
    async applyHistoryAction(action) {
      if (action.kind === 'operation-progress')
        return { matched: writer.updateOperationProgress(action) };
      let matched = action.kind === 'user-status' && action.requeueUndelivered === true;
      const apply = (entries: SessionHistoryInput[]) => {
        const result = applyHistoryAction(entries, action);
        matched = result.matched;
        return result.turns;
      };
      const target = historyActionTarget(action);
      if (action.kind === 'user-status') writer.updateCopies(action.turnId, apply);
      else if (target !== undefined)
        writer.updateEntry(target, (entry) => apply([entry])[0] ?? entry);
      else writer.updateSelected((rows) => selectHistoryActionRows(rows, action), apply);
      return { matched };
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
        restoreRange = writer.updateSelectedWithRollback(
          (rows) => {
            let start = rows.length;
            for (let i = rows.length - 1; i >= 0; i--)
              if (rows[i]?.role === 'user') {
                start = i;
                break;
              }
            return rows.slice(start).map((_, offset) => start + offset);
          },
          (turns) => {
            const next = planEditableTailReplacement(
              turns as unknown as readonly SessionTurn[],
              input
            );
            plan = next;
            return next.turns as unknown as SessionHistoryInput[];
          }
        );
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
        const { cursor, projectedHashes } = prepareHistoryImportCursor(
          input,
          options.historyImportCursor.read()
        );
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

  return {
    sessionId,
    history,
    commands,
    writer,
    snapshots,
    readLatestGoal,
    readLatestUserId,
    dispose,
  };
}

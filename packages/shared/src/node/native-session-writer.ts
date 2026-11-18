import { planNativeSessionInitialControl } from './native-session-initial-plan';
import type { NativeSessionInitialState } from './native-session-document';
import { createHash } from 'node:crypto';
import { HistoryWriteError, parseHistoryWrite } from '../history-write-schema';
import { PermissionOutcomeSchema } from '../message-schemas';
import {
  prepareReplacement,
  prepareHistoryFieldWrite,
  prepareNewHistoryEntry,
  planHistorySequenceUpdate,
  prepareOperationProgressWrite,
  planSelectedHistoryUpdate,
  historyRollbackRange,
  assertHistoryRollbackReceipt,
  captureStoredHistory,
  prepareStoredHistoryCopy,
} from '../history-writer';
import { isSessionHistoryPendingForDispatch } from '../schema';
import type {
  HistoryRollbackMember,
  SessionPlanEntry,
  SessionHistoryInput,
  PermissionOutcome,
} from '../index';
import { applyHistoryAction, historyActionTarget } from '../session-data/history-actions';
import { selectHistoryActionRows } from '../session-data/history-selection';
import {
  applyOpenAssistantTurn,
  createAssistantTurn,
  applyRespondPermission,
  applyMarkTurnSeen,
  markTurnSeenBlocked,
  planEditableTailReplacement,
  EditableTailRefusedError,
} from '../session-data/planner';
import { getOperationProgressTurnId } from '../session-data/operation-progress';
import {
  prepareHistoryImportCursor,
  planHistoryImport,
  createImportCursor,
  HistoryImportRefused,
} from '../session-data/history-import';
import { applySessionAgentBatch } from '../session-data/agent-batch';
import type {
  HistoryAction,
  SessionActionResult,
  SessionEntry,
  SessionTurn,
  OpenAssistantTurnInput,
  SessionWritableField,
  SessionTurnWritableValues,
  SessionFieldChange,
  HistoryImportInput,
  SessionImportResult,
  SessionHistoryCommands,
  AgentHistoryBatchInput,
  SessionSnapshotService,
  ReplaceEditableTailInput,
  SessionEditableTailResult,
} from '../session-data';
import { RepoRpcError, type RepoClient } from '@loro-dev/loro-repo-client';
import type { NativeSessionReader, NativeSessionReadView } from './native-session-reader';
import {
  supportsNativeSessionLiteralValues,
  type NativeSessionSdkCompatibility,
} from './native-session-compatibility';
import { createNativeHistoryPatchPlan } from './native-history-patch';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const historyPath = (position: number) => ['history', position] as const;

/** Actual domain commands for the trusted Node owner; SDK and patch handles stay private. */
export function createNativeSessionWriter(options: {
  readonly client: Pick<RepoClient, 'applyDocPatch' | 'transactCas'>;
  readonly reader: NativeSessionReader | (() => NativeSessionReader);
  readonly namespace: string;
  readonly sessionId: string;
  readonly writer: string;
  readonly compatibility?: NativeSessionSdkCompatibility;
  readonly assertCurrent?: () => void;
}) {
  const { client, namespace, writer } = options;
  const currentReader = () =>
    typeof options.reader === 'function' ? options.reader() : options.reader;
  const room = { kind: 'loro_doc' as const, id: `session-${options.sessionId}` };
  const commit = async <A>(
    prepare: (
      view: NativeSessionReadView,
      plan: ReturnType<typeof createNativeHistoryPatchPlan>
    ) => A,
    phase?: (state: 'preparing' | 'sent' | 'committed') => void
  ): Promise<A> =>
    await client.transactCas(async () => {
      options.assertCurrent?.();
      phase?.('preparing');
      const prepared = await currentReader().queryLossless((view) => {
        const plan = createNativeHistoryPatchPlan(view, undefined, options.compatibility);
        const result = prepare(view, plan);
        return { result, ...plan.finish() };
      });
      options.assertCurrent?.();
      if (prepared.value.patch.length) {
        phase?.('sent');
        await client.applyDocPatch(namespace, room, prepared.value.patch, {
          writer,
          docSchema: prepared.value.docSchema,
          precondition: { mode: 'cas', expected_room_tx_id: prepared.checkpoint.roomTxId },
        });
        phase?.('committed');
      }
      return prepared.value.result;
    });
  const findLast = (view: NativeSessionReadView, turnId: string): number => {
    for (let index = view.history.count() - 1; index >= 0; index--)
      if (view.valueAt([...historyPath(index), 'id']) === turnId) return index;
    return -1;
  };
  const replace = (
    view: NativeSessionReadView,
    plan: ReturnType<typeof createNativeHistoryPatchPlan>,
    position: number,
    update: (entry: SessionHistoryInput) => SessionHistoryInput
  ) => {
    const before = view.valueAt(historyPath(position));
    if (!object(before))
      throw new HistoryWriteError([{ path: ['history', position], code: 'invalid_stored_turn' }]);
    const next = prepareReplacement(before, update(structuredClone(before) as SessionHistoryInput));
    plan.replace(position, before, next);
  };

  const updateSelected = (
    view: NativeSessionReadView,
    plan: ReturnType<typeof createNativeHistoryPatchPlan>,
    select: Parameters<typeof planSelectedHistoryUpdate>[2],
    updater: Parameters<typeof planSelectedHistoryUpdate>[3]
  ) => {
    const prepared = planSelectedHistoryUpdate(
      view.readQuery(),
      (position) => view.valueAt(historyPath(position)) as SessionHistoryInput,
      select,
      updater
    );
    const sequence = planHistorySequenceUpdate(
      prepared.before,
      prepared.next,
      prepared.prepareValue
    );
    for (const item of sequence.items)
      if (item.index >= 0 && item.changed)
        plan.replace(item.index, prepared.before[item.index], item.value);
    for (let index = prepared.before.length - 1; index >= 0; index--)
      if (!sequence.used.has(index)) plan.remove(index, 1);
    sequence.items.forEach((item, index) => {
      if (item.index < 0) plan.append(index, [item.value]);
    });
  };
  const snapshots: SessionSnapshotService = {
    async capture() {
      return (
        await currentReader().queryLossless((view) =>
          captureStoredHistory(view.history.readAll() as SessionHistoryInput[])
        )
      ).value;
    },
    async copyFrom(snapshot, selection) {
      await commit((view, plan) => {
        // A fork is an explicit full copy operation, never a streaming path.
        const previous = view.history.readAll() as SessionHistoryInput[];
        const entries = prepareStoredHistoryCopy(
          snapshot,
          selection as SessionHistoryInput[],
          previous
        );
        plan.append(0, entries);
      });
    },
  };

  const commands = {
    snapshots,
    async initializeDocument(initial?: NativeSessionInitialState): Promise<void> {
      if (!initial) return;
      const entries = (initial.history ?? []).map(prepareNewHistoryEntry);
      await commit((view, plan) => {
        planNativeSessionInitialControl(view, plan, initial, options.sessionId);
        if (entries.length && view.history.count() === 0) plan.append(0, entries);
      });
    },
    async setPlan(entries: readonly SessionPlanEntry[]): Promise<void> {
      await commit((view, plan) => {
        for (let index = view.history.count() - 1; index >= 0; index--) {
          if (view.valueAt(['history', index, 'role']) !== 'assistant') continue;
          const prepared = prepareHistoryFieldWrite(
            'plan',
            view.valueAt(['history', index, 'plan']),
            entries
          );
          if (prepared.changed) plan.fields(index, { plan: prepared.value });
          return;
        }
      });
    },
    async applyAgentBatch(input: AgentHistoryBatchInput): Promise<void> {
      await commit((view, plan) => {
        const events = [
          ...(input.notifications ?? []).map((value) => ({ kind: 'notification' as const, value })),
          ...(input.contents ?? []).map((value) => ({ kind: 'content' as const, value })),
        ];
        const ids = input.operationIds;
        if (ids && (ids.length !== events.length || new Set(ids).size !== events.length))
          throw new HistoryWriteError([{ path: ['operationIds'], code: 'invalid_input' }]);
        const hash = (value: string) => createHash('sha256').update(value).digest('hex');
        const pending = events.filter((event, index) => {
          if (!ids) return true;
          const key = hash(ids[index]!);
          const digest = hash(
            JSON.stringify([event, input.targetAssistantEntryId, input.entryBound, input.model])
          );
          const prior = view.valueAt(['nativeAgentOperations', key]);
          if (prior !== undefined && prior !== digest)
            throw new HistoryWriteError([
              { path: ['operationIds', index], code: 'operation_identity_conflict' },
            ]);
          if (prior === digest) return false;
          plan.agentReceipt(key, digest);
          return true;
        });
        applySessionAgentBatch(
          {
            updateTail(id, targets, updater) {
              const normalized = Array.isArray(targets)
                ? { toolCallIds: targets, taskIds: [], runs: [] }
                : (targets as import('@lody/shared').AgentHistoryTargets);
              const planned = view.planAgentUpdate(id, normalized, updater);
              if (planned.handled) planned.patches.forEach((change) => plan.sparse(change));
              return planned.handled;
            },
            updateEntry(id, updater) {
              const position = findLast(view, id);
              if (position < 0) return false;
              replace(view, plan, position, updater);
              return true;
            },
            updateSelected(select, updater) {
              updateSelected(view, plan, select, updater);
            },
          },
          {
            ...input,
            notifications: pending.flatMap((event) =>
              event.kind === 'notification' ? [event.value] : []
            ),
            contents: pending.flatMap((event) => (event.kind === 'content' ? [event.value] : [])),
          }
        );
      });
    },
    async appendTurn(turn: SessionTurn): Promise<void> {
      const entry = prepareNewHistoryEntry(turn);
      await commit((view, plan) => {
        plan.append(view.history.count(), [entry]);
      });
    },
    async replaceTurn(turnId: string, turn: SessionTurn): Promise<void> {
      if (turn.id !== turnId) throw new HistoryWriteError([{ path: ['id'], code: 'immutable_id' }]);
      await commit((view, plan) => {
        const position = findLast(view, turnId);
        if (position < 0) throw new HistoryWriteError([{ path: ['history'], code: 'not_found' }]);
        replace(view, plan, position, () => turn as SessionHistoryInput);
      });
    },
    async setTurnField<K extends SessionWritableField>(
      turnId: string,
      key: K,
      change: SessionFieldChange<SessionTurnWritableValues[K]>
    ): Promise<void> {
      await commit((view, plan) => {
        const position = findLast(view, turnId);
        if (position < 0) throw new HistoryWriteError([{ path: ['history'], code: 'not_found' }]);
        const previous = view.valueAt([...historyPath(position), key]);
        const prepared = prepareHistoryFieldWrite(
          key,
          previous,
          change.kind === 'set' ? change.value : undefined
        );
        if (prepared.changed) plan.fields(position, { [key]: prepared.value });
      });
    },
    async markTurnSeen(turnId: string): Promise<boolean> {
      return await commit((view, plan) => {
        const position = findLast(view, turnId);
        if (position < 0) return false;
        const before = {
          status: view.valueAt([...historyPath(position), 'status']),
          read: view.valueAt([...historyPath(position), 'read']),
        };
        if (markTurnSeenBlocked(before)) return false;
        const next = { ...before };
        applyMarkTurnSeen(next);
        const fields: Record<string, unknown> = {};
        for (const key of ['status', 'read'] as const) {
          const prepared = prepareHistoryFieldWrite(key, before[key], next[key]);
          if (prepared.changed) fields[key] = prepared.value;
        }
        plan.fields(position, fields);
        return true;
      });
    },
    async openAssistantTurn(input: OpenAssistantTurnInput): Promise<void> {
      await commit((view, plan) => {
        const position = findLast(view, input.turnId);
        if (position < 0) {
          plan.append(view.history.count(), [prepareNewHistoryEntry(createAssistantTurn(input))]);
          return;
        }
        replace(view, plan, position, (turn) => {
          if (turn.role !== 'assistant')
            throw new HistoryWriteError([{ path: ['role'], code: 'invalid_input' }]);
          applyOpenAssistantTurn(turn, input);
          return turn;
        });
      });
    },
    async respondPermission(
      requestId: string,
      outcome: PermissionOutcome,
      respondOptions?: { readonly turnId?: string }
    ): Promise<boolean> {
      parseHistoryWrite(PermissionOutcomeSchema, outcome);
      return await commit((view, plan) => {
        const rows = view.readQuery();
        let selected = -1;
        if (respondOptions?.turnId) selected = findLast(view, respondOptions.turnId);
        const start = respondOptions?.turnId ? selected : rows.length - 1;
        if (respondOptions?.turnId && selected < 0) return false;
        for (let index = start; index >= (respondOptions?.turnId ? selected : 0); index--) {
          const row = rows[index];
          if (
            typeof row?.id !== 'string' ||
            !row.items?.some(
              (item) =>
                item.type === 'tool_call' &&
                (item.permissionRequest as { requestId?: unknown } | undefined)?.requestId ===
                  requestId
            )
          )
            continue;
          // The legacy writer locates the newest duplicate business id before
          // applying the shared single-assignment permission rule.
          const position = findLast(view, row.id);
          if (position < 0) return false;
          let applied = false;
          replace(view, plan, position, (turn) => {
            applied = applyRespondPermission(turn, requestId, outcome);
            return turn;
          });
          return applied;
        }
        return false;
      });
    },
    async replaceEditableTail(input: ReplaceEditableTailInput): Promise<SessionEditableTailResult> {
      let phase: 'preparing' | 'sent' | 'committed' = 'preparing';
      const members = (view: NativeSessionReadView): HistoryRollbackMember[] =>
        Array.from({ length: view.history.count() }, (_, index) => {
          const kind = view.kindAt(historyPath(index));
          return {
            id: view.valueAt([...historyPath(index), 'id']),
            record:
              kind === 'map' || (kind === 'value' && object(view.valueAt(historyPath(index)))),
          };
        });
      try {
        const captured = await commit(
          (view, plan) => {
            const beforeMembers = members(view);
            const query = view.readQuery();
            let previousUserTurnId: string | undefined;
            const prepared = planSelectedHistoryUpdate(
              query,
              (position) => view.valueAt(historyPath(position)) as SessionHistoryInput,
              (rows) => {
                let start = rows.length;
                for (let index = rows.length - 1; index >= 0; index--)
                  if (rows[index]?.role === 'user') {
                    start = index;
                    break;
                  }
                return rows.slice(start).map((_, offset) => start + offset);
              },
              (entries) => {
                const replacement = planEditableTailReplacement(entries as SessionTurn[], input);
                previousUserTurnId = replacement.previousUserTurnId;
                return replacement.turns as SessionHistoryInput[];
              }
            );
            const sequence = planHistorySequenceUpdate(
              prepared.before,
              prepared.next,
              prepared.prepareValue
            );
            const stored = sequence.items.map((item) =>
              item.changed ? item.value : prepared.before[item.index]
            );
            const range = historyRollbackRange(prepared.before, prepared.next);
            const removed = Array.from({ length: range.beforeEnd - range.start }, (_, offset) =>
              view.valueAt(historyPath(range.start + offset))
            );
            const kinds = new Set(
              Array.from({ length: removed.length }, (_, offset) =>
                view.kindAt(historyPath(range.start + offset))
              )
            );
            if (
              [...kinds].some((kind) => kind !== 'map' && kind !== 'value') ||
              removed.some((entry) => !object(entry))
            )
              throw new HistoryWriteError([{ path: ['history'], code: 'invalid_stored_turn' }]);
            if (!supportsNativeSessionLiteralValues(options.compatibility) && kinds.size > 1)
              throw new HistoryWriteError([
                { path: ['history'], code: 'unsupported_mixed_atomic_restore' },
              ]);
            for (const item of sequence.items)
              if (item.index >= 0 && item.changed)
                plan.replace(item.index, prepared.before[item.index], item.value);
            for (let index = prepared.before.length - 1; index >= 0; index--)
              if (!sequence.used.has(index)) plan.remove(index, 1);
            sequence.items.forEach((item, index) => {
              if (item.index < 0) plan.append(index, [item.value]);
            });
            const afterMembers = sequence.items.map((item) =>
              item.changed
                ? { id: object(item.value) ? item.value.id : undefined, record: object(item.value) }
                : beforeMembers[item.index]!
            );
            return {
              beforeMembers,
              afterMembers,
              removed: structuredClone(removed),
              afterRange: structuredClone(stored.slice(range.start, range.afterEnd)),
              atomic: Array.from(
                { length: removed.length },
                (_, offset) => view.kindAt(historyPath(range.start + offset)) === 'value'
              ),
              range,
              previousUserTurnId,
            };
          },
          (next) => {
            phase = next;
          }
        );
        let consumed = false;
        let inFlight: Promise<void> | undefined;
        return {
          status: 'accepted',
          ...(captured.previousUserTurnId === undefined
            ? {}
            : { previousUserTurnId: captured.previousUserTurnId }),
          rollback() {
            if (inFlight) return inFlight;
            inFlight = commit((view, plan) => {
              const currentRange = Array.from(
                { length: captured.range.afterEnd - captured.range.start },
                (_, offset) => view.valueAt(historyPath(captured.range.start + offset))
              );
              assertHistoryRollbackReceipt({
                beforeMembers: captured.beforeMembers,
                afterMembers: captured.afterMembers,
                currentMembers: members(view),
                afterRange: captured.afterRange,
                currentRange,
                consumed,
              });
              plan.remove(captured.range.start, captured.range.afterEnd - captured.range.start);
              plan.restore(captured.range.start, captured.removed, captured.atomic);
            })
              .then(() => {
                consumed = true;
              })
              .finally(() => {
                inFlight = undefined;
              });
            return inFlight;
          },
        };
      } catch (error) {
        if (error instanceof EditableTailRefusedError)
          return { status: 'rejected', reason: { code: error.code } };
        if (phase === 'preparing' && error instanceof HistoryWriteError) {
          if (
            error.issues.some(
              (issue) =>
                issue.code === 'unsupported_mixed_atomic_restore' ||
                issue.code === 'unsupported_mixed_atomic_insertion'
            )
          )
            return { status: 'rejected', reason: { code: 'unsupported' } };
          return { status: 'rejected', reason: { code: 'invalid_input', issues: error.issues } };
        }
        if (error instanceof RepoRpcError && error.code === 'precondition_failed')
          return { status: 'rejected', reason: { code: 'stale_boundary' } };
        return { status: 'indeterminate', cause: error };
      }
    },
    async applyHistoryImport(input: HistoryImportInput): Promise<SessionImportResult> {
      let phase: 'preparing' | 'sent' | 'committed' = 'preparing';
      try {
        const appended = await commit(
          (view, plan) => {
            const current = view.history.readAll() as SessionHistoryInput[];
            const rawCursor = view.valueAt(['externalHistoryCursor']);
            const { cursor, projectedHashes } = prepareHistoryImportCursor(input, rawCursor);
            const imported = planHistoryImport(
              input,
              current as SessionTurn[],
              cursor,
              projectedHashes,
              current.some(isSessionHistoryPendingForDispatch)
            );
            const sequence = planHistorySequenceUpdate(
              current,
              imported.turns as SessionHistoryInput[]
            );
            for (const item of sequence.items)
              if (item.index >= 0 && item.changed)
                plan.replace(item.index, current[item.index], item.value);
            for (let index = current.length - 1; index >= 0; index--)
              if (!sequence.used.has(index)) plan.remove(index, 1);
            sequence.items.forEach((item, index) => {
              if (item.index < 0) plan.append(index, [item.value]);
            });
            const stored = sequence.items.map((item) =>
              item.changed ? item.value : current[item.index]
            ) as SessionTurn[];
            const nextCursor = createImportCursor(
              input.replay.turnHashes,
              stored,
              input.replay.hashVersion
            );
            const nextControl = object(rawCursor) ? { ...rawCursor } : {};
            for (const key of [
              'importedTurnHashes',
              'hashVersion',
              'storedHistoryBaseline',
            ] as const) {
              if (nextCursor[key] === undefined) delete nextControl[key];
              else nextControl[key] = nextCursor[key];
            }
            // History and cursor share this room CAS and one native transaction.
            plan.control('externalHistoryCursor', rawCursor, nextControl);
            return imported.appended;
          },
          (next) => {
            phase = next;
          }
        );
        return { status: 'accepted', appended };
      } catch (error) {
        if (error instanceof HistoryImportRefused)
          return { status: 'rejected', reason: { code: error.code } };
        if (phase === 'preparing' && error instanceof HistoryWriteError)
          return { status: 'rejected', reason: { code: 'invalid_input', issues: error.issues } };
        if (phase === 'preparing') return { status: 'rejected', reason: { code: 'invalid_input' } };
        if (error instanceof RepoRpcError && error.code === 'precondition_failed')
          return { status: 'rejected', reason: { code: 'concurrent_write' } };
        return { status: 'indeterminate', cause: error };
      }
    },
    async applyHistoryAction(action: HistoryAction): Promise<SessionActionResult> {
      return await commit((view, plan) => {
        if (action.kind === 'user-status') {
          // Status guards inspect every duplicate's scalars, never their items.
          const positions: number[] = [],
            copies: Record<string, unknown>[] = [];
          for (let index = 0; index < view.history.count(); index++) {
            if (view.valueAt([...historyPath(index), 'id']) !== action.turnId) continue;
            const copy: Record<string, unknown> = { id: action.turnId };
            for (const key of ['role', 'status', 'read', 'cancellationReason'])
              copy[key] = view.valueAt([...historyPath(index), key]);
            if (action.deliveredSteer)
              copy.inputConfig = view.valueAt([...historyPath(index), 'inputConfig']);
            positions.push(index);
            copies.push(copy);
          }
          const drafts = structuredClone(copies);
          const result = applyHistoryAction(drafts as SessionEntry[], action);
          copies.forEach((before, index) => {
            const after = result.turns[index] as unknown as Record<string, unknown>;
            const fields: Record<string, unknown> = {};
            for (const key of [
              'status',
              'read',
              'cancellationReason',
              ...(action.deliveredSteer ? ['inputConfig'] : []),
            ]) {
              const prepared = prepareHistoryFieldWrite(key, before[key], after[key]);
              if (prepared.changed) fields[key] = prepared.value;
            }
            plan.fields(positions[index]!, fields);
          });
          return { matched: result.matched };
        }
        if (action.kind === 'operation-progress') {
          if (
            action.operation.kind !== 'session_create' &&
            action.operation.kind !== 'session_create_many'
          )
            return { matched: false };
          const id = getOperationProgressTurnId(
            action.operation.requesterSessionId,
            action.operation.operationId
          );
          const positions: number[] = [];
          for (let index = 0; index < view.history.count(); index++) {
            const rowId = view.valueAt([...historyPath(index), 'id']);
            if (
              typeof rowId === 'string' &&
              (rowId === id || rowId.startsWith(`${id}:duplicate:`)) &&
              view.valueAt([...historyPath(index), 'role']) === 'system'
            )
              positions.push(index);
          }
          const previous = positions.map(
            (position) => view.valueAt(historyPath(position)) as SessionHistoryInput
          );
          const planned = prepareOperationProgressWrite(previous, action);
          if (!planned) return { matched: false };
          if (planned.retainedIndex < 0) plan.append(view.history.count(), [planned.value]);
          else {
            plan.replace(
              positions[planned.retainedIndex]!,
              previous[planned.retainedIndex],
              planned.value
            );
            for (let index = positions.length - 1; index >= 0; index--)
              if (index !== planned.retainedIndex) plan.remove(positions[index]!, 1);
          }
          return { matched: true };
        }
        const target = historyActionTarget(action);
        let matched = false;
        const prepared = planSelectedHistoryUpdate(
          view.readQuery(),
          (position) => view.valueAt(historyPath(position)) as SessionHistoryInput,
          (rows) =>
            target === undefined
              ? selectHistoryActionRows(rows, action)
              : (() => {
                  for (let index = rows.length - 1; index >= 0; index--)
                    if (rows[index]?.id === target) return [index];
                  return [];
                })(),
          (entries) => {
            const result = applyHistoryAction(entries as SessionEntry[], structuredClone(action));
            matched = result.matched;
            return result.turns as SessionHistoryInput[];
          }
        );
        // The same sequence/provenance/preflight planner is used by the legacy
        // HistoryWriter. Structural edits never read untouched transcript bodies.
        const sequence = planHistorySequenceUpdate(
          prepared.before,
          prepared.next,
          prepared.prepareValue
        );
        for (const item of sequence.items)
          if (item.index >= 0 && item.changed)
            plan.replace(item.index, prepared.before[item.index], item.value);
        for (let index = prepared.before.length - 1; index >= 0; index--)
          if (!sequence.used.has(index)) plan.remove(index, 1);
        sequence.items.forEach((item, index) => {
          if (item.index < 0) plan.append(index, [item.value]);
        });
        return { matched };
      });
    },
  };
  return commands satisfies SessionHistoryCommands;
}

export type NativeSessionWriter = ReturnType<typeof createNativeSessionWriter>;

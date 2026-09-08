import type { Loro, LoroList, LoroMap } from 'loro-crdt';
import {
  getServerNow,
  type LodyOperationItemResult,
  type OperationProgressContent,
  type OperationProgressItem,
  type OperationProgressStatus,
  type SessionHistoryInput,
  type SessionId,
  type StoredLodyOperation,
} from '@lody/shared';

export type OperationProgressHistoryDocument = {
  handle?: { doc: Pick<Loro, 'getList' | 'commit'> } | null;
  getHistory: () => Promise<SessionHistoryInput[]>;
  updateHistory: (
    updater: (history: SessionHistoryInput[]) => SessionHistoryInput[]
  ) => Promise<void>;
};

export type OperationProgressStatusByTarget = ReadonlyMap<string, OperationProgressStatus>;

export const getOperationProgressTurnId = (
  requesterSessionId: SessionId,
  operationId: string
): string => `operation-progress:${requesterSessionId}:${operationId}`;

export const getOperationProgressTargetKey = (target: {
  sessionId: SessionId;
  userTurnId: string;
}): string => `${target.sessionId}\0${target.userTurnId}`;

const progressStatusRank = (status: OperationProgressStatus): number =>
  status === 'created' ? 0 : status === 'running' ? 1 : 2;

const progressStatusForItem = (
  item: LodyOperationItemResult,
  statusByTarget?: OperationProgressStatusByTarget,
  materializedTargets?: ReadonlySet<string>
): OperationProgressStatus | null => {
  if (!('target' in item) || !item.target) return null;
  const key = getOperationProgressTargetKey(item.target);
  const targetStatus = statusByTarget?.get(key);
  const wasMaterialized = targetStatus !== undefined || materializedTargets?.has(key);
  if (item.status === 'succeeded') return item.status;
  if (item.status === 'failed' || item.status === 'cancelled') {
    if (targetStatus) return targetStatus;
    if (!wasMaterialized) return null;
    // A deadline ends observation for the result, not execution of the child.
    return item.status === 'failed' && item.error.code === 'TARGET_TIMEOUT'
      ? 'created'
      : item.status;
  }
  // Preallocated target ids are not navigable evidence. Wait until the target
  // Session/UserTurn is durable before publishing it as a created card.
  if (!item.inputDurable && !wasMaterialized) return null;
  return targetStatus ?? 'created';
};

export const buildOperationProgressContent = (
  operation: StoredLodyOperation,
  statusByTarget?: OperationProgressStatusByTarget,
  materializedTargets?: ReadonlySet<string>
): OperationProgressContent | null => {
  if (operation.kind !== 'session_create' && operation.kind !== 'session_create_many') return null;
  const items = operation.items.reduce<OperationProgressItem[]>((acc, item) => {
    const status = progressStatusForItem(item, statusByTarget, materializedTargets);
    if (!status || !('target' in item) || !item.target) return acc;
    acc.push({
      target: item.target,
      ...(item.label ? { label: item.label } : {}),
      status,
    });
    return acc;
  }, []);
  if (items.length === 0) return null;
  return {
    type: 'operation_progress',
    operationId: operation.operationId,
    operationKind: operation.kind,
    items,
  };
};

const mergeProgressItem = (
  existing: OperationProgressItem | undefined,
  next: OperationProgressItem
): OperationProgressItem => {
  // Terminal snapshots stay fixed; running must not regress to created.
  if (
    existing &&
    (progressStatusRank(existing.status) === 2 ||
      progressStatusRank(existing.status) > progressStatusRank(next.status))
  )
    return existing;
  return { ...existing, ...next };
};

export const mergeOperationProgressContent = (
  existing: OperationProgressContent | undefined,
  next: OperationProgressContent
): OperationProgressContent => {
  const mergedItems = new Map<string, OperationProgressItem>();
  for (const item of existing?.items ?? []) {
    mergedItems.set(getOperationProgressTargetKey(item.target), item);
  }
  for (const item of next.items) {
    const key = getOperationProgressTargetKey(item.target);
    mergedItems.set(key, mergeProgressItem(mergedItems.get(key), item));
  }
  return {
    ...next,
    items: [...mergedItems.values()],
  };
};

export const upsertOperationProgressHistory = async (
  sessionDoc: OperationProgressHistoryDocument,
  operation: StoredLodyOperation,
  now: () => number = getServerNow,
  statusByTarget?: OperationProgressStatusByTarget
): Promise<void> => {
  if (operation.kind !== 'session_create' && operation.kind !== 'session_create_many') return;
  const id = getOperationProgressTurnId(operation.requesterSessionId, operation.operationId);
  // Mirror's history list is keyed by id and cannot diff duplicate ids safely.
  // Give legacy duplicates recoverable, container-stable aliases first; the next
  // validated update merges their contents and removes the aliases. A crash
  // between these commits retains every target state for the next reconciliation.
  const duplicatePrefix = `${id}:duplicate:`;
  const doc = sessionDoc.handle?.doc;
  if (doc) {
    const list = doc.getList('history') as LoroList<LoroMap>;
    let seen = false;
    let renamed = false;
    for (let index = 0; index < list.length; index++) {
      const row = list.get(index);
      if (row?.get('id') !== id || row.get('role') !== 'system') continue;
      if (seen) {
        row.set('id', `${duplicatePrefix}${row.id}`);
        renamed = true;
      }
      seen = true;
    }
    if (renamed) doc.commit();
  }
  const isProgressRow = (entry: SessionHistoryInput) =>
    entry.role === 'system' && (entry.id === id || entry.id.startsWith(duplicatePrefix));
  const timestamp = new Date(now()).toISOString();
  const updateHistory = (history: SessionHistoryInput[]): SessionHistoryInput[] => {
    const existingIndex = history.findIndex((entry) => entry.id === id && entry.role === 'system');
    const duplicates = history.filter(isProgressRow);
    const existing = duplicates[0];
    const existingProgress = duplicates
      .flatMap((entry) => entry.items ?? [])
      .filter((item) => item.type === 'operation_progress')
      .reduce<OperationProgressContent | undefined>(
        (merged, item) => mergeOperationProgressContent(merged, item),
        undefined
      );
    // A prior card proves existence, not the current execution state. Keep that
    // evidence separate: a root timeout/cancel is not a target terminal state.
    const materializedTargets = new Set(
      (existingProgress?.items ?? []).map((item) => getOperationProgressTargetKey(item.target))
    );
    const content = buildOperationProgressContent(operation, statusByTarget, materializedTargets);
    if (!content) return history;
    const merged = mergeOperationProgressContent(existingProgress, content);
    const nextItems = [merged];
    if (
      duplicates.length === 1 &&
      existing &&
      JSON.stringify(existing.items ?? []) === JSON.stringify(nextItems)
    ) {
      return history;
    }
    const entry: SessionHistoryInput = {
      ...(existing ?? {}),
      id,
      role: 'system',
      userId: operation.requesterUserId,
      timestamp: existing?.timestamp ?? timestamp,
      items: nextItems,
      fileDiff: existing?.fileDiff ?? [],
      finished: true,
    };
    if (existingIndex < 0) return [...history, entry];
    return history.flatMap((candidate, index) =>
      index === existingIndex ? [entry] : isProgressRow(candidate) ? [] : [candidate]
    );
  };
  // Mirror notifies subscribers even when its updater returns unchanged state.
  // In A -> B -> C, rewriting B's progress wakes A's coordinator indefinitely.
  // Check before entering Mirror, then recompute against the latest history on write.
  const history = await sessionDoc.getHistory();
  if (updateHistory(history) === history) return;
  await sessionDoc.updateHistory(updateHistory);
};

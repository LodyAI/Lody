import type { LodyOperationItemResult, StoredLodyOperation } from '../session-orchestration';
import type {
  OperationProgressContent,
  OperationProgressItem,
  OperationProgressStatus,
} from '../session-orchestration';
import type { SessionId } from '../ids';
import type { SessionEntry } from './domain';
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

export function planOperationProgress(
  currentHistory: SessionEntry[],
  operation: StoredLodyOperation,
  timestamp: string,
  statusEntries?: readonly (readonly [string, OperationProgressStatus])[]
): SessionEntry[] {
  const statusByTarget = statusEntries ? new Map(statusEntries) : undefined;
  if (operation.kind !== 'session_create' && operation.kind !== 'session_create_many')
    return currentHistory;
  const id = getOperationProgressTurnId(operation.requesterSessionId, operation.operationId);
  // The shared HistoryWriter identifies existing rows before applying deletions,
  // so duplicate legacy ids can be merged without raw CRDT alias writes.
  const duplicatePrefix = `${id}:duplicate:`;
  const isProgressRow = (entry: SessionEntry) =>
    entry.role === 'system' && (entry.id === id || entry.id.startsWith(duplicatePrefix));
  const updateHistory = (history: SessionEntry[]): SessionEntry[] => {
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
    const entry: SessionEntry = {
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
  return updateHistory(currentHistory);
}

export function findProgressMessageId(
  history: SessionEntry[],
  operation: StoredLodyOperation
): string | undefined {
  if (operation.kind !== 'session_create' && operation.kind !== 'session_create_many') {
    return undefined;
  }
  const progressMessageId = getOperationProgressTurnId(
    operation.requesterSessionId,
    operation.operationId
  );
  const progress = history
    .find((entry) => entry.id === progressMessageId && entry.role === 'system')
    ?.items?.find(
      (item) => item.type === 'operation_progress' && item.operationId === operation.operationId
    );
  if (progress?.type !== 'operation_progress') return undefined;
  const covered = new Map(
    progress.items.map((item) => [getOperationProgressTargetKey(item.target), item.status])
  );
  // A partial row is not permission to hide every successful-target fallback.
  // Include the completion payload as well as stored items for recovery snapshots.
  const completion = operation.completion;
  const results =
    completion?.type === 'result'
      ? completion.value.items
      : completion?.type === 'cancelled'
        ? (completion.partial?.items ?? [])
        : [];
  const complete = [...operation.items, ...results].every((item) =>
    item.status === 'succeeded'
      ? covered.get(getOperationProgressTargetKey(item.target)) === 'succeeded'
      : item.status === 'active' && item.inputDurable
        ? covered.has(getOperationProgressTargetKey(item.target))
        : true
  );
  return complete ? progressMessageId : undefined;
}

export function planOperationCompletion(
  history: SessionEntry[],
  operation: StoredLodyOperation,
  turn: SessionEntry
): SessionEntry[] {
  const progressMessageId = findProgressMessageId(history, operation);
  const desired = turn.items?.find((item) => item.type === 'operation_completion');
  if (desired?.type !== 'operation_completion') throw new Error('Missing completion item');
  const existing = history.find((entry) => entry.id === turn.id);
  if (!existing)
    return [
      ...history,
      {
        ...turn,
        items: turn.items?.map((item) =>
          item === desired && progressMessageId ? { ...item, progressMessageId } : item
        ),
      },
    ];
  if (existing.role !== 'system') return history;
  return history.map((entry) =>
    entry !== existing
      ? entry
      : {
          ...entry,
          items: entry.items?.map((item) => {
            if (item.type !== 'operation_completion' || item.deliveryId !== desired.deliveryId)
              return item;
            const next = progressMessageId ? { ...item, progressMessageId } : { ...item };
            if (desired.continuation) next.continuation = desired.continuation;
            else delete next.continuation;
            return next;
          }),
        }
  );
}

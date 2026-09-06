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
  operation: StoredLodyOperation,
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
    return targetStatus ?? (wasMaterialized ? item.status : null);
  }
  if (operation.completion?.type === 'cancelled') {
    return targetStatus ?? (wasMaterialized || item.inputDurable ? 'cancelled' : null);
  }
  if (operation.completion?.type === 'error') {
    return targetStatus ?? (wasMaterialized || item.inputDurable ? 'failed' : null);
  }
  // Preallocated target ids are not navigable evidence. Wait until the target
  // Session/UserTurn is durable before publishing it as a created card.
  if (!item.inputDurable) return null;
  return targetStatus ?? 'created';
};

export const buildOperationProgressContent = (
  operation: StoredLodyOperation,
  statusByTarget?: OperationProgressStatusByTarget,
  materializedTargets?: ReadonlySet<string>
): OperationProgressContent | null => {
  if (operation.kind !== 'session_create' && operation.kind !== 'session_create_many') return null;
  const items = operation.items.reduce<OperationProgressItem[]>((acc, item) => {
    const status = progressStatusForItem(operation, item, statusByTarget, materializedTargets);
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
    mergedItems.set(
      getOperationProgressTargetKey(item.target),
      mergeProgressItem(mergedItems.get(getOperationProgressTargetKey(item.target)), item)
    );
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
  const timestamp = new Date(now()).toISOString();
  await sessionDoc.updateHistory((history) => {
    const existingIndex = history.findIndex((entry) => entry.id === id && entry.role === 'system');
    const existing = existingIndex >= 0 ? history[existingIndex] : undefined;
    const existingProgress = existing?.items?.find((item) => item.type === 'operation_progress');
    // A prior card proves existence, not the current execution state. Keep that
    // evidence separate so a stale running snapshot cannot mask root termination.
    const materializedTargets = new Set(
      (existingProgress?.items ?? []).map((item) => getOperationProgressTargetKey(item.target))
    );
    const content = buildOperationProgressContent(operation, statusByTarget, materializedTargets);
    if (!content) return history;
    const merged = mergeOperationProgressContent(existingProgress, content);
    const nextItems = [merged];
    if (existing && JSON.stringify(existing.items ?? []) === JSON.stringify(nextItems)) {
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
    return history.map((candidate, index) => (index === existingIndex ? entry : candidate));
  });
};

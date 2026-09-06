import {
  getServerNow,
  type LodyOperationItemResult,
  type MessageContent,
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

const TERMINAL_PROGRESS_STATUSES = new Set<OperationProgressStatus>([
  'succeeded',
  'failed',
  'cancelled',
]);

const progressStatusRank = (status: OperationProgressStatus): number =>
  status === 'created' ? 0 : status === 'running' ? 1 : 2;

const isOperationProgressContent = (item: MessageContent): item is OperationProgressContent =>
  item.type === 'operation_progress';

const progressStatusForItem = (
  operation: StoredLodyOperation,
  item: LodyOperationItemResult,
  statusByTarget?: OperationProgressStatusByTarget
): OperationProgressStatus | null => {
  if (!('target' in item) || !item.target) return null;
  const targetStatus = statusByTarget?.get(getOperationProgressTargetKey(item.target));
  if (item.status === 'succeeded') return item.status;
  if (item.status === 'failed' || item.status === 'cancelled') {
    return targetStatus ? item.status : null;
  }
  if (operation.completion?.type === 'cancelled') {
    return targetStatus || item.inputDurable ? 'cancelled' : null;
  }
  if (operation.completion?.type === 'error') {
    return targetStatus || item.inputDurable ? 'failed' : null;
  }
  // Preallocated target ids are not navigable evidence. Wait until the target
  // Session/UserTurn is durable before publishing it as a created card.
  if (!item.inputDurable) return null;
  return targetStatus ?? 'created';
};

export const buildOperationProgressContent = (
  operation: StoredLodyOperation,
  statusByTarget?: OperationProgressStatusByTarget
): OperationProgressContent | null => {
  if (operation.kind !== 'session_create' && operation.kind !== 'session_create_many') return null;
  const items = operation.items.reduce<OperationProgressItem[]>((acc, item) => {
    const status = progressStatusForItem(operation, item, statusByTarget);
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
  if (!existing) return next;
  const existingRank = progressStatusRank(existing.status);
  const nextRank = progressStatusRank(next.status);
  if (nextRank > existingRank) {
    return { ...existing, ...next, status: next.status };
  }
  if (nextRank < existingRank) {
    return existing;
  }
  // Terminal state is monotonic. Do not let a stale/older snapshot flip a
  // terminal target to another terminal result after one was published.
  if (TERMINAL_PROGRESS_STATUSES.has(existing.status)) {
    return existing;
  }
  return { ...existing, ...next, status: next.status };
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
): Promise<boolean> => {
  if (operation.kind !== 'session_create' && operation.kind !== 'session_create_many') return false;
  const id = getOperationProgressTurnId(operation.requesterSessionId, operation.operationId);
  const timestamp = new Date(now()).toISOString();
  let changed = false;
  await sessionDoc.updateHistory((history) => {
    const existingIndex = history.findIndex((entry) => entry.id === id && entry.role === 'system');
    const existing = existingIndex >= 0 ? history[existingIndex] : undefined;
    const existingProgress = existing?.items?.find(isOperationProgressContent);
    // A published card already proves materialization, even when its target's
    // replica is unavailable at timeout/cancellation. Use that evidence before
    // filtering terminal items so an existing card cannot remain stuck running.
    const materializedStatuses = new Map(statusByTarget);
    for (const item of existingProgress?.items ?? []) {
      const key = getOperationProgressTargetKey(item.target);
      if (!materializedStatuses.has(key)) materializedStatuses.set(key, item.status);
    }
    const content = buildOperationProgressContent(operation, materializedStatuses);
    if (!content) return history;
    const merged = mergeOperationProgressContent(existingProgress, content);
    const nextItems = [merged as MessageContent];
    if (existing && JSON.stringify(existing.items ?? []) === JSON.stringify(nextItems)) {
      return history;
    }
    changed = true;
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
  return changed;
};

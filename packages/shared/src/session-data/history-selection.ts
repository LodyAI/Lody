import type { HistoryAction } from './history-actions';
import { getOperationProgressTurnId } from './operation-progress';

/** Fields used to locate records and summarize stored history. */
export type HistoryQueryRow = {
  _record?: boolean;
  id?: unknown;
  role?: unknown;
  timestamp?: unknown;
  status?: unknown;
  read?: unknown;
  finished?: unknown;
  endedAt?: unknown;
  acpTurnId?: unknown;
  userTurnId?: unknown;
  userId?: unknown;
  inputConfig?: { _lodyDeliveryKind?: unknown };
  items?: Record<string, unknown>[];
};
export type HistoryQueryAccess = {
  field(value: unknown, key: string): unknown;
  scalar(value: unknown): unknown;
  length(value: unknown): number;
  at(value: unknown, index: number): unknown;
  keys?(value: unknown): readonly string[];
};
const names = [
  'id',
  'role',
  'timestamp',
  'status',
  'read',
  'finished',
  'endedAt',
  'acpTurnId',
  'userTurnId',
  'userId',
] as const;
const itemNames = [
  'type',
  'toolCallId',
  'taskId',
  'threadId',
  'objective',
  'status',
  'fileId',
  'transport',
  'name',
] as const;
export function historyQueryRow(
  value: unknown,
  access: HistoryQueryAccess,
  transcriptVisibility = false
): HistoryQueryRow {
  const row: Record<string, unknown> = {
    _record: value !== null && typeof value === 'object' && !Array.isArray(value),
  };
  for (const name of names) {
    const field = access.scalar(access.field(value, name));
    if (field !== undefined) row[name] = field;
  }
  const config = access.field(value, 'inputConfig');
  const delivery = access.scalar(access.field(config, '_lodyDeliveryKind'));
  if (delivery !== undefined) row.inputConfig = { _lodyDeliveryKind: delivery };
  const items = access.field(value, 'items');
  row.items = Array.from({ length: access.length(items) }, (_, index) => {
    const source = access.at(items, index),
      item: Record<string, unknown> = {};
    for (const name of itemNames) {
      const field = access.scalar(access.field(source, name));
      if (field !== undefined) item[name] = field;
    }
    if (transcriptVisibility) {
      const text = access.scalar(access.field(source, 'text'));
      if (typeof text === 'string') item._textNonBlank = text.trim().length > 0;
      item._imageCount = access.length(access.field(source, 'images'));
    }
    const request = access.scalar(
      access.field(access.field(source, 'permissionRequest'), 'requestId')
    );
    if (request !== undefined) item.permissionRequest = { requestId: request };
    const sessionId = access.scalar(access.field(access.field(source, 'run'), 'sessionId'));
    if (sessionId !== undefined) {
      const parentRunId = access.scalar(
        access.field(access.field(access.field(source, 'run'), 'snapshot'), 'parentRunId')
      );
      item.run = { sessionId, ...(parentRunId === undefined ? {} : { snapshot: { parentRunId } }) };
    }
    if (item.type === 'system_notice' && access.keys) {
      const meta = access.field(source, 'meta');
      const keys = access
        .keys(meta)
        .filter((key) => access.field(meta, key) === undefined)
        .slice(0, 10);
      if (keys.length) item._metaUndefinedKeys = keys;
    }
    return item;
  });
  return row;
}

/** Select reducer positions, including matching owners and fallback tails. */
export function selectHistoryActionRows(
  rows: readonly HistoryQueryRow[],
  action: HistoryAction
): number[] {
  const result = new Set<number>();
  const addWhere = (predicate: (row: HistoryQueryRow) => boolean) =>
    rows.forEach((row, i) => {
      if (predicate(row)) result.add(i);
    });
  const last = (predicate: (row: HistoryQueryRow) => boolean) => {
    for (let index = rows.length - 1; index >= 0; index--)
      if (predicate(rows[index]!)) {
        result.add(index);
        return;
      }
  };
  const has = (row: HistoryQueryRow, predicate: (item: Record<string, unknown>) => boolean) =>
    row.items?.some(predicate) === true;
  switch (action.kind) {
    case 'permission-request': {
      addWhere((row) =>
        has(
          row,
          (item) =>
            item.type === 'tool_call' && item.toolCallId === action.request.toolCall.toolCallId
        )
      );
      if (!result.size && rows.length) result.add(rows.length - 1);
      break;
    }
    case 'upsert-goal':
      addWhere((row) =>
        has(
          row,
          (item) =>
            item.type === 'goal' &&
            (item.threadId === action.goal.threadId || item.status === 'cleared')
        )
      );
      addWhere((row) => row.id === action.targetTurnId && row.role === 'assistant');
      last(
        (row) =>
          row.role === 'assistant' && row.finished !== true && typeof row.endedAt !== 'number'
      );
      break;
    case 'clear-goal':
      addWhere((row) =>
        has(row, (item) => item.type === 'goal' && item.threadId === action.threadId)
      );
      break;
    case 'operation-completion': {
      const progressId = getOperationProgressTurnId(
        action.operation.requesterSessionId,
        action.operation.operationId
      );
      addWhere((row) => row.id === action.turn.id || row.id === progressId);
      break;
    }
    case 'operation-progress':
      addWhere(
        (row) =>
          typeof row.id === 'string' &&
          row.id.startsWith(
            getOperationProgressTurnId(
              action.operation.requesterSessionId,
              action.operation.operationId
            )
          )
      );
      break;
    case 'agent-warning':
      addWhere((row) =>
        has(row, (item) => item.type === 'system_notice' && item.name === 'agent_warning')
      );
      break;
    case 'file-backfilled':
      addWhere((row) =>
        has(
          row,
          (item) =>
            item.type === 'file' && item.fileId === action.fileId && item.transport === 'local'
        )
      );
      break;
    case 'upsert-turn':
      addWhere((row) => row.id === action.turn.id);
      break;
    case 'remove-turn':
      addWhere((row) => row.id === action.turnId);
      break;
    case 'finish-assistant':
    case 'assistant-file-diff':
      last((row) => row.role === 'assistant' && (!action.turnId || row.id === action.turnId));
      break;
    case 'assistant-items':
    case 'assistant-token-usage':
    case 'user-status':
    case 'operation-batch-status':
      addWhere((row) => row.id === action.turnId);
      break;
  }
  return [...result].sort((left, right) => left - right);
}

export function selectAgentHistoryRows(
  rows: readonly HistoryQueryRow[],
  dependencies: {
    targetId?: string;
    toolCallIds: ReadonlySet<string>;
    taskIds: ReadonlySet<string>;
    runs?: readonly { sessionId: string; runId: string }[];
  }
): number[] {
  const requiredRuns = new Set(
    (dependencies.runs ?? []).map((run) => JSON.stringify([run.sessionId, run.runId]))
  );
  const parents = new Map<string, { sessionId: string; parentRunId: string }>();
  for (const row of rows)
    for (const item of row.items ?? []) {
      const run = item.run as
        | { sessionId?: unknown; snapshot?: { parentRunId?: unknown } }
        | undefined;
      if (
        item.type === 'subagent_task' &&
        typeof item.taskId === 'string' &&
        typeof run?.sessionId === 'string'
      ) {
        const key = JSON.stringify([run.sessionId, item.taskId]);
        if (!parents.has(key))
          parents.set(key, {
            sessionId: run.sessionId,
            parentRunId:
              typeof run.snapshot?.parentRunId === 'string' ? run.snapshot.parentRunId : '',
          });
      }
    }
  for (const key of requiredRuns) {
    const parent = parents.get(key);
    if (parent?.parentRunId)
      requiredRuns.add(JSON.stringify([parent.sessionId, parent.parentRunId]));
  }
  return rows.flatMap((row, index) => {
    if (row.id === dependencies.targetId || (index === rows.length - 1 && row.role === 'assistant'))
      return [index];
    return row.items?.some(
      (item) =>
        dependencies.toolCallIds.has(item.toolCallId as string) ||
        dependencies.taskIds.has(item.taskId as string) ||
        requiredRuns.has(
          JSON.stringify([
            (item.run as { sessionId?: unknown } | undefined)?.sessionId,
            item.taskId,
          ])
        )
    )
      ? [index]
      : [];
  });
}

/** Aggregate item types, abnormal metadata samples and final-row statistics. */
export function summarizeHistoryQuery(rows: readonly HistoryQueryRow[]): Record<string, unknown> {
  const history = rows.filter((row) => row._record !== false);
  const countTypes = (items: readonly Record<string, unknown>[]) => {
    const counts: Record<string, number> = {};
    for (const item of items) {
      const type = typeof item.type === 'string' ? item.type : 'unknown';
      counts[type] = (counts[type] ?? 0) + 1;
    }
    return counts;
  };
  const undefinedKeys: { entryId: unknown; keys: string[] }[] = [];
  let historyItems = 0;
  const counts: Record<string, number> = {};
  for (const row of history) {
    const items = row.items ?? [];
    historyItems += items.length;
    for (const [type, count] of Object.entries(countTypes(items)))
      counts[type] = (counts[type] ?? 0) + count;
    for (const item of items)
      if (
        item.type === 'system_notice' &&
        Array.isArray(item._metaUndefinedKeys) &&
        undefinedKeys.length < 5
      )
        undefinedKeys.push({ entryId: row.id, keys: item._metaUndefinedKeys as string[] });
  }
  const last = history.at(-1);
  return {
    historyEntries: history.length,
    historyItems,
    historyItemTypes: counts,
    systemNoticeMetaUndefinedKeys: undefinedKeys,
    lastEntry: last
      ? {
          id: last.id,
          role: last.role,
          timestamp: last.timestamp,
          items: last.items?.length ?? 0,
          itemTypes: countTypes(last.items ?? []),
        }
      : null,
  };
}

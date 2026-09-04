import type { Role, SessionHistory } from '@lody/shared';
import { summarizeTurn } from './turn-summary';
import type { TurnIndexInputConfig, TurnIndexRow } from './types';

/** Turn-map scalars mirrored into the index row, in `TurnIndexRow` order. */
export const INDEX_SCALAR_KEYS = [
  'id',
  'role',
  'timestamp',
  'status',
  'finished',
  'endedAt',
  'sendStatus',
  'userTurnId',
  'acpTurnId',
  'startedAt',
  'permissionWaitMs',
] as const;

export type IndexScalarKey = (typeof INDEX_SCALAR_KEYS)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The shallow role-selection subset of a user turn's `inputConfig`. */
export function pickIndexInputConfig(value: unknown): TurnIndexInputConfig | undefined {
  if (!isRecord(value)) return undefined;
  const out: TurnIndexInputConfig = {};
  if (typeof value.agentRoleId === 'string' || value.agentRoleId === null) {
    out.agentRoleId = value.agentRoleId as TurnIndexInputConfig['agentRoleId'];
  }
  if (typeof value.agentRoleRevision === 'number') out.agentRoleRevision = value.agentRoleRevision;
  if (typeof value.modeId === 'string') out.modeId = value.modeId;
  if (typeof value.modelId === 'string') out.modelId = value.modelId;
  if (typeof value.cliType === 'string') {
    out.cliType = value.cliType as TurnIndexInputConfig['cliType'];
  }
  if (typeof value.agentType === 'string') out.agentType = value.agentType;
  return out;
}

/** Copy the index scalars out of any record-shaped source (a hydrated turn or a shallow value). */
export function pickIndexScalars(source: Record<string, unknown>): TurnIndexRow {
  const row: TurnIndexRow = {
    id: typeof source.id === 'string' ? source.id : '',
    role: (typeof source.role === 'string' ? source.role : 'system') as Role,
    timestamp: typeof source.timestamp === 'string' ? source.timestamp : '',
  };
  if (typeof source.status === 'string') row.status = source.status as TurnIndexRow['status'];
  if (typeof source.finished === 'boolean') row.finished = source.finished;
  if (typeof source.endedAt === 'number') row.endedAt = source.endedAt;
  if (typeof source.sendStatus === 'string') {
    row.sendStatus = source.sendStatus as TurnIndexRow['sendStatus'];
  }
  if (typeof source.userTurnId === 'string') row.userTurnId = source.userTurnId;
  if (typeof source.acpTurnId === 'string') row.acpTurnId = source.acpTurnId;
  if (typeof source.startedAt === 'number') row.startedAt = source.startedAt;
  if (typeof source.permissionWaitMs === 'number') row.permissionWaitMs = source.permissionWaitMs;
  return row;
}

/** Everything the index knows about a turn we hold in full. */
export function indexRowFromEntry(entry: SessionHistory): TurnIndexRow {
  const row = pickIndexScalars(entry as unknown as Record<string, unknown>);
  row.itemCount = Array.isArray(entry.items) ? entry.items.length : 0;
  row.planCount = Array.isArray(entry.plan) ? entry.plan.length : 0;
  row.summary = summarizeTurn(entry);
  if (row.role === 'user') row.inputConfig = pickIndexInputConfig(entry.inputConfig);
  return row;
}

/**
 * Mirrors `buildChatStreamItems`' rule: an assistant entry with no items and no
 * plan renders to nothing, so scans for "the last assistant turn" skip it.
 *
 * A row whose counts have not been resolved yet (the doc-backed view fills them
 * with the summary) is NOT empty: guessing "empty" would drop a real turn from
 * the stream, while guessing "non-empty" only shows a placeholder for an
 * interrupted turn until its counts arrive.
 */
export const isEmptyAssistantIndexRow = (row: TurnIndexRow): boolean =>
  row.role === 'assistant' && row.itemCount === 0 && (row.planCount ?? 0) === 0;

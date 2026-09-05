import type { SessionId, WorkspaceId } from './ids';
import { sha256Hex } from './incremental-sha256';
import {
  ScheduleDefinitionSchema,
  ScheduleRegistryRowSchema,
  ScheduleTombstoneSchema,
  scheduleUsesElevatedPermissions,
  validateSchedulePrompt,
  type ScheduleDocument,
  type ScheduleRegistryRow,
} from './schedule-types';
import { validateScheduleTrigger } from './schedule-time';

export const SCHEDULE_DOC_PREFIX = 'schedule-';
export const getScheduleRoomId = (id: string): string => `${SCHEDULE_DOC_PREFIX}${id}`;
export const getScheduleIdFromRoomId = (id: string): string | undefined =>
  id.startsWith(SCHEDULE_DOC_PREFIX) && id.length > SCHEDULE_DOC_PREFIX.length
    ? id.slice(SCHEDULE_DOC_PREFIX.length)
    : undefined;
export const getLoroScheduleStreamId = (workspaceId: WorkspaceId, id: string): string =>
  `${workspaceId}:schedule:${id}`;
export const getScheduleRegistryFlockDocId = (workspaceId: WorkspaceId): string =>
  `${workspaceId}:sr`;
export const isScheduleRegistryFlockDocId = (id: string): boolean => /^[^:]+:sr$/.test(id);
export const scheduleRegistryKeys = {
  schedule: (id: string): string[] => ['schedule', id],
  runtime: (id: string, machineId: string): string[] => ['runtime', id, machineId],
  tombstone: (id: string): string[] => ['tombstone', id],
  manual: (id: string, requestId: string): string[] => ['manual', id, requestId],
};

/** Stable across object insertion order, on Node and every UI runtime. */
export function canonicalScheduleJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, normalize(v)])
      );
    return entry;
  };
  return JSON.stringify(normalize(value));
}
const digest = (value: unknown): string =>
  sha256Hex(new TextEncoder().encode(canonicalScheduleJson(value)));

export function scheduleDefinitionFingerprint(
  document: Pick<ScheduleDocument, 'definition' | 'prompt'>
): string {
  const definition = ScheduleDefinitionSchema.parse(document.definition);
  validateScheduleTrigger(definition.trigger);
  validateSchedulePrompt(document.prompt);
  // Include identity and activation gates. Cosmetic title/timestamps don't
  // affect execution, and timeline appends must never invalidate a definition.
  const {
    title: _title,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    createdBy: _createdBy,
    ...execution
  } = definition;
  return digest({ definition: execution, prompt: document.prompt });
}

export function buildScheduleRegistryRow(document: ScheduleDocument): ScheduleRegistryRow {
  const d = document.definition;
  return ScheduleRegistryRowSchema.parse({
    scheduleId: d.scheduleId,
    title: d.title,
    ownerId: d.ownerId,
    machineId: d.machineId,
    enabled: d.enabled,
    activationId: d.activationId,
    activeFrom: d.activeFrom,
    trigger: d.trigger,
    agentConfigId: d.agent.agentConfigId,
    projectKind: d.project.kind,
    projectKey: d.project.kind === 'local' ? d.project.localProjectId : d.project.repoFullName,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    elevatedPermissions: scheduleUsesElevatedPermissions(d.agent),
    definitionFingerprint: scheduleDefinitionFingerprint(document),
  });
}

export function scheduleRunKey(
  scheduleId: string,
  activationId: string,
  scheduledFor: number
): string {
  return digest([scheduleId, activationId, scheduledFor]);
}
export function manualScheduleRunKey(scheduleId: string, manualRunId: string): string {
  return digest([scheduleId, 'manual', manualRunId]);
}
export function scheduleRunIds(runKey: string): {
  sessionId: SessionId;
  userTurnId: string;
  sourceEntryId: string;
} {
  // RFC 9562 UUIDv8 with a domain-separated SHA-256 payload.
  const id = (purpose: string): string => {
    const bytes = digest(['lody.schedule.v1', purpose, runKey]).slice(0, 32).split('');
    bytes[12] = '8';
    bytes[16] = ((parseInt(bytes[16]!, 16) & 3) | 8).toString(16);
    const hex = bytes.join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  return {
    sessionId: id('session') as SessionId,
    userTurnId: id('turn'),
    sourceEntryId: id('source'),
  };
}

export type ScheduleRegistryScanRow = { key: readonly unknown[]; value?: unknown };
export function readScheduleRegistryRows(
  scanned: Iterable<ScheduleRegistryScanRow>
): ScheduleRegistryRow[] {
  const rows = new Map<string, ScheduleRegistryRow>();
  const deleted = new Set<string>();
  for (const entry of scanned) {
    if (entry.key.length !== 2 || typeof entry.key[1] !== 'string') continue;
    if (entry.key[0] === 'tombstone' && ScheduleTombstoneSchema.safeParse(entry.value).success)
      deleted.add(entry.key[1]);
    if (entry.key[0] !== 'schedule') continue;
    const result = ScheduleRegistryRowSchema.safeParse(entry.value);
    if (result.success && result.data.scheduleId === entry.key[1])
      rows.set(entry.key[1], result.data);
  }
  return [...rows.values()].filter((row) => !deleted.has(row.scheduleId));
}

/** Purge/export discovery includes tombstones, but never grants execution. */
export function collectScheduleIds(
  roomIds: Iterable<string>,
  rows: Iterable<ScheduleRegistryScanRow>
): string[] {
  const ids = new Set<string>();
  for (const room of roomIds) {
    const id = getScheduleIdFromRoomId(room);
    if (id) ids.add(id);
  }
  for (const row of rows) {
    if (
      (row.key[0] === 'schedule' || row.key[0] === 'tombstone') &&
      typeof row.key[1] === 'string' &&
      row.key[1]
    )
      ids.add(row.key[1]);
  }
  return [...ids].sort();
}

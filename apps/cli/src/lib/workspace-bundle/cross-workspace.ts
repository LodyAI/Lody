import { LoroMap, type LoroDoc } from 'loro-crdt';
import {
  createSessionMirror,
  type ScheduleImportFence,
  type SessionImportFence,
} from '@lody/shared';

/**
 * Spec: specs/workspace-export-import.md, "来源工作区 ≠ 目标工作区".
 * Entity ids, peers and user ids are kept; only room ids that embed the workspace id
 * change. Machine rooms never cross workspaces.
 */
export function mapRoomId(
  roomId: string,
  sourceWorkspaceId: string,
  targetWorkspaceId: string
): string {
  const prefix = `${sourceWorkspaceId}:`;
  return roomId.startsWith(prefix) ? `${targetWorkspaceId}:${roomId.slice(prefix.length)}` : roomId;
}

/** Rewrites Meta rows that name a named Flock (`ef`/`efx`) to the target workspace. */
export function mapMetaKey(
  key: readonly unknown[],
  sourceWorkspaceId: string,
  targetWorkspaceId: string
): unknown[] {
  if ((key[0] === 'ef' || key[0] === 'efx') && typeof key[1] === 'string')
    return [key[0], mapRoomId(key[1], sourceWorkspaceId, targetWorkspaceId), ...key.slice(2)];
  return [...key];
}

/**
 * Schedule registry rows that describe one machine's runs or pending manual requests
 * stay behind; only definitions and deletion records move.
 */
export function crossWorkspaceRowWithheld(codec: string, key: readonly unknown[]): boolean {
  return codec === 'schedule-registry/v1' && key[0] !== 'schedule' && key[0] !== 'tombstone';
}

/**
 * Spec owner decision 11: a cross-workspace import does not rewrite the imported
 * sessions or schedules. It records on their metadata which input and which schedule
 * activation came from the bundle, scoped to the target workspace; execution there
 * skips exactly those (`getImportFence`, `isScheduleImportFenced`). New input and a
 * schedule resumed there run normally, and another workspace ignores the fence.
 * Every user turn and queued item present in the imported document is fenced: by
 * provenance, not by enumerating which states the dispatcher would act on.
 */
export function sessionImportFence(
  doc: LoroDoc,
  sourceMeta: (field: string) => unknown,
  workspaceId: string
): SessionImportFence {
  const turnIds = new Set<string>();
  const queueItemIds = new Set<string>();
  const mirror = createSessionMirror({ doc, initialState: {} });
  try {
    for (const turn of mirror.historyWriter.readStored())
      if (turn.role === 'user') turnIds.add(turn.id);
  } finally {
    mirror.dispose();
  }
  const queue = doc.getMovableList('mq');
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue.get(index);
    if (!(item instanceof LoroMap)) continue;
    queueItemIds.add(item.id);
    const userTurnId = item.get('userTurnId');
    if (typeof userTurnId === 'string' && userTurnId) turnIds.add(userTurnId);
  }
  for (const field of ['latestUserMsgId', 'processingUserMsgId']) {
    const id = sourceMeta(field);
    if (typeof id === 'string' && id) turnIds.add(id);
  }
  for (const field of ['steerTurnStatuses', 'queuePromotionLedger']) {
    const value = sourceMeta(field);
    if (!value || typeof value !== 'object') continue;
    for (const [id, record] of Object.entries(value)) {
      turnIds.add(id);
      const userTurnId = (record as { userTurnId?: unknown } | null)?.userTurnId;
      if (typeof userTurnId === 'string') turnIds.add(userTurnId);
    }
  }
  return { workspaceId, turnIds: [...turnIds], queueItemIds: [...queueItemIds] };
}

/** The imported schedule activation, fenced in the target workspace. */
export function scheduleImportFence(
  doc: LoroDoc,
  workspaceId: string
): ScheduleImportFence | undefined {
  const activationId = doc.getMap('definition').get('activationId');
  return typeof activationId === 'string' ? { workspaceId, activationId } : undefined;
}

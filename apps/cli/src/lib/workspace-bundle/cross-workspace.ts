import { createSessionMirror } from '@lody/shared/session-mirror';
import { LoroMap, type LoroDoc } from 'loro-crdt';
import { type ScheduleImportFence, type SessionImportFence } from '@lody/shared';

/** Only room ids that embed the workspace id change; machine rooms never cross. */
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

/** Only schedule definitions and deletion records cross; per-machine run rows stay. */
export function crossWorkspaceRowWithheld(codec: string, key: readonly unknown[]): boolean {
  return codec === 'schedule-registry/v1' && key[0] !== 'schedule' && key[0] !== 'tombstone';
}

/**
 * Spec decision 11: fences every user turn and queued item in the imported document,
 * so the target workspace never runs them; other workspaces ignore the fence.
 */
export function sessionImportFence(
  doc: LoroDoc,
  sourceMeta: (field: string) => unknown,
  workspaceId: string,
  importedBy: string | undefined
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
  return {
    workspaceId,
    turnIds: [...turnIds],
    queueItemIds: [...queueItemIds],
    ...(importedBy ? { importedBy } : {}),
  };
}

/** The imported schedule activation, fenced in the target workspace. */
export function scheduleImportFence(
  doc: LoroDoc,
  workspaceId: string
): ScheduleImportFence | undefined {
  const activationId = doc.getMap('definition').get('activationId');
  return typeof activationId === 'string' ? { workspaceId, activationId } : undefined;
}

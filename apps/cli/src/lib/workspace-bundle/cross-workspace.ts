import type { JsonObject, LoroRepo } from 'loro-repo';

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

const DISPATCH_FIELDS = [
  'latestUserMsgId',
  'processingUserMsgId',
  'steerTurnStatuses',
  'steerOperationLedger',
  'queuePromotionLedger',
  'messageQueueUpdatedAt',
  'messageQueueUpdateVersion',
  'messageQueueCheckedAt',
  'awaitingUserSince',
  'previewConnection',
  'previewCandidate',
] as const;

/**
 * New writes after a cross-workspace merge, matching OSS migration: imported sessions
 * stop collaborating and lose pending dispatch, imported schedules are disabled. The
 * original state stays in each document's history. Applied only to rooms the target
 * did not have, so a later reimport does not undo the target's own changes.
 */
export async function applyPostImportWrites(
  repo: LoroRepo<JsonObject>,
  rooms: ReadonlyArray<{ targetId: string; codec: string }>
): Promise<void> {
  for (const room of rooms) {
    if (room.codec === 'session/v1') {
      const lease = await repo.acquireDoc(room.targetId);
      try {
        const queue = lease.doc.getMovableList('mq');
        if (queue.length > 0) queue.delete(0, queue.length);
        const fork = lease.doc.getMap('forkOperation');
        for (const key of fork.keys()) fork.delete(key);
        lease.doc.commit();
        await repo.persistDocNow(room.targetId, lease.doc);
      } finally {
        lease.release();
      }
      const patch: JsonObject = { status: { type: 'idle' }, collaborationStopped: true };
      const meta: Record<string, unknown> = patch;
      for (const field of DISPATCH_FIELDS) meta[field] = undefined;
      await repo.upsertDocMeta(room.targetId, patch);
    } else if (room.codec === 'schedule/v1') {
      const lease = await repo.acquireDoc(room.targetId);
      try {
        const definition = lease.doc.getMap('definition');
        if (definition.get('enabled') !== false) definition.set('enabled', false);
        lease.doc.commit();
        await repo.persistDocNow(room.targetId, lease.doc);
      } finally {
        lease.release();
      }
    }
  }
}

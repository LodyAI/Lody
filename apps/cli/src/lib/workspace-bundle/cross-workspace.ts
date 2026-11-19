import { LoroMap } from 'loro-crdt';
import type { JsonObject, LoroRepo } from 'loro-repo';
import {
  createSessionMirror,
  getPendingUserTurnActivationId,
  type SessionImportFence,
  type SessionMeta,
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
 * Spec owner question 1, option (b): a cross-workspace import does not rewrite the
 * imported sessions or schedules. It records, on their metadata, which input and
 * which schedule activation came from the bundle, scoped to the target workspace.
 * Execution there skips exactly those (`getImportFence`, `isScheduleImportFenced`);
 * new input and a schedule resumed there run normally. Another workspace ignores the
 * fence, so a bundle exported back to the source does not stop its originals.
 * Applied only to rooms the target did not have before this import.
 */
export async function applyImportFences(
  repo: LoroRepo<JsonObject>,
  workspaceId: string,
  rooms: ReadonlyArray<{ targetId: string; codec: string }>
): Promise<void> {
  for (const room of rooms) {
    if (room.codec === 'session/v1') {
      const fence = await sessionImportFence(repo, room.targetId, workspaceId);
      await repo.upsertDocMeta(room.targetId, { importFence: fence });
    } else if (room.codec === 'schedule/v1') {
      const definition = (await repo.openDetachedDoc(room.targetId)).getMap('definition');
      const activationId = definition.get('activationId');
      if (typeof activationId === 'string')
        await repo.upsertDocMeta(room.targetId, { importFence: { workspaceId, activationId } });
    }
  }
}

const TERMINAL_TURN_STATUSES = new Set(['handled', 'error', 'canceled', 'cancelled']);

async function sessionImportFence(
  repo: LoroRepo<JsonObject>,
  docId: string,
  workspaceId: string
): Promise<SessionImportFence> {
  const turnIds = new Set<string>();
  const queueItemIds = new Set<string>();
  const doc = await repo.openDetachedDoc(docId);
  const mirror = createSessionMirror({ doc, initialState: {} });
  try {
    for (const turn of mirror.historyWriter.readStored()) {
      if (turn.role !== 'user') continue;
      const status = (turn as { status?: unknown }).status;
      if (typeof status !== 'string' || !TERMINAL_TURN_STATUSES.has(status)) turnIds.add(turn.id);
    }
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
  const meta = ((await repo.getDocMeta(docId))?.meta ?? {}) as Partial<SessionMeta>;
  for (const id of [
    meta.latestUserMsgId,
    meta.processingUserMsgId,
    getPendingUserTurnActivationId(meta as SessionMeta),
  ])
    if (typeof id === 'string' && id) turnIds.add(id);
  for (const id of Object.keys(meta.steerTurnStatuses ?? {})) turnIds.add(id);
  for (const record of Object.values(meta.queuePromotionLedger ?? {}))
    if (typeof record?.userTurnId === 'string') turnIds.add(record.userTurnId);
  return { workspaceId, turnIds: [...turnIds], queueItemIds: [...queueItemIds] };
}

/** True when this schedule activation came from an import into `workspaceId`. */
export function isScheduleImportFenced(
  meta: JsonObject | undefined,
  workspaceId: string,
  activationId: string
): boolean {
  const fence = meta?.importFence;
  if (!fence || typeof fence !== 'object' || Array.isArray(fence)) return false;
  return fence.workspaceId === workspaceId && fence.activationId === activationId;
}

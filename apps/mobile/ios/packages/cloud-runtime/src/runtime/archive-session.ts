import { Flock, type Value } from '@loro-dev/flock-wasm/base64';
import { projectRows } from '../protocol/catalog.ts';
import {
  sessionDeletionTargets,
  sessionDeletionBlocked,
} from '../models/sessionDeletion.ts';
import type { StreamsClient } from '@loro-dev/streams-client';
import { encodeFrame } from '../frames';
import { clientFor } from './session';

type Grant = () => Promise<{ token: string; gatewayBaseUrl: string }>;

function object(value: unknown): { [key: string]: Value } {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { [key: string]: Value })
    : {};
}

function docFields(flock: Flock, room: string): Record<string, unknown> {
  const fields = object(flock.get(['m', room]));
  for (const row of flock.scan({ prefix: ['m', room] })) {
    if (row.key.length !== 3 || typeof row.key[2] !== 'string') continue;
    if (row.value === undefined) delete fields[row.key[2]];
    else fields[row.key[2]] = row.value;
  }
  return fields;
}

function sessionPresent(flock: Flock, room: string) {
  if (flock.get(['e', room]) === false) return false;
  if (flock.get(['e', room]) === true) return true;
  if (flock.get(['m', room]) !== undefined) return true;
  return flock
    .scan({ prefix: ['m', room] })
    .some((row) => row.value !== undefined);
}

function sessionIdFromRoom(room: string) {
  if (!room.startsWith('session-') || room.startsWith('session-comment-'))
    return undefined;
  return room.slice('session-'.length);
}

function childTab(fields: Record<string, unknown>) {
  return (
    typeof fields.parentSessionId === 'string' && fields.parentSessionId !== ''
  );
}

function lifecycleSessionIds(flock: Flock, sessionId: string) {
  const childrenByOwner = new Map<string, string[]>();
  for (const row of flock.scan({ prefix: ['e'] })) {
    const room = row.key[1];
    if (row.value !== true || typeof room !== 'string') continue;
    const id = sessionIdFromRoom(room);
    if (!id) continue;
    const fields = docFields(flock, room);
    for (const owner of [
      fields.parentSessionId,
      fields.openedBySessionId,
      fields.openedByRootSessionId,
    ]) {
      if (typeof owner !== 'string' || !owner || owner === id) continue;
      const list = childrenByOwner.get(owner);
      if (list) list.push(id);
      else childrenByOwner.set(owner, [id]);
    }
  }
  const result: string[] = [];
  const pending = [sessionId];
  const included = new Set<string>();
  for (let i = 0; i < pending.length; i++) {
    const current = pending[i];
    if (!current || included.has(current)) continue;
    included.add(current);
    result.push(current);
    pending.push(...(childrenByOwner.get(current) ?? []));
  }
  return result;
}

function patchNeedToArchive(
  flock: Flock,
  machineId: string,
  sessionId: string,
  archived: boolean,
) {
  if (!machineId) return;
  const room = `machine-${machineId}`;
  const need = object(docFields(flock, room).needToArchiveSessions);
  if (archived) need[sessionId] = true;
  else delete need[sessionId];
  flock.set(['m', room, 'needToArchiveSessions'], need);
}

async function appendJson(client: StreamsClient, update: unknown) {
  const result = await client.append({
    part: {
      contentType: 'application/octet-stream',
      body: encodeFrame(new TextEncoder().encode(JSON.stringify(update))),
    },
  });
  if (!result.ok) throw new Error(result.result.code);
}

export async function deleteSession(
  args: { sessionId: string; sessionIds: string[] },
  meta: { flock: Flock; client: StreamsClient },
  beforeDelete?: (roostSessionIds: string[]) => Promise<void>,
) {
  if (
    typeof args.sessionId !== 'string' ||
    !args.sessionId ||
    !Array.isArray(args.sessionIds) ||
    !args.sessionIds.every((id) => typeof id === 'string')
  )
    throw new Error('invalid_session');
  const resolveTargets = () => {
    const sessions = projectRows(meta.flock.scan(), 'meta').sessions;
    if (!sessions.some((session) => session.id === args.sessionId))
      throw new Error('session_not_found');
    const targets = sessionDeletionTargets(sessions, args.sessionId);
    if (sessionDeletionBlocked(targets)) throw new Error('session_busy');
    if (
      targets.length !== args.sessionIds.length ||
      targets.some((session) => !args.sessionIds.includes(session.id))
    )
      throw new Error('session_delete_targets_changed');
    return targets;
  };
  let targets = resolveTargets();
  const roostIds = targets
    .map((session) => session.id)
    .filter(
      (id) => docFields(meta.flock, `session-${id}`).historyBackend === 'roost',
    );
  if (roostIds.length && beforeDelete) {
    await beforeDelete(roostIds);
    targets = resolveTargets();
  }

  // Stage separately: a failed append must not hide sessions in the live replica.
  const staged = new Flock(`lody-ios-delete-${crypto.randomUUID()}`);
  staged.importFile(meta.flock.exportFile());
  const version = staged.version();
  for (const session of targets)
    staged.set(['e', `session-${session.id}`], false);
  staged.commit();
  const update = staged.exportJson(version);
  await appendJson(meta.client, update);
  meta.flock.importJson(update);
  return targets.map((session) => session.id);
}

export async function renameSession(
  args: { sessionId: string; title: string },
  meta: { flock: Flock; client: StreamsClient },
) {
  if (typeof args.sessionId !== 'string' || typeof args.title !== 'string')
    throw new Error('invalid_session');
  const title = args.title.trim();
  if (!title || title.length > 200) throw new Error('invalid_session');
  const room = `session-${args.sessionId}`;
  if (!sessionPresent(meta.flock, room)) throw new Error('session_not_found');
  const version = meta.flock.version();
  meta.flock.set(['m', room, 'title'], title);
  meta.flock.set(['m', room, 'titleSource'], 'user');
  meta.flock.commit();
  await appendJson(meta.client, meta.flock.exportJson(version));
}

/** Web `transferSessionOwner`: rewrites only the owner `userId`, never sharing or visibility. */
export async function setSessionOwner(
  args: { sessionId: string; userId: string },
  meta: { flock: Flock; client: StreamsClient },
) {
  if (typeof args.sessionId !== 'string' || typeof args.userId !== 'string')
    throw new Error('invalid_session');
  const userId = args.userId.trim();
  if (!userId) throw new Error('invalid_session');
  const room = `session-${args.sessionId}`;
  if (!sessionPresent(meta.flock, room)) throw new Error('session_not_found');
  const version = meta.flock.version();
  meta.flock.set(['m', room, 'userId'], userId);
  meta.flock.commit();
  await appendJson(meta.client, meta.flock.exportJson(version));
}

export async function pinSession(
  args: { sessionId: string; pinned: boolean },
  meta: { flock: Flock; client: StreamsClient },
) {
  if (typeof args.sessionId !== 'string' || typeof args.pinned !== 'boolean')
    throw new Error('invalid_session');
  const room = `session-${args.sessionId}`;
  if (!sessionPresent(meta.flock, room)) throw new Error('session_not_found');
  const version = meta.flock.version();
  meta.flock.set(['m', room, 'isPinned'], args.pinned);
  meta.flock.commit();
  await appendJson(meta.client, meta.flock.exportJson(version));
}

export async function markSessionRead(
  args: { sessionId: string; lastReadAt: number },
  meta: { flock: Flock; client: StreamsClient },
) {
  if (typeof args.sessionId !== 'string' || !Number.isFinite(args.lastReadAt))
    throw new Error('invalid_session');
  const room = `session-${args.sessionId}`;
  if (!sessionPresent(meta.flock, room)) throw new Error('session_not_found');
  const current = meta.flock.get(['m', room, 'lastReadAt']);
  if (typeof current === 'number' && current >= args.lastReadAt) return;
  const version = meta.flock.version();
  meta.flock.set(['m', room, 'lastReadAt'], args.lastReadAt);
  meta.flock.commit();
  await appendJson(meta.client, meta.flock.exportJson(version));
}

export async function archiveSession(
  args: { workspaceId: string; sessionId: string; archived: boolean },
  meta: { flock: Flock; client: StreamsClient },
  machines: Map<string, Flock>,
  getGrant: Grant,
  beforeArchive?: (roostSessionIds: string[]) => Promise<void>,
) {
  if (typeof args.sessionId !== 'string' || typeof args.archived !== 'boolean')
    throw new Error('invalid_session');
  const room = `session-${args.sessionId}`;
  if (!sessionPresent(meta.flock, room)) throw new Error('session_not_found');
  const ids = lifecycleSessionIds(meta.flock, args.sessionId);
  if (args.archived && beforeArchive) {
    const roostIds = ids.filter(
      (id) => docFields(meta.flock, `session-${id}`).historyBackend === 'roost',
    );
    if (roostIds.length) {
      await beforeArchive(roostIds);
      const current = lifecycleSessionIds(meta.flock, args.sessionId);
      if (
        !sessionPresent(meta.flock, room) ||
        current.length !== ids.length ||
        current.some((id) => !ids.includes(id))
      )
        throw new Error('session_archive_targets_changed');
    }
  }
  const version = meta.flock.version();
  const roots: { id: string; machineId: string }[] = [];
  for (const id of ids) {
    const sessionRoom = `session-${id}`;
    const fields = docFields(meta.flock, sessionRoom);
    meta.flock.set(['m', sessionRoom, 'isArchived'], args.archived);
    if (args.archived)
      meta.flock.set(['m', sessionRoom, 'status'], { type: 'idle' });
    if (childTab(fields)) continue;
    const machineId = String(fields.machineId ?? '');
    roots.push({ id, machineId });
    patchNeedToArchive(meta.flock, machineId, id, args.archived);
  }
  meta.flock.commit();
  await appendJson(meta.client, meta.flock.exportJson(version));
  // Mirrors desktop: the session flag is the archive; the machine cleanup
  // command is best effort so an offline or unsynced machine cannot block it.
  const queued = new Map<string, string[]>();
  for (const root of roots) {
    if (!root.machineId || !machines.has(root.machineId)) continue;
    const list = queued.get(root.machineId);
    if (list) list.push(root.id);
    else queued.set(root.machineId, [root.id]);
  }
  for (const [machineId, sessionIds] of queued) {
    const machine = machines.get(machineId);
    if (!machine) continue;
    const machineVersion = machine.version();
    for (const id of sessionIds) {
      const key = ['cmd', 'archiveSession', id];
      if (args.archived) machine.set(key, { v: 1, requestedAt: Date.now() });
      else machine.delete(key);
    }
    machine.commit();
    try {
      const client = await clientFor(
        `${args.workspaceId}:mf:${machineId}`,
        getGrant,
      );
      await appendJson(client, machine.exportJson(machineVersion));
    } catch {
      /* archived state is already saved; machine cleanup waits for the next request */
    }
  }
}

/** Tab visibility is independent of archive, worktree and agent lifecycle. */
export async function setTabClosed(
  args: { sessionId: string; closed: boolean },
  meta: { flock: Flock; client: StreamsClient },
) {
  if (!args.sessionId || typeof args.closed !== 'boolean')
    throw new Error('invalid_session');
  const room = `session-${args.sessionId}`;
  if (!sessionPresent(meta.flock, room)) throw new Error('session_not_found');
  const staged = new Flock(`lody-tab-${crypto.randomUUID()}`);
  staged.importFile(meta.flock.exportFile());
  const version = staged.version();
  staged.set(['m', room, 'isTabClosed'], args.closed);
  staged.commit();
  const update = staged.exportJson(version);
  await appendJson(meta.client, update);
  meta.flock.importJson(update);
}

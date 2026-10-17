import {
  applyWorkspaceFlockRowEvents,
  getWorkspaceFlockDocId,
  listWorkspaceAgentRoles,
  listWorkspaceMcpServers,
  listWorkspaceProjects,
  readWorkspaceFlockRowsFromFlock,
  type AgentRole,
  type WorkspaceFlockEvent,
  type WorkspaceFlockRowMap,
  type WorkspaceMcpServerMeta,
  type WorkspaceProject,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';

/**
 * The workspace document's catalogs, as one snapshot.
 *
 * MCP servers, Agent Roles and Project groups are separate row families of the SAME Flock
 * document, so they are read through one room rather than one room each: a
 * second room would open the same document, join the same Loro room, and keep a
 * second copy of the same row map for a list of a few dozen entries.
 */
export type WorkspaceCatalogSnapshot = {
  servers: WorkspaceMcpServerMeta[];
  roles: AgentRole[];
  /** Multi-repository Project groups, sorted by name. */
  projects: WorkspaceProject[];
  /** True once the first remote sync landed, which makes an empty catalog authoritative. */
  synced: boolean;
};

type WorkspaceCatalogListener = (snapshot: WorkspaceCatalogSnapshot) => void;

const EMPTY_ROWS = Object.freeze({}) as WorkspaceFlockRowMap;

export const EMPTY_WORKSPACE_CATALOG: WorkspaceCatalogSnapshot = Object.freeze({
  servers: Object.freeze([]) as unknown as WorkspaceMcpServerMeta[],
  roles: Object.freeze([]) as unknown as AgentRole[],
  projects: Object.freeze([]) as unknown as WorkspaceProject[],
  synced: false,
});

type SharedCatalogRoom = {
  refCount: number;
  cancelled: boolean;
  rows: WorkspaceFlockRowMap;
  snapshot: WorkspaceCatalogSnapshot;
  listeners: Set<WorkspaceCatalogListener>;
  teardown: Set<() => void>;
};

// The catalog is ONE document per workspace, but the composer mounts a consumer
// per visible session (plus every hidden child tab and side chat) and settings
// mounts another. Opening a doc, joining a room, and keeping a row map per
// mount meant N leases and N duplicate re-renders for a single small list, so
// every consumer of a runtime shares one room here — the same reason
// `use-machine-flock-rows.ts` ref-counts its rooms.
const ROOMS = new WeakMap<WorkspaceRuntime, SharedCatalogRoom>();

/**
 * Keep the previous array when a family's contents did not move.
 *
 * The two families share a document, so every Role write re-lists the MCP
 * servers as well. Handing out a fresh `servers` identity for that would
 * invalidate the MCP selection memos on an edit they have nothing to do with
 * (and vice versa). Rows are identity-stable across
 * `applyWorkspaceFlockRowEvents`, so element identity is the whole comparison.
 */
const reuseUnchanged = <T>(previous: T[], next: T[]): T[] =>
  previous.length === next.length && previous.every((item, index) => item === next[index])
    ? previous
    : next;

function publish(room: SharedCatalogRoom, rows: WorkspaceFlockRowMap, synced: boolean): void {
  if (room.rows === rows && room.snapshot.synced === synced) return;
  room.rows = rows;
  const servers = reuseUnchanged(room.snapshot.servers, listWorkspaceMcpServers(rows));
  const roles = reuseUnchanged(room.snapshot.roles, listWorkspaceAgentRoles(rows));
  const projects = reuseUnchanged(room.snapshot.projects, listWorkspaceProjects(rows));
  if (
    servers === room.snapshot.servers &&
    roles === room.snapshot.roles &&
    projects === room.snapshot.projects &&
    room.snapshot.synced === synced
  ) {
    return;
  }
  room.snapshot = { servers, roles, projects, synced };
  for (const listener of room.listeners) {
    listener(room.snapshot);
  }
}

function startRoom(runtime: WorkspaceRuntime, room: SharedCatalogRoom): void {
  void (async () => {
    try {
      const handle = await runtime.repo.openFlockDoc(getWorkspaceFlockDocId(runtime.workspaceId));
      if (room.cancelled) return;

      publish(room, readWorkspaceFlockRowsFromFlock(handle.flock), room.snapshot.synced);
      const unsubscribeFlock = handle.flock.subscribe((batch) => {
        if (room.cancelled) return;
        const events = (batch as { events?: WorkspaceFlockEvent[] }).events ?? [];
        if (events.length > 0) {
          publish(room, applyWorkspaceFlockRowEvents(room.rows, events), room.snapshot.synced);
        }
      });
      room.teardown.add(unsubscribeFlock);

      const subscription = await handle.joinRoom();
      if (room.cancelled) {
        subscription.unsubscribe();
        return;
      }
      room.teardown.add(() => subscription.unsubscribe());
      await subscription.firstSyncedWithRemote;
      if (room.cancelled) return;

      // The first remote sync may arrive as a snapshot. Replace the local view
      // wholesale so remotely deleted rows cannot survive in the UI cache.
      publish(room, readWorkspaceFlockRowsFromFlock(handle.flock), true);
    } catch (error) {
      if (!room.cancelled) console.error('Failed to sync workspace catalog', error);
    }
  })();
}

/**
 * Join the workspace's shared catalog room. The returned snapshot is the
 * current shared state; `listener` receives every later one until `release`.
 */
export function acquireWorkspaceCatalog(
  runtime: WorkspaceRuntime,
  listener: WorkspaceCatalogListener
): { snapshot: WorkspaceCatalogSnapshot; release: () => void } {
  let room = ROOMS.get(runtime);
  if (!room) {
    room = {
      refCount: 0,
      cancelled: false,
      rows: EMPTY_ROWS,
      snapshot: EMPTY_WORKSPACE_CATALOG,
      listeners: new Set(),
      teardown: new Set(),
    };
    ROOMS.set(runtime, room);
    startRoom(runtime, room);
  }

  const joined = room;
  joined.refCount += 1;
  joined.listeners.add(listener);

  let released = false;
  return {
    snapshot: joined.snapshot,
    release: () => {
      if (released) return;
      released = true;
      joined.listeners.delete(listener);
      joined.refCount -= 1;
      if (joined.refCount > 0) return;
      joined.cancelled = true;
      if (ROOMS.get(runtime) === joined) {
        ROOMS.delete(runtime);
      }
      for (const stop of joined.teardown) {
        stop();
      }
      joined.teardown.clear();
    },
  };
}

import {
  applyWorkspaceFlockRowEvents,
  getProjectMcpDefaults,
  getWorkspaceFlockDocId,
  listWorkspaceAgentRoles,
  listWorkspaceMcpServers,
  listWorkspaceProjects,
  readWorkspaceFlockRowsFromFlock,
  type AgentRole,
  type ProjectMcpDefault,
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
  /** Explicit per-project default MCP selections, keyed by `getProjectMcpKey`. */
  projectMcpDefaults: Readonly<Record<string, ProjectMcpDefault>>;
  /**
   * True once the local document has been read. Defaults derived before this
   * would be derived from nothing, so default-dependent sends wait for it.
   */
  loaded: boolean;
  /** Opening or reading the document failed; defaults cannot be resolved. */
  failed: boolean;
  /** True once the first remote sync landed, which makes an empty catalog authoritative. */
  synced: boolean;
};

type WorkspaceCatalogListener = (snapshot: WorkspaceCatalogSnapshot) => void;

const EMPTY_ROWS = Object.freeze({}) as WorkspaceFlockRowMap;

export const EMPTY_WORKSPACE_CATALOG: WorkspaceCatalogSnapshot = Object.freeze({
  servers: Object.freeze([]) as unknown as WorkspaceMcpServerMeta[],
  roles: Object.freeze([]) as unknown as AgentRole[],
  projects: Object.freeze([]) as unknown as WorkspaceProject[],
  projectMcpDefaults: Object.freeze({}),
  loaded: false,
  failed: false,
  synced: false,
});

type SharedCatalogRoom = {
  refCount: number;
  inFlight: boolean;
  retryDelay: number;
  retryTimer?: ReturnType<typeof setTimeout>;
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

/** The same, for the project-default family: keyed rows, identity-stable values. */
const reuseUnchangedRecord = <T>(
  previous: Readonly<Record<string, T>>,
  next: Record<string, T>
): Readonly<Record<string, T>> => {
  const previousKeys = Object.keys(previous);
  return previousKeys.length === Object.keys(next).length &&
    previousKeys.every((key) => previous[key] === next[key])
    ? previous
    : next;
};

function emit(room: SharedCatalogRoom, snapshot: WorkspaceCatalogSnapshot): void {
  room.snapshot = snapshot;
  for (const listener of room.listeners) {
    listener(room.snapshot);
  }
}

function publish(room: SharedCatalogRoom, rows: WorkspaceFlockRowMap, synced: boolean): void {
  const previous = room.snapshot;
  if (room.rows === rows && previous.loaded && previous.synced === synced) return;
  room.rows = rows;
  const servers = reuseUnchanged(previous.servers, listWorkspaceMcpServers(rows));
  const roles = reuseUnchanged(previous.roles, listWorkspaceAgentRoles(rows));
  const projects = reuseUnchanged(previous.projects, listWorkspaceProjects(rows));
  const projectMcpDefaults = reuseUnchangedRecord(
    previous.projectMcpDefaults,
    getProjectMcpDefaults(rows)
  );
  if (
    servers === previous.servers &&
    roles === previous.roles &&
    projects === previous.projects &&
    projectMcpDefaults === previous.projectMcpDefaults &&
    previous.loaded &&
    previous.synced === synced
  ) {
    return;
  }
  emit(room, {
    servers,
    roles,
    projects,
    projectMcpDefaults,
    loaded: true,
    failed: false,
    synced,
  });
}

function startRoom(runtime: WorkspaceRuntime, room: SharedCatalogRoom): void {
  if (room.cancelled || room.inFlight) return;
  clearTimeout(room.retryTimer);
  room.inFlight = true;
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
      if (room.cancelled) return;
      console.error('Failed to sync workspace catalog', error);
      // Only a document that was never read is a failure to resolve defaults: a
      // read snapshot stays usable while the remote room is unavailable.
      if (!room.snapshot.loaded) {
        emit(room, { ...room.snapshot, failed: true });
        room.retryTimer = setTimeout(() => startRoom(runtime, room), room.retryDelay);
        room.retryDelay = Math.min(room.retryDelay * 2, 30_000);
      }
    } finally {
      room.inFlight = false;
    }
  })();
}

/** Retry an unread catalog without opening a second room for its consumers. */
export function retryWorkspaceCatalog(runtime: WorkspaceRuntime): void {
  const room = ROOMS.get(runtime);
  if (room?.snapshot.failed) startRoom(runtime, room);
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
      inFlight: false,
      retryDelay: 1_000,
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
      clearTimeout(joined.retryTimer);
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

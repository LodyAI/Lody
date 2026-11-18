import {
  createLegacyWorkspaceCatalogReader,
  isWorkspaceCatalogRestartRequired,
  getWorkspaceFlockDocId,
  type WorkspaceCatalogProjection,
  type WorkspaceCatalogReader,
  type AgentRole,
  type ProjectMcpDefault,
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
  snapshot: WorkspaceCatalogSnapshot;
  listeners: Set<WorkspaceCatalogListener>;
  teardown: Set<() => Promise<void>>;
  restartAttempts: number;
  retryRestart?: () => void;
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

function publish(
  room: SharedCatalogRoom,
  projection: WorkspaceCatalogProjection,
  synced: boolean
): void {
  const previous = room.snapshot;
  const servers = reuseUnchanged(previous.servers, projection.servers);
  const roles = reuseUnchanged(previous.roles, projection.roles);
  const projects = reuseUnchanged(previous.projects, projection.projects);
  const projectMcpDefaults = reuseUnchangedRecord(
    previous.projectMcpDefaults,
    projection.projectMcpDefaults
  );
  if (
    servers === previous.servers &&
    roles === previous.roles &&
    projects === previous.projects &&
    projectMcpDefaults === previous.projectMcpDefaults &&
    previous.loaded &&
    !previous.failed &&
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

const catalogBinding = (runtime: WorkspaceRuntime) => ({
  workspaceId: runtime.workspaceId,
  accountId: runtime.accountId ?? null,
});
function catalogReader(runtime: WorkspaceRuntime): WorkspaceCatalogReader {
  const binding = catalogBinding(runtime);
  return (
    runtime.workspaceCatalogReader ??
    createLegacyWorkspaceCatalogReader({
      binding,
      open: () => runtime.repo.openFlockDoc(getWorkspaceFlockDocId(runtime.workspaceId)),
    })
  );
}

/** Cold domain projection for proposal validation; does not acquire another room owner. */
export function readWorkspaceCatalog(runtime: WorkspaceRuntime) {
  return catalogReader(runtime).read(catalogBinding(runtime));
}

const MAX_CATALOG_RESTARTS = 3;
const CATALOG_RELEASE_TIMEOUT_MS = 5_000;
async function boundedCatalogRelease(work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Workspace catalog observation release is unconfirmed')),
          CATALOG_RELEASE_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function startRoom(runtime: WorkspaceRuntime, room: SharedCatalogRoom): void {
  if (room.cancelled || room.inFlight) return;
  clearTimeout(room.retryTimer);
  room.inFlight = true;
  const binding = catalogBinding(runtime);
  const reader = catalogReader(runtime);
  let retired = false;
  let boundedRestarts = false;
  let retiring = false;
  let close: (() => Promise<void>) | undefined;
  const schedule = (resume: () => void) => {
    if (room.cancelled) return;
    room.retryRestart = resume;
    if (boundedRestarts && room.restartAttempts >= MAX_CATALOG_RESTARTS) return;
    const delay = boundedRestarts
      ? Math.min(1_000 * 2 ** room.restartAttempts, 30_000)
      : room.retryDelay;
    if (boundedRestarts) room.restartAttempts += 1;
    else room.retryDelay = Math.min(room.retryDelay * 2, 30_000);
    clearTimeout(room.retryTimer);
    room.retryTimer = setTimeout(resume, delay);
  };
  const retire = async () => {
    if (!close || retiring) return;
    retiring = true;
    room.inFlight = true;
    try {
      await boundedCatalogRelease(close());
      schedule(() => startRoom(runtime, room));
    } catch (error) {
      if (!room.cancelled) console.warn('Workspace catalog observation release failed', error);
      // Retain and retry this one release; never acquire another observer while
      // its cleanup is unconfirmed, and never stop the host or sibling readers.
      schedule(() => {
        void retire();
      });
    } finally {
      retiring = false;
      room.inFlight = false;
    }
  };
  const failed = (error: unknown) => {
    if (room.cancelled || retired) return;
    retired = true;
    boundedRestarts = isWorkspaceCatalogRestartRequired(error) || room.snapshot.loaded;
    console.error('Failed to sync workspace catalog', error);
    emit(room, { ...room.snapshot, failed: true, synced: false });
    room.retryRestart = () => {
      if (close) void retire();
    };
    if (close) void retire();
  };
  void reader
    .observe(
      binding,
      (update) => {
        if (room.cancelled || retired) return;
        room.restartAttempts = 0;
        room.retryRestart = undefined;
        publish(room, update.projection, update.synced);
      },
      failed
    )
    .then((observation) => {
      let released = false;
      let releasing: Promise<void> | undefined;
      close = () => {
        retired = true;
        if (released) return Promise.resolve();
        if (releasing) return releasing;
        const pending = Promise.resolve()
          .then(() => observation.close())
          .then(() => {
            released = true;
            room.teardown.delete(close!);
          });
        releasing = pending;
        void pending.catch(() => {
          if (releasing === pending) releasing = undefined;
        });
        return pending;
      };
      room.teardown.add(close);
      if (room.cancelled || retired) return retire();
    })
    .catch((error) => {
      failed(error);
      if (!close) schedule(() => startRoom(runtime, room));
    })
    .finally(() => {
      room.inFlight = false;
    });
}

/** Retry an unread catalog without opening a second room for its consumers. */
export function retryWorkspaceCatalog(runtime: WorkspaceRuntime): void {
  const room = ROOMS.get(runtime);
  if (room?.snapshot.failed) {
    room.restartAttempts = 0;
    clearTimeout(room.retryTimer);
    if (room.retryRestart) room.retryRestart();
    else startRoom(runtime, room);
  }
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
      snapshot: EMPTY_WORKSPACE_CATALOG,
      listeners: new Set(),
      teardown: new Set(),
      restartAttempts: 0,
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
        void stop().catch((error) =>
          console.warn('Workspace catalog observation close failed', error)
        );
      }
    },
  };
}

import { EphemeralStore, type Value } from 'loro-crdt';
import {
  LODY_PRESENCE_HEARTBEAT_MS,
  LODY_PRESENCE_TTL_MS,
  getLodySessionViewingPresenceKey,
  getServerNow,
  parseLodyPresenceStates,
  toLodyPresenceStreamUrl,
  type LodyPresenceInstanceId,
  type LodyPresenceStateMap,
  type LodySessionViewingPresenceState,
  type LoroStreamsPresenceShardId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import {
  EphemeralRoomTransport,
  type EphemeralRoomAuthCallback,
  type EphemeralRoomBaseOptions,
  type EphemeralRoomStoreLike,
  type EphemeralRoomTransportLike,
} from './ephemeral-room-transport';

export type PresenceStoreLike = EphemeralRoomStoreLike & {
  set(key: string, value: Value): void;
  delete(key: string): void;
};
export type PresenceTransportLike = EphemeralRoomTransportLike;

type PresenceAuthCallback = EphemeralRoomAuthCallback;

export type WorkspacePresenceDebugGlobal = {
  readonly workspaceId: WorkspaceId;
  readonly presenceShardId: LoroStreamsPresenceShardId;
  readonly generation: number;
  readonly streamUrl: string | null;
  readonly store: PresenceStoreLike | null;
  getAllStates(): Record<string, unknown>;
  getParsedStates(): LodyPresenceStateMap;
  subscribe(listener: (states: LodyPresenceStateMap) => void): () => void;
};

export type WorkspacePresenceTransportOptions = EphemeralRoomBaseOptions & {
  onSnapshot?: (states: LodyPresenceStateMap) => void;
  createStore?: () => PresenceStoreLike;
  createTransport?: (args: {
    streamUrl: string;
    auth: PresenceAuthCallback;
    store: PresenceStoreLike;
  }) => PresenceTransportLike;
};

export type WorkspacePresenceTransportStartOptions = {
  baseUrl: string;
  auth: PresenceAuthCallback;
  shardHostSuffix?: string;
};

export class WorkspacePresenceTransport extends EphemeralRoomTransport<
  PresenceStoreLike,
  WorkspacePresenceTransportOptions
> {
  protected readonly warnPrefix = 'createWorkspaceRuntime';
  protected readonly roomLabel = 'presence room';
  private lastSnapshotAtMs: number | null = null;
  private readonly viewingInstanceId = createViewingInstanceId();
  private viewing: { sessionId: SessionId; userId: string; since: number } | null = null;
  private viewingHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  shouldRestartOnExternalWake(nowMs: number = Date.now()): boolean {
    const syncState = this.getSyncState();
    if (syncState === 'idle') return false;
    if (syncState !== 'synced') return true;
    if (this.lastSnapshotAtMs === null) return true;
    return nowMs - this.lastSnapshotAtMs >= LODY_PRESENCE_HEARTBEAT_MS * 2;
  }

  /**
   * Publish (or clear, with null) "this app instance is viewing session S".
   * The entry is heartbeated while set, re-asserted on every room start/join
   * (the store is recreated per start), and actively deleted on clear/teardown
   * — the ephemeral TTL is only the crash fallback.
   */
  publishSessionViewing(args: { sessionId: SessionId; userId: string } | null): void {
    if (args === null) {
      if (!this.viewing) return;
      const key = getLodySessionViewingPresenceKey(this.viewing.userId, this.viewingInstanceId);
      this.viewing = null;
      this.stopViewingHeartbeat();
      this.store?.delete(key);
      return;
    }
    if (
      this.viewing &&
      this.viewing.sessionId === args.sessionId &&
      this.viewing.userId === args.userId
    ) {
      return;
    }
    // Replace any previous entry in place: one entry per app instance.
    const previousKey = this.viewing
      ? getLodySessionViewingPresenceKey(this.viewing.userId, this.viewingInstanceId)
      : null;
    this.viewing = {
      sessionId: args.sessionId,
      userId: args.userId,
      since: getServerNow(),
    };
    if (previousKey) this.store?.delete(previousKey);
    this.writeViewingEntry();
    this.startViewingHeartbeat();
  }

  protected createStore(): PresenceStoreLike {
    return this.options.createStore?.() ?? new EphemeralStore(LODY_PRESENCE_TTL_MS);
  }

  protected override createTransport(args: {
    streamUrl: string;
    auth: PresenceAuthCallback;
    store: PresenceStoreLike;
  }): PresenceTransportLike {
    return this.options.createTransport?.(args) ?? super.createTransport(args);
  }

  protected tagStreamUrl(durableStreamUrl: string): string {
    return toLodyPresenceStreamUrl(durableStreamUrl);
  }

  protected onStoreChange(store: PresenceStoreLike): void {
    this.lastSnapshotAtMs = Date.now();
    const states = parseLodyPresenceStates(store.getAllStates());
    if (!Object.values(states).some((state) => state.kind === 'machine')) {
      return;
    }
    this.options.onSnapshot?.(states);
  }

  protected override onRoomStarted(store: PresenceStoreLike): void {
    this.exposeDebugGlobal();
    // Fresh store per start: re-assert local state and restart its heartbeat.
    this.writeViewingEntry();
    this.startViewingHeartbeat();
    this.onStoreChange(store);
  }

  protected override onJoined(store: PresenceStoreLike): void {
    // Local writes may have raced the join; re-assert once the room is live.
    this.writeViewingEntry();
    super.onJoined(store);
  }

  protected override onBeforeTeardown(): void {
    this.stopViewingHeartbeat();
    if (this.viewing) {
      this.store?.delete(
        getLodySessionViewingPresenceKey(this.viewing.userId, this.viewingInstanceId)
      );
    }
  }

  protected override onBeforeStop(): void {
    this.lastSnapshotAtMs = null;
  }

  private startViewingHeartbeat(): void {
    if (!this.viewing || this.viewingHeartbeatTimer) return;
    this.viewingHeartbeatTimer = setInterval(() => {
      this.writeViewingEntry();
    }, LODY_PRESENCE_HEARTBEAT_MS);
  }

  private stopViewingHeartbeat(): void {
    if (!this.viewingHeartbeatTimer) return;
    clearInterval(this.viewingHeartbeatTimer);
    this.viewingHeartbeatTimer = null;
  }

  private writeViewingEntry(): void {
    if (!this.store || !this.viewing) return;
    const state: LodySessionViewingPresenceState = {
      kind: 'session-viewing',
      userId: this.viewing.userId,
      instanceId: this.viewingInstanceId,
      sessionId: this.viewing.sessionId,
      since: this.viewing.since,
      updatedAt: getServerNow(),
    };
    this.store.set(
      getLodySessionViewingPresenceKey(this.viewing.userId, this.viewingInstanceId),
      state as unknown as Value
    );
  }

  private exposeDebugGlobal(): void {
    if (typeof window === 'undefined') return;
    const owner = this;
    const target = window as typeof window & { lodyPresence?: WorkspacePresenceDebugGlobal };
    target.lodyPresence = {
      get workspaceId() {
        return owner.options.workspaceId;
      },
      get presenceShardId() {
        return owner.presenceShardId;
      },
      get generation() {
        return owner.generation;
      },
      get streamUrl() {
        return owner.streamUrl;
      },
      get store() {
        return owner.store;
      },
      getAllStates() {
        return owner.store?.getAllStates() ?? {};
      },
      getParsedStates() {
        return parseLodyPresenceStates(owner.store?.getAllStates() ?? {});
      },
      subscribe(listener) {
        const store = owner.store;
        if (!store) return () => {};
        return store.subscribe(() => {
          listener(parseLodyPresenceStates(store.getAllStates()));
        });
      },
    };
  }
}

function createViewingInstanceId(): LodyPresenceInstanceId {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID() as LodyPresenceInstanceId;
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}` as LodyPresenceInstanceId;
}

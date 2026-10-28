import { EphemeralStreamCrdt } from '@loro-dev/streams-crdt/loro';
import { createEncryptedPresenceAdaptorLegacy } from '@lody/shared/encrypted-presence-adaptor-legacy';
import type { EncryptedPresencePort } from '@lody/shared/encrypted-presence';
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
  type EphemeralRoomStartArgs,
  type EphemeralRoomStoreLike,
  type EphemeralRoomTransportLike,
} from './ephemeral-room-transport';
import type { RoomSyncState } from '@/lib/room-sync-state';

/**
 * How long a synced presence room's DISPLAY state survives an in-place
 * reconnect. The Streams SDK reports `reconnecting` whenever its SSE read loop
 * recycles (a routine server-side stream recycle qualifies), even though the
 * retained store still holds the last applied snapshot. The raw state must keep
 * driving recovery immediately; the UI must not blink every machine's "Offline"
 * pill for the milliseconds a reconnect takes. A store-replacing restart and
 * every terminal state bypass this window because the snapshot is gone/unknown.
 */
export const PRESENCE_SYNC_DISPLAY_GRACE_MS = 5_000;

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
  encryptedPresence?: EncryptedPresencePort;
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
  /** UI-facing liveness state: the raw state, held through a brief in-place reconnect. */
  private displaySyncState: RoomSyncState = 'idle';
  private displayGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly displaySyncStateListeners = new Set<(state: RoomSyncState) => void>();
  /**
   * `start()` replaces the store, so its snapshot is empty until the new join
   * bootstraps. Never let the display grace cover that: unlike an SSE recycle,
   * it has no retained snapshot to speak for.
   */
  private replacingStore = false;

  /**
   * Presence health as the UI should read it. This equals the raw transport
   * state except during a brief in-place reconnect, when the last synced state
   * still describes the retained snapshot. Recovery and reconnect decisions
   * must use {@link getSyncState} / {@link subscribeSyncState} instead.
   */
  getDisplaySyncState(): RoomSyncState {
    return this.displaySyncState;
  }

  subscribeDisplaySyncState(listener: (state: RoomSyncState) => void): () => void {
    this.displaySyncStateListeners.add(listener);
    listener(this.displaySyncState);
    return () => {
      this.displaySyncStateListeners.delete(listener);
    };
  }

  override start(args: EphemeralRoomStartArgs): void {
    this.replacingStore = true;
    try {
      super.start(args);
    } finally {
      this.replacingStore = false;
    }
  }

  protected override setSyncState(next: RoomSyncState): void {
    super.setSyncState(next);
    this.advanceDisplaySyncState(next);
  }

  private advanceDisplaySyncState(next: RoomSyncState): void {
    this.clearDisplayGrace();
    const briefRecovery = next === 'connecting' || next === 'reconnecting';
    if (this.displaySyncState === 'synced' && briefRecovery && !this.replacingStore) {
      this.displayGraceTimer = setTimeout(() => {
        this.displayGraceTimer = null;
        // The raw state may have moved on without a status event; publish what
        // it is now, and let a concurrent `synced` win (the snapshot is back).
        const current = this.getSyncState();
        if (current !== 'synced') this.publishDisplaySyncState(current);
      }, PRESENCE_SYNC_DISPLAY_GRACE_MS);
      return;
    }
    this.publishDisplaySyncState(next);
  }

  private publishDisplaySyncState(next: RoomSyncState): void {
    if (this.displaySyncState === next) return;
    this.displaySyncState = next;
    for (const listener of Array.from(this.displaySyncStateListeners)) {
      listener(next);
    }
  }

  private clearDisplayGrace(): void {
    if (this.displayGraceTimer === null) return;
    clearTimeout(this.displayGraceTimer);
    this.displayGraceTimer = null;
  }

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
    if (this.options.createTransport) return this.options.createTransport(args);
    if (!this.options.encryptedPresence) return super.createTransport(args);
    const encrypted = createEncryptedPresenceAdaptorLegacy(
      args.store as EphemeralStore,
      this.options.encryptedPresence
    );
    const transport = new EphemeralStreamCrdt({
      streamUrl: args.streamUrl,
      auth: args.auth,
      adaptor: encrypted.adaptor,
    });
    return {
      join: (options) => transport.join(options),
      close: async () => {
        encrypted.retire();
        try {
          await transport.close();
        } finally {
          await encrypted.close();
        }
      },
    };
  }

  protected tagStreamUrl(durableStreamUrl: string): string {
    return toLodyPresenceStreamUrl(durableStreamUrl);
  }

  protected onStoreChange(store: PresenceStoreLike): void {
    this.lastSnapshotAtMs = Date.now();
    this.options.onSnapshot?.(
      parseLodyPresenceStates(
        store.getAllStates(),
        this.options.encryptedPresence ? { authenticatedExpiry: true } : undefined
      )
    );
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
    this.options.onSnapshot?.({});
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
        return parseLodyPresenceStates(
          owner.store?.getAllStates() ?? {},
          owner.options.encryptedPresence ? { authenticatedExpiry: true } : undefined
        );
      },
      subscribe(listener) {
        const store = owner.store;
        if (!store) return () => {};
        return store.subscribe(() => {
          listener(
            parseLodyPresenceStates(
              store.getAllStates(),
              owner.options.encryptedPresence ? { authenticatedExpiry: true } : undefined
            )
          );
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

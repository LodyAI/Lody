import { EphemeralStore, LoroDoc, VersionVector } from 'loro-crdt';
import type {
  TransportAdapter,
  TransportConnectionStatus,
  TransportJoinParams,
  TransportRoomStatus,
  TransportSubscription,
  TransportSyncResult,
} from 'loro-repo';
import {
  base64ToBytes,
  buildDocUpdateChunkPayloads,
  bytesToBase64,
  chunkFlockBundle,
  createDocUpdateTransferId,
  decodeFlockVersion,
  DocUpdateChunkAssembler,
  encodeFlockVersion,
  isEmptyFlockBundle,
  LOCAL_LORO_DATA_PLANE_MAX_PAYLOAD_BYTES,
  LOCAL_LORO_DATA_PLANE_PAYLOAD_TOO_LARGE,
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  mergeFlockVersions,
  roomKey,
  sameRoom,
  type FlockVersionVector,
  type LocalLoroDataPlaneClientMessage,
  type LocalLoroDataPlanePayload,
  type LocalLoroDataPlaneRoom,
  type LocalLoroDataPlaneServerMessage,
  type LocalLoroServerErrorMessage,
} from './local-loro-data-plane';

/**
 * Persistent, push-capable link to the CLI data-plane server. The renderer wires
 * this to the Electron relay (send → IPC send, onMessage → IPC event); the
 * in-memory test harness wires it straight to a LocalLoroDataPlaneServer.
 *
 * The link is a BROADCAST pipe: `onMessage` may deliver frames addressed to
 * other peers, other rooms, and other workspaces (the Electron relay fans every
 * server push out to every window). The adapter is responsible for filtering by
 * workspaceId + its own peerId — never assume a delivered frame is ours.
 */
export type LocalLoroDataPlaneConnection = {
  send: (message: LocalLoroDataPlaneClientMessage) => void;
  onMessage: (listener: (message: LocalLoroDataPlaneServerMessage) => void) => () => void;
  onStatusChange: (listener: (connected: boolean) => void) => () => void;
  isConnected: () => boolean;
};

type FlockLike = {
  exportJson(from: FlockVersionVector): unknown | Promise<unknown>;
  importJson(bundle: unknown): void | Promise<void>;
  /** Exclusive/visible flock version vector — the incremental-export baseline. */
  version(): FlockVersionVector;
  commit?: () => void;
  subscribe(listener: (batch: { source?: string; by?: string }) => void): () => void;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  if (!resolve || !reject) {
    throw new Error('failed_to_create_deferred');
  }
  return { promise, resolve, reject };
}

function notify<T>(listeners: Set<(value: T) => void>, value: T): void {
  for (const listener of listeners) {
    listener(value);
  }
}

function createPeerId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `local:${Date.now()}:${Math.random().toString(36)}`;
}

type RoomState = {
  room: LocalLoroDataPlaneRoom;
  target: LoroDoc | FlockLike;
  isDoc: boolean;
  closed: boolean;
  joined: boolean;
  // Fast-path hint that there are unsent local changes. Correctness never
  // depends on it: every (re)join reconciles against the server's returned
  // version regardless (see handleJoined), so writes made before this process
  // started, or dropped by the relay mid-flight, still converge.
  dirty: boolean;
  // Terminal room failure (e.g. payload_too_large). Terminal rooms are NOT
  // retried by reconnect loops or connection status transitions — only an
  // explicit `subscription.rejoin()` clears this and tries again (R4).
  terminalError: string | null;
  // Server's version vector we export up-sync deltas from (doc rooms).
  serverVersion: VersionVector | null;
  // Server's flock frontier we export up-sync deltas from (flock rooms).
  // Replaced by the authoritative `joined` frontier, then advanced by server
  // updates and successful local exports within that join generation.
  serverFlockVersion: FlockVersionVector | null;
  // Invalidates async Flock exports started before a newer join request. An old
  // export must never overwrite the authoritative baseline returned on rejoin.
  syncGeneration: number;
  // Serializes flock up-sync passes (export is async); the queued latch bounds
  // a burst of local changes to one running + one queued export.
  flockFlushChain: Promise<void>;
  flockFlushQueued: boolean;
  // Reassembles chunked doc-update pushes from the server. Reset on (re)join
  // and on connection loss: frames of an interrupted transfer must never be
  // concatenated with a later transfer's.
  docChunkAssembler: DocUpdateChunkAssembler | null;
  pendingJoinRequestId: string | null;
  firstSynced: Deferred<void>;
  syncedWaiters: Set<Deferred<void>>;
  unsubscribeLocal: () => void;
  status: TransportRoomStatus;
  statusListeners: Set<(status: TransportRoomStatus) => void>;
};

export type LocalLoroTransportAdapterOptions = {
  workspaceId: string;
  peerId?: string;
  connection: LocalLoroDataPlaneConnection;
  maxPayloadBytes?: number;
};

export class LocalLoroTransportAdapter implements TransportAdapter {
  private readonly workspaceId: string;
  private readonly peerId: string;
  private readonly connection: LocalLoroDataPlaneConnection;
  private readonly maxPayloadBytes: number;
  private readonly rooms = new Map<string, RoomState>();
  private readonly statusListeners = new Set<(status: TransportConnectionStatus) => void>();
  private readonly disposers: Array<() => void> = [];
  private requestSeq = 0;

  constructor(options: LocalLoroTransportAdapterOptions) {
    this.workspaceId = options.workspaceId;
    this.peerId = options.peerId ?? createPeerId();
    this.connection = options.connection;
    this.maxPayloadBytes = options.maxPayloadBytes ?? LOCAL_LORO_DATA_PLANE_MAX_PAYLOAD_BYTES;
    this.disposers.push(this.connection.onMessage((message) => this.handleServerMessage(message)));
    this.disposers.push(
      this.connection.onStatusChange((connected) => this.handleConnectionStatus(connected))
    );
  }

  async connect(): Promise<void> {
    notify(this.statusListeners, this.getStatus());
  }

  async close(): Promise<void> {
    for (const state of this.rooms.values()) {
      this.closeRoom(state);
    }
    this.rooms.clear();
    // Withdraw the whole peer server-side. The relay also synthesizes this for
    // destroyed/navigated windows; sending it here covers in-process teardown
    // (workspace switch) where the window — and the shared socket — live on.
    if (this.connection.isConnected()) {
      try {
        this.connection.send({
          type: 'detach',
          protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
          workspaceId: this.workspaceId,
          peerId: this.peerId,
        });
      } catch {
        // Best effort; the server also drops this peer's rooms on disconnect.
      }
    }
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    notify(this.statusListeners, 'disconnected');
  }

  isConnected(): boolean {
    return this.connection.isConnected();
  }

  getStatus(): TransportConnectionStatus {
    return this.connection.isConnected() ? 'connected' : 'disconnected';
  }

  onStatusChange(listener: (status: TransportConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => this.statusListeners.delete(listener);
  }

  getLatency(): number | undefined {
    return undefined;
  }

  onLatency(_listener: (latencyMs: number) => void): () => void {
    return () => {};
  }

  async reconnect(): Promise<void> {
    for (const state of this.rooms.values()) {
      if (state.terminalError) {
        continue;
      }
      this.rejoinRoom(state);
    }
  }

  async syncMeta(flock: FlockLike): Promise<TransportSyncResult> {
    await this.ensureJoinedOnce({ scope: 'meta' }, flock, false);
    return { ok: true };
  }

  joinMetaRoom(flock: FlockLike, _params?: TransportJoinParams): TransportSubscription {
    return this.joinRoom({ scope: 'meta' }, flock, false);
  }

  async syncDoc(docId: string, doc: LoroDoc): Promise<TransportSyncResult> {
    await this.ensureJoinedOnce({ scope: 'doc', docId }, doc, true);
    return { ok: true };
  }

  joinDocRoom(docId: string, doc: LoroDoc, _params?: TransportJoinParams): TransportSubscription {
    return this.joinRoom({ scope: 'doc', docId }, doc, true);
  }

  async syncFlockDoc(flockDocId: string, flock: FlockLike): Promise<TransportSyncResult> {
    await this.ensureJoinedOnce({ scope: 'flock-doc', flockDocId }, flock, false);
    return { ok: true };
  }

  joinFlockDocRoom(
    flockDocId: string,
    flock: FlockLike,
    _params?: TransportJoinParams
  ): TransportSubscription {
    return this.joinRoom({ scope: 'flock-doc', flockDocId }, flock, false);
  }

  async forgetFlockDoc(flockDocId: string): Promise<void> {
    const key = roomKey({ scope: 'flock-doc', flockDocId });
    const state = this.rooms.get(key);
    if (state) {
      this.closeRoom(state);
      this.rooms.delete(key);
      this.sendLeave(state.room);
    }
  }

  joinEphemeralRoom(_roomId: string): TransportSubscription & { store: EphemeralStore } {
    const firstSynced = Promise.resolve();
    return {
      store: new EphemeralStore(),
      unsubscribe: () => {},
      firstSyncedWithRemote: firstSynced,
      waitUntilSynced: async () => {},
      status: 'joined',
      onStatusChange: (listener) => {
        listener('joined');
        return () => {};
      },
    };
  }

  private joinRoom(
    room: LocalLoroDataPlaneRoom,
    target: LoroDoc | FlockLike,
    isDoc: boolean
  ): TransportSubscription {
    const key = roomKey(room);
    const existing = this.rooms.get(key);
    if (existing) {
      return this.subscriptionFor(existing);
    }
    const state: RoomState = {
      room,
      target,
      isDoc,
      closed: false,
      joined: false,
      dirty: false,
      terminalError: null,
      serverVersion: null,
      serverFlockVersion: null,
      syncGeneration: 0,
      flockFlushChain: Promise.resolve(),
      flockFlushQueued: false,
      docChunkAssembler: null,
      pendingJoinRequestId: null,
      firstSynced: createDeferred<void>(),
      syncedWaiters: new Set(),
      unsubscribeLocal: () => {},
      status: 'connecting',
      statusListeners: new Set(),
    };
    state.unsubscribeLocal = this.subscribeLocal(state);
    this.rooms.set(key, state);
    this.sendJoin(state);
    return this.subscriptionFor(state);
  }

  private async ensureJoinedOnce(
    room: LocalLoroDataPlaneRoom,
    target: LoroDoc | FlockLike,
    isDoc: boolean
  ): Promise<void> {
    const key = roomKey(room);
    const existing = this.rooms.get(key);
    if (existing) {
      await existing.firstSynced.promise;
      return;
    }
    const subscription = this.joinRoom(room, target, isDoc);
    await subscription.firstSyncedWithRemote;
  }

  private subscribeLocal(state: RoomState): () => void {
    if (state.isDoc) {
      const doc = state.target as LoroDoc;
      return doc.subscribe((event: { by?: string }) => {
        // Only our own local edits need up-syncing; imports (server pushes) must
        // not bounce back — this is the structural fix for the echo the old
        // `muted` flag could not suppress.
        if (event.by !== undefined && event.by !== 'local') {
          return;
        }
        state.dirty = true;
        this.flushLocal(state);
      });
    }
    const flock = state.target as FlockLike;
    return flock.subscribe((batch: { source?: string }) => {
      if (batch.source !== 'local') {
        return;
      }
      state.dirty = true;
      this.flushLocal(state);
    });
  }

  private sendJoin(state: RoomState): void {
    if (state.closed || state.terminalError) {
      return;
    }
    this.setRoomStatus(state, this.connection.isConnected() ? 'connecting' : 'reconnecting');
    if (!this.connection.isConnected()) {
      return;
    }
    const requestId = `join:${this.peerId}:${++this.requestSeq}`;
    state.syncGeneration += 1;
    state.pendingJoinRequestId = requestId;
    // Both room kinds report what they already hold, so (re)join catch-up is
    // always incremental: base64 Loro VV for docs, JSON flock VV for flocks.
    const haveVersion = state.isDoc
      ? bytesToBase64((state.target as LoroDoc).oplogVersion().encode())
      : encodeFlockVersion((state.target as FlockLike).version());
    try {
      this.connection.send({
        type: 'join',
        protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
        requestId,
        workspaceId: this.workspaceId,
        peerId: this.peerId,
        room: state.room,
        ...(haveVersion ? { haveVersion } : {}),
      });
    } catch {
      this.setRoomStatus(state, 'reconnecting');
    }
  }

  private rejoinRoom(state: RoomState): void {
    state.joined = false;
    this.sendJoin(state);
  }

  private sendLeave(room: LocalLoroDataPlaneRoom): void {
    if (!this.connection.isConnected()) {
      return;
    }
    try {
      this.connection.send({
        type: 'leave',
        protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
        workspaceId: this.workspaceId,
        peerId: this.peerId,
        room,
      });
    } catch {
      // Best effort; the server also drops rooms on disconnect/detach.
    }
  }

  /**
   * Up-sync local changes. `force` bypasses the `dirty` fast-path hint and
   * reconciles against `serverVersion` unconditionally — used on every
   * (re)join so convergence never depends on in-memory state (R3/F5).
   */
  private flushLocal(state: RoomState, options: { force?: boolean } = {}): void {
    if (state.closed || state.terminalError || !state.joined || !this.connection.isConnected()) {
      return;
    }
    if (!state.dirty && !options.force) {
      return;
    }
    try {
      if (state.isDoc) {
        const doc = state.target as LoroDoc;
        const from = state.serverVersion ?? new VersionVector(null);
        const delta = doc.export({ mode: 'update', from });
        if (delta.length === 0) {
          state.dirty = false;
          this.resolveSyncedWaiters(state);
          return;
        }
        const dataBase64 = bytesToBase64(delta);
        const haveVersion = bytesToBase64(doc.oplogVersion().encode());
        if (dataBase64.length > this.maxPayloadBytes) {
          // Sender-side frame discipline: never write one oversized frame.
          // Slice into `doc-update-chunk` frames the server reassembles before
          // one import (realistic when a long offline run reconciles at join).
          // A send failure mid-transfer keeps the room dirty; the retry flush
          // starts a fresh transferId, which supersedes the server's partial.
          for (const payload of buildDocUpdateChunkPayloads(
            dataBase64,
            this.maxPayloadBytes,
            createDocUpdateTransferId()
          )) {
            this.connection.send({
              type: 'update',
              protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
              workspaceId: this.workspaceId,
              peerId: this.peerId,
              room: state.room,
              haveVersion,
              payload,
            });
          }
        } else {
          this.connection.send({
            type: 'update',
            protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
            workspaceId: this.workspaceId,
            peerId: this.peerId,
            room: state.room,
            haveVersion,
            payload: { kind: 'doc-update', dataBase64 },
          });
        }
        // The server now has at least everything we hold, so advance our
        // baseline to avoid re-sending these ops on the next local edit.
        state.serverVersion = doc.oplogVersion();
        state.dirty = false;
        this.resolveSyncedWaiters(state);
        return;
      }
      this.flushLocalFlock(state);
    } catch {
      // Stay dirty; a reconnect (or the next local edit) retries.
      this.setRoomStatus(state, 'reconnecting');
    }
  }

  private flushLocalFlock(state: RoomState): void {
    // Serialize passes; the queued latch folds a burst of local changes into
    // one export that observes them all.
    if (state.flockFlushQueued) {
      return;
    }
    state.flockFlushQueued = true;
    state.flockFlushChain = state.flockFlushChain
      .then(() => {
        state.flockFlushQueued = false;
        return this.flushLocalFlockOnce(state);
      })
      .catch(() => {
        // Stay dirty; a reconnect (or the next local edit) retries.
        this.setRoomStatus(state, 'reconnecting');
      });
  }

  private async flushLocalFlockOnce(state: RoomState): Promise<void> {
    const flock = state.target as FlockLike;
    const syncGeneration = state.syncGeneration;
    // Capture the frontier BEFORE exporting: entries landing in between are
    // re-sent by the next pass (idempotent) instead of silently skipped.
    const have = flock.version();
    const from = state.serverFlockVersion ?? {};
    const bundle = await flock.exportJson(from);
    if (
      state.closed ||
      state.terminalError ||
      !state.joined ||
      !this.connection.isConnected() ||
      state.syncGeneration !== syncGeneration
    ) {
      return;
    }
    if (isEmptyFlockBundle(bundle)) {
      state.serverFlockVersion = mergeFlockVersions(from, have);
      state.dirty = false;
      this.resolveSyncedWaiters(state);
      return;
    }
    const chunks = chunkFlockBundle(bundle, this.maxPayloadBytes);
    if (!chunks) {
      // A single flock ENTRY above the frame budget — pathological; chunking
      // handles every realistic oversize without failing the room.
      this.markTerminal(state, LOCAL_LORO_DATA_PLANE_PAYLOAD_TOO_LARGE);
      return;
    }
    const haveVersion = encodeFlockVersion(have);
    for (const chunk of chunks) {
      this.connection.send({
        type: 'update',
        protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
        workspaceId: this.workspaceId,
        peerId: this.peerId,
        room: state.room,
        haveVersion,
        payload: { kind: 'flock-json', bundle: chunk },
      });
    }
    state.serverFlockVersion = mergeFlockVersions(from, have);
    state.dirty = false;
    this.resolveSyncedWaiters(state);
  }

  private handleServerMessage(message: LocalLoroDataPlaneServerMessage): void {
    if (message.type === 'pong') {
      // Connection liveness is the relay's concern, not the adapter's.
      return;
    }
    if (message.type === 'presence' || message.type === 'machine-monitor') {
      // Workspace-level ephemeral state is consumed by the runtime layer, not
      // the repo transport; ignore it here.
      return;
    }
    // The connection is a broadcast pipe (every window sees every frame):
    // anything not addressed to this workspace + peer is someone else's.
    if (message.workspaceId !== undefined && message.workspaceId !== this.workspaceId) {
      return;
    }
    if (message.peerId !== undefined && message.peerId !== this.peerId) {
      return;
    }
    if (message.type === 'error') {
      this.handleServerError(message);
      return;
    }
    if (message.type === 'room-status') {
      const state = this.rooms.get(roomKey(message.room));
      if (!state || state.closed || !sameRoom(state.room, message.room)) {
        return;
      }
      // A terminally-failed room is cleared only by an explicit
      // `subscription.rejoin()` (R4). Applying a server push here would
      // downgrade its `error` to whatever was pushed and quietly re-enter it
      // into the reconnect loops that R4 excludes it from.
      if (state.terminalError) {
        return;
      }
      this.setRoomStatus(state, message.status);
      if (message.status === 'joined') {
        this.resolveSyncedWaiters(state);
        return;
      }
      // A server-pushed TERMINAL status means this one room is gone and must be
      // re-established (today the only publisher is the CLI's
      // `invalidateDocRoom`, after the repo evicted the room's doc). Repair it
      // here, room-scoped.
      //
      // The alternative was to leave it to the workspace reconnect loop, which
      // is what a terminal status would otherwise reach via
      // `needsReconnect()`. That makes one dead room cost a workspace-wide
      // reconcile: it releases every idle document store and rejoins EVERY
      // local room, and charges a backoff step forgiven only after 30s of
      // health. A session being GC'd is routine, so that would ratchet local
      // reconnect latency for the whole workspace.
      //
      // NOTE the consequence, because a previous version of this comment got it
      // wrong: `sendJoin` below sets a non-terminal status in this same
      // synchronous block, so the workspace loop NEVER observes the terminal
      // status and is NOT a backstop here. If the rejoin frame is lost — the
      // relay drops client frames silently while the renderer still reports
      // connected — this room stays stale until the next
      // `handleConnectionStatus(true)` edge rejoins everything. That is the
      // same recovery contract every other frame this transport sends already
      // has (see the F5b regression case), not a gap introduced here.
      if (message.status === 'disconnected' || message.status === 'error') {
        this.rejoinRoom(state);
      }
      return;
    }
    if (message.type === 'joined') {
      // `peerId` was already required to match above; requestId + room pin the
      // exact join this answers.
      const state = this.findByPendingJoin(message.requestId);
      if (!state || !sameRoom(state.room, message.room)) {
        return;
      }
      this.handleJoined(state, message.serverVersion, message.payload);
      return;
    }
    // type === 'update'
    const state = this.rooms.get(roomKey(message.room));
    if (!state || state.closed || !sameRoom(state.room, message.room)) {
      return;
    }
    if (state.isDoc && message.serverVersion) {
      state.serverVersion = VersionVector.decode(base64ToBytes(message.serverVersion));
    } else if (!state.isDoc && message.serverVersion) {
      // The server already holds everything under the frontier it pushed with
      // this delta — advance our up-sync baseline so we never re-upload it.
      state.serverFlockVersion = mergeFlockVersions(
        state.serverFlockVersion ?? {},
        decodeFlockVersion(message.serverVersion)
      );
    }
    this.applyPayload(state, message.payload);
  }

  private handleJoined(
    state: RoomState,
    serverVersion: string | undefined,
    payload: LocalLoroDataPlanePayload | undefined
  ): void {
    state.pendingJoinRequestId = null;
    state.joined = true;
    // A (re)join restarts the catch-up stream; a partial chunk transfer from
    // before must never be concatenated with post-join frames.
    state.docChunkAssembler = null;
    if (state.isDoc) {
      if (serverVersion) {
        state.serverVersion = VersionVector.decode(base64ToBytes(serverVersion));
      }
      if (payload) {
        this.applyPayload(state, payload);
      }
      this.setRoomStatus(state, 'joined');
      state.firstSynced.resolve();
      // Join is the reconciliation point: up-sync whatever the server is
      // missing relative to its returned version — regardless of `dirty`, so
      // offline writes from a previous process run (or frames the relay
      // silently dropped) are recovered here (F5).
      this.flushLocal(state, { force: true });
      return;
    }
    // A join reply is the authoritative up-sync baseline. Replace the prior
    // optimistic frontier: a local send may have been silently dropped after
    // we advanced it, so merge-only would keep claiming the server has entries
    // it never received (notably lastCanceledTurn).
    state.serverFlockVersion = serverVersion ? decodeFlockVersion(serverVersion) : {};
    const receivedBundle = payload && payload.kind === 'flock-json' ? payload.bundle : undefined;
    const syncGeneration = state.syncGeneration;
    void this.reconcileFlockAfterJoin(state, receivedBundle, syncGeneration)
      .catch(() => {
        if (state.syncGeneration === syncGeneration && state.joined) {
          this.setRoomStatus(state, 'reconnecting');
        }
      })
      .finally(() => {
        if (
          state.closed ||
          state.syncGeneration !== syncGeneration ||
          !state.joined ||
          !this.connection.isConnected()
        ) {
          return;
        }
        if (!state.terminalError) {
          this.setRoomStatus(state, 'joined');
        }
        state.firstSynced.resolve();
      });
  }

  private async reconcileFlockAfterJoin(
    state: RoomState,
    receivedBundle: unknown,
    syncGeneration: number
  ): Promise<void> {
    const flock = state.target as FlockLike;
    if (receivedBundle !== undefined) {
      await flock.importJson(receivedBundle);
      flock.commit?.();
    }
    if (
      state.closed ||
      state.syncGeneration !== syncGeneration ||
      !state.joined ||
      !this.connection.isConnected()
    ) {
      return;
    }
    // Mirror of the doc-room reconcile: export the delta the server is missing
    // relative to its returned frontier — regardless of the in-memory dirty
    // flag, so offline writes from a previous process run converge here (F5).
    // An empty delta costs nothing.
    this.flushLocalFlock(state);
  }

  private handleServerError(message: LocalLoroServerErrorMessage): void {
    const roomState = message.room ? this.rooms.get(roomKey(message.room)) : undefined;
    const pendingState = message.requestId ? this.findByPendingJoin(message.requestId) : undefined;
    const state = pendingState ?? roomState;
    if (!state) {
      return;
    }
    if (message.requestId && state.pendingJoinRequestId === message.requestId) {
      state.pendingJoinRequestId = null;
    }
    if (message.terminal) {
      this.markTerminal(state, message.code);
      return;
    }
    // Non-terminal (e.g. workspace runtime still bootstrapping): surface an
    // error status; the runtime's reconnect loop rejoins with backoff.
    this.setRoomStatus(state, 'error');
  }

  private markTerminal(state: RoomState, code: string): void {
    state.terminalError = code;
    this.setRoomStatus(state, 'error');
    // Never leave waiters hanging on a room that will not converge.
    state.firstSynced.resolve();
    this.resolveSyncedWaiters(state);
  }

  private applyPayload(state: RoomState, payload: LocalLoroDataPlanePayload | undefined): void {
    if (!payload) {
      return;
    }
    if (payload.kind === 'doc-update') {
      // Imports fire the local subscription with `by: 'import'`, which the
      // subscribe filter ignores, so applying a server push never bounces back.
      (state.target as LoroDoc).import(base64ToBytes(payload.dataBase64));
      return;
    }
    if (payload.kind === 'doc-update-chunk') {
      if (!state.isDoc) {
        return;
      }
      state.docChunkAssembler ??= new DocUpdateChunkAssembler();
      const dataBase64 = state.docChunkAssembler.push(payload);
      if (dataBase64 === null) {
        return;
      }
      state.docChunkAssembler = null;
      (state.target as LoroDoc).import(base64ToBytes(dataBase64));
      return;
    }
    const flock = state.target as FlockLike;
    void Promise.resolve(flock.importJson(payload.bundle)).then(() => flock.commit?.());
  }

  private handleConnectionStatus(connected: boolean): void {
    notify(this.statusListeners, this.getStatus());
    if (!connected) {
      for (const state of this.rooms.values()) {
        state.joined = false;
        // Frames of an in-flight chunked transfer are lost with the socket.
        state.docChunkAssembler = null;
        if (!state.terminalError) {
          this.setRoomStatus(state, 'reconnecting');
        }
      }
      return;
    }
    for (const state of this.rooms.values()) {
      if (state.terminalError) {
        continue;
      }
      this.rejoinRoom(state);
    }
  }

  private findByPendingJoin(requestId: string): RoomState | undefined {
    for (const state of this.rooms.values()) {
      if (state.pendingJoinRequestId === requestId) {
        return state;
      }
    }
    return undefined;
  }

  private subscriptionFor(state: RoomState): TransportSubscription {
    return {
      unsubscribe: () => {
        this.closeRoom(state);
        this.rooms.delete(roomKey(state.room));
        this.sendLeave(state.room);
      },
      get firstSyncedWithRemote() {
        return state.firstSynced.promise;
      },
      waitUntilSynced: async () => {
        if (state.terminalError || (!state.dirty && state.joined)) {
          return;
        }
        const waiter = createDeferred<void>();
        state.syncedWaiters.add(waiter);
        await waiter.promise;
      },
      rejoin: async () => {
        // The only path allowed to retry a terminal room (R4: explicit, not a
        // reconnect loop).
        state.terminalError = null;
        this.rejoinRoom(state);
      },
      get status() {
        return state.status;
      },
      onStatusChange: (listener) => {
        state.statusListeners.add(listener);
        listener(state.status);
        return () => state.statusListeners.delete(listener);
      },
    };
  }

  private resolveSyncedWaiters(state: RoomState): void {
    for (const waiter of state.syncedWaiters) {
      waiter.resolve();
    }
    state.syncedWaiters.clear();
  }

  private closeRoom(state: RoomState): void {
    state.closed = true;
    state.unsubscribeLocal();
    this.setRoomStatus(state, 'disconnected');
    this.resolveSyncedWaiters(state);
  }

  private setRoomStatus(state: RoomState, status: TransportRoomStatus): void {
    if (state.status === status) {
      return;
    }
    state.status = status;
    notify(state.statusListeners, status);
  }
}

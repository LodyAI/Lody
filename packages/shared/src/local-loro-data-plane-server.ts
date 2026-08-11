import { LoroDoc, VersionVector } from 'loro-crdt';
import type { TransportRoomStatus } from 'loro-repo';
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
  type FlockVersionVector,
  type LocalLoroDataPlaneClientMessage,
  type LocalLoroDataPlaneRoom,
  type LocalLoroDataPlaneServerMessage,
  type LocalLoroJoinMessage,
  type LocalLoroUpdateMessage,
} from './local-loro-data-plane';
import {
  createLocalLoroDataPlaneScheduler,
  type LocalLoroDataPlaneScheduler,
} from './local-loro-data-plane-scheduler';

/**
 * Flock-like CRDT (loro-repo Flock). Flock entries are self-contained LWW
 * records, so `exportJson(from)` deltas are independently importable — flock
 * rooms sync incrementally, exactly like doc rooms (per-peer version-vector
 * frontier), just with a JSON version-vector encoding.
 */
export type LocalLoroFlockLike = {
  exportJson(from: FlockVersionVector): unknown | Promise<unknown>;
  importJson(bundle: unknown): void | Promise<void>;
  /** Exclusive/visible flock version vector — the incremental-export baseline. */
  version(): FlockVersionVector;
  commit?: () => void;
  subscribe(listener: (batch: { source?: string }) => void): () => void;
};

/**
 * One connected transport link (a socket), as seen by the server engine. A
 * single connection can multiplex many peers: the Electron relay funnels every
 * renderer window through one daemon socket, so per-peer sync state is keyed by
 * peerId, never by connection id. The connection id only scopes teardown when
 * the socket itself dies.
 *
 * Flow control mirrors `net.Socket.write`: `send` always accepts the message;
 * returning `false` asks the engine to pause this connection's writer until
 * `onDrain` fires. A connection without `onDrain` (in-memory harnesses) never
 * exerts backpressure — a `false` return is ignored. This is what keeps a slow
 * consumer SLOW instead of DEAD: the engine stops exporting for it (deltas
 * coalesce against the per-peer frontier) rather than buffering unboundedly or
 * destroying the socket.
 */
export type LocalLoroDataPlaneServerConnection = {
  id: string;
  send: (message: LocalLoroDataPlaneServerMessage) => boolean | void;
  onDrain?: (listener: () => void) => () => void;
};

/**
 * Presence source for the local plane. Presence is one-way here (CLI →
 * renderer): the server pushes a snapshot to every connected client on change,
 * so local-first renderers get machine/session liveness without connecting to
 * the cloud presence stream. Snapshots are taken at WRITE time (latest-wins),
 * so a burst of presence changes against a slow connection collapses to one frame.
 *
 * INVARIANT: this plane carries LOCAL-ORIGIN presence only — the entries the
 * serving CLI process itself authors, never the remote peers its workspace-wide
 * presence replica also holds. The renderer merges by origin and treats this
 * snapshot as authoritative (`mergePresenceSnapshots`), so the obligation is in
 * both method names; the rationale is in `specs/local-first-two-plane.md`.
 */
export type LocalLoroPresenceSource = {
  encodeLocalOrigin: () => Uint8Array;
  subscribeLocalOrigin: (listener: () => void) => () => void;
};

/**
 * Device-resource source for the local plane. `encodeAll` is right here, and
 * the presence invariant above does not apply: the renderer routes device
 * resources per target machine rather than merging planes by origin, and this
 * channel is bidirectional (the renderer publishes observer leases through it),
 * so the whole store is genuinely shared state. Remote machines are addressed
 * through the cloud machine-monitor channel instead, never through this one.
 */
export type LocalLoroMachineMonitorSource = {
  encodeAll: () => Uint8Array;
  subscribe: (listener: () => void) => () => void;
  apply: (update: Uint8Array) => void;
};

export type LocalLoroDocRoomJoinHandler = (docId: string) => void | Promise<void>;
export type LocalLoroFlockRoomHandler = (flockDocId: string) => void | Promise<void>;

export type LocalLoroDataPlaneServerOptions = {
  workspaceId: string;
  resolveDoc: (docId: string) => Promise<LoroDoc>;
  resolveFlockDoc: (flockDocId: string) => Promise<LocalLoroFlockLike>;
  // The `meta` room is loro-repo's internal metaFlock (doc registry + per-doc
  // metadata), NOT a named flock doc — resolving it via `resolveFlockDoc('meta')`
  // would open a detached user flock, so renderer `upsertDocMeta` writes would
  // never reach the CLI's real metaFlock (and its doc-metadata live monitor /
  // dispatch watcher). When provided, the meta room is resolved through this
  // instead. Falls back to `resolveFlockDoc('meta')` when omitted (test harness).
  resolveMetaFlock?: () => Promise<LocalLoroFlockLike>;
  presenceSource?: LocalLoroPresenceSource | null;
  machineMonitorSource?: LocalLoroMachineMonitorSource | null;
  // Sender-side frame discipline (R4): a sync payload above this is never
  // written as one frame. Flock payloads are chunked entry-wise; doc payloads
  // are sliced into `doc-update-chunk` frames the peer reassembles before one
  // import. Only a single flock ENTRY above the budget is terminal.
  maxPayloadBytes?: number;
  onDocRoomJoin?: LocalLoroDocRoomJoinHandler;
  onFlockRoomJoin?: LocalLoroFlockRoomHandler;
  onFlockRoomLeave?: LocalLoroFlockRoomHandler;
  onError?: (error: unknown, context: string) => void;
  // Share one scheduler across workspace engines so no workspace's bulk export
  // can monopolize another workspace's local control path.
  scheduler?: LocalLoroDataPlaneScheduler;
};

type DocSubscriber = {
  peerId: string;
  connection: LocalLoroDataPlaneServerConnection;
  // The newest join requestId from this peer. A queued join-reply task whose
  // requestId no longer matches is superseded (the client only accepts the
  // reply matching its latest pending join); building it anyway would advance
  // `lastSentVV` for a reply the client discards, silently losing the catch-up.
  latestJoinRequestId: string;
  // Server's version vector the peer is known to have. Down-sync deltas are
  // exported from here AT WRITE TIME (not at change time), so however long a
  // slow connection stays blocked, it costs one coalesced delta — never a
  // queue of stale frames. Advanced to the doc's version captured before each
  // export, and set to the peer's `haveVersion` when the peer sends an update
  // (so a peer's own ops are never echoed back to it).
  lastSentVV: VersionVector;
};

type FlockSubscriber = {
  peerId: string;
  connection: LocalLoroDataPlaneServerConnection;
  // See DocSubscriber.latestJoinRequestId.
  latestJoinRequestId: string;
  // Flock frontier the peer is known to hold — same write-time delta contract
  // as `lastSentVV`. Advanced by MERGE only (a frontier never regresses):
  // merged with the flock version captured before each export, and with the
  // peer's reported version when it uploads. Fail-open: a peer whose frontier
  // under-reports gets redundant-but-idempotent entries, never a starve.
  lastSentVersion: FlockVersionVector;
};

type DocRoomEntry = {
  scope: 'doc';
  room: LocalLoroDataPlaneRoom;
  doc: LoroDoc;
  unsubscribe: () => void;
  subscribers: Map<string, DocSubscriber>;
  // Per-peer reassembly of chunked doc-update uploads. Entries are dropped
  // when the peer leaves/disconnects, when a plain `doc-update` supersedes a
  // partial transfer, and with the room itself.
  uploadAssemblers: Map<string, DocUpdateChunkAssembler>;
};

type FlockRoomEntry = {
  scope: 'flock';
  room: LocalLoroDataPlaneRoom;
  flock: LocalLoroFlockLike;
  unsubscribe: () => void;
  subscribers: Map<string, FlockSubscriber>;
};

type RoomEntry = DocRoomEntry | FlockRoomEntry;

// Writer work items. Sync payloads are deliberately NOT materialized here:
// a task names (room, peer) and the export happens when the connection is
// writable, against the frontier as it is THEN. That single property is the
// engine's flow control — outbound memory is bounded by one in-flight frame
// per connection, and bursts coalesce for free.
type WriterTask =
  | { kind: 'message'; message: LocalLoroDataPlaneServerMessage }
  | { kind: 'join-reply'; roomKey: string; peerId: string; requestId: string }
  | { kind: 'sync'; roomKey: string; peerId: string }
  | { kind: 'presence' }
  | { kind: 'machine-monitor' };

type ConnectionWriter = {
  connection: LocalLoroDataPlaneServerConnection;
  queue: WriterTask[];
  // Dedup for queued sync tasks (roomKey + peerId): a room that changes 100
  // times while queued still costs one task — the write-time export sees all
  // 100 changes at once.
  queuedSyncKeys: Set<string>;
  presenceQueued: boolean;
  machineMonitorQueued: boolean;
  // Frames built by the current task but not yet written (a chunked flock
  // delta blocked mid-chunk resumes here before the next task runs).
  pendingFrames: LocalLoroDataPlaneServerMessage[];
  pumping: boolean;
  pumpScheduled: boolean;
  cancelScheduledPump: (() => void) | null;
  blocked: boolean;
  unsubscribeDrain: (() => void) | null;
};

function syncTaskKey(key: string, peerId: string): string {
  return `${key}\n${peerId}`;
}

/**
 * Transport-agnostic server half of the local Loro data plane. It holds one
 * entry per room (shared across all peers), subscribes to the underlying CRDT
 * once, and syncs each subscribed PEER incrementally from its own frontier
 * (per-peer `lastSentVV` / `lastSentVersion`), so sibling windows multiplexed
 * over the same relay socket sync independently and a sender's own ops are
 * never echoed.
 *
 * Scheduling is PULL-based: CRDT subscriptions only mark (room, peer) dirty;
 * a per-connection writer exports and frames deltas when the connection can
 * accept them (`send` → boolean + `onDrain`, mirroring `net.Socket.write`).
 * There is no eager per-change export, no broadcast chain, and no
 * slow-consumer disconnect: backpressure propagates to the export step itself.
 * The engine performs no I/O — the CLI socket server (and the in-memory test
 * harness) drive it via `handleMessage`.
 */
export class LocalLoroDataPlaneServer {
  private readonly rooms = new Map<string, RoomEntry>();
  // `null` resolves mean the build was superseded by an invalidation; retry.
  private readonly resolveInFlight = new Map<string, Promise<RoomEntry | null>>();
  // Per room key, bumped by `invalidateDocRoom`, so a room build already in
  // flight can discover that the doc it resolved has since been evicted.
  private readonly roomGenerations = new Map<string, number>();
  // Every connected client receives workspace presence pushes.
  private readonly presenceReceivers = new Map<string, LocalLoroDataPlaneServerConnection>();
  private readonly machineMonitorReceivers = new Map<string, LocalLoroDataPlaneServerConnection>();
  private readonly writers = new Map<string, ConnectionWriter>();
  private presenceUnsubscribe: (() => void) | null = null;
  private machineMonitorUnsubscribe: (() => void) | null = null;
  private docRoomJoinHandler: LocalLoroDocRoomJoinHandler | null = null;
  private flockRoomJoinHandler: LocalLoroFlockRoomHandler | null = null;
  private flockRoomLeaveHandler: LocalLoroFlockRoomHandler | null = null;
  private readonly scheduler: LocalLoroDataPlaneScheduler;
  private disposed = false;

  constructor(private readonly options: LocalLoroDataPlaneServerOptions) {
    this.scheduler = options.scheduler ?? createLocalLoroDataPlaneScheduler();
    this.docRoomJoinHandler = options.onDocRoomJoin ?? null;
    this.flockRoomJoinHandler = options.onFlockRoomJoin ?? null;
    this.flockRoomLeaveHandler = options.onFlockRoomLeave ?? null;
    if (options.presenceSource) {
      this.presenceUnsubscribe = options.presenceSource.subscribeLocalOrigin(() =>
        this.broadcastPresence()
      );
    }
    if (options.machineMonitorSource) {
      this.machineMonitorUnsubscribe = options.machineMonitorSource.subscribe(() =>
        this.broadcastMachineMonitor()
      );
    }
  }

  setDocRoomJoinHandler(handler: LocalLoroDocRoomJoinHandler | null): void {
    this.docRoomJoinHandler = handler;
  }

  setFlockRoomJoinHandler(handler: LocalLoroFlockRoomHandler | null): void {
    this.flockRoomJoinHandler = handler;
  }

  setFlockRoomLeaveHandler(handler: LocalLoroFlockRoomHandler | null): void {
    this.flockRoomLeaveHandler = handler;
  }

  publishRoomStatus(room: LocalLoroDataPlaneRoom, status: TransportRoomStatus): void {
    const entry = this.rooms.get(roomKey(room));
    if (!entry) {
      return;
    }
    for (const subscriber of entry.subscribers.values()) {
      this.enqueueMessage(subscriber.connection, {
        type: 'room-status',
        protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
        workspaceId: this.options.workspaceId,
        peerId: subscriber.peerId,
        room,
        status,
      });
    }
  }

  /**
   * Drop the cached room for `docId` because its underlying LoroDoc instance is
   * no longer the repo's.
   *
   * A doc room resolves its `LoroDoc` ONCE (`buildDocRoom`) and holds it for as
   * long as the room has subscribers. `repo.unloadDoc(docId)` evicts that
   * instance from the repo's cache, so the next `openPersistedDoc` returns a
   * DIFFERENT object — and the room keeps importing/exporting against the
   * orphan: renderer uploads vanish, CLI writes stop being pushed, and nothing
   * errors (the room stays `joined`, and relay pings never touch this path).
   * Re-joining does not repair it either, because `ensureRoom` returns the
   * cached entry.
   *
   * The caller must invoke this AFTER the unload completes, so a racing join
   * cannot re-open the doc into the repo cache just before it is evicted.
   * Updates that land in the window are not lost: peers reconcile against the
   * server version on (re)join and re-upload whatever the server is missing.
   */
  invalidateDocRoom(docId: string): void {
    const room: LocalLoroDataPlaneRoom = { scope: 'doc', docId };
    const key = roomKey(room);
    // Bump FIRST and unconditionally, ahead of the `this.rooms` lookup: a room
    // build racing this eviction has not installed its entry yet, so the lookup
    // would miss it and return having published nothing. The generation is what
    // lets that build discard itself instead of installing a room bound to the
    // instance the repo just dropped.
    this.roomGenerations.set(key, (this.roomGenerations.get(key) ?? 0) + 1);
    const entry = this.rooms.get(key);
    if (!entry || entry.scope !== 'doc') {
      return;
    }
    // Queued sync work names (room, peer) and is materialized at write time, so
    // a task left over from the old room would export against the REBUILT one
    // and could emit an `update` ahead of its `joined` reply, breaking the FIFO
    // ordering `enqueueJoinReply` relies on.
    this.dropQueuedRoomWork(key);
    // Publish before dropping the entry: `publishRoomStatus` reads the room's
    // subscribers, and outbound recovery depends entirely on the peer rejoining
    // — once the entry is gone there is no subscriber left to mark dirty, so a
    // renderer that is only READING the session would stay stale forever.
    //
    // `disconnected` and not `reconnecting`: only `disconnected`/`error` are
    // terminal in `createRoomSyncTracker.needsReconnect()`, and that predicate
    // is what `roomSyncRegistry.anyNeedsReconnect()` — hence the renderer's
    // local reconnect loop — gates on. A `reconnecting` status reads as
    // "already recovering" and the loop would never fire. `disconnected` is
    // also the honest description: the server dropped this room and the peer
    // must re-join to get another one.
    this.publishRoomStatus(room, 'disconnected');
    entry.unsubscribe();
    entry.subscribers.clear();
    entry.uploadAssemblers.clear();
    this.rooms.delete(key);
  }

  /** Forget queued writer work naming a room that no longer exists. */
  private dropQueuedRoomWork(key: string): void {
    for (const writer of this.writers.values()) {
      writer.queue = writer.queue.filter(
        (task) => !((task.kind === 'sync' || task.kind === 'join-reply') && task.roomKey === key)
      );
      for (const taskKey of [...writer.queuedSyncKeys]) {
        if (taskKey.startsWith(`${key}\n`)) {
          writer.queuedSyncKeys.delete(taskKey);
        }
      }
    }
  }

  private get maxPayloadBytes(): number {
    return this.options.maxPayloadBytes ?? LOCAL_LORO_DATA_PLANE_MAX_PAYLOAD_BYTES;
  }

  async handleMessage(
    connection: LocalLoroDataPlaneServerConnection,
    message: Exclude<LocalLoroDataPlaneClientMessage, { type: 'ping' }>
  ): Promise<void> {
    if (this.disposed) {
      this.sendError(connection, {
        code: 'workspace_runtime_unavailable',
        peerId: message.peerId,
        requestId: message.type === 'join' ? message.requestId : undefined,
      });
      return;
    }
    if (message.workspaceId !== this.options.workspaceId) {
      this.sendError(connection, {
        code: 'workspace_mismatch',
        peerId: message.peerId,
        requestId: message.type === 'join' ? message.requestId : undefined,
      });
      return;
    }
    try {
      // Any message from a connection registers it as a presence receiver and
      // gets the current presence snapshot (presence is workspace-level, not
      // per-room).
      this.registerPresenceReceiver(connection);
      switch (message.type) {
        case 'join':
          await this.handleJoin(connection, message);
          return;
        case 'update':
          await this.handleUpdate(connection, message);
          return;
        case 'leave':
          this.unsubscribePeer(message.peerId, roomKey(message.room));
          return;
        case 'detach':
          this.detachPeer(message.peerId);
          return;
        case 'machine-monitor':
          this.registerMachineMonitorReceiver(connection);
          this.options.machineMonitorSource?.apply(base64ToBytes(message.dataBase64));
          return;
      }
    } catch (error) {
      this.options.onError?.(error, `handleMessage:${message.type}`);
      this.sendError(connection, {
        code: 'data_plane_error',
        message: errorMessage(error),
        peerId: message.peerId,
        requestId: message.type === 'join' ? message.requestId : undefined,
        room: 'room' in message ? message.room : undefined,
      });
    }
  }

  private registerPresenceReceiver(connection: LocalLoroDataPlaneServerConnection): void {
    if (!this.options.presenceSource || this.presenceReceivers.has(connection.id)) {
      return;
    }
    this.presenceReceivers.set(connection.id, connection);
    this.enqueuePresence(connection);
  }

  private broadcastPresence(): void {
    if (this.disposed) {
      return;
    }
    for (const connection of this.presenceReceivers.values()) {
      this.enqueuePresence(connection);
    }
  }

  private registerMachineMonitorReceiver(connection: LocalLoroDataPlaneServerConnection): void {
    if (!this.options.machineMonitorSource || this.machineMonitorReceivers.has(connection.id)) {
      return;
    }
    this.machineMonitorReceivers.set(connection.id, connection);
    this.enqueueMachineMonitor(connection);
  }

  private broadcastMachineMonitor(): void {
    if (this.disposed) return;
    for (const connection of this.machineMonitorReceivers.values()) {
      this.enqueueMachineMonitor(connection);
    }
  }

  /**
   * Tear the engine down (workspace runtime stopping): releases the presence
   * subscription AND every room's CRDT subscription, so a stale engine can never
   * keep pushing from a destroyed repo.
   */
  dispose(): void {
    this.disposed = true;
    this.presenceUnsubscribe?.();
    this.presenceUnsubscribe = null;
    this.machineMonitorUnsubscribe?.();
    this.machineMonitorUnsubscribe = null;
    this.presenceReceivers.clear();
    this.machineMonitorReceivers.clear();
    for (const entry of this.rooms.values()) {
      entry.unsubscribe();
      this.notifyFlockRoomLeave(entry.room);
      entry.subscribers.clear();
    }
    this.rooms.clear();
    this.roomGenerations.clear();
    for (const writer of this.writers.values()) {
      this.cancelScheduledDataPump(writer);
      writer.unsubscribeDrain?.();
      writer.queue.length = 0;
      writer.pendingFrames.length = 0;
    }
    this.writers.clear();
  }

  /** Drop everything scoped to a dead socket (all peers it multiplexed). */
  handleDisconnect(connectionId: string): void {
    this.presenceReceivers.delete(connectionId);
    this.machineMonitorReceivers.delete(connectionId);
    const writer = this.writers.get(connectionId);
    if (writer) {
      this.cancelScheduledDataPump(writer);
      writer.unsubscribeDrain?.();
      writer.queue.length = 0;
      writer.pendingFrames.length = 0;
      this.writers.delete(connectionId);
    }
    for (const key of [...this.rooms.keys()]) {
      const entry = this.rooms.get(key);
      if (!entry) {
        continue;
      }
      for (const [peerId, subscriber] of [...entry.subscribers]) {
        if (subscriber.connection.id === connectionId) {
          entry.subscribers.delete(peerId);
          if (entry.scope === 'doc') {
            entry.uploadAssemblers.delete(peerId);
          }
        }
      }
      this.releaseRoomIfEmpty(key, entry);
    }
  }

  /** Drop every subscription held by one peer (adapter close / dead window). */
  private detachPeer(peerId: string): void {
    for (const key of [...this.rooms.keys()]) {
      this.unsubscribePeer(peerId, key);
    }
  }

  private async handleJoin(
    connection: LocalLoroDataPlaneServerConnection,
    message: LocalLoroJoinMessage
  ): Promise<void> {
    const key = roomKey(message.room);
    for (;;) {
      const entry = await this.ensureRoom(message.room);
      // The liveness check and the registration below MUST stay in one
      // synchronous block. `ensureRoom`'s generation check only covers the
      // window before the entry is installed, and every `await` after it —
      // including returning from a helper — reopens the window. Registering on
      // an invalidated entry is worse than the bug this class fixes:
      // `buildJoinReplyFrames` would find no room and emit nothing, parking the
      // client on `connecting` forever, which is not terminal and so never
      // wakes the renderer's reconnect loop.
      if (this.rooms.get(key) !== entry) {
        continue;
      }
      // Register inbound (serialized with leave/detach on this connection), then
      // let the writer build the catch-up reply when the connection is writable.
      // The reply task is FIFO-ordered before any sync task this registration can
      // produce, so `joined` always precedes the room's `update` frames.
      if (entry.scope === 'doc') {
        entry.subscribers.set(message.peerId, {
          peerId: message.peerId,
          connection,
          latestJoinRequestId: message.requestId,
          lastSentVV: decodeVersion(message.haveVersion),
        });
      } else {
        entry.subscribers.set(message.peerId, {
          peerId: message.peerId,
          connection,
          latestJoinRequestId: message.requestId,
          lastSentVersion: decodeFlockVersion(message.haveVersion),
        });
      }
      this.enqueueJoinReply(connection, key, message.peerId, message.requestId);
      if (message.room.scope === 'doc') {
        this.notifyDocRoomJoin(message.room.docId);
      } else if (message.room.scope === 'flock-doc') {
        this.notifyFlockRoomJoin(message.room.flockDocId);
      }
      return;
    }
  }

  private notifyDocRoomJoin(docId: string): void {
    if (!this.docRoomJoinHandler) {
      return;
    }
    void Promise.resolve(this.docRoomJoinHandler(docId)).catch((error) => {
      this.options.onError?.(error, 'onDocRoomJoin');
    });
  }

  private notifyFlockRoomJoin(flockDocId: string): void {
    if (!this.flockRoomJoinHandler) {
      return;
    }
    void Promise.resolve(this.flockRoomJoinHandler(flockDocId)).catch((error) => {
      this.options.onError?.(error, 'onFlockRoomJoin');
    });
  }

  private notifyFlockRoomLeave(room: LocalLoroDataPlaneRoom): void {
    if (room.scope !== 'flock-doc' || !this.flockRoomLeaveHandler) {
      return;
    }
    void Promise.resolve(this.flockRoomLeaveHandler(room.flockDocId)).catch((error) => {
      this.options.onError?.(error, 'onFlockRoomLeave');
    });
  }

  private async handleUpdate(
    connection: LocalLoroDataPlaneServerConnection,
    message: LocalLoroUpdateMessage
  ): Promise<void> {
    const key = roomKey(message.room);
    let entry = await this.ensureRoom(message.room);
    // Same one-synchronous-block requirement as `handleJoin`: an invalidation
    // landing after the entry was installed but before this resumes would make
    // the import below write into the doc the repo already evicted, on an entry
    // that is no longer subscribed — dead in both directions, silently.
    while (this.rooms.get(key) !== entry) {
      entry = await this.ensureRoom(message.room);
    }
    if (entry.scope === 'doc') {
      if (message.payload.kind === 'flock-json') {
        this.sendError(connection, {
          code: 'payload_kind_mismatch',
          message: 'expected doc-update',
          peerId: message.peerId,
          room: message.room,
        });
        return;
      }
      let dataBase64: string | null;
      if (message.payload.kind === 'doc-update') {
        // A plain update supersedes any stale partial chunk transfer from this
        // peer (e.g. a re-flush after a mid-transfer send failure).
        entry.uploadAssemblers.delete(message.peerId);
        dataBase64 = message.payload.dataBase64;
      } else {
        let assembler = entry.uploadAssemblers.get(message.peerId);
        if (!assembler) {
          assembler = new DocUpdateChunkAssembler();
          entry.uploadAssemblers.set(message.peerId, assembler);
        }
        dataBase64 = assembler.push(message.payload);
        if (dataBase64 === null) {
          return;
        }
        entry.uploadAssemblers.delete(message.peerId);
      }
      // Mark the sending peer as already holding everything up to its reported
      // version BEFORE the import-triggered subscription fires, so the change we
      // just received is never echoed straight back to it — while every OTHER
      // peer (including siblings on the same relay socket) still gets its delta.
      const subscriber = entry.subscribers.get(message.peerId);
      if (subscriber) {
        subscriber.lastSentVV = decodeVersion(message.haveVersion);
      }
      entry.doc.import(base64ToBytes(dataBase64));
      // The doc.subscribe handler marks the other subscribers dirty; their
      // writers export the delta when writable.
      return;
    }
    if (message.payload.kind !== 'flock-json') {
      this.sendError(connection, {
        code: 'payload_kind_mismatch',
        message: 'expected flock-json',
        peerId: message.peerId,
        room: message.room,
      });
      return;
    }
    // Advance the sender's frontier with what it reports holding, so the
    // import-triggered dirty pass exports (near-)nothing back to it. Merge, not
    // set: a flock frontier never regresses.
    const subscriber = entry.subscribers.get(message.peerId);
    if (subscriber) {
      subscriber.lastSentVersion = mergeFlockVersions(
        subscriber.lastSentVersion,
        decodeFlockVersion(message.haveVersion)
      );
    }
    // Dirty-marking is driven solely by the room's flock subscription: an import
    // that actually changes the flock fires it (source 'import'), and a no-op
    // import fires nothing — so subscribers are only synced on real change.
    await entry.flock.importJson(message.payload.bundle);
    entry.flock.commit?.();
  }

  private async ensureRoom(room: LocalLoroDataPlaneRoom): Promise<RoomEntry> {
    const key = roomKey(room);
    // Loops only when an invalidation lands while this call was resolving, and
    // every retry needs its own invalidation — so it cannot spin.
    for (;;) {
      const existing = this.rooms.get(key);
      if (existing) {
        return existing;
      }
      const inFlight = this.resolveInFlight.get(key);
      if (inFlight) {
        const shared = await inFlight;
        if (shared) {
          return shared;
        }
        continue;
      }
      // Captured BEFORE resolving. `resolveDoc` reads the repo's instance
      // cache, so a build that started before `invalidateDocRoom` bumped this
      // counter can be holding the very instance the repo then evicted.
      // Installing it would recreate the orphaned room that invalidation exists
      // to prevent — and silently, because that invalidation found no entry in
      // `this.rooms` and so published no status to trigger a rejoin.
      const generation = this.roomGenerations.get(key) ?? 0;
      const build = (async (): Promise<RoomEntry | null> => {
        const entry =
          room.scope === 'doc'
            ? await this.buildDocRoom(room, room.docId)
            : await this.buildFlockRoom(room, await this.resolveFlockForRoom(room));
        if (this.disposed) {
          entry.unsubscribe();
          throw new Error('data_plane_engine_disposed');
        }
        if ((this.roomGenerations.get(key) ?? 0) !== generation) {
          entry.unsubscribe();
          return null;
        }
        this.rooms.set(key, entry);
        return entry;
      })().finally(() => this.resolveInFlight.delete(key));
      this.resolveInFlight.set(key, build);
      const resolved = await build;
      if (resolved) {
        return resolved;
      }
    }
  }

  private async buildDocRoom(room: LocalLoroDataPlaneRoom, docId: string): Promise<DocRoomEntry> {
    const doc = await this.options.resolveDoc(docId);
    const entry: DocRoomEntry = {
      scope: 'doc',
      room,
      doc,
      unsubscribe: () => {},
      subscribers: new Map(),
      uploadAssemblers: new Map(),
    };
    entry.unsubscribe = doc.subscribe(() => this.markRoomDirty(entry));
    return entry;
  }

  private resolveFlockForRoom(room: LocalLoroDataPlaneRoom): Promise<LocalLoroFlockLike> {
    if (room.scope === 'flock-doc') {
      return this.options.resolveFlockDoc(room.flockDocId);
    }
    // scope === 'meta'
    return this.options.resolveMetaFlock
      ? this.options.resolveMetaFlock()
      : this.options.resolveFlockDoc('meta');
  }

  private async buildFlockRoom(
    room: LocalLoroDataPlaneRoom,
    flock: LocalLoroFlockLike
  ): Promise<FlockRoomEntry> {
    const entry: FlockRoomEntry = {
      scope: 'flock',
      room,
      flock,
      unsubscribe: () => {},
      subscribers: new Map(),
    };
    entry.unsubscribe = flock.subscribe(() => this.markRoomDirty(entry));
    return entry;
  }

  /**
   * A room changed: mark every subscriber dirty. No export happens here — the
   * per-connection writer exports from each peer's frontier when that
   * connection is writable, so a burst of N changes costs each peer ONE delta.
   */
  private markRoomDirty(entry: RoomEntry): void {
    if (this.disposed) {
      return;
    }
    const key = roomKey(entry.room);
    for (const subscriber of entry.subscribers.values()) {
      this.enqueueSync(subscriber.connection, key, subscriber.peerId);
    }
    this.releaseRoomIfEmpty(key, entry);
  }

  // ---- Per-connection writer ----

  private writerFor(connection: LocalLoroDataPlaneServerConnection): ConnectionWriter {
    const existing = this.writers.get(connection.id);
    if (existing) {
      return existing;
    }
    const writer: ConnectionWriter = {
      connection,
      queue: [],
      queuedSyncKeys: new Set(),
      presenceQueued: false,
      machineMonitorQueued: false,
      pendingFrames: [],
      pumping: false,
      pumpScheduled: false,
      cancelScheduledPump: null,
      blocked: false,
      unsubscribeDrain: null,
    };
    writer.unsubscribeDrain =
      connection.onDrain?.(() => {
        writer.blocked = false;
        this.scheduleDataPump(writer);
      }) ?? null;
    this.writers.set(connection.id, writer);
    return writer;
  }

  private enqueueMessage(
    connection: LocalLoroDataPlaneServerConnection,
    message: LocalLoroDataPlaneServerMessage
  ): void {
    const writer = this.writerFor(connection);
    writer.queue.push({ kind: 'message', message });
    this.scheduleDataPump(writer);
  }

  private enqueueJoinReply(
    connection: LocalLoroDataPlaneServerConnection,
    key: string,
    peerId: string,
    requestId: string
  ): void {
    const writer = this.writerFor(connection);
    writer.queue.push({ kind: 'join-reply', roomKey: key, peerId, requestId });
    this.scheduleDataPump(writer);
  }

  private enqueueSync(
    connection: LocalLoroDataPlaneServerConnection,
    key: string,
    peerId: string
  ): void {
    const writer = this.writerFor(connection);
    const taskKey = syncTaskKey(key, peerId);
    if (writer.queuedSyncKeys.has(taskKey)) {
      return;
    }
    writer.queuedSyncKeys.add(taskKey);
    writer.queue.push({ kind: 'sync', roomKey: key, peerId });
    this.scheduleDataPump(writer);
  }

  private enqueuePresence(connection: LocalLoroDataPlaneServerConnection): void {
    const writer = this.writerFor(connection);
    if (writer.presenceQueued) {
      return;
    }
    writer.presenceQueued = true;
    writer.queue.push({ kind: 'presence' });
    this.scheduleDataPump(writer);
  }

  private enqueueMachineMonitor(connection: LocalLoroDataPlaneServerConnection): void {
    const writer = this.writerFor(connection);
    if (writer.machineMonitorQueued) return;
    writer.machineMonitorQueued = true;
    writer.queue.push({ kind: 'machine-monitor' });
    this.scheduleDataPump(writer);
  }

  private isWriterActive(writer: ConnectionWriter): boolean {
    return !this.disposed && this.writers.get(writer.connection.id) === writer;
  }

  private cancelScheduledDataPump(writer: ConnectionWriter): void {
    writer.cancelScheduledPump?.();
    writer.cancelScheduledPump = null;
    writer.pumpScheduled = false;
  }

  private hasPendingDataWork(writer: ConnectionWriter): boolean {
    return writer.pendingFrames.length > 0 || writer.queue.length > 0;
  }

  private scheduleDataPump(writer: ConnectionWriter): void {
    if (
      !this.isWriterActive(writer) ||
      writer.blocked ||
      writer.pumping ||
      writer.pumpScheduled ||
      !this.hasPendingDataWork(writer)
    ) {
      return;
    }
    writer.pumpScheduled = true;
    writer.cancelScheduledPump = this.scheduler.scheduleDataWork(() => {
      writer.pumpScheduled = false;
      writer.cancelScheduledPump = null;
      return this.pumpWriter(writer).catch((error) => {
        this.options.onError?.(error, 'pumpWriter');
      });
    });
  }

  private async pumpWriter(writer: ConnectionWriter): Promise<void> {
    if (!this.isWriterActive(writer) || writer.pumping || writer.blocked) {
      return;
    }
    writer.pumping = true;
    try {
      // One already-materialized frame is one complete scheduling quantum.
      // Chunked catch-ups therefore yield between frames as well as exports.
      const pendingFrame = writer.pendingFrames.shift();
      if (pendingFrame) {
        this.writeFrame(writer, pendingFrame);
        return;
      }

      const task = writer.queue.shift();
      if (!task) {
        return;
      }
      if (task.kind === 'sync') {
        writer.queuedSyncKeys.delete(syncTaskKey(task.roomKey, task.peerId));
      } else if (task.kind === 'presence') {
        writer.presenceQueued = false;
      } else if (task.kind === 'machine-monitor') {
        writer.machineMonitorQueued = false;
      }
      try {
        const frames = await this.buildFrames(writer, task);
        if (!this.isWriterActive(writer)) return;
        writer.pendingFrames.push(...frames);
      } catch (error) {
        this.options.onError?.(error, `buildFrames:${task.kind}`);
      }

      if (!this.isWriterActive(writer) || writer.blocked) {
        return;
      }
      const firstFrame = writer.pendingFrames.shift();
      if (firstFrame) {
        this.writeFrame(writer, firstFrame);
      }
    } finally {
      writer.pumping = false;
      if (this.isWriterActive(writer)) {
        this.scheduleDataPump(writer);
      }
    }
  }

  private writeFrame(writer: ConnectionWriter, frame: LocalLoroDataPlaneServerMessage): void {
    const accepted = writer.connection.send(frame);
    // Only a connection that can signal drain may exert backpressure; ignoring
    // `false` otherwise keeps in-memory harness connections trivial.
    if (accepted === false && writer.unsubscribeDrain) {
      writer.blocked = true;
    }
  }

  /**
   * Materialize one writer task into frames. This is the ONLY place sync
   * payloads are exported, so exports always run against the peer's live
   * frontier — everything that changed while the task waited is one delta.
   */
  private async buildFrames(
    writer: ConnectionWriter,
    task: WriterTask
  ): Promise<LocalLoroDataPlaneServerMessage[]> {
    switch (task.kind) {
      case 'message':
        return [task.message];
      case 'presence': {
        const source = this.options.presenceSource;
        if (!source) {
          return [];
        }
        const encoded = source.encodeLocalOrigin();
        if (encoded.length === 0) {
          return [];
        }
        return [
          {
            type: 'presence',
            protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
            workspaceId: this.options.workspaceId,
            dataBase64: bytesToBase64(encoded),
          },
        ];
      }
      case 'machine-monitor': {
        const source = this.options.machineMonitorSource;
        if (!source) return [];
        const encoded = source.encodeAll();
        if (encoded.length === 0) return [];
        return [
          {
            type: 'machine-monitor',
            protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
            workspaceId: this.options.workspaceId,
            dataBase64: bytesToBase64(encoded),
          },
        ];
      }
      case 'join-reply':
        return await this.buildJoinReplyFrames(writer, task);
      case 'sync':
        return await this.buildSyncFrames(writer, task.roomKey, task.peerId, null);
    }
    const exhaustive: never = task;
    throw new Error(`Unsupported local data-plane writer task: ${String(exhaustive)}`);
  }

  private async buildJoinReplyFrames(
    writer: ConnectionWriter,
    task: { roomKey: string; peerId: string; requestId: string }
  ): Promise<LocalLoroDataPlaneServerMessage[]> {
    const entry = this.rooms.get(task.roomKey);
    if (!entry) {
      return [];
    }
    const subscriber = entry.subscribers.get(task.peerId);
    // Left/detached while queued, or superseded by a rejoin on another
    // connection — the newer connection's own join-reply answers it.
    if (!subscriber || subscriber.connection.id !== writer.connection.id) {
      return [];
    }
    // Superseded by a newer join on the SAME connection (e.g. a visibility-wake
    // force reconnect racing the relay's own rejoin). The client only accepts
    // the reply matching its latest pending requestId, so building this one
    // would advance the send frontier for a discarded reply.
    if (subscriber.latestJoinRequestId !== task.requestId) {
      return [];
    }
    return await this.buildSyncFrames(writer, task.roomKey, task.peerId, task.requestId);
  }

  /**
   * Export the peer's delta and frame it. With `joinRequestId` set the first
   * frame is the `joined` reply (carrying the catch-up payload when non-empty);
   * chunked flock catch-ups continue as ordinary `update` frames behind it.
   */
  private async buildSyncFrames(
    writer: ConnectionWriter,
    key: string,
    peerId: string,
    joinRequestId: string | null
  ): Promise<LocalLoroDataPlaneServerMessage[]> {
    const entry = this.rooms.get(key);
    if (!entry) {
      return [];
    }
    const subscriber = entry.subscribers.get(peerId);
    if (!subscriber || subscriber.connection.id !== writer.connection.id) {
      return [];
    }
    if (entry.scope === 'doc') {
      const docSubscriber = subscriber as DocSubscriber;
      // Capture BEFORE export: ops landing in between are re-sent next pass
      // (idempotent) instead of silently skipped.
      const serverVV = entry.doc.oplogVersion();
      const delta = entry.doc.export({ mode: 'update', from: docSubscriber.lastSentVV });
      const serverVersion = bytesToBase64(serverVV.encode());
      const dataBase64 = delta.length > 0 ? bytesToBase64(delta) : null;
      docSubscriber.lastSentVV = serverVV;
      if (dataBase64 && dataBase64.length > this.maxPayloadBytes) {
        // A Loro update blob is causally dependent, so it cannot be split into
        // independently importable pieces — but it CAN be sliced at the
        // transport layer: the peer reassembles `doc-update-chunk` frames (in
        // order on this connection) back into the full payload before one
        // import. A big session doc's first catch-up export is a realistic
        // oversize; this replaces the former terminal `payload_too_large`
        // room failure. On join the `joined` reply goes first (no payload) so
        // the client reconciles its up-sync against `serverVersion` while the
        // chunked catch-up streams in behind it.
        const chunkPayloads = buildDocUpdateChunkPayloads(
          dataBase64,
          this.maxPayloadBytes,
          createDocUpdateTransferId()
        );
        const frames: LocalLoroDataPlaneServerMessage[] = [];
        if (joinRequestId !== null) {
          frames.push({
            type: 'joined',
            protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
            workspaceId: this.options.workspaceId,
            peerId,
            requestId: joinRequestId,
            room: entry.room,
            serverVersion,
          });
        }
        for (const payload of chunkPayloads) {
          frames.push({
            type: 'update',
            protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
            workspaceId: this.options.workspaceId,
            peerId,
            room: entry.room,
            serverVersion,
            payload,
          });
        }
        return frames;
      }
      if (joinRequestId !== null) {
        return [
          {
            type: 'joined',
            protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
            workspaceId: this.options.workspaceId,
            peerId,
            requestId: joinRequestId,
            room: entry.room,
            serverVersion,
            ...(dataBase64 ? { payload: { kind: 'doc-update', dataBase64 } } : {}),
          },
        ];
      }
      if (!dataBase64) {
        return [];
      }
      return [
        {
          type: 'update',
          protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
          workspaceId: this.options.workspaceId,
          peerId,
          room: entry.room,
          serverVersion,
          payload: { kind: 'doc-update', dataBase64 },
        },
      ];
    }
    const flockSubscriber = subscriber as FlockSubscriber;
    // Same capture-before-export contract as docs, with merge-only advance.
    const have = entry.flock.version();
    const bundle = await entry.flock.exportJson(flockSubscriber.lastSentVersion);

    // exportJson may yield. A newer join can replace this subscriber while the
    // export is running, including on the same connection. Do not send the old
    // reply or advance a frontier for a response the client will discard.
    const currentEntry = this.rooms.get(key);
    const currentSubscriber =
      currentEntry?.scope === 'flock'
        ? (currentEntry.subscribers.get(peerId) as FlockSubscriber | undefined)
        : undefined;
    if (
      currentEntry !== entry ||
      currentSubscriber !== flockSubscriber ||
      currentSubscriber.connection.id !== writer.connection.id ||
      (joinRequestId !== null && currentSubscriber.latestJoinRequestId !== joinRequestId)
    ) {
      return [];
    }

    flockSubscriber.lastSentVersion = mergeFlockVersions(flockSubscriber.lastSentVersion, have);
    // Report the server's TRUE frontier, like the doc branch does with
    // `oplogVersion()`. `lastSentVersion` is per-peer down-sync bookkeeping
    // seeded from the peer's own `haveVersion`; echoing it back would claim the
    // server holds everything the client holds, poisoning the client's up-sync
    // baseline (`exportJson(from = serverVersion)` would then skip client-ahead
    // entries forever, e.g. after a dropped upload frame).
    const serverVersion = encodeFlockVersion(have);
    if (isEmptyFlockBundle(bundle)) {
      if (joinRequestId !== null) {
        return [
          {
            type: 'joined',
            protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
            workspaceId: this.options.workspaceId,
            peerId,
            requestId: joinRequestId,
            room: entry.room,
            serverVersion,
          },
        ];
      }
      return [];
    }
    const chunks = chunkFlockBundle(bundle, this.maxPayloadBytes);
    if (!chunks) {
      // A single flock ENTRY above the frame budget — pathological (chunking
      // already replaced every realistic oversize). Terminal, like docs.
      entry.subscribers.delete(peerId);
      this.releaseRoomIfEmpty(key, entry);
      return [this.payloadTooLargeError(peerId, entry.room, joinRequestId ?? undefined)];
    }
    const frames: LocalLoroDataPlaneServerMessage[] = [];
    for (const [index, chunk] of chunks.entries()) {
      if (joinRequestId !== null && index === 0) {
        frames.push({
          type: 'joined',
          protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
          workspaceId: this.options.workspaceId,
          peerId,
          requestId: joinRequestId,
          room: entry.room,
          serverVersion,
          payload: { kind: 'flock-json', bundle: chunk },
        });
        continue;
      }
      frames.push({
        type: 'update',
        protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
        workspaceId: this.options.workspaceId,
        peerId,
        room: entry.room,
        serverVersion,
        payload: { kind: 'flock-json', bundle: chunk },
      });
    }
    return frames;
  }

  private payloadTooLargeError(
    peerId: string,
    room: LocalLoroDataPlaneRoom,
    requestId?: string
  ): LocalLoroDataPlaneServerMessage {
    return {
      type: 'error',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      workspaceId: this.options.workspaceId,
      code: LOCAL_LORO_DATA_PLANE_PAYLOAD_TOO_LARGE,
      message: 'sync payload exceeds the local data-plane frame budget',
      peerId,
      room,
      ...(requestId ? { requestId } : {}),
      terminal: true,
    };
  }

  private unsubscribePeer(peerId: string, key: string): void {
    const entry = this.rooms.get(key);
    if (!entry) {
      return;
    }
    entry.subscribers.delete(peerId);
    if (entry.scope === 'doc') {
      entry.uploadAssemblers.delete(peerId);
    }
    this.releaseRoomIfEmpty(key, entry);
  }

  private releaseRoomIfEmpty(key: string, entry: RoomEntry): void {
    if (entry.subscribers.size > 0 || this.rooms.get(key) !== entry) {
      return;
    }
    entry.unsubscribe();
    this.rooms.delete(key);
    this.notifyFlockRoomLeave(entry.room);
  }

  private sendError(
    connection: LocalLoroDataPlaneServerConnection,
    error: {
      code: string;
      message?: string;
      peerId?: string;
      requestId?: string;
      room?: LocalLoroDataPlaneRoom;
      terminal?: boolean;
    }
  ): void {
    this.enqueueMessage(connection, {
      type: 'error',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      workspaceId: this.options.workspaceId,
      code: error.code,
      ...(error.message ? { message: error.message } : {}),
      ...(error.peerId ? { peerId: error.peerId } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.room ? { room: error.room } : {}),
      ...(error.terminal ? { terminal: true } : {}),
    });
  }
}

function decodeVersion(encoded: string | undefined): VersionVector {
  if (!encoded) {
    return new VersionVector(null);
  }
  return VersionVector.decode(base64ToBytes(encoded));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

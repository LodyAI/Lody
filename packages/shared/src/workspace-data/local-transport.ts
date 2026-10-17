import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Queue,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';
import { z } from 'zod';
import { VersionVector } from 'loro-crdt';
import {
  RepoClosed,
  RepoIOError,
  RepoResnapshotRequired,
  type NativeTransport,
  type NativeTransportRoom,
  type RepoError,
  type RoomReplica,
  type RoomState,
  type RoomStatus,
  type RoomTarget,
  type TransportStatus,
} from 'loro-repo/effect';
import type { NativeWorkspaceTransport } from './transport';
import type { LocalLoroDataPlaneConnection } from '../local-loro-data-plane';
import {
  base64ToBytes,
  bytesToBase64,
  buildDocUpdateChunkPayloads,
  chunkFlockBundle,
  createDocUpdateTransferId,
  decodeFlockVersion,
  DocUpdateChunkAssembler,
  encodeFlockVersion,
  isEmptyFlockBundle,
  LOCAL_LORO_DATA_PLANE_MAX_PAYLOAD_BYTES,
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  roomKey,
  sameRoom,
  type FlockVersionVector,
  type LocalLoroDataPlaneClientMessage,
  type LocalLoroDataPlanePayload,
  type LocalLoroDataPlaneRoom,
  type LocalLoroDataPlaneServerMessage,
} from '../local-loro-data-plane';

const flockBundle = z.object({
  version: z.number(),
  entries: z.record(
    z.string(),
    z.object({
      c: z.string(),
      d: z.json().optional(),
      m: z.record(z.string(), z.unknown()).optional(),
    })
  ),
});

const io = <A>(operation: string, run: () => A | PromiseLike<A>) =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: () => Promise.resolve(run()),
      catch: (failure) => new RepoIOError(operation, failure),
    })
  );
const toRoom = (target: RoomTarget): LocalLoroDataPlaneRoom =>
  target.kind === 'meta'
    ? { scope: 'meta' }
    : target.kind === 'doc'
      ? { scope: 'doc', docId: target.id }
      : { scope: 'flock-doc', flockDocId: target.id };
const coversFlock = (have: FlockVersionVector, need: FlockVersionVector) =>
  Object.entries(need).every(([peer, clock]) => {
    const value = have[peer];
    return (
      !clock ||
      (!!value &&
        (value.physicalTime > clock.physicalTime ||
          (value.physicalTime === clock.physicalTime &&
            value.logicalCounter >= clock.logicalCounter)))
    );
  });
type Receipt = {
  readonly done: Deferred.Deferred<'confirmed' | 'offline', RepoError>;
  readonly version: string;
};
type Event =
  | { readonly kind: 'message'; readonly message: LocalLoroDataPlaneServerMessage }
  | { readonly kind: 'connection'; readonly online: boolean }
  | { readonly kind: 'dirty' }
  | { readonly kind: 'refresh' }
  | { readonly kind: 'deadline'; readonly id: string }
  | { readonly kind: 'sync' };
type Member = {
  readonly room: LocalLoroDataPlaneRoom;
  readonly offer: (event: Event) => void;
  readonly needsRecovery: () => boolean;
  readonly reconnect: Effect.Effect<void>;
};

export type LocalWorkspaceTransportOptions = {
  readonly workspaceId: string;
  readonly peerId: string;
  readonly connection: LocalLoroDataPlaneConnection;
  readonly maxPayloadBytes?: number;
  readonly joinTimeoutMs?: number;
  readonly maxQueuedBytes?: number;
};

/** Native v7 protocol workers; the physical Electron connection is injected. */
export const makeLocalWorkspaceTransport = Effect.fnUntraced(function* (
  transportId: string,
  options: LocalWorkspaceTransportOptions
): Effect.fn.Return<NativeTransport, RepoError, Scope.Scope> {
  const members = new Map<string, Member>();
  const recoveries = yield* FiberMap.make<Member, void, never>();
  const transportStatus = yield* SubscriptionRef.make<TransportStatus>('offline');
  const connection = options.connection;
  const maxPayloadBytes = options.maxPayloadBytes ?? LOCAL_LORO_DATA_PLANE_MAX_PAYLOAD_BYTES;
  const deadline = options.joinTimeoutMs ?? 120_000;
  const maxQueuedBytes = options.maxQueuedBytes ?? 64 * 1024 * 1024;
  if (
    !Number.isFinite(deadline) ||
    deadline <= 0 ||
    !Number.isSafeInteger(maxPayloadBytes) ||
    maxPayloadBytes < 1 ||
    !Number.isSafeInteger(maxQueuedBytes) ||
    maxQueuedBytes < 1
  )
    return yield* Effect.fail(
      new RepoIOError('local configuration', new RangeError('Invalid local transport limits'))
    );
  let connected = false;
  let retired = false;
  const send = (message: LocalLoroDataPlaneClientMessage) =>
    Effect.try({
      try: () => connection.send(message),
      catch: (failure) => new RepoIOError('local send', failure),
    });
  const envelope = {
    protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
    workspaceId: options.workspaceId,
    peerId: options.peerId,
  } as const;
  const connect = Effect.gen(function* () {
    if (connected) return undefined;
    if (retired) return yield* Effect.fail(new RepoClosed());
    const events = yield* Queue.unbounded<boolean>();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const stopMessage = connection.onMessage((message) => {
          if (
            message.type === 'pong' ||
            message.type === 'presence' ||
            message.type === 'machine-monitor'
          )
            return;
          if (message.workspaceId !== undefined && message.workspaceId !== options.workspaceId)
            return;
          if (message.peerId !== undefined && message.peerId !== options.peerId) return;
          if (message.room) members.get(roomKey(message.room))?.offer({ kind: 'message', message });
          else if (message.type === 'error')
            for (const member of members.values()) member.offer({ kind: 'message', message });
        });
        const stopStatus = connection.onStatusChange((online) => Queue.offerUnsafe(events, online));
        return () => {
          stopStatus();
          stopMessage();
        };
      }),
      (stop) => Effect.sync(stop)
    );
    yield* Stream.fromQueue(events).pipe(
      Stream.runForEach((online) =>
        Effect.gen(function* () {
          if (retired) return;
          yield* SubscriptionRef.set(transportStatus, online ? 'online' : 'offline');
          for (const member of members.values()) {
            // Recovery may drain accepted I/O. Supervise one task per member
            // without holding up this connection's later status edges.
            if (online && member.needsRecovery())
              yield* FiberMap.run(recoveries, member, member.reconnect, { onlyIfMissing: true });
            else member.offer({ kind: 'connection', online });
          }
        })
      ),
      Effect.forkScoped
    );
    connected = true;
    yield* SubscriptionRef.set(transportStatus, connection.isConnected() ? 'online' : 'offline');
    return undefined;
  });
  const disconnect = Effect.gen(function* () {
    if (retired) return;
    retired = true;
    for (const member of members.values()) member.offer({ kind: 'connection', online: false });
    if (connection.isConnected()) yield* send({ type: 'detach', ...envelope });
    yield* SubscriptionRef.set(transportStatus, 'closed');
  });
  const join = Effect.fnUntraced(function* (
    target: RoomTarget,
    replica: RoomReplica
  ): Effect.fn.Return<NativeTransportRoom, RepoError, Scope.Scope> {
    if (!connected || retired) return yield* Effect.fail(new RepoClosed());
    const room = toRoom(target);
    const key = roomKey(room);
    if (members.has(key)) return yield* Effect.fail(new RepoIOError('local duplicate room', key));
    const makeQueue = () => Queue.make<Event, RepoError>({ capacity: 1024, strategy: 'dropping' });
    let queue = yield* makeQueue();
    const lifecycle = Semaphore.makeUnsafe(1);
    let worker: Fiber.Fiber<void> | undefined;
    const status = yield* SubscriptionRef.make<RoomStatus>('joining');
    const state = yield* SubscriptionRef.make<RoomState>({
      connection: 'joining',
      baseline: false,
      current: false,
      uploadPending: false,
      epoch: 0,
    });
    const scope = yield* Effect.scope;
    const receipts: Receipt[] = [];
    let overflow = false;
    let closed = false;
    let dirtyQueued = false;
    let serverVersion: string | undefined;
    let requested: { readonly id: string; readonly epoch: boolean } | undefined;
    let timer: Fiber.Fiber<void> | undefined;
    let deadlineId: string | undefined;
    let docChunks: DocUpdateChunkAssembler | undefined;
    let importComplete = true;
    let queuedBytes = 0;
    const eventBytes = (event: Event) =>
      event.kind === 'message' ? JSON.stringify(event.message).length * 2 : 0;
    const offer = (event: Event) => {
      if (closed || overflow) return;
      if (event.kind === 'dirty') {
        if (dirtyQueued) return;
        dirtyQueued = true;
      }
      const bytes = eventBytes(event);
      if (queuedBytes + bytes > maxQueuedBytes || !Queue.offerUnsafe(queue, event)) {
        overflow = true;
        Queue.failCauseUnsafe(queue, Cause.fail(new RepoResnapshotRequired(`local:${key}`)));
      } else queuedBytes += bytes;
    };
    const version = () =>
      replica.kind === 'doc'
        ? bytesToBase64(replica.lease.doc.oplogVersion().encode())
        : encodeFlockVersion(replica.lease.flock.version());
    const covers = (have: string | undefined, need: string) => {
      if (!have) return false;
      if (replica.kind !== 'doc')
        return coversFlock(decodeFlockVersion(have), decodeFlockVersion(need));
      const comparison = VersionVector.decode(base64ToBytes(have)).compare(
        VersionVector.decode(base64ToBytes(need))
      );
      return comparison === 0 || comparison === 1;
    };
    const change = (patch: Partial<RoomState>) =>
      SubscriptionRef.update(state, (previous) => ({ ...previous, ...patch }));
    const stopTimer = Effect.suspend(() =>
      timer ? Fiber.interrupt(timer).pipe(Effect.asVoid) : Effect.void
    );
    const settle = (error?: RepoError) =>
      Effect.sync(() => {
        for (const receipt of receipts.splice(0))
          Deferred.doneUnsafe(receipt.done, error ? Exit.fail(error) : Exit.succeed('offline'));
      });
    const close = Effect.gen(function* () {
      if (closed) return;
      closed = true;
      members.delete(key);
      if (worker) yield* Fiber.interrupt(worker);
      yield* stopTimer;
      yield* settle(new RepoClosed());
      Queue.shutdownUnsafe(queue);
      if (connection.isConnected())
        yield* send({ type: 'leave', ...envelope, room }).pipe(Effect.catch(() => Effect.void));
      yield* change({ connection: 'detached', current: false });
      yield* SubscriptionRef.set(status, 'detached');
    }).pipe(lifecycle.withPermits(1), Effect.uninterruptible);
    // Establish cleanup before installing callbacks or starting any worker.
    yield* Effect.addFinalizer(() => close.pipe(Effect.orDie));
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        replica.kind === 'doc'
          ? replica.lease.doc.subscribeLocalUpdates(() => offer({ kind: 'dirty' }))
          : replica.lease.flock.subscribe((batch) => {
              if (batch.source === 'local') offer({ kind: 'dirty' });
            })
      ),
      (stop) => Effect.sync(stop)
    );
    const beginJoin = (advanceEpoch: boolean) =>
      Effect.gen(function* () {
        if (!connection.isConnected()) {
          yield* change({ connection: 'offline', current: false });
          yield* SubscriptionRef.set(status, 'offline');
          yield* settle();
          return;
        }
        yield* stopTimer;
        const id = globalThis.crypto.randomUUID();
        requested = { id, epoch: advanceEpoch };
        deadlineId = id;
        if (advanceEpoch) {
          docChunks = undefined;
          yield* change({ connection: 'joining', current: false });
          yield* SubscriptionRef.set(status, 'joining');
        }
        timer = yield* Effect.sleep(deadline).pipe(
          Effect.andThen(Effect.sync(() => offer({ kind: 'deadline', id }))),
          Effect.forkIn(scope)
        );
        yield* send({ type: 'join', ...envelope, requestId: id, room, haveVersion: version() });
      });
    const flush = Effect.gen(function* () {
      if (
        !connection.isConnected() ||
        !serverVersion ||
        !(yield* SubscriptionRef.get(state)).current
      )
        return undefined;
      if (replica.kind === 'doc') {
        const doc = replica.lease.doc;
        const delta = doc.export({
          mode: 'update',
          from: VersionVector.decode(base64ToBytes(serverVersion)),
        });
        const dataBase64 = bytesToBase64(delta);
        // An empty Loro export can contain its binary header; equality is the actual fast path.
        if (covers(serverVersion, version())) return undefined;
        const payloads: LocalLoroDataPlanePayload[] =
          dataBase64.length > maxPayloadBytes
            ? buildDocUpdateChunkPayloads(dataBase64, maxPayloadBytes, createDocUpdateTransferId())
            : [{ kind: 'doc-update', dataBase64 }];
        const haveVersion = version();
        for (const payload of payloads)
          yield* send({ type: 'update', ...envelope, room, haveVersion, payload });
      } else {
        const haveVersion = version();
        const bundle = yield* io('local Flock export', () =>
          replica.lease.flock.exportJson(decodeFlockVersion(serverVersion))
        );
        if (isEmptyFlockBundle(bundle)) return undefined;
        const chunks = chunkFlockBundle(bundle, maxPayloadBytes);
        if (!chunks) return yield* Effect.fail(new RepoIOError('local payload too large', key));
        for (const chunk of chunks)
          yield* send({
            type: 'update',
            ...envelope,
            room,
            haveVersion,
            payload: { kind: 'flock-json', bundle: chunk },
          });
      }
      yield* change({ uploadPending: true });
      return undefined;
    });
    const apply = (payload?: LocalLoroDataPlanePayload) =>
      Effect.gen(function* () {
        if (!payload) return undefined;
        if (payload.kind === 'flock-json') {
          if (replica.kind === 'doc')
            return yield* Effect.fail(new RepoIOError('local payload kind', key));
          yield* io('local Flock import', () =>
            replica.lease.flock.importJson(flockBundle.parse(payload.bundle))
          );
          replica.lease.flock.commit();
        } else {
          if (replica.kind !== 'doc')
            return yield* Effect.fail(new RepoIOError('local payload kind', key));
          let bytes: string | null;
          if (payload.kind === 'doc-update-chunk') {
            docChunks ??= new DocUpdateChunkAssembler();
            bytes = docChunks.push(payload);
            if (bytes === null) {
              importComplete = false;
              return undefined;
            }
            docChunks = undefined;
          } else bytes = payload.dataBase64;
          const imported = yield* replica.lease.importUpdates([base64ToBytes(bytes)]);
          importComplete = imported.complete;
        }
        return undefined;
      });
    const complete = (advanceEpoch: boolean) =>
      Effect.gen(function* () {
        const caughtUp =
          importComplete && !docChunks && !!serverVersion && covers(version(), serverVersion);
        if (!caughtUp) return;
        yield* stopTimer;
        deadlineId = undefined;
        const previous = yield* SubscriptionRef.get(state);
        yield* change({
          baseline: true,
          current: true,
          connection: 'joined',
          epoch: previous.epoch + (advanceEpoch ? 1 : 0),
          uploadPending: !covers(serverVersion, version()),
        });
        yield* SubscriptionRef.set(status, 'synced');
        for (let index = receipts.length - 1; index >= 0; index--) {
          const receipt = receipts[index];
          if (receipt && covers(serverVersion, receipt.version)) {
            receipts.splice(index, 1);
            Deferred.doneUnsafe(receipt.done, Exit.succeed('confirmed'));
          }
        }
      });
    let awaitingCatchUpEpoch = false;
    const process = (event: Event) =>
      Effect.gen(function* () {
        if (closed) return undefined;
        if (overflow) return yield* Effect.fail(new RepoResnapshotRequired(`local:${key}`));
        switch (event.kind) {
          case 'sync':
            if (!connection.isConnected()) {
              yield* settle();
              return undefined;
            }
            yield* flush;
            if (!requested) yield* beginJoin(false);
            return undefined;
          case 'refresh':
            yield* beginJoin(true);
            return undefined;
          case 'connection':
            if (event.online) yield* beginJoin(true);
            else {
              requested = undefined;
              serverVersion = undefined;
              docChunks = undefined;
              yield* stopTimer;
              yield* change({ connection: 'offline', current: false });
              yield* SubscriptionRef.set(status, 'offline');
              yield* settle();
            }
            return undefined;
          case 'deadline':
            if (event.id === deadlineId) {
              requested = undefined;
              return yield* Effect.fail(new RepoIOError('local join deadline', key));
            }
            return undefined;
          case 'dirty':
            dirtyQueued = false;
            yield* change({ uploadPending: true });
            yield* flush;
            if (!requested && serverVersion) yield* beginJoin(false);
            return undefined;
          case 'message':
            break;
        }
        const message = event.message;
        if (message.type === 'error') {
          if (message.requestId && message.requestId !== requested?.id) return undefined;
          requested = undefined;
          return yield* Effect.fail(
            new RepoIOError('local room error', { code: message.code, terminal: message.terminal })
          );
        }
        if (message.type === 'room-status') {
          if (message.status === 'disconnected' || message.status === 'error')
            yield* beginJoin(true);
          return undefined;
        }
        if (message.type !== 'joined' && message.type !== 'update') return undefined;
        if (!sameRoom(room, message.room)) return undefined;
        if (message.type === 'joined') {
          if (message.requestId !== requested?.id) return undefined;
          awaitingCatchUpEpoch ||= requested.epoch;
          requested = undefined;
          serverVersion = message.serverVersion;
        } else if (message.serverVersion) serverVersion = message.serverVersion;
        yield* apply(message.payload);
        yield* complete(awaitingCatchUpEpoch);
        if ((yield* SubscriptionRef.get(state)).current) awaitingCatchUpEpoch = false;
        // A joined frontier acknowledges applied peer state, unlike an optimistic send.
        yield* flush;
        if (
          !requested &&
          (yield* SubscriptionRef.get(state)).current &&
          (receipts.length || (yield* SubscriptionRef.get(state)).uploadPending) &&
          !docChunks
        )
          yield* beginJoin(false);
        return undefined;
      });
    const failed = (cause: Cause.Cause<RepoError>) =>
      Effect.gen(function* () {
        if (Cause.hasInterruptsOnly(cause) || closed) return;
        yield* change({ connection: 'failed', current: false });
        yield* SubscriptionRef.set(status, 'failed');
        yield* settle(new RepoIOError('local protocol', cause));
      });
    const startWorker = (events: Queue.Queue<Event, RepoError>) =>
      Stream.fromQueue(events).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            queuedBytes -= eventBytes(event);
            yield* process(event).pipe(Effect.catchCause(failed));
          })
        ),
        Effect.catchCause(failed),
        Effect.forkIn(scope)
      );
    const reconnect = Effect.gen(function* () {
      if (closed || retired) return;
      if (overflow) {
        // The failed queue and consumer cannot accept refresh. Drain the old
        // producer before replacing protocol state, preserving the replica lease.
        if (worker) yield* Fiber.interrupt(worker);
        yield* stopTimer;
        yield* settle(new RepoResnapshotRequired(`local:${key}`));
        if (closed || retired) return;
        Queue.shutdownUnsafe(queue);
        queue = yield* makeQueue();
        queuedBytes = 0;
        dirtyQueued = false;
        requested = undefined;
        deadlineId = undefined;
        serverVersion = undefined;
        docChunks = undefined;
        importComplete = true;
        awaitingCatchUpEpoch = false;
        overflow = false;
        worker = yield* startWorker(queue);
      }
      if (!closed && !retired) offer({ kind: 'refresh' });
    }).pipe(lifecycle.withPermits(1), Effect.uninterruptible);
    members.set(key, { room, offer, reconnect, needsRecovery: () => overflow });
    worker = yield* startWorker(queue);
    offer({ kind: 'refresh' });
    return {
      state,
      status,
      close,
      sync: Effect.suspend(() => {
        if (closed || retired) return Effect.fail(new RepoClosed());
        if (overflow) return Effect.fail(new RepoResnapshotRequired(`local:${key}`));
        if (receipts.length >= 256)
          return Effect.fail(new RepoResnapshotRequired(`local receipts:${key}`));
        const done = Deferred.makeUnsafe<'confirmed' | 'offline', RepoError>();
        const receipt = { done, version: version() };
        // Register before enqueueing: overflow must also settle unconsumed waits.
        receipts.push(receipt);
        offer({ kind: 'sync' });
        return Deferred.await(done).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const index = receipts.indexOf(receipt);
              if (index !== -1) receipts.splice(index, 1);
            })
          )
        );
      }),
    };
  });
  return {
    id: transportId,
    authority: 'peer',
    status: transportStatus,
    connect,
    disconnect,
    join,
    reconnect: Effect.gen(function* () {
      yield* Effect.forEach(members.values(), (member) => member.reconnect, {
        concurrency: 'unbounded',
        discard: true,
      });
    }),
  };
});

export const localWorkspaceTransport = (
  options: LocalWorkspaceTransportOptions
): NativeWorkspaceTransport => ({
  kind: 'native-workspace-transport',
  make: (id) => makeLocalWorkspaceTransport(id, options),
});

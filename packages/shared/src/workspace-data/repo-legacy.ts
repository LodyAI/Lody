import { Cause, Effect, Exit, Option, Scope, Stream } from 'effect';
import {
  RepoClosed,
  RepoIOError,
  RepoUnsupported,
  RepoReleaseFailed,
  RepoSyncFailed,
  type DocLease,
  type FlockLease,
  type Repo,
  type MakeOptions,
  type RepoError,
  type RoomState,
  type RoomLease,
  type RoomTarget,
  type TransportLease,
} from 'loro-repo/effect';
import {
  RepoSyncError,
  RepoTransportError,
  StaleReplicaError,
  type LoroRepoOptions,
  type RepoRoomDescriptor,
  type RepoRoomSubscription,
  type RepoTransportRoomSubscription,
  type RepoTransportRoomStatus,
  type RepoSyncOptions,
  type RepoSyncReport,
  type RepoAttachmentReport,
  type RepoEventListener,
  type RepoEventFilter,
  type RepoWatchHandle,
  type ReplicaCheckpointTarget,
  type JsonObject,
  type RepoDocHandle,
  type RepoFlockDocHandle,
  type RepoDocLease,
  type RepoFlockDocLease,
  type ListDocQuery,
  type ListFlockDocQuery,
  type EvictDocOptions,
  type RepoReconnectOptions,
  type RepoTransportOptions,
  type RemoveTransportOptions,
} from 'loro-repo';
import type { RemoteCursorStore } from '@loro-dev/streams-crdt';
import type { DurableHealth } from '@loro-dev/streams-crdt/effect';
import type { NativeWorkspaceTransport, WorkspaceNativeTransport } from './transport';
export type { NativeWorkspaceTransport } from './transport';
import { make as makeWorkspaceRepo } from 'loro-repo/effect';
import { acquireWorkspaceScope, type WorkspaceOwnedScope } from './ownership';

/** Preserve typed failures and defects, including release retry owners. Never log this object. */
export class WorkspaceRepoLegacyFailure extends Error {
  constructor(readonly effectCause: Cause.Cause<unknown>) {
    super('Workspace Repo operation failed');
    this.name = 'WorkspaceRepoLegacyFailure';
  }
}
export const workspaceAcquisitionFailureLegacy = (
  error: unknown,
  cleanup: unknown,
  operation: string
) => new AggregateError([error, cleanup], `${operation} and release failed`, { cause: error });

/** Bound native failures become the existing safe diagnostic vocabulary only here. */
export const workspaceSyncFailuresLegacy = (
  error: unknown,
  TransportError = RepoTransportError
): readonly unknown[] => {
  if (error instanceof RepoSyncError)
    return error.report.transports.flatMap((route) =>
      route.failures.map((failure) => failure.error)
    );
  const reasons = (cause: Cause.Cause<unknown>) =>
    cause.reasons.flatMap((reason) =>
      Cause.isFailReason(reason) ? [reason.error] : Cause.isDieReason(reason) ? [reason.defect] : []
    );
  if (error instanceof WorkspaceRepoLegacyFailure) return reasons(error.effectCause);
  if (error instanceof RepoReleaseFailed) return reasons(error.fullCause);
  if (error instanceof RepoSyncFailed)
    return error.report.transports.flatMap((route) => (route.cause ? reasons(route.cause) : []));
  if (
    error instanceof RepoIOError &&
    error.operation === 'streams protocol' &&
    typeof error.failure === 'object' &&
    error.failure !== null &&
    'streamsCode' in error.failure
  ) {
    // Repo's native transport already validates this public projection. Never forward fullCause.
    const safe = error.failure as Pick<
      RepoTransportError,
      'streamsCode' | 'streamsContext' | 'failureKind' | 'retryable'
    >;
    return [
      new TransportError('Streams protocol failed', {
        code: 'internal',
        phase: 'sync',
        transportId: 'streams',
        retryable: safe.retryable,
        streamsCode: safe.streamsCode,
        streamsContext: safe.streamsContext,
        failureKind: safe.failureKind,
      }),
    ];
  }
  return [];
};

export type WorkspaceRepoLegacyOptions = Pick<
  LoroRepoOptions,
  'storageAdapter' | 'resolveRoomTransports' | 'flockDocRetentionMs'
> &
  Pick<
    MakeOptions,
    'authority' | 'documentCursorPolicy' | 'documentRemoteCursorStore' | 'releaseTimeoutMs'
  > & {
    readonly acquisitionTimeoutMs?: number;
  };

type Owned<A> = WorkspaceOwnedScope & { readonly value: A };
type TransportOwner = WorkspaceOwnedScope & {
  readonly cancelled: AbortController;
  value?: TransportLease;
  transport?: WorkspaceNativeTransport;
};
export type WorkspaceRoomBinding = Pick<
  RepoTransportRoomSubscription,
  'status' | 'onStatusChange' | 'firstSyncedWithRemote' | 'waitUntilSynced'
> & {
  /** Read on demand; no status change announces it. See `initializationEnded`. */
  readonly initializationFailed: boolean;
};
/** Native ownership plus the status view still consumed by application UI. */
export type WorkspaceRoom = Pick<
  RepoRoomSubscription,
  'unsubscribe' | 'transportIds' | 'firstSyncedWithRemote'
> & {
  readonly native: RoomLease;
  readonly signal: AbortSignal;
  readonly subscription: (transportId: string) => WorkspaceRoomBinding;
};
export type WorkspaceDocHandle = Omit<RepoDocHandle, 'joinRoom'> & {
  readonly joinRoom: () => Promise<WorkspaceRoom>;
};
export type WorkspaceFlockDocHandle = Omit<RepoFlockDocHandle, 'joinRoom'> & {
  readonly joinRoom: () => Promise<WorkspaceRoom>;
};
const descriptor = (target: RoomTarget): RepoRoomDescriptor =>
  target.kind === 'meta'
    ? { kind: 'meta', id: 'meta' }
    : { kind: target.kind === 'flock' ? 'flock-doc' : 'doc', id: target.id };
const keyOf = (target: RoomTarget) => JSON.stringify(target);
/**
 * The SDK stopped initializing this generation and will not retry it, while Repo
 * still projects the room as joining: only a per-room sync restarts it. The hard
 * initial-sync deadline ends initialization even though its error is retryable.
 */
const initializationEnded = (health: DurableHealth | undefined): boolean =>
  !!health &&
  !health.ready &&
  health.releasePending <= 0 &&
  (health.lastError?.retryable === false || health.lastError?.code === 'initial_sync_timeout');
const roomStatus = (state: RoomState): RepoTransportRoomStatus => {
  switch (state.connection) {
    case 'joined':
      return state.current ? 'joined' : 'connecting';
    case 'joining':
      return state.baseline ? 'reconnecting' : 'connecting';
    case 'offline':
      return state.baseline ? 'disconnected' : 'connecting';
    case 'failed':
      return 'error';
    default:
      return 'detached';
  }
};

/**
 * @deprecated Single execution door for existing manager/renderer consumers.
 * The implementation owns a native Repo; no Promise LoroRepo or second replica.
 * Delete as WorkspaceData consumers accept Services and caller Scopes directly.
 */
export class WorkspaceRepoLegacy {
  readonly native: Repo;
  private readonly scope: Scope.Closeable;
  private readonly consumers: WorkspaceOwnedScope;
  private readonly meta: FlockLease;
  private readonly options: WorkspaceRepoLegacyOptions;
  private readonly documents = new Map<string, Promise<Owned<DocLease>>>();
  private readonly flocks = new Map<string, Promise<Owned<FlockLease>>>();
  private readonly roomOwners = new Map<string, Set<WorkspaceRoom>>();
  private readonly attachments = new Map<string, TransportOwner>();
  private readonly statusListeners = new Map<
    string,
    Set<(status: 'connected' | 'connecting' | 'disconnected') => void>
  >();
  private closing = false;
  private released = false;
  private closeReceipt?: Promise<void>;

  private constructor(
    native: Repo,
    scope: Scope.Closeable,
    meta: FlockLease,
    options: WorkspaceRepoLegacyOptions,
    consumers: WorkspaceOwnedScope
  ) {
    this.native = native;
    this.scope = scope;
    this.consumers = consumers;
    this.meta = meta;
    this.options = options;
  }

  static async create(options: WorkspaceRepoLegacyOptions) {
    const scope = Scope.makeUnsafe();
    const initialize = Effect.gen(function* () {
      const repo = yield* makeWorkspaceRepo({
        storageAdapter: options.storageAdapter,
        documentCursorPolicy: options.documentCursorPolicy,
        authority: options.authority,
        documentRemoteCursorStore: options.documentRemoteCursorStore,
        releaseTimeoutMs: options.releaseTimeoutMs,
      });
      const consumers = yield* acquireWorkspaceScope('workspace consumers');
      const meta = yield* repo.acquireMetaReplica.pipe(
        Effect.provideService(Scope.Scope, consumers.scope)
      );
      return { repo, meta, consumers };
    });
    const acquired = await Effect.runPromiseExit(
      (options.acquisitionTimeoutMs && options.acquisitionTimeoutMs > 0
        ? initialize.pipe(Effect.timeout(options.acquisitionTimeoutMs))
        : initialize
      ).pipe(Effect.provideService(Scope.Scope, scope))
    );
    if (Exit.isFailure(acquired)) {
      const cleanup = await Effect.runPromiseExit(Scope.close(scope, acquired));
      throw new WorkspaceRepoLegacyFailure(
        Exit.isFailure(cleanup) ? Cause.combine(acquired.cause, cleanup.cause) : acquired.cause
      );
    }
    return new WorkspaceRepoLegacy(
      acquired.value.repo,
      scope,
      acquired.value.meta,
      options,
      acquired.value.consumers
    );
  }

  /** Native consumers borrow the existing workspace owner, never construct another Repo. */
  runLegacy<A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
    return Effect.runPromiseExit(effect, { signal }).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      const reason = exit.cause.reasons[0];
      if (exit.cause.reasons.length === 1 && reason && Cause.isFailReason(reason))
        throw reason.error;
      throw new WorkspaceRepoLegacyFailure(exit.cause);
    });
  }

  private syncLegacy<A, E>(effect: Effect.Effect<A, E>): A {
    const exit = Effect.runSyncExit(effect);
    if (Exit.isFailure(exit)) throw new WorkspaceRepoLegacyFailure(exit.cause);
    return exit.value;
  }

  private fork<A, E>(effect: Effect.Effect<A, E>, scope = this.consumers.scope): void {
    Effect.runFork(
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (!Cause.hasInterruptsOnly(cause))
              console.warn(
                'Workspace Repo background task failed; independent cleanup will continue'
              );
          })
        ),
        Effect.forkIn(scope)
      )
    ).addObserver((exit) => {
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
        console.warn('Workspace Repo background task failed; independent cleanup will continue');
    });
  }

  async acquireScopeLegacy(resource: string): Promise<WorkspaceOwnedScope> {
    if (this.closing) throw new RepoClosed();
    const owner = await this.runLegacy(
      acquireWorkspaceScope(resource).pipe(Effect.provideService(Scope.Scope, this.consumers.scope))
    );
    if (this.closing) {
      await this.runLegacy(owner.close);
      throw new RepoClosed();
    }
    return owner;
  }

  private async own<A>(effect: Effect.Effect<A, RepoError, Scope.Scope>): Promise<Owned<A>> {
    if (this.closing) throw new RepoClosed();
    const owner = this.syncLegacy(
      acquireWorkspaceScope('workspace borrower').pipe(
        Effect.provideService(Scope.Scope, this.consumers.scope)
      )
    );
    try {
      const value = await this.runLegacy(
        effect.pipe(Effect.provideService(Scope.Scope, owner.scope))
      );
      if (this.closing) throw new RepoClosed();
      return { value, ...owner };
    } catch (error) {
      try {
        await this.runLegacy(owner.close);
      } catch (cleanup) {
        throw workspaceAcquisitionFailureLegacy(error, cleanup, 'Workspace acquisition');
      }
      throw error;
    }
  }

  private document(id: string): Promise<Owned<DocLease>> {
    let owned = this.documents.get(id);
    if (!owned) {
      owned = this.own(this.native.acquireDoc(id));
      this.documents.set(id, owned);
      void owned.catch(() => {
        if (this.documents.get(id) === owned) this.documents.delete(id);
      });
    }
    return owned;
  }

  private flock(id: string): Promise<Owned<FlockLease>> {
    let owned = this.flocks.get(id);
    if (!owned) {
      owned = this.own(this.native.acquireFlockDoc(id));
      this.flocks.set(id, owned);
      void owned.catch(() => {
        if (this.flocks.get(id) === owned) this.flocks.delete(id);
      });
    }
    return owned;
  }

  async openPersistedDoc(id: string): Promise<WorkspaceDocHandle> {
    const { value } = await this.document(id);
    return {
      doc: value.doc,
      syncOnce: () => this.sync({ scope: 'doc', docIds: [id] }),
      joinRoom: () => this.joinDocRoom(id),
    };
  }
  async acquireDocHandleLegacy(
    id: string
  ): Promise<WorkspaceDocHandle & { release(): Promise<void> }> {
    // Legacy stores dispose their projections before attempting eviction. Keep
    // the cached replica alive until unloadDoc has persisted it successfully;
    // an ordinary save failure must not retire the only borrowable replica.
    await this.document(id);
    const lease = await this.acquireDoc(id);
    return {
      doc: lease.doc,
      release: lease.release,
      syncOnce: () => this.sync({ scope: 'doc', docIds: [id] }),
      joinRoom: () => this.joinDocRoom(id),
    };
  }
  async openFlockDoc(id: string): Promise<WorkspaceFlockDocHandle> {
    const { value } = await this.flock(id);
    const retention =
      typeof this.options.flockDocRetentionMs === 'function'
        ? this.options.flockDocRetentionMs(id)
        : this.options.flockDocRetentionMs;
    if (retention !== undefined)
      await this.runLegacy(this.native.extendFlockDoc(id, Date.now() + retention));
    return {
      flock: value.flock,
      syncOnce: () => this.sync({ scope: 'doc', flockDocIds: [id] }),
      joinRoom: () => this.joinFlockDocRoom(id),
    };
  }
  async acquireFlockDocHandleLegacy(
    id: string
  ): Promise<WorkspaceFlockDocHandle & { release(): Promise<void> }> {
    // Match cached Doc handles: a failed eviction must leave this replica
    // active and borrowable, rather than retiring the native last lease.
    await this.flock(id);
    const lease = await this.acquireFlockDoc(id);
    return {
      flock: lease.flock,
      release: lease.release,
      syncOnce: () => this.sync({ scope: 'doc', flockDocIds: [id] }),
      joinRoom: () => this.joinFlockDocRoom(id),
    };
  }
  async acquireDoc(id: string): Promise<RepoDocLease> {
    const owned = await this.own(this.native.acquireDoc(id));
    return {
      doc: owned.value.doc,
      generation: owned.value.generation,
      release: () => this.runLegacy(owned.close),
    };
  }
  async acquireFlockDoc(id: string): Promise<RepoFlockDocLease> {
    const owned = await this.own(this.native.acquireFlockDoc(id));
    return {
      flock: owned.value.flock,
      generation: owned.value.generation,
      release: () => this.runLegacy(owned.close),
    };
  }
  async unloadDoc(id: string, _options?: EvictDocOptions) {
    const owned = await this.documents.get(id);
    if (owned) {
      if (this.native.hasStorage)
        await this.runLegacy(
          owned.value.persist.pipe(Effect.timeout(this.options.releaseTimeoutMs ?? 30_000))
        );
      await this.runLegacy(owned.close);
      this.documents.delete(id);
    }
  }
  async unloadFlockDoc(id: string, _options?: EvictDocOptions) {
    const owned = await this.flocks.get(id);
    if (owned) {
      if (this.native.hasStorage)
        await this.runLegacy(
          owned.value.persist.pipe(Effect.timeout(this.options.releaseTimeoutMs ?? 30_000))
        );
      await this.runLegacy(owned.close);
      this.flocks.delete(id);
    }
  }
  upsertDocMeta(id: string, patch: Partial<JsonObject>) {
    return this.runLegacy(this.native.upsertDocMeta(id, patch));
  }
  getDocMeta(id: string) {
    return this.runLegacy(this.native.getDocMeta(id));
  }
  async listDoc(query?: ListDocQuery) {
    return [...(await this.runLegacy(this.native.listDoc(query)))];
  }
  async listFlockDoc(query?: ListFlockDocQuery) {
    return [...(await this.runLegacy(this.native.listFlockDoc(query)))];
  }
  deleteDoc(id: string) {
    return this.runLegacy(this.native.deleteDoc(id));
  }
  restoreDoc(id: string) {
    return this.runLegacy(this.native.restoreDoc(id));
  }
  deleteFlockDoc(id: string) {
    return this.runLegacy(this.native.deleteFlockDoc(id));
  }
  restoreFlockDoc(id: string) {
    return this.runLegacy(this.native.restoreFlockDoc(id));
  }
  async purgeDoc(id: string, _options?: EvictDocOptions) {
    for (const room of this.roomOwners.get(keyOf({ kind: 'doc', id })) ?? []) room.unsubscribe();
    await this.unloadDoc(id);
    return this.runLegacy(this.native.purgeDoc(id));
  }
  async purgeFlockDoc(id: string, _options?: EvictDocOptions) {
    for (const room of this.roomOwners.get(keyOf({ kind: 'flock', id })) ?? []) room.unsubscribe();
    await this.unloadFlockDoc(id);
    return this.runLegacy(this.native.purgeFlockDoc(id));
  }
  getMeta(): FlockLease['flock'] {
    return this.meta.flock;
  }
  hasStorage() {
    return this.native.hasStorage;
  }
  getReplicaCheckpointStore(target: ReplicaCheckpointTarget): RemoteCursorStore {
    const lease = async () => {
      const current =
        target.kind === 'meta' ? this.meta : (await this.flock(target.flockDocId)).value;
      if (current.flock !== target.flock) throw new StaleReplicaError('flock', current.id);
      return this.runLegacy(current.checkpoint);
    };
    return {
      load: async (url) => this.runLegacy((await lease()).load(url)),
      save: async (cursor) => this.runLegacy((await lease()).save(cursor)),
      delete: async (url) => this.runLegacy((await lease()).delete(url)),
    };
  }
  // Legacy memory-only consumers used these as no-op barriers; native persist
  // deliberately requires storage and remains strict at the native API boundary.
  persistMetaNow() {
    return this.native.hasStorage ? this.runLegacy(this.native.persistMeta) : Promise.resolve();
  }
  async persistDocNow(id: string, doc: RepoDocHandle['doc']) {
    const current = (await this.document(id)).value;
    if (doc !== current.doc) throw new StaleReplicaError('doc', id);
    if (this.native.hasStorage) await this.runLegacy(current.persist);
  }
  async persistFlockDocNow(id: string, flock: RepoFlockDocHandle['flock']) {
    const current = (await this.flock(id)).value;
    if (flock !== current.flock) throw new StaleReplicaError('flock', id);
    if (this.native.hasStorage) await this.runLegacy(current.persist);
  }
  watch(
    listener: RepoEventListener<JsonObject>,
    filter?: RepoEventFilter<JsonObject>
  ): RepoWatchHandle {
    const scope = this.syncLegacy(Scope.fork(this.consumers.scope));
    const events = this.syncLegacy(
      this.native.watch(filter).pipe(Effect.provideService(Scope.Scope, scope))
    );
    this.fork(
      Stream.runForEach(events, ({ event }) =>
        Effect.sync(() => {
          if (event.kind !== 'flock-doc-expiration-changed') listener(this.currentEvent(event));
        })
      ),
      scope
    );
    return { unsubscribe: () => this.fork(Scope.close(scope, Exit.succeed(undefined))) };
  }
  observeDocs(
    listener: RepoEventListener<JsonObject>,
    options?: { query?: ListDocQuery; filter?: RepoEventFilter<JsonObject> }
  ) {
    const scope = this.syncLegacy(Scope.fork(this.consumers.scope));
    const observation = this.syncLegacy(
      this.native
        .observeDocs(options?.query, options?.filter)
        .pipe(Effect.provideService(Scope.Scope, scope))
    );
    this.fork(
      Stream.runForEach(observation.changes, ({ event }) =>
        Effect.sync(() => {
          if (event.kind !== 'flock-doc-expiration-changed') listener(this.currentEvent(event));
        })
      ),
      scope
    );
    return {
      snapshot: observation.snapshot,
      watermark: observation.watermark,
      unsubscribe: () => this.fork(Scope.close(scope, Exit.succeed(undefined))),
    };
  }
  private currentEvent<E extends { kind: string }>(event: E): E {
    if (event.kind !== 'doc-metadata' || !('docId' in event) || typeof event.docId !== 'string')
      return event;
    const row = this.syncLegacy(this.native.getDocMeta(event.docId));
    // A native metadata write can publish multiple rows. Legacy observers must
    // validate the completed catalog row, never accept an intermediate owner/backend pair.
    return row
      ? {
          ...event,
          patch: {
            ...('patch' in event && typeof event.patch === 'object' && event.patch !== null
              ? event.patch
              : {}),
            ...row.meta,
          },
        }
      : event;
  }
  flush() {
    return this.runLegacy(this.native.flush);
  }
  get destroyed() {
    return this.closing;
  }
  destroy(): Promise<void> {
    if (this.released) return Promise.resolve();
    if (this.closeReceipt) return this.closeReceipt;
    this.closing = true;
    this.closeReceipt = this.runLegacy(
      Effect.gen({ self: this }, function* () {
        // Each borrower owner remains registered here, including failed manual
        // releases. Retry those owners, rather than replaying historical stream errors.
        yield* this.consumers.close;
        yield* this.native.close;
        yield* Scope.close(this.scope, Exit.succeed(undefined));
        this.released = true;
      })
    ).finally(() => {
      this.closeReceipt = undefined;
    });
    return this.closeReceipt;
  }

  private route(target: RoomTarget): readonly string[] {
    return (
      this.options.resolveRoomTransports?.(descriptor(target)).transportIds ?? [
        ...this.attachments.keys(),
      ]
    );
  }
  onTransportStatusChange(
    id: string,
    listener: (status: 'connected' | 'connecting' | 'disconnected') => void
  ) {
    const listeners = this.statusListeners.get(id) ?? new Set();
    this.statusListeners.set(id, listeners);
    listeners.add(listener);
    const attachment = this.attachments.get(id);
    const status = attachment?.value && this.syncLegacy(attachment.value.statusSnapshot);
    listener(
      status === 'online' ? 'connected' : status === 'connecting' ? 'connecting' : 'disconnected'
    );
    return () => {
      listeners.delete(listener);
    };
  }
  hasTransport() {
    return this.attachments.size > 0;
  }
  private getTransportIds() {
    return [...this.attachments.keys()];
  }
  async addTransport(
    id: string,
    adapter: NativeWorkspaceTransport,
    _options?: RepoTransportOptions
  ): Promise<RepoAttachmentReport> {
    if (this.attachments.get(id)?.cancelled.signal.aborted) await this.removeTransport(id);
    if (this.closing) throw new RepoClosed();
    if (this.attachments.has(id)) throw new Error(`Transport already attached: ${id}`);
    const owned: TransportOwner = {
      ...this.syncLegacy(
        acquireWorkspaceScope(`transport:${id}`).pipe(
          Effect.provideService(Scope.Scope, this.consumers.scope)
        )
      ),
      cancelled: new AbortController(),
    };
    // Publish ownership before either adapter construction or native connect can suspend.
    this.attachments.set(id, owned);
    try {
      const attachment = await this.runLegacy(
        Effect.gen({ self: this }, function* () {
          const transport = yield* adapter.make(id);
          if (this.closing || owned.cancelled.signal.aborted)
            return yield* Effect.fail(new RepoClosed());
          owned.transport = transport;
          const route = transport.routes;
          return yield* this.native.attachTransport({
            ...transport,
            routes: (target) =>
              (
                this.options.resolveRoomTransports?.(descriptor(target)).transportIds ?? [
                  ...this.attachments.keys(),
                  id,
                ]
              ).includes(id) &&
              (route?.(target) ?? true),
          });
        }).pipe(Effect.provideService(Scope.Scope, owned.scope)),
        owned.cancelled.signal
      );
      if (this.closing || owned.cancelled.signal.aborted) throw new RepoClosed();
      owned.value = attachment;
      this.fork(
        Stream.runForEach(attachment.status, (status) =>
          Effect.sync(() => {
            for (const listener of this.statusListeners.get(id) ?? [])
              listener(
                status === 'online'
                  ? 'connected'
                  : status === 'connecting'
                    ? 'connecting'
                    : 'disconnected'
              );
          })
        ),
        owned.scope
      );
      return this.attachmentReport();
    } catch (error) {
      owned.cancelled.abort();
      try {
        await this.runLegacy(owned.close);
        if (this.attachments.get(id) === owned) this.attachments.delete(id);
      } catch (cleanup) {
        throw workspaceAcquisitionFailureLegacy(error, cleanup, 'Transport acquisition');
      }
      throw error;
    }
  }
  async removeTransport(id: string, _options?: RemoveTransportOptions) {
    const owned = this.attachments.get(id);
    if (!owned) return;
    owned.cancelled.abort();
    // The Scope finalizer revokes native registration and drains accepted connect I/O.
    await this.runLegacy(owned.close);
    if (this.attachments.get(id) === owned) this.attachments.delete(id);
  }
  async refreshTransportRoutes(): Promise<RepoAttachmentReport> {
    for (const { value } of this.attachments.values())
      if (value) await this.runLegacy(value.refreshRoutes);
    return this.attachmentReport();
  }
  async reconnect(options?: RepoReconnectOptions): Promise<RepoAttachmentReport> {
    const native = this.native;
    const results = await Promise.allSettled(
      [...this.attachments]
        .filter(([id]) => !options?.transportIds || options.transportIds.includes(id))
        .map(([id, { value, transport }]) =>
          value
            ? this.runLegacy(
                Effect.gen(function* () {
                  const status = yield* value.statusSnapshot;
                  const reset =
                    status === 'offline' ||
                    status === 'closed' ||
                    status === 'failed' ||
                    (options?.resetBackoff === true && transport?.authority !== 'server');
                  if (reset) return yield* value.reconnect;
                  // Online server repair stays per-room even on wake/auth triggers:
                  // native Streams reconnect restarts every SDK generation/presence.
                  // Peer reconnect still rebuilds overflowed local v7 workers.
                  const rooms = yield* value.rooms;
                  const roomResults = yield* Effect.forEach(
                    rooms.filter(
                      (room) =>
                        room.status === 'failed' ||
                        room.status === 'offline' ||
                        room.status === 'joining'
                    ),
                    ({ target, status: bindingStatus }) =>
                      Effect.gen(function* () {
                        if (bindingStatus === 'joining') {
                          // Keep active SDK retries owned.
                          const health = transport?.health
                            ? yield* transport.health(target)
                            : undefined;
                          if (!initializationEnded(health)) return undefined;
                        }
                        yield* native.syncOnce(target, id);
                        return undefined;
                      }).pipe(Effect.exit),
                    { concurrency: 'unbounded' }
                  );
                  const cause = roomResults.reduce<Cause.Cause<RepoError>>(
                    (failure, result) =>
                      Exit.isFailure(result) ? Cause.combine(failure, result.cause) : failure,
                    Cause.empty
                  );
                  if (cause.reasons.length) return yield* Effect.failCause(cause);
                  return undefined;
                }),
                options?.signal
              )
            : Promise.resolve()
        )
    );
    const report = this.attachmentReport();
    const failed = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    return failed.length
      ? { ...report, ok: false, error: new AggregateError(failed.map((item) => item.reason)) }
      : report;
  }
  transportRooms(id: string) {
    const attachment = this.attachments.get(id);
    return attachment?.value
      ? this.syncLegacy(attachment.value.rooms).filter(({ target }) =>
          this.route(target).includes(id)
        )
      : [];
  }
  private attachmentReport(): RepoAttachmentReport {
    const rooms = this.getTransportIds().flatMap((id) =>
      this.transportRooms(id).map(({ target, status }) => ({
        kind: descriptor(target).kind,
        roomId: descriptor(target).id,
        transportId: id,
        status:
          status === 'synced'
            ? ('joined' as const)
            : status === 'failed'
              ? ('error' as const)
              : status === 'offline'
                ? ('disconnected' as const)
                : status === 'detached'
                  ? ('detached' as const)
                  : ('connecting' as const),
        attached: status !== 'detached',
      }))
    );
    const failed = rooms.filter((room) => room.status === 'error');
    return { ok: failed.length === 0, rooms, failed };
  }
  createRemoteStreamLegacy(id: string, target: RoomTarget) {
    const transport = this.attachments.get(id)?.transport;
    if (!transport?.createStream)
      return Promise.reject(new RepoUnsupported('remote stream creation'));
    return this.runLegacy(transport.createStream(target));
  }
  joinMetaRoom() {
    return this.joinRoom({ kind: 'meta' });
  }
  joinDocRoom(id: string) {
    return this.joinRoom({ kind: 'doc', id });
  }
  joinFlockDocRoom(id: string) {
    return this.joinRoom({ kind: 'flock', id });
  }

  /** A selected peer receipt is a causal handoff, not proof of server upload. */
  syncRoomLegacy(
    target: RoomTarget,
    transportId: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ) {
    const sync = Effect.scoped(
      Effect.flatMap(this.native.acquireRoom(target), (room) => room.sync(transportId))
    );
    return this.runLegacy(
      options.timeoutMs === undefined ? sync : sync.pipe(Effect.timeout(options.timeoutMs)),
      options.signal
    );
  }

  private async joinRoom(target: RoomTarget): Promise<WorkspaceRoom> {
    const owned = await this.own(this.native.acquireRoom(target));
    const lease = owned.value;
    const closed = new AbortController();
    this.syncLegacy(
      Scope.addFinalizer(
        owned.scope,
        Effect.sync(() => closed.abort())
      )
    );
    const bindings = new Map<string, WorkspaceRoomBinding>();
    const binding = (id: string): WorkspaceRoomBinding => {
      const existing = bindings.get(id);
      if (existing) return existing;
      const project = (state: RoomState): RepoTransportRoomStatus => {
        // Native detail refs start at "joining" even before a transport exists.
        // Deliberate route absence is idle, not a connection that needs repair.
        if (
          closed.signal.aborted ||
          !this.syncLegacy(this.native.transportIds).includes(id) ||
          (this.options.resolveRoomTransports && !this.route(target).includes(id))
        )
          return 'detached';
        return state.connection === 'detached' && !state.baseline
          ? 'connecting'
          : roomStatus(state);
      };
      const status = () => project(this.syncLegacy(lease.stateSnapshot(id)));
      const initializationFailed = () => {
        const health = this.attachments.get(id)?.transport?.health;
        return (
          !closed.signal.aborted && !!health && initializationEnded(this.syncLegacy(health(target)))
        );
      };
      const firstSyncedWithRemote = () => {
        const wait = this.runLegacy(
          lease.state(id).pipe(
            Stream.mapEffect((state) =>
              state.connection === 'failed' && project(state) !== 'detached'
                ? Effect.fail(new RepoIOError('room readiness', state.connection))
                : Effect.succeed(state)
            ),
            Stream.filter(
              (state) => state.baseline && state.current && project(state) === 'joined'
            ),
            Stream.runHead,
            Effect.flatMap((state) =>
              Option.isSome(state) ? Effect.void : Effect.fail(new RepoClosed())
            )
          ),
          closed.signal
        );
        // Status-only consumers need no waiter. Preserve each caller's failure,
        // while later callers can observe a recovered native binding.
        void wait.catch(() => undefined);
        return wait;
      };
      const value: WorkspaceRoomBinding = {
        get status() {
          return status();
        },
        get firstSyncedWithRemote() {
          return firstSyncedWithRemote();
        },
        get initializationFailed() {
          return initializationFailed();
        },
        onStatusChange: (listener) => {
          const scope = this.syncLegacy(Scope.fork(owned.scope));
          this.fork(
            Stream.runForEach(lease.state(id).pipe(Stream.map(project), Stream.changes), (next) =>
              Effect.sync(() => listener(next))
            ),
            scope
          );
          return () => this.fork(Scope.close(scope, Exit.succeed(undefined)));
        },
        waitUntilSynced: () =>
          this.runLegacy(
            Effect.gen({ self: this }, function* () {
              if (this.attachments.get(id)?.transport?.authority === 'server') {
                const result = yield* lease.awaitUploaded(id);
                if (result.outcome === 'acked') return undefined;
                if (result.cause) return yield* Effect.failCause(result.cause);
                return yield* Effect.fail(
                  new RepoIOError('room upload not confirmed', result.outcome)
                );
              }
              const report = yield* lease.sync(id);
              if (
                !report.transports.some((route) => route.id === id && route.outcome === 'confirmed')
              )
                return yield* Effect.fail(new RepoSyncFailed(report));
              return undefined;
            }),
            closed.signal
          ),
      };
      bindings.set(id, value);
      return value;
    };
    const single = () => {
      const ids = this.route(target);
      if (ids.length !== 1) throw new RepoUnsupported('select a transport explicitly');
      const id = ids[0];
      if (!id) throw new RepoUnsupported('room transport');
      return binding(id);
    };
    const holders = this.roomOwners.get(keyOf(target)) ?? new Set<WorkspaceRoom>();
    this.roomOwners.set(keyOf(target), holders);
    const subscription: WorkspaceRoom = {
      native: lease,
      signal: closed.signal,
      unsubscribe: () => {
        if (closed.signal.aborted) return;
        closed.abort();
        holders.delete(subscription);
        if (holders.size === 0) this.roomOwners.delete(keyOf(target));
        this.fork(owned.close);
      },
      get firstSyncedWithRemote() {
        return single().firstSyncedWithRemote;
      },
      transportIds: () => this.route(target),
      subscription: binding,
    };
    holders.add(subscription);
    return subscription;
  }
  async sync(options?: RepoSyncOptions): Promise<RepoSyncReport> {
    const report = await this.runLegacy(this.native.sync(options), options?.signal);
    const transports = new Map<
      string,
      {
        transportId: string;
        ok: boolean;
        failures: { kind: RepoRoomDescriptor['kind']; id?: string; error: unknown }[];
      }
    >();
    for (const resource of report.resources) {
      const sync = Exit.isSuccess(resource.exit) ? resource.exit.value : undefined;
      for (const entry of sync?.transports ?? []) {
        const transport = transports.get(entry.id) ?? {
          transportId: entry.id,
          ok: true,
          failures: [],
        };
        if (entry.outcome !== 'confirmed') {
          transport.ok = false;
          transport.failures.push({
            kind: descriptor(resource.target).kind,
            id: descriptor(resource.target).id,
            error: entry.cause
              ? new WorkspaceRepoLegacyFailure(entry.cause)
              : new RepoIOError('transport offline', entry.id),
          });
        }
        transports.set(entry.id, transport);
      }
      if (Exit.isFailure(resource.exit)) {
        for (const id of options?.requireTransports ?? this.route(resource.target)) {
          const transport = transports.get(id) ?? { transportId: id, ok: true, failures: [] };
          transport.ok = false;
          transport.failures.push({
            kind: descriptor(resource.target).kind,
            id: descriptor(resource.target).id,
            error: new WorkspaceRepoLegacyFailure(resource.exit.cause),
          });
          transports.set(id, transport);
        }
      }
    }
    const outcome =
      report.outcome === 'confirmed'
        ? 'synced'
        : report.outcome === 'skipped'
          ? transports.size
            ? 'failed'
            : 'no-route'
          : report.outcome;
    const result: RepoSyncReport = {
      ok: outcome === 'synced' || outcome === 'no-route',
      outcome,
      transports: [...transports.values()],
      missingRequiredTransports: options?.requireTransports?.filter(
        (id) => !transports.get(id)?.ok
      ),
    };
    if (outcome === 'failed') throw new RepoSyncError(result);
    return result;
  }
}

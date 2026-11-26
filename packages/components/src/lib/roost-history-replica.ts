import { IndexedDbStorage, Store, StoreError, type Stream } from '@loro-dev/roost';
import { StreamsClient, type StreamError } from '@loro-dev/streams-client';
import {
  LodyHistory,
  toApplicationJson,
  type ActiveBranchPageCursor,
  type ActiveBranchPageRead,
  type HistoryProjectedMessage,
} from '@loro-dev/roost/lody-history';
import {
  Executor,
  HistoryReader,
  HistoryError,
  Link,
  LinkError,
  TransportError,
  RemoteRegistry,
  StreamsTransport,
  linkLimitsForSync,
  type HistoryReport,
  type ReadPage,
} from '@loro-dev/roost/sync';
import {
  roostCloudHistoryStreamId,
  ROOST_HISTORY_BUCKET_ID,
  roostHistorySourceId,
  roostHistoryAuthorKey,
  RoostCloudHistoryPendingError,
  RoostCloudHistoryRequestError,
  RoostCloudHistoryTransportError,
  roostCloudHistoryBindingSchema,
  type RoostCloudHistoryBinding,
  type RoostCloudHistoryReadResult,
  type RoostCloudSyncState,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import {
  createRoostDirectoryRow,
  projectRoostSegments,
  readSessionHistoryMetadata,
  selectTurnOutput,
  type SessionDataChangeListener,
  type SessionDirectoryRow,
  type SessionEntry,
  type SessionHistoryDirectoryPage,
  type SessionHistoryReader,
  type SessionTurn,
  type SessionTurnRead,
} from '@lody/shared/session-data';

type Database = {
  storage: IndexedDbStorage;
  store: Store;
  owners: Map<string, string>;
};
type DatabaseLease = Database & { release(): Promise<void> };
const databases = new Map<string, { refs: number; ready: Promise<Database> }>();
const closingDatabases = new Map<string, Promise<void>>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
const PAGE_SIZE = 40;
const WINDOW_BYTES = 256 * 1024;
const MAX_WINDOW_BYTES = 64 * 1024 * 1024;
const byteOffset = (value: string | undefined) =>
  value !== undefined && /^\d+$/.test(value) ? BigInt(value) : undefined;

class OwnerAuthorizationRequired extends Error {
  constructor() {
    super('Roost history requires authorization from the target machine');
  }
}

export function canReadRoostHistoryFromOwnerAfter(error: unknown): boolean {
  if ((error instanceof HistoryError || error instanceof LinkError) && error.code === 'transport')
    error = error.cause;
  return (
    error instanceof RoostCloudHistoryPendingError ||
    error instanceof OwnerAuthorizationRequired ||
    error instanceof RoostCloudHistoryTransportError ||
    (error instanceof RoostCloudHistoryRequestError && error.retryable) ||
    (error instanceof TransportError && error.code === 'unavailable') ||
    (error instanceof DOMException && error.name === 'QuotaExceededError') ||
    (error instanceof Error && error.name === 'TimeoutError')
  );
}

function failStreamRead(error: StreamError): never {
  const { context } = error;
  if (
    context?.serverErrorCode === 'space_deleted' ||
    context?.serverErrorCode === 'space_generation_fenced'
  )
    throw new RoostCloudHistoryRequestError(410);
  const status = ('status' in error ? error.status : undefined) ?? context?.status;
  if (status !== undefined && status >= 400 && status < 600)
    throw new RoostCloudHistoryRequestError(status);
  if (error.code === 'network_error' || error.code === 'timeout')
    throw new RoostCloudHistoryTransportError();
  throw new Error('Roost cloud history stream returned an invalid response');
}

async function acquireDatabase(name: string): Promise<DatabaseLease> {
  let entry = databases.get(name);
  if (!entry) {
    const closing = closingDatabases.get(name);
    entry = {
      refs: 0,
      ready: (async () => {
        await closing;
        const storage = await IndexedDbStorage.open(name);
        const owners = new Map<string, string>();
        const store = new Store(
          storage,
          (stream, owner) => owners.get(stream) === roostHistoryAuthorKey(owner),
          {
            clock: () => BigInt(Date.now()),
            randomBytes: () => globalThis.crypto.getRandomValues(new Uint8Array(16)),
          }
        );
        return { storage, store, owners };
      })(),
    };
    databases.set(name, entry);
  }
  const acquired = entry;
  acquired.refs += 1;
  let database: Database;
  try {
    database = await acquired.ready;
  } catch (error) {
    acquired.refs -= 1;
    if (databases.get(name) === acquired) databases.delete(name);
    throw error;
  }
  let released = false;
  return {
    ...database,
    async release() {
      if (released) return;
      released = true;
      if (--acquired.refs > 0) return;
      if (databases.get(name) === acquired) databases.delete(name);
      const closing = (async () => {
        await database.store.close();
        await database.storage.close();
      })();
      closingDatabases.set(name, closing);
      try {
        await closing;
      } finally {
        if (closingDatabases.get(name) === closing) closingDatabases.delete(name);
      }
    },
  };
}

type ReplicaMeta = {
  binding: RoostCloudHistoryBinding;
  bootstrapped: boolean;
  reachedStart: boolean;
  before?: string;
  remoteId?: string;
  endpoint?: string;
};

function readReplicaMeta(value: unknown, expected: RoostCloudHistoryBinding): ReplicaMeta {
  if (!value || typeof value !== 'object') throw new Error('Invalid Roost replica metadata');
  const row = value as Record<string, unknown>;
  const binding = roostCloudHistoryBindingSchema.safeParse(row.binding).data;
  if (
    !binding ||
    binding.generation !== expected.generation ||
    binding.ownerPublicKey !== expected.ownerPublicKey
  ) {
    throw new Error('Roost replica belongs to a different history binding');
  }
  if (
    typeof row.bootstrapped !== 'boolean' ||
    typeof row.reachedStart !== 'boolean' ||
    (row.before !== undefined && (typeof row.before !== 'string' || !row.before.length)) ||
    (row.remoteId !== undefined &&
      (typeof row.remoteId !== 'string' || !/^[0-9a-f]{32}$/.test(row.remoteId))) ||
    (row.endpoint !== undefined && (typeof row.endpoint !== 'string' || !row.endpoint.length)) ||
    (row.reachedStart && !row.bootstrapped) ||
    (row.bootstrapped && (!row.remoteId || !row.endpoint || (!row.reachedStart && !row.before)))
  )
    throw new Error('Invalid Roost replica progress');
  return {
    binding,
    bootstrapped: row.bootstrapped,
    reachedStart: row.reachedStart,
    before: row.before as string | undefined,
    remoteId: row.remoteId as string | undefined,
    endpoint: row.endpoint as string | undefined,
  };
}

type PublishedGrant = Extract<RoostCloudHistoryReadResult, { state: 'published' }>;
type Replica = {
  lease: DatabaseLease;
  stream: Stream;
  history: LodyHistory;
  meta: ReplicaMeta;
  eventCursor: bigint;
  forwardOffset?: string;
  link?: Link;
  reader?: HistoryReader;
  transport?: StreamsTransport;
  streamClient?: StreamsClient;
  livePage?: { offset: string; page: ReadPage };
  endpoint?: string;
};
type CachedTurn = { position: number; turn: SessionEntry; segments: Uint8Array[]; dirty: boolean };

const sameBinding = (left: RoostCloudHistoryBinding, right: RoostCloudHistoryBinding) =>
  left.ownerPublicKey === right.ownerPublicKey && left.generation === right.generation;

export type RoostHistoryReplicaOptions = {
  readonly accountId?: string | null;
  readonly workspaceId: WorkspaceId;
  readonly machineId: string;
  readonly replicaNamespace: string;
  readonly sessionId: SessionId;
  readonly getBinding: () => RoostCloudHistoryBinding | undefined;
  readonly observeBinding: (wake: () => void) => () => void;
  readonly requestGrant: (signal: AbortSignal) => Promise<RoostCloudHistoryReadResult>;
  readonly onSyncState?: (state: { checkpoint: string } | { reason: string }) => void;
};

/** A read-only native Roost replica. Owner RPC remains the write authority;
 * this reader never manufactures an identity, outbox, or remote acknowledgement. */
export function createRoostHistoryReplica(options: RoostHistoryReplicaOptions): {
  history: SessionHistoryReader;
  watchPublication(listener: () => void): () => void;
  syncStatus(): RoostCloudSyncState;
  ownerReadAllowed(): boolean;
  watchSyncStatus(listener: () => void): () => void;
  prepareLatestWindow(): Promise<void>;
  readPublishedSnapshot(): Promise<SessionEntry[]>;
  refresh(): void;
  dispose(): void;
} {
  const abort = new AbortController();
  const stop = {
    get stopped() {
      return abort.signal.aborted;
    },
  };
  const listeners = new Set<SessionDataChangeListener>();
  const publicationListeners = new Set<() => void>();
  const statusListeners = new Set<() => void>();
  const bodies = new Map<string, CachedTurn>();
  const positions = new Map<number, string>();
  const cursors = new Map<string, ActiveBranchPageCursor>();
  let nextCursor = 0;
  let opened: Promise<Replica> | undefined;
  let serial: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let background = false;
  let requested = false;
  let tailWait: AbortController | undefined;
  let failures = 0;
  let lastBranchRevision: bigint | undefined;
  let totalCount = 0;
  let currentBinding: RoostCloudHistoryBinding | undefined;
  let latestGrant: { value: PublishedGrant; expires: number } | undefined;
  let pendingGrant: Promise<PublishedGrant> | undefined;
  let forceGrant = false;
  let terminal: RoostCloudHistoryRequestError | undefined;
  let readDeadline: AbortSignal | undefined;
  let status: RoostCloudSyncState = { phase: 'idle' };
  let readFailure: unknown;

  const report = (
    phase: RoostCloudSyncState['phase'],
    httpStatus?: number,
    newerVersionPending = status.newerVersionPending,
    failure?: unknown
  ) => {
    if (abort.signal.aborted) return;
    const ownerRecoveryChanged =
      canReadRoostHistoryFromOwnerAfter(readFailure) !== canReadRoostHistoryFromOwnerAfter(failure);
    readFailure = failure;
    if (
      !ownerRecoveryChanged &&
      status.phase === phase &&
      status.httpStatus === httpStatus &&
      status.newerVersionPending === newerVersionPending
    )
      return;
    status = {
      phase,
      ...(httpStatus !== undefined && { httpStatus }),
      ...(newerVersionPending !== undefined && { newerVersionPending }),
    };
    for (const listener of statusListeners) listener();
  };

  const assertOpen = () => {
    if (abort.signal.aborted) throw new Error('Roost history replica is disposed');
    if (terminal) throw terminal;
  };
  const assertLive = () => {
    assertOpen();
    readDeadline?.throwIfAborted();
  };
  const invalidateWindow = () => {
    const hadWindow = lastBranchRevision !== undefined;
    bodies.clear();
    positions.clear();
    cursors.clear();
    lastBranchRevision = undefined;
    if (hadWindow)
      for (const listener of listeners)
        listener({ kind: 'structure', from: 0, to: Number.MAX_SAFE_INTEGER });
  };

  const reportFailure = (error: unknown) => {
    if (abort.signal.aborted || terminal) return;
    if (error instanceof RoostCloudHistoryRequestError && !error.retryable) {
      terminal = error;
      invalidateWindow();
      report('refused', error.status, false);
      options.onSyncState?.({ reason: error.message });
      return;
    }
    if (
      error instanceof RoostCloudHistoryPendingError ||
      error instanceof OwnerAuthorizationRequired
    ) {
      invalidateWindow();
      report(
        error instanceof OwnerAuthorizationRequired ? 'owner-required' : 'pending',
        undefined,
        false,
        error
      );
      options.onSyncState?.({ reason: error.message });
      return;
    }
    report(
      'retrying',
      error instanceof RoostCloudHistoryRequestError ? error.status : undefined,
      undefined,
      error
    );
  };

  const grant = (refresh = false): Promise<PublishedGrant> => {
    assertLive();
    if (pendingGrant) return pendingGrant;
    if (!refresh && !forceGrant && latestGrant && Date.now() < latestGrant.expires)
      return Promise.resolve(latestGrant.value);
    forceGrant = false;
    if (status.phase === 'idle') report('checking');
    const signal = readDeadline ? AbortSignal.any([abort.signal, readDeadline]) : abort.signal;
    pendingGrant = (async () => {
      const result = await options.requestGrant(signal);
      assertLive();
      if (result.state === 'pending') throw new RoostCloudHistoryPendingError();
      if (result.state === 'owner-required') throw new OwnerAuthorizationRequired();
      latestGrant = { value: result, expires: Date.now() + (result.expiresIn - 5) * 1_000 };
      const replaced = currentBinding && !sameBinding(currentBinding, result.binding);
      if (replaced) {
        stopWaiting();
        schedule();
      }
      report(
        status.phase === 'ready' && !replaced ? 'ready' : 'syncing',
        undefined,
        result.newerVersionPending
      );
      return result;
    })()
      .catch((error) => {
        latestGrant = undefined;
        reportFailure(error);
        throw error;
      })
      .finally(() => {
        pendingGrant = undefined;
      });
    return pendingGrant;
  };

  const grantWasReplaced = (binding: RoostCloudHistoryBinding) =>
    latestGrant !== undefined && !sameBinding(binding, latestGrant.value.binding);

  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = serial.then(async () => {
      readDeadline = AbortSignal.timeout(20_000);
      try {
        for (;;) {
          const { binding } = await grant();
          if (opened) {
            const current = await opened;
            if (!sameBinding(current.meta.binding, binding)) {
              opened = undefined;
              currentBinding = undefined;
              invalidateWindow();
              options.onSyncState?.({ reason: 'roost_cloud_history_changed' });
              await current.lease.release();
            } else await changes(current);
          }
          try {
            const value = await operation();
            assertLive();
            if (pendingGrant) await pendingGrant;
            if (!latestGrant) await grant();
            if (!grantWasReplaced(binding)) return value;
          } catch (error) {
            assertLive();
            if (!grantWasReplaced(binding)) throw error;
          }
        }
      } catch (error) {
        reportFailure(error);
        throw terminal ?? error;
      } finally {
        readDeadline = undefined;
      }
    });
    serial = result.catch(() => {});
    return result;
  };

  const persistMeta = async (replica: Replica) => {
    const space = replica.stream.space('lody_remote_reader_v1');
    const bytes = encoder.encode(JSON.stringify(replica.meta));
    await replica.lease.storage.transact(true, function* (tx) {
      yield* tx.put(space, new Uint8Array(), bytes);
    });
  };
  const open = (): Promise<Replica> => {
    if (!opened) {
      opened = (async () => {
        // Metadata hints can wake this reader, but only a live session grant
        // identifies the replica that this reader may expose.
        const initialGrant = await grant();
        const binding = initialGrant.binding;
        report('syncing', undefined, initialGrant.newerVersionPending);
        assertLive();
        const name =
          'lody-roost-replica-' +
          JSON.stringify([
            options.accountId ?? 'local',
            options.workspaceId,
            options.machineId,
            options.replicaNamespace,
            options.sessionId,
            binding.ownerPublicKey,
            binding.generation,
          ]);
        const lease = await acquireDatabase(name);
        try {
          assertLive();
          const stream = lease.store.stream(
            roostHistorySourceId(options.sessionId, binding.generation)
          );
          const space = stream.space('lody_remote_reader_v1');
          const raw = await lease.storage.transact(false, function* (tx) {
            return yield* tx.get(space, new Uint8Array());
          });
          const meta = raw
            ? readReplicaMeta(JSON.parse(decoder.decode(raw)), binding)
            : { binding, bootstrapped: false, reachedStart: false };
          lease.owners.set(stream.id, binding.ownerPublicKey);
          const history = LodyHistory.readOnly(stream);
          const replica: Replica = {
            lease,
            stream,
            history,
            meta,
            eventCursor: await history.observedEventCursor(),
          };
          if (meta.remoteId) {
            await network(replica, async () => {
              const registry = new RemoteRegistry(lease.storage);
              const remoteId = unhex(replica.meta.remoteId!);
              if (!(await registry.get(remoteId))) return;
              const scope = await new Executor(lease.storage).scope(registry, remoteId, stream.id);
              const link = Link.openPartial(lease.storage, stream, scope, linkLimitsForSync());
              const offset = await link.position();
              if (offset === undefined) return;
              await link.catchUpAt(offset);
              await changes(replica);
              replica.forwardOffset = offset;
            });
          }
          currentBinding = binding;
          return replica;
        } catch (error) {
          await lease.release();
          throw error;
        }
      })().catch((error) => {
        opened = undefined;
        throw error;
      });
    }
    return opened;
  };

  const network = async <T>(replica: Replica, operation: () => Promise<T>): Promise<T> => {
    const perform = async () => {
      assertLive();
      const space = replica.stream.space('lody_remote_reader_v1');
      const raw = await replica.lease.storage.transact(false, function* (tx) {
        return yield* tx.get(space, new Uint8Array());
      });
      if (raw) {
        const meta = readReplicaMeta(JSON.parse(decoder.decode(raw)), replica.meta.binding);
        if (meta.remoteId !== replica.meta.remoteId || meta.endpoint !== replica.meta.endpoint)
          replica.endpoint = undefined;
        replica.meta = meta;
      }
      return await operation();
    };
    if (typeof navigator !== 'undefined' && navigator.locks) {
      const key = JSON.stringify([
        'lody:roost-intake',
        options.accountId ?? 'local',
        options.workspaceId,
        options.replicaNamespace,
        options.sessionId,
      ]);
      const signal = readDeadline ? AbortSignal.any([abort.signal, readDeadline]) : abort.signal;
      return await navigator.locks.request(key, { signal }, perform);
    }
    return await perform();
  };

  const grantFor = async (replica: Replica, refresh = false) => {
    const value = await grant(refresh);
    assertLive();
    if (!sameBinding(replica.meta.binding, value.binding))
      throw new Error('Roost history generation changed');
    return value;
  };

  const connect = async (replica: Replica) => {
    const access = await grantFor(replica);
    assertLive();
    const binding = replica.meta.binding;
    if (
      replica.endpoint === access.streamUrl &&
      replica.transport &&
      replica.link &&
      replica.reader
    )
      return;
    const physical = roostCloudHistoryStreamId(
      options.workspaceId,
      options.machineId,
      options.sessionId,
      binding
    );
    const url = access.streamUrl;
    if (
      !new URL(url).pathname.endsWith(
        `/ds/${ROOST_HISTORY_BUCKET_ID}/${encodeURIComponent(physical)}`
      )
    )
      throw new Error('Roost history read grant does not name the published stream');
    const registry = new RemoteRegistry(replica.lease.storage);
    let remote = replica.meta.remoteId
      ? await registry.get(unhex(replica.meta.remoteId))
      : undefined;
    if (
      !remote ||
      remote.endpoint.url !== url ||
      remote.endpoint.stream !== physical ||
      decoder.decode(remote.generation.bytes) !== binding.generation ||
      remote.generation.source !== 'app_marker'
    ) {
      const id = await registry.register(
        physical,
        { url, stream: physical },
        { bytes: encoder.encode(binding.generation), source: 'app_marker' }
      );
      remote = (await registry.get(id))!;
      replica.meta = {
        binding,
        bootstrapped: false,
        reachedStart: false,
        remoteId: hex(id),
        endpoint: url,
      };
      await persistMeta(replica);
    }
    const scope = await new Executor(replica.lease.storage).scope(
      registry,
      remote.id,
      replica.stream.id
    );
    const fetchWithLifetime: typeof fetch = async (input, init) => {
      assertLive();
      const signals = [abort.signal, AbortSignal.timeout(35_000)];
      if (readDeadline) signals.push(readDeadline);
      if (init?.signal) signals.push(init.signal);
      if (input instanceof Request) signals.push(input.signal);
      const signal = AbortSignal.any(signals);
      const response = await fetch(input, { ...init, signal });
      signal.throwIfAborted();
      if (response.status === 403 || response.status === 404 || response.status === 410) {
        await grantFor(replica, true);
        reportFailure(new RoostCloudHistoryRequestError(response.status));
      }
      return response;
    };
    const auth = async (context?: { reason: string }) => {
      const current = await grantFor(replica, context?.reason === 'unauthorized');
      if (current.streamUrl !== url) throw new Error('Roost read grant changed stream');
      return current.token;
    };
    replica.transport = new StreamsTransport(url, auth, fetchWithLifetime);
    replica.streamClient = new StreamsClient({ url, auth, fetch: fetchWithLifetime });
    replica.link = Link.openPartial(
      replica.lease.storage,
      replica.stream,
      scope,
      linkLimitsForSync()
    );
    replica.reader = HistoryReader.openPartial(
      replica.lease.storage,
      replica.stream,
      scope,
      linkLimitsForSync()
    );
    replica.endpoint = url;
  };

  const readHistoryIdentity = async (replica: Replica, turnId: Uint8Array) => {
    try {
      const { value } = await replica.stream.readValue(turnId, [{ key: 'lodyHistory' }]);
      return value instanceof Map ? value : undefined;
    } catch (error) {
      if (!(error instanceof StoreError && error.code === 'invalid')) throw error;
    }
  };

  const changes = async (replica: Replica) => {
    const ids = new Set<string>();
    let structure = false;
    let cursor = replica.eventCursor;
    for (;;) {
      assertLive();
      const events = await replica.stream.eventsAfter(cursor, 128);
      if (!events.length) break;
      for (const { event } of events) {
        if (event.kind !== 'changed') continue;
        if (event.update.seq === 0n) {
          structure = true;
          continue;
        }
        const identity = await readHistoryIdentity(replica, event.update.turnId);
        if (identity?.get('kind') === 'message') {
          const id = identity.get('businessId');
          if (typeof id === 'string') ids.add(id);
        }
      }
      cursor = events.at(-1)!.cursor;
      if (events.length < 128) break;
    }
    await replica.history.catchUpIndex();
    replica.eventCursor = cursor;
    if (structure) {
      bodies.clear();
      positions.clear();
      lastBranchRevision = undefined;
      for (const listener of listeners)
        listener({ kind: 'structure', from: 0, to: Number.MAX_SAFE_INTEGER });
    } else if (ids.size) {
      for (const id of ids) {
        const cached = bodies.get(id);
        if (cached) cached.dirty = true;
      }
      for (const listener of listeners) listener({ kind: 'changed', ids: [...ids] });
    }
  };

  const fetchOlder = async (replica: Replica): Promise<void> => {
    await connect(replica);
    if (replica.meta.bootstrapped && replica.meta.reachedStart)
      throw new Error('Roost history is incomplete at the start of the remote stream');
    let budget = WINDOW_BYTES;
    for (;;) {
      let originalTail: string | undefined;
      const source = {
        readBackward: async (from: string | undefined, limit: number) => {
          const page = await replica.transport!.readBackward(from, limit);
          originalTail ??= page.endOffset;
          return page;
        },
      };
      const before = replica.meta.bootstrapped ? replica.meta.before : undefined;
      const report = await replica.reader!.fetchWindow(
        source,
        budget,
        Math.min(budget, WINDOW_BYTES),
        stop,
        { before, completePrefixes: false }
      );
      assertLive();
      if (report.stopped) throw new Error('Roost history window was interrupted');
      if (!report.fetchedRange && !report.reachedStart) {
        if (budget >= MAX_WINDOW_BYTES)
          throw new Error('Roost history message exceeds the supported window size');
        budget = Math.min(MAX_WINDOW_BYTES, budget * 2);
        continue;
      }
      const tail = report.fetchedRange?.[1] ?? originalTail;
      if ((await replica.link!.position()) === undefined) {
        if (tail === undefined) throw new Error('Roost history window has no tail boundary');
        await replica.link!.catchUpAt(tail);
      }
      replica.forwardOffset = await replica.link!.position();
      replica.meta = {
        ...replica.meta,
        bootstrapped: true,
        reachedStart: report.reachedStart,
        before: report.fetchedRange?.[0] ?? replica.meta.before,
      };
      await persistMeta(replica);
      await changes(replica);
      return;
    }
  };

  const completePrefixes = async (replica: Replica): Promise<HistoryReport> => {
    await connect(replica);
    const report = await replica.reader!.completePrefixes(
      replica.transport!,
      WINDOW_BYTES,
      WINDOW_BYTES,
      stop
    );
    assertLive();
    if (report.stopped) throw new Error('Roost history prefix repair was interrupted');
    await changes(replica);
    return report;
  };

  const syncForward = async (replica: Replica, targetOffset?: bigint) => {
    await connect(replica);
    if (!replica.meta.bootstrapped || (await replica.link!.position()) === undefined)
      await fetchOlder(replica);
    const report = await replica.link!.downloadCycle(
      {
        readOnce: async (offset) => {
          const received = replica.livePage;
          replica.livePage = undefined;
          if (received && received.offset === offset) return received.page;
          return await replica.transport!.readOnce(offset);
        },
      },
      1,
      stop
    );
    assertLive();
    replica.forwardOffset = await replica.link!.position();
    await changes(replica);
    if (await replica.reader!.prefixScan()) {
      const prefixes = await completePrefixes(replica);
      if (await replica.reader!.prefixScan()) {
        if (prefixes.reachedStart)
          throw new Error('Roost history has a missing prefix at the start of the remote stream');
        return false;
      }
    }
    const applied = byteOffset(replica.forwardOffset);
    if (targetOffset !== undefined && applied !== undefined) {
      if (applied >= targetOffset) return true;
      if (report.upToDate)
        throw new Error('Roost history reached the stream tail before the captured offset');
      return false;
    }
    return report.upToDate;
  };

  const atPublishedTail = async <T>(operation: (replica: Replica) => Promise<T>) =>
    run(async () => {
      stopWaiting();
      const replica = await open();
      return await network(replica, async () => {
        await connect(replica);
        const head = await replica.streamClient!.head({ signal: readDeadline });
        if (!head.ok) failStreamRead(head.result);
        const targetOffset = byteOffset(head.result.nextOffset);
        while (!(await syncForward(replica, targetOffset))) assertLive();
        const result = await operation(replica);
        report('ready');
        options.onSyncState?.({ checkpoint: checkpoint(replica) });
        return result;
      });
    }).finally(() => schedule());

  const waitAtTail = (replica: Replica) => {
    const waiter = new AbortController();
    tailWait = waiter;
    void (async () => {
      const offset = await replica.link?.position();
      if (!offset || !replica.streamClient) return;
      const started = Date.now();
      const received = await replica.streamClient.readOnce({
        offset,
        live: 'long-poll',
        signal: waiter.signal,
      });
      waiter.signal.throwIfAborted();
      if (!received.ok) {
        if (received.result.code === 'timeout' && Date.now() - started >= 5_000) return;
        failStreamRead(received.result);
      }
      const { payload, nextOffset, upToDate, closed } = received.result;
      replica.livePage = {
        offset,
        page: { payload: payload?.body ?? new Uint8Array(), nextOffset, upToDate, closed },
      };
    })().then(
      () => {
        if (tailWait !== waiter) return;
        tailWait = undefined;
        schedule();
      },
      (error: unknown) => {
        if (tailWait !== waiter) return;
        tailWait = undefined;
        if (!grantWasReplaced(replica.meta.binding)) reportFailure(error);
        if (terminal) return;
        failures++;
        options.onSyncState?.({ reason: 'roost_cloud_sync_unavailable' });
        schedule(Math.min(30_000, 500 * 2 ** Math.min(failures, 6)));
      }
    );
  };

  const stopWaiting = () => {
    const waiting = tailWait;
    tailWait = undefined;
    waiting?.abort();
  };

  const schedule = (delay = 0) => {
    if (abort.signal.aborted || terminal || !listeners.size) return;
    requested = true;
    if (background) return;
    stopWaiting();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      background = true;
      requested = false;
      let caughtUp = false;
      let syncedReplica: Replica | undefined;
      void run(async () => {
        const replica = await open();
        caughtUp = await network(replica, async () => await syncForward(replica));
        if (caughtUp) {
          syncedReplica = replica;
          const page = await replica.history.readActiveBranchPage(options.sessionId, {
            latest: true,
            limit: PAGE_SIZE,
          });
          if (page.complete) {
            report('ready');
            options.onSyncState?.({ checkpoint: checkpoint(replica) });
          }
        } else {
          report('syncing');
        }
        failures = 0;
      })
        .catch((error) => {
          reportFailure(error);
          if (!abort.signal.aborted && !terminal) {
            failures++;
            options.onSyncState?.({ reason: 'roost_cloud_sync_unavailable' });
          }
        })
        .finally(() => {
          background = false;
          if (abort.signal.aborted || terminal || !listeners.size) return;
          if (!requested && !failures && syncedReplica) waitAtTail(syncedReplica);
          else schedule(failures ? Math.min(30_000, 500 * 2 ** Math.min(failures, 6)) : 0);
        });
    }, delay);
  };

  const project = (messages: readonly HistoryProjectedMessage[]): SessionEntry[] => [
    ...projectRoostSegments(
      messages.map((row) => ({
        businessId: row.businessId,
        segmentId: row.segmentId,
        content: toApplicationJson(row.content),
        nextSeq: row.nextSeq,
        sealed: row.sealed,
      }))
    ),
  ];

  const checkpoint = (replica: Replica) =>
    JSON.stringify([
      replica.meta.binding.ownerPublicKey,
      replica.meta.binding.generation,
      replica.forwardOffset,
    ]);

  const remember = (replica: Replica, page: ActiveBranchPageRead): SessionHistoryDirectoryPage => {
    if (lastBranchRevision !== undefined && lastBranchRevision !== page.state.revision) {
      bodies.clear();
      positions.clear();
    }
    lastBranchRevision = page.state.revision;
    totalCount = page.totalCount;
    const entries = project(page.messages);
    const rows = entries.map((turn, index) => {
      const position = page.startPosition + index;
      bodies.delete(turn.id);
      bodies.set(turn.id, {
        turn,
        position,
        dirty: false,
        segments: page.messages
          .filter((segment) => segment.businessId === turn.id)
          .map((segment) => segment.turnId),
      });
      positions.set(position, turn.id);
      return createRoostDirectoryRow(position, turn);
    });
    while (bodies.size > 500) {
      const id = bodies.keys().next().value!;
      const cached = bodies.get(id)!;
      bodies.delete(id);
      if (positions.get(cached.position) === id) positions.delete(cached.position);
    }
    let cursor: string | null = null;
    if (page.cursor) {
      cursor = `roost-replica:${++nextCursor}`;
      cursors.set(cursor, page.cursor);
      while (cursors.size > 256) cursors.delete(cursors.keys().next().value!);
    }
    return {
      checkpoint: checkpoint(replica),
      startPosition: page.startPosition,
      totalCount: page.totalCount,
      rows,
      hasMoreOlder: page.hasMoreOlder,
      cursor,
    };
  };

  const page = async (
    replica: Replica,
    input: { latest?: boolean; before?: ActiveBranchPageCursor; limit: number },
    exclusive = false
  ): Promise<SessionHistoryDirectoryPage> => {
    const readRemote = <T>(operation: () => Promise<T>) =>
      exclusive ? operation() : network(replica, operation);
    for (;;) {
      assertLive();
      const result = await replica.history.readActiveBranchPage(options.sessionId, input);
      if (result.complete && (result.state.revision > 0n || replica.meta.reachedStart)) {
        schedule();
        return remember(replica, result);
      }
      if (!replica.meta.bootstrapped) {
        await readRemote(() => fetchOlder(replica));
        continue;
      }
      const prefixes = await readRemote(() => completePrefixes(replica));
      if (prefixes.bytesFetched > 0) continue;
      await readRemote(() => fetchOlder(replica));
    }
  };

  const latest = (replica: Replica, limit = PAGE_SIZE) => page(replica, { latest: true, limit });
  const older = async (
    replica: Replica,
    cursor: string,
    limit: number
  ): Promise<SessionHistoryDirectoryPage> => {
    const before = cursors.get(cursor);
    if (!before) throw new Error('Roost history page cursor has expired');
    try {
      return await page(replica, { before, limit });
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'stale') throw error;
      let current = await latest(replica, limit);
      while (current.startPosition > before.position && current.cursor)
        current = await older(replica, current.cursor, limit);
      return current;
    }
  };

  const ensurePosition = async (
    replica: Replica,
    position: number
  ): Promise<CachedTurn | undefined> => {
    if (!Number.isSafeInteger(position) || position < 0) return undefined;
    let id = positions.get(position);
    if (id) return bodies.get(id);
    let current = await latest(replica);
    if (position >= current.totalCount) return undefined;
    while (position < current.startPosition && current.cursor)
      current = await older(replica, current.cursor, PAGE_SIZE);
    id = positions.get(position);
    return id ? bodies.get(id) : undefined;
  };
  const readCached = async (
    replica: Replica,
    cached: CachedTurn | undefined
  ): Promise<SessionTurnRead> => {
    if (!cached) return { state: 'missing' };
    if (cached.dirty) {
      const entries = project(await replica.history.readProjectedMessagesById(cached.segments));
      if (entries.length !== 1 || entries[0]!.id !== cached.turn.id)
        throw new Error('Roost history segment projection is incomplete');
      cached.turn = entries[0]!;
      cached.dirty = false;
    }
    return { state: 'ready', turn: structuredClone(cached.turn) as SessionTurn };
  };
  const findTurn = async (replica: Replica, id: string): Promise<CachedTurn | undefined> => {
    const found = bodies.get(id);
    if (found) return found;
    let current = await latest(replica);
    for (;;) {
      const cached = bodies.get(id);
      if (cached) return cached;
      if (!current.cursor) return undefined;
      current = await older(replica, current.cursor, PAGE_SIZE);
    }
  };

  const hasLiveWindowGrant = () =>
    !forceGrant &&
    !pendingGrant &&
    currentBinding !== undefined &&
    latestGrant !== undefined &&
    Date.now() < latestGrant.expires &&
    sameBinding(currentBinding, latestGrant.value.binding);

  const cachedRange = (from: number, to: number): CachedTurn[] | undefined => {
    assertOpen();
    if (!hasLiveWindowGrant()) return;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to))
      throw new Error('Invalid Roost history range');
    if (lastBranchRevision === undefined) return undefined;
    const result: CachedTurn[] = [];
    for (let position = Math.max(0, from); position < Math.min(to, totalCount); position++) {
      const id = positions.get(position);
      const cached = id ? bodies.get(id) : undefined;
      if (!cached || cached.dirty) return undefined;
      result.push(cached);
    }
    return result;
  };

  const fillBranch = async (replica: Replica) => {
    if (!replica.meta.bootstrapped) return await fetchOlder(replica);
    const prefixes = await completePrefixes(replica);
    if (prefixes.bytesFetched) return;
    if (replica.meta.reachedStart) throw new Error('Published Roost history is incomplete');
    await fetchOlder(replica);
  };

  const metadataSuperseded = () => new Error('Roost history observation was superseded');

  const readMetadataRows = async (): Promise<SessionDirectoryRow[] | undefined> => {
    const pages: SessionDirectoryRow[][] = [];
    const changed = new Set<string>();
    let observation: { replica: Replica; through: bigint } | undefined;
    let before: ActiveBranchPageCursor | undefined;
    do {
      const next = await run(async () => {
        const replica = await open();
        if (observation && observation.replica !== replica) throw metadataSuperseded();
        return await network(replica, async () => {
          const through = await replica.history.observedEventCursor();
          const page = await replica.history.readActiveBranchPage(options.sessionId, {
            ...(before ? { before } : { latest: true }),
            limit: PAGE_SIZE,
          });
          if (!page.complete || (page.state.revision === 0n && !replica.meta.reachedStart)) {
            await fillBranch(replica);
            return;
          }
          // The SDK cursor verifies the branch prefix. Check for later writes
          // to the physical segments still needed to read that prefix.
          for (let after = observation?.through ?? through; after < through;) {
            const events = await replica.stream.eventsAfter(after, 128);
            if (!events.length) throw metadataSuperseded();
            for (const { cursor, event } of events) {
              if (cursor > through) break;
              if (event.kind !== 'changed') continue;
              const { turnId, seq } = event.update;
              if (seq === 0n) {
                const identity = await readHistoryIdentity(replica, turnId);
                if (identity?.get('kind') === 'branch_state') throw metadataSuperseded();
              }
              changed.add(hex(turnId));
            }
            after = events.at(-1)!.cursor;
          }
          // Readers without Web Locks may see another replica commit during
          // this page. Reopen the observation before accepting those rows.
          if ((await replica.stream.eventsAfter(through, 1)).length) return;
          if (page.messages.some((message) => changed.has(hex(message.turnId))))
            throw metadataSuperseded();
          const rows = project(page.messages).map((entry, index) =>
            createRoostDirectoryRow(page.startPosition + index, entry)
          );
          const end = before ? before.position + 1 : page.totalCount;
          if (
            page.startPosition + rows.length !== end ||
            (page.cursor?.position ?? -1) !== page.startPosition - 1
          )
            throw metadataSuperseded();
          return { replica, through, rows, cursor: page.cursor };
        });
      });
      if (!next) return;
      pages.push(next.rows);
      observation = { replica: next.replica, through: next.through };
      before = next.cursor ?? undefined;
    } while (before);
    return pages.reverse().flat();
  };

  const readLatestWindow = (limit = PAGE_SIZE) =>
    run(async () => {
      stopWaiting();
      return await latest(await open(), limit);
    }).finally(() => schedule());

  const history: SessionHistoryReader = {
    count: () => {
      assertOpen();
      return hasLiveWindowGrant() && lastBranchRevision !== undefined
        ? totalCount
        : run(async () => (await latest(await open())).totalCount);
    },
    readAt: (position) => {
      assertOpen();
      const id = positions.get(position);
      const cached = id ? bodies.get(id) : undefined;
      if (hasLiveWindowGrant() && cached && !cached.dirty)
        return { state: 'ready', turn: structuredClone(cached.turn) as SessionTurn };
      return run(async () => {
        const replica = await open();
        return await readCached(replica, await ensurePosition(replica, position));
      });
    },
    readTurn: (id) => {
      assertOpen();
      const cached = bodies.get(id);
      if (hasLiveWindowGrant() && cached && !cached.dirty)
        return { state: 'ready', turn: structuredClone(cached.turn) as SessionTurn };
      return run(async () => {
        const replica = await open();
        return await readCached(replica, await findTurn(replica, id));
      });
    },
    readRange: (from, to) => {
      const cached = cachedRange(from, to);
      if (cached)
        return cached.map(({ turn }) => ({
          state: 'ready' as const,
          turn: structuredClone(turn) as SessionTurn,
        }));
      return run(async () => {
        const replica = await open();
        const result: SessionTurnRead[] = [];
        const count =
          lastBranchRevision === undefined ? (await latest(replica)).totalCount : totalCount;
        for (let i = Math.max(0, from); i < Math.min(to, count); i++)
          result.push(await readCached(replica, await ensurePosition(replica, i)));
        return result;
      });
    },
    readDirectory: (from, to) => {
      const cachedWindow = cachedRange(from, to);
      if (cachedWindow)
        return cachedWindow.map(({ position, turn }) => createRoostDirectoryRow(position, turn));
      return run(async () => {
        const replica = await open();
        const result: SessionDirectoryRow[] = [];
        const count =
          lastBranchRevision === undefined ? (await latest(replica)).totalCount : totalCount;
        for (let i = Math.max(0, from); i < Math.min(to, count); i++) {
          const cached = await ensurePosition(replica, i);
          const read = await readCached(replica, cached);
          if (read.state === 'ready' && cached)
            result.push(createRoostDirectoryRow(i, cached.turn));
        }
        return result;
      });
    },
    readLatestDirectoryPage: readLatestWindow,
    readOlderDirectoryPage: (cursor, limit) =>
      run(async () => await older(await open(), cursor, limit)),
    readMetadata: async () => {
      for (;;) {
        const rows = await readMetadataRows();
        if (rows) return await readSessionHistoryMetadata({ readDirectory: () => rows });
      }
    },
    readAll: () =>
      run(async () => {
        const replica = await open();
        await latest(replica);
        return readComplete(replica);
      }),
    readTurnOutput: (userTurnId) =>
      run(async () => {
        const replica = await open();
        const user = await findTurn(replica, userTurnId);
        if (!user) return [];
        const selected: SessionEntry[] = [];
        const userRead = await readCached(replica, user);
        if (userRead.state !== 'ready' || userRead.turn.role !== 'user') return [];
        selected.push(user.turn);
        for (let i = user.position + 1; i < totalCount; i++) {
          const cached = await ensurePosition(replica, i);
          const read = await readCached(replica, cached);
          if (read.state !== 'ready' || !cached) continue;
          const turn = cached.turn;
          if (
            turn.role === 'assistant' &&
            turn.userTurnId === userTurnId &&
            !selected.some((row) => row.role === 'assistant')
          ) {
            selected.push(turn);
            if (userRead.turn.status !== 'failed') break;
          } else if (userRead.turn.status === 'failed' && turn.role === 'system')
            selected.push(turn);
        }
        return structuredClone(
          selectTurnOutput(
            selected.length,
            userTurnId,
            (index) => selected[index],
            (index) => selected[index]
          )
        );
      }),
    observe: (listener) => {
      listeners.add(listener);
      const initialPage = readLatestWindow();
      return {
        initialPage,
        initial: initialPage.then((value) => value.rows),
        unsubscribe: () => {
          listeners.delete(listener);
          if (!listeners.size) stopWaiting();
          if (!listeners.size && timer) {
            clearTimeout(timer);
            timer = undefined;
          }
        },
      };
    },
  };

  const readComplete = async (replica: Replica, exclusive = false): Promise<SessionEntry[]> => {
    for (;;) {
      assertLive();
      const branch = await replica.history.readActiveBranch(options.sessionId);
      if (branch.complete) return structuredClone(project(branch.messages));
      if (exclusive) await fillBranch(replica);
      else await network(replica, () => fillBranch(replica));
    }
  };

  let hint: RoostCloudHistoryBinding | undefined;
  const unsubscribeBinding = options.observeBinding(() => {
    const current = options.getBinding();
    const changed = current ? !hint || !sameBinding(current, hint) : hint !== undefined;
    if (!changed) return;
    hint = current;
    forceGrant = true;
    for (const listener of publicationListeners) listener();
    schedule();
  });
  hint = options.getBinding();
  const online = () => schedule();
  globalThis.addEventListener?.('online', online);

  return {
    history,
    watchPublication(listener) {
      publicationListeners.add(listener);
      return () => publicationListeners.delete(listener);
    },
    syncStatus: () => status,
    ownerReadAllowed: () => canReadRoostHistoryFromOwnerAfter(readFailure),
    watchSyncStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    prepareLatestWindow: () =>
      atPublishedTail(async (replica) => {
        await page(replica, { latest: true, limit: PAGE_SIZE }, true);
      }),
    readPublishedSnapshot: () => atPublishedTail((replica) => readComplete(replica, true)),
    refresh: () => schedule(),
    dispose: () => {
      if (abort.signal.aborted) return;
      abort.abort();
      stopWaiting();
      unsubscribeBinding();
      globalThis.removeEventListener?.('online', online);
      if (timer) clearTimeout(timer);
      listeners.clear();
      publicationListeners.clear();
      statusListeners.clear();
      bodies.clear();
      positions.clear();
      cursors.clear();
      void serial
        .then(async () => {
          if (opened) await (await opened).lease.release();
        })
        .catch((error) => console.warn('Roost history replica close failed', error));
    },
  };
}

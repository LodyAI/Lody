import { IndexedDbStorage, Store, StoreError, type Stream } from '@loro-dev/roost';
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
  Link,
  RemoteRegistry,
  StreamsTransport,
  linkLimitsForSync,
  type HistoryReport,
} from '@loro-dev/roost/sync';
import {
  createLoroStreamUrl,
  getRoostHistoryStreamId,
  LORO_STREAMS_BUCKET_ID,
  parseRoostHistoryRemoteBinding,
  type RoostStreamsConnection,
  type SessionId,
  type SessionRoostHistoryRemoteDocState,
  type WorkspaceId,
} from '@lody/shared';
import {
  createRoostDirectoryRow,
  projectRoostSegments,
  selectTurnOutput,
  type SessionDataChangeListener,
  type SessionDirectoryRow,
  type SessionEntry,
  type SessionHistoryDirectoryPage,
  type SessionHistoryReader,
  type SessionTurn,
  type SessionTurnRead,
} from '@lody/shared/session-data';
import type { LoroDoc } from 'loro-crdt';
import { rememberRoostReplicaDatabase } from './roost-history-cache';

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

async function acquireDatabase(name: string): Promise<DatabaseLease> {
  let entry = databases.get(name);
  if (!entry) {
    const closing = closingDatabases.get(name);
    entry = {
      refs: 0,
      ready: (async () => {
        await closing;
        rememberRoostReplicaDatabase(name);
        const storage = await IndexedDbStorage.open(name);
        const owners = new Map<string, string>();
        const store = new Store(storage, (stream, owner) => owners.get(stream) === hex(owner), {
          clock: () => BigInt(Date.now()),
          randomBytes: () => globalThis.crypto.getRandomValues(new Uint8Array(16)),
        });
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
  binding: SessionRoostHistoryRemoteDocState;
  bootstrapped: boolean;
  reachedStart: boolean;
  before?: string;
  remoteId?: string;
  endpoint?: string;
};

function readReplicaMeta(value: unknown, expected: SessionRoostHistoryRemoteDocState): ReplicaMeta {
  if (!value || typeof value !== 'object') throw new Error('Invalid Roost replica metadata');
  const row = value as Record<string, unknown>;
  const binding = parseRoostHistoryRemoteBinding(row.binding);
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

type Replica = {
  lease: DatabaseLease;
  stream: Stream;
  history: LodyHistory;
  meta: ReplicaMeta;
  eventCursor: bigint;
  link?: Link;
  reader?: HistoryReader;
  transport?: StreamsTransport;
  connection?: RoostStreamsConnection;
};
type CachedTurn = { position: number; turn: SessionEntry; segments: Uint8Array[]; dirty: boolean };

export type RoostHistoryReplicaOptions = {
  readonly accountId?: string | null;
  readonly workspaceId: WorkspaceId;
  readonly replicaNamespace: string;
  readonly sessionId: SessionId;
  readonly doc: LoroDoc;
  readonly getConnection: () => Promise<RoostStreamsConnection>;
};

/** A read-only native Roost replica. Owner RPC remains the write authority;
 * this reader never manufactures an identity, outbox, or remote acknowledgement. */
export function createRoostHistoryReplica(options: RoostHistoryReplicaOptions): {
  history: SessionHistoryReader;
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
  const bindingWaiters = new Set<() => void>();
  const bodies = new Map<string, CachedTurn>();
  const positions = new Map<number, string>();
  const cursors = new Map<string, ActiveBranchPageCursor>();
  let nextCursor = 0;
  let opened: Promise<Replica> | undefined;
  let serial: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let background = false;
  let requested = false;
  let failures = 0;
  let lastBranchRevision: bigint | undefined;
  let totalCount = 0;

  const assertLive = () => {
    if (abort.signal.aborted) throw new Error('Roost history replica is disposed');
  };
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = serial.then(async () => {
      assertLive();
      if (opened) await changes(await opened);
      return await operation();
    });
    serial = result.catch(() => {});
    return result;
  };
  const bindingNow = () => {
    const value = options.doc.getMap('roostHistoryRemote').toJSON();
    // The root can be absent while its control document is still joining.
    return Object.keys(value).length ? parseRoostHistoryRemoteBinding(value) : undefined;
  };

  const waitForBinding = async (): Promise<SessionRoostHistoryRemoteDocState> => {
    const current = bindingNow();
    if (current) return current;
    return await new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timeout);
        bindingWaiters.delete(check);
        abort.signal.removeEventListener('abort', cancelled);
        if (error) reject(error);
      };
      const check = () => {
        try {
          const binding = bindingNow();
          if (binding) {
            finish();
            resolve(binding);
          }
        } catch (error) {
          finish(error);
        }
      };
      const cancelled = () => finish(new Error('Roost history replica is disposed'));
      const timeout = setTimeout(
        () => finish(new Error('Roost history remote binding has not synchronized')),
        20_000
      );
      bindingWaiters.add(check);
      abort.signal.addEventListener('abort', cancelled, { once: true });
      if (abort.signal.aborted) cancelled();
      else check();
    });
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
        const binding = await waitForBinding();
        assertLive();
        const name = `lody-roost-replica-${JSON.stringify([options.accountId ?? 'local', options.workspaceId, options.replicaNamespace])}`;
        const lease = await acquireDatabase(name);
        try {
          assertLive();
          const stream = lease.store.stream(`lody-session:${options.sessionId}`);
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
      // Primary browser tabs share the persisted replica. Serialize intake
      // where Web Locks is available, and reload its hints AFTER acquiring
      // the lock. Native Inbox/Replay CAS remains the durability boundary.
      const space = replica.stream.space('lody_remote_reader_v1');
      const raw = await replica.lease.storage.transact(false, function* (tx) {
        return yield* tx.get(space, new Uint8Array());
      });
      if (raw) {
        const meta = readReplicaMeta(JSON.parse(decoder.decode(raw)), replica.meta.binding);
        if (meta.remoteId !== replica.meta.remoteId || meta.endpoint !== replica.meta.endpoint)
          replica.connection = undefined;
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
      return await navigator.locks.request(key, { signal: abort.signal }, perform);
    }
    return await perform();
  };

  const connect = async (replica: Replica) => {
    const connection = await options.getConnection();
    assertLive();
    if (connection.signal.aborted) throw new Error('Roost Streams access was revoked');
    const binding = bindingNow();
    if (
      !binding ||
      binding.generation !== replica.meta.binding.generation ||
      binding.ownerPublicKey !== replica.meta.binding.ownerPublicKey
    ) {
      throw new Error('Roost history binding changed');
    }
    if (replica.connection === connection && replica.transport && replica.link && replica.reader)
      return;
    const physical = getRoostHistoryStreamId(
      options.workspaceId,
      options.sessionId,
      binding.generation
    );
    const url = createLoroStreamUrl({
      baseUrl: connection.baseUrl,
      bucketId: LORO_STREAMS_BUCKET_ID,
      streamId: physical,
    });
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
    const fetchWithLifetime: typeof fetch = (input, init) => {
      assertLive();
      const signals = [abort.signal, connection.signal, AbortSignal.timeout(20_000)];
      if (init?.signal) signals.push(init.signal);
      if (input instanceof Request) signals.push(input.signal);
      return fetch(input, { ...init, signal: AbortSignal.any(signals) });
    };
    replica.transport = new StreamsTransport(
      url,
      async (context) => {
        assertLive();
        if (connection.signal.aborted) throw new Error('Roost Streams access was revoked');
        return await connection.auth(context);
      },
      fetchWithLifetime
    );
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
    replica.connection = connection;
  };

  const changes = async (replica: Replica) => {
    const ids = new Set<string>();
    let structure = false;
    let cursor = replica.eventCursor;
    for (;;) {
      const events = await replica.stream.eventsAfter(cursor, 128);
      if (!events.length) break;
      for (const { event } of events) {
        if (event.kind !== 'changed') continue;
        if (event.update.seq === 0n) {
          structure = true;
          continue;
        }
        let identity;
        try {
          identity = (await replica.stream.readValue(event.update.turnId, [{ key: 'lodyHistory' }]))
            .value;
        } catch (error) {
          // Unknown application envelopes are not history rows. Storage or
          // admission errors still fail the read and retain its event cursor.
          if (error instanceof StoreError && error.code === 'invalid') continue;
          throw error;
        }
        if (identity instanceof Map && identity.get('kind') === 'message') {
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
        // This is the tail observed by THIS window, never a later HEAD.
        await replica.link!.catchUpAt(tail);
      }
      replica.meta = {
        ...replica.meta,
        bootstrapped: true,
        reachedStart: report.reachedStart,
        before: report.fetchedRange?.[0] ?? replica.meta.before,
      };
      // Receipts/imports and the initial catch-up position are durable first.
      // Losing this derived hint only causes a repeated, deduplicated window.
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

  const syncForward = async (replica: Replica) => {
    await connect(replica);
    if (!replica.meta.bootstrapped || (await replica.link!.position()) === undefined)
      await fetchOlder(replica);
    const report = await replica.link!.downloadCycle(replica.transport!, 1, stop);
    assertLive();
    await changes(replica);
    if (await replica.reader!.prefixScan()) {
      const prefixes = await completePrefixes(replica);
      if (await replica.reader!.prefixScan()) {
        if (prefixes.reachedStart)
          throw new Error('Roost history has a missing prefix at the start of the remote stream');
        return false;
      }
    }
    return report.upToDate;
  };

  const schedule = (delay = 0) => {
    if (abort.signal.aborted || !listeners.size) return;
    requested = true;
    if (background) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      background = true;
      requested = false;
      let caughtUp = false;
      void run(async () => {
        const replica = await open();
        caughtUp = await network(replica, async () => await syncForward(replica));
        failures = 0;
      })
        .catch((error) => {
          if (!abort.signal.aborted && failures++ === 0)
            console.warn('Roost history synchronization will retry', error);
        })
        .finally(() => {
          background = false;
          if (!abort.signal.aborted)
            schedule(
              requested || (!caughtUp && !failures)
                ? 0
                : failures
                  ? Math.min(30_000, 500 * 2 ** Math.min(failures, 6))
                  : 2_000
            );
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

  const remember = (page: ActiveBranchPageRead): SessionHistoryDirectoryPage => {
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
      startPosition: page.startPosition,
      totalCount: page.totalCount,
      rows,
      hasMoreOlder: page.hasMoreOlder,
      cursor,
    };
  };

  const page = async (
    replica: Replica,
    input: { latest?: boolean; before?: ActiveBranchPageCursor; limit: number }
  ): Promise<SessionHistoryDirectoryPage> => {
    for (;;) {
      assertLive();
      const result = await replica.history.readActiveBranchPage(options.sessionId, input);
      if (result.complete && (result.state.revision > 0n || replica.meta.reachedStart)) {
        schedule();
        return remember(result);
      }
      if (!replica.meta.bootstrapped) {
        await network(replica, async () => await fetchOlder(replica));
        continue;
      }
      const prefixes = await network(replica, async () => await completePrefixes(replica));
      if (prefixes.bytesFetched > 0) continue;
      await network(replica, async () => await fetchOlder(replica));
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
      // A replacement invalidates ancestry. Rebuild only the requested window
      // on the new branch; a stale cursor cannot resurrect a replaced suffix.
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

  const cachedRange = (from: number, to: number): CachedTurn[] | undefined => {
    assertLive();
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

  const history: SessionHistoryReader = {
    count: () => {
      assertLive();
      return lastBranchRevision === undefined
        ? run(async () => (await latest(await open())).totalCount)
        : totalCount;
    },
    readAt: (position) => {
      assertLive();
      const id = positions.get(position);
      const cached = id ? bodies.get(id) : undefined;
      if (cached && !cached.dirty)
        return { state: 'ready', turn: structuredClone(cached.turn) as SessionTurn };
      return run(async () => {
        const replica = await open();
        return await readCached(replica, await ensurePosition(replica, position));
      });
    },
    readTurn: (id) => {
      assertLive();
      const cached = bodies.get(id);
      if (cached && !cached.dirty)
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
    readLatestDirectoryPage: (limit) => run(async () => await latest(await open(), limit)),
    readOlderDirectoryPage: (cursor, limit) =>
      run(async () => await older(await open(), cursor, limit)),
    readAll: () =>
      run(async () => {
        const replica = await open();
        await latest(replica);
        for (;;) {
          const branch = await replica.history.readActiveBranch(options.sessionId);
          if (branch.complete) return structuredClone(project(branch.messages));
          const prefixes = await network(replica, async () => await completePrefixes(replica));
          if (!prefixes.bytesFetched) await network(replica, async () => await fetchOlder(replica));
        }
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
      assertLive();
      listeners.add(listener);
      const initialPage = run(async () => await latest(await open()));
      void initialPage.finally(() => schedule()).catch(() => {});
      return {
        initialPage,
        initial: initialPage.then((value) => value.rows),
        unsubscribe: () => {
          listeners.delete(listener);
          if (!listeners.size && timer) {
            clearTimeout(timer);
            timer = undefined;
          }
        },
      };
    },
  };

  const unsubscribeDoc = options.doc.subscribe((batch) => {
    if (batch.events.some((event) => String(event.path[0]) === 'roostHistoryRemote')) {
      for (const check of [...bindingWaiters]) check();
    }
    if (
      batch.events.some((event) =>
        ['roostHistoryCursor', 'roostHistoryRemote'].includes(String(event.path[0]))
      )
    )
      schedule();
  });
  const online = () => schedule();
  globalThis.addEventListener?.('online', online);

  return {
    history,
    refresh: () => schedule(),
    dispose: () => {
      if (abort.signal.aborted) return;
      abort.abort();
      unsubscribeDoc();
      globalThis.removeEventListener?.('online', online);
      if (timer) clearTimeout(timer);
      listeners.clear();
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

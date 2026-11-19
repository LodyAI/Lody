import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  connectEngine,
  connectSocketTransport,
  readEngineEndpoint,
} from '@loro-dev/loro-repo-client/node';
import type {
  FlockChangesUpdate,
  FlockKey,
  FlockRegisterEntry,
  FlockStateEntry,
  LoroUpdates,
  RepoClient,
  RoomKey,
} from '@loro-dev/loro-repo-client';
import { startProcessLegacy } from './process';
import { getLodyDataDir } from './installation-profile';

/** One engine directory per installation; namespaces are workspace ids. */
export const nativeRepoDataDir = () => join(getLodyDataDir('local'), 'native-repo', 'v1');

/** Explicit opt-in. Both daemon and desktop read the same variable. */
export const isNativeWorkspaceMetaEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.LODY_NATIVE_WORKSPACE_META === '1';

/** How this process starts the separate host when none is running. */
export interface NativeRepoHostLauncher {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

const RECONNECT_MAX_DELAY_MS = 2_000;
const START_WAIT_MS = 10_000;

async function openTransport(dataDir: string) {
  const endpoint = await readEngineEndpoint(dataDir);
  return connectSocketTransport(endpoint.socket);
}

/** The host owns its own lifetime (files.lock + idle exit); this process never stops it. */
function launchHost(dataDir: string, resolveLauncher: () => NativeRepoHostLauncher) {
  const launcher = resolveLauncher();
  const handle = startProcessLegacy({
    command: launcher.command,
    args: [...launcher.args, dataDir],
    options: { stdio: 'ignore', env: launcher.env ?? process.env },
    processGroup: true,
    windowsDetached: true,
  });
  handle.child.unref();
  // A losing duplicate host exits on ENGINE_BUSY; nothing waits for its exit.
  handle.child.once('error', () => {});
}

async function connectOrLaunch(dataDir: string, launcher: () => NativeRepoHostLauncher) {
  try {
    return await openTransport(dataDir);
  } catch {
    // Missing or stale endpoint: start a host and wait for its publication.
    launchHost(dataDir, launcher);
    const deadline = Date.now() + START_WAIT_MS;
    for (let delay = 25; ; delay = Math.min(delay * 2, 500)) {
      try {
        return await openTransport(dataDir);
      } catch (error) {
        if (String(error).includes('ENGINE_PROTOCOL_MISMATCH') || Date.now() > deadline)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}

/**
 * The process-wide connection. Every observation and command shares it. A lost
 * host is relaunched by whichever process reconnects first; reconnection never
 * gives up while the connection is open, so callers see only connected and
 * reconnecting states.
 */
export interface NativeRepoConnection {
  readonly client: RepoClient;
  readonly dataDir: string;
  close(): Promise<void>;
}

const connections = new Map<string, Promise<NativeRepoConnection>>();

export function connectNativeRepo(options: {
  /** Resolved only when a host must be started. */
  launcher: () => NativeRepoHostLauncher;
  dataDir?: string;
}): Promise<NativeRepoConnection> {
  const dataDir = options.dataDir ?? nativeRepoDataDir();
  const existing = connections.get(dataDir);
  if (existing) return existing;
  const opening = (async () => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    let closed = false;
    const reconnect = async () => {
      for (let delay = 25; ; delay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS)) {
        try {
          return await connectOrLaunch(dataDir, options.launcher);
        } catch (error) {
          if (closed || String(error).includes('ENGINE_PROTOCOL_MISMATCH')) throw error;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    };
    const clientOptions = { reconnect, queueWhileReconnecting: false };
    const client = await connectEngine(dataDir, clientOptions).catch(() => {
      launchHost(dataDir, options.launcher);
      return connectEngine(dataDir, { ...clientOptions, waitForEndpointMs: START_WAIT_MS });
    });
    const connection: NativeRepoConnection = {
      client,
      dataDir,
      async close() {
        closed = true;
        if (connections.get(dataDir) === opening) connections.delete(dataDir);
        await client.close();
      },
    };
    return connection;
  })();
  connections.set(dataDir, opening);
  // A failed attempt is never cached.
  opening.catch(() => {
    if (connections.get(dataDir) === opening) connections.delete(dataDir);
  });
  return opening;
}

export type FlockObservationEvent =
  | { kind: 'snapshot' | 'changes'; entries: FlockStateEntry[]; txId: number }
  | { kind: 'invalidated' };

/** Register mode: a complete Flock file, then changes with their clocks. */
export type FlockRegisterObservationEvent =
  | { kind: 'snapshot'; file: Uint8Array; txId: number }
  | { kind: 'changes'; registers: FlockRegisterEntry[]; txId: number }
  | { kind: 'invalidated' };

export interface FlockObservation {
  /** Resolves after the first snapshot was delivered. */
  readonly ready: Promise<void>;
  /** Waits until this observation has delivered `txId` from a local commit. */
  whenVisible(txId: number): Promise<void>;
  /** Stops callbacks at once, then confirms the engine-side release. */
  release(): Promise<void>;
}

const PAGE_BUDGET = { maxRows: 4096, maxBytes: 1024 * 1024 };
type Update = { kind: 'snapshot' | 'changes' | 'gap' };
type Opening = {
  handle: { release(): Promise<{ status: string }>; whenVisible(txId: number): Promise<void> };
  ready: Promise<unknown>;
};
type Loader<U> = (
  update: U,
  isCurrent: () => boolean
) => { buffer(update: U): void; run(): Promise<boolean> };

/**
 * The single observation lifecycle. The engine subscription starts at the head
 * without a snapshot, so no frame grows with the room; the loader then reads
 * initial state and merges changes that raced it. The view receives one
 * `snapshot`, followed by changes. Disconnect or a gap emits `invalidated`; the
 * SDK resubscribes after reconnect (and a gap is resubscribed here), and both
 * reload. Domains own no retry, release or reconnect state.
 */
function observe<U extends Update>(
  client: RepoClient,
  subscribe: (onUpdate: (update: U) => void) => Opening,
  load: Loader<U>,
  onChanges: (update: U) => void,
  onInvalidated: () => void
): FlockObservation {
  let active = true;
  let current: Opening | undefined;
  let loading: ReturnType<Loader<U>> | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});
  const stopState = client.onConnectionStateChange((state) => {
    if (active && state !== 'connected') onInvalidated();
  });
  const begin = () => {
    const opening: Opening = subscribe((update) => {
      if (!active || current !== opening) return;
      if (update.kind === 'gap') {
        onInvalidated();
        void opening.handle.release().catch(() => {});
        begin();
      } else if (update.kind === 'snapshot') {
        // Initial subscribe or SDK resubscription after reconnect: reload.
        const isCurrent = () => active && current === opening && loading === pending;
        const pending = load(update, isCurrent);
        loading = pending;
        void (async () => {
          // A resubscription snapshot arrives during the SDK's reconnect
          // resync, before ordinary reads are admitted.
          if (client.connectionState !== 'connected') await client.whenConnected();
          if (await pending.run()) {
            if (loading === pending) loading = undefined;
            resolveReady();
          }
        })().catch((error: unknown) => {
          if (!isCurrent()) return;
          rejectReady(error);
          onInvalidated();
        });
      } else if (loading) {
        loading.buffer(update);
      } else {
        onChanges(update);
      }
    });
    current = opening;
    opening.ready.catch((error: unknown) => {
      if (current === opening) rejectReady(error);
    });
  };
  begin();
  return {
    ready,
    whenVisible: (txId) => {
      if (!current) return Promise.reject(new Error('observation released'));
      return current.handle.whenVisible(txId);
    },
    async release() {
      active = false;
      stopState();
      const opening = current;
      if (!opening) return;
      const result = await opening.handle.release();
      if (result.status !== 'acknowledged' && client.connectionState === 'connected')
        throw new Error('native_repo_release_unconfirmed');
      current = undefined;
    },
  };
}

/**
 * Key-state view. Initial state is read in bounded pages, each a fresh query
 * at its own head; a change buffered during the load is kept only if it is
 * newer than the page that returned its key.
 */
export function observeFlock(
  client: RepoClient,
  namespace: string,
  room: RoomKey,
  prefix: FlockKey,
  listener: (event: FlockObservationEvent) => void
): FlockObservation {
  return observe<FlockChangesUpdate>(
    client,
    (onUpdate) =>
      client.beginFlockChangesSubscription(namespace, room, prefix, onUpdate, { snapshot: false }),
    (_update, isCurrent) => {
      const buffered: { entries: FlockStateEntry[]; txId: number }[] = [];
      return {
        buffer: (update) => buffered.push({ entries: update.entries, txId: update.roomTxId }),
        async run() {
          const pageHead = new Map<string, number>();
          const rows: FlockStateEntry[] = [];
          let start: FlockKey | undefined;
          let head = 0;
          for (;;) {
            const page = await client.flockScanPage(
              namespace,
              room,
              { prefix, ...(start ? { start: { bound: 'exclusive', key: start } } : {}) },
              PAGE_BUDGET
            );
            if (!isCurrent()) return false;
            for (const entry of page.entries) {
              pageHead.set(JSON.stringify(entry.key), page.roomTxId);
              rows.push(entry);
            }
            head = Math.max(head, page.roomTxId);
            if (page.eof) break;
            const last = page.entries.at(-1);
            if (!last) throw new Error('native_repo_page_without_progress');
            start = last.key;
          }
          const byKey = new Map(rows.map((row) => [JSON.stringify(row.key), row]));
          for (const change of buffered) {
            head = Math.max(head, change.txId);
            for (const entry of change.entries) {
              const key = JSON.stringify(entry.key);
              const seen = pageHead.get(key);
              if (seen === undefined || change.txId > seen) byKey.set(key, entry);
            }
          }
          listener({ kind: 'snapshot', entries: [...byKey.values()], txId: head });
          return true;
        },
      };
    },
    (update) => listener({ kind: 'changes', entries: update.entries, txId: update.txId }),
    () => listener({ kind: 'invalidated' })
  );
}

/**
 * Register view for an in-memory Flock replica. Initial state is the room's
 * complete raw export; changes carry clocks, so buffered and repeated changes
 * merge in any order.
 */
export function observeFlockRegisters(
  client: RepoClient,
  namespace: string,
  room: RoomKey,
  listener: (event: FlockRegisterObservationEvent) => void
): FlockObservation {
  return observe<FlockChangesUpdate>(
    client,
    (onUpdate) =>
      client.beginFlockChangesSubscription(namespace, room, [], onUpdate, {
        snapshot: false,
        registers: true,
      }),
    (_update, isCurrent) => {
      const buffered: FlockChangesUpdate[] = [];
      return {
        buffer: (update) => buffered.push(update),
        async run() {
          const { bytes, roomTxId } = await client.exportFlockRaw(namespace, room);
          if (!isCurrent()) return false;
          listener({ kind: 'snapshot', file: bytes, txId: roomTxId });
          const registers = buffered.flatMap((update) => update.registers ?? []);
          if (registers.length) listener({ kind: 'changes', registers, txId: roomTxId });
          return true;
        },
      };
    },
    (update) => listener({ kind: 'changes', registers: update.registers ?? [], txId: update.txId }),
    () => listener({ kind: 'invalidated' })
  );
}

/**
 * Loro document mode: the room's raw snapshot (with `since`, only the ops past
 * that version: `delta`), then binary updates.
 */
export type LoroDocObservationEvent =
  | { kind: 'snapshot'; file: Uint8Array; delta: boolean; txId: number }
  | { kind: 'changes'; updates: Uint8Array[]; txId: number }
  | { kind: 'invalidated' };

/**
 * Update view for an in-memory Loro replica. Initial state is the room's raw
 * export, or the ops past `since` for a replica that kept an earlier state;
 * buffered or repeated updates import in any order.
 */
export function observeLoroDoc(
  client: RepoClient,
  namespace: string,
  room: RoomKey,
  listener: (event: LoroDocObservationEvent) => void,
  since?: Readonly<Record<string, number>>
): FlockObservation {
  return observe<LoroUpdates>(
    client,
    (onUpdate) => client.beginLoroUpdatesSubscription(namespace, room, onUpdate),
    (_update, isCurrent) => {
      const buffered: Uint8Array[] = [];
      return {
        buffer: (update) => buffered.push(...update.updates),
        async run() {
          // A reload after reconnect also starts from `since`: the replica
          // still holds that state, so the ops past it are all it lacks.
          const { bytes, roomTxId } = since
            ? await client.exportLoroSince(namespace, room, since)
            : await client.exportLoroRaw(namespace, room);
          if (!isCurrent()) return false;
          listener({ kind: 'snapshot', file: bytes, delta: since !== undefined, txId: roomTxId });
          if (buffered.length) listener({ kind: 'changes', updates: buffered, txId: roomTxId });
          return true;
        },
      };
    },
    (update) => listener({ kind: 'changes', updates: update.updates, txId: update.txId }),
    () => listener({ kind: 'invalidated' })
  );
}

// ---------------------------------------------------------------------------
// Legacy replica migration

/** A legacy Flock replica's complete JSON export, tombstones and clocks included. */
export interface LegacyFlockBundle {
  readonly version: number;
  readonly entries: Readonly<Record<string, { readonly c: string; readonly d?: unknown }>>;
}

export const MIGRATIONS_ROOM: RoomKey = { kind: 'flock', id: 'lody-migrations' };

const PAGE = { maxRows: 4096, maxBytes: 1024 * 1024 };
const READ_CHUNK = 1024;

/** Canonical JSON for value comparison; object key order is not significant. */
const canonical = (value: unknown): string =>
  value !== null && typeof value === 'object'
    ? Array.isArray(value)
      ? `[${value.map(canonical).join(',')}]`
      : `{${Object.keys(value)
          .sort()
          .map(
            (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
          )
          .join(',')}}`
    : typeof value === 'bigint'
      ? value.toString()
      : JSON.stringify(value);
const stateOf = (entry: { deleted: boolean; value: unknown } | undefined) =>
  entry ? (entry.deleted ? 'deleted' : `=${canonical(entry.value)}`) : 'missing';
const legacyStateOf = (record: { d?: unknown }) =>
  'd' in record && record.d !== undefined ? `=${canonical(record.d)}` : 'deleted';

async function readStates(client: RepoClient, namespace: string, room: RoomKey, keys: string[]) {
  const states = new Map<string, string>();
  for (let i = 0; i < keys.length; i += READ_CHUNK) {
    const chunk = keys.slice(i, i + READ_CHUNK);
    const read = await client.flockReadMany(
      namespace,
      room,
      chunk.map((key) => ({ kind: 'key' as const, key: JSON.parse(key) as FlockKey })),
      PAGE
    );
    chunk.forEach((key, index) => states.set(key, stateOf(read.results[index]?.[0])));
  }
  return states;
}

/**
 * Legacy registers the native room does not cover, using bounded reads only.
 * A key whose native state equals the legacy state is covered. For any other
 * key, the legacy record is imported again: under LWW, an older record cannot
 * change a key that holds a newer register, so a changed key proves the first
 * import did not keep that register.
 */
export async function findUncoveredRegisters(
  client: RepoClient,
  namespace: string,
  room: RoomKey,
  bundle: LegacyFlockBundle
): Promise<string[]> {
  const native = new Map<string, string>();
  let start: FlockKey | undefined;
  for (;;) {
    const page = await client.flockScanPage(
      namespace,
      room,
      start ? { start: { bound: 'exclusive', key: start } } : {},
      PAGE
    );
    for (const entry of page.entries) native.set(JSON.stringify(entry.key), stateOf(entry));
    if (page.eof) break;
    const last = page.entries.at(-1);
    if (!last) throw new Error('native_repo_page_without_progress');
    start = last.key;
  }
  const differing = Object.entries(bundle.entries)
    .map(([key, record]) => [JSON.stringify(JSON.parse(key)), record] as const)
    .filter(([key, record]) => native.get(key) !== legacyStateOf(record));
  if (differing.length === 0) return [];
  const keys = differing.map(([key]) => key);
  const before = await readStates(client, namespace, room, keys);
  await client.importRoomState(namespace, room, {
    updates: [
      new TextEncoder().encode(
        JSON.stringify({ version: bundle.version, entries: Object.fromEntries(differing) })
      ),
    ],
    enqueueOutbox: false,
  });
  const after = await readStates(client, namespace, room, keys);
  return keys.filter((key) => before.get(key) !== after.get(key));
}

export type LegacyRoomImport = 'imported' | 'already-published';

/**
 * Freeze → import → verify → publish one legacy replica of a room. The caller
 * freezes the source: no legacy writer for that replica runs in native mode,
 * so the bundle is final. Import is an LWW merge that keeps tombstones, clocks
 * and unknown fields, so a retry after any failure is safe. The marker is
 * written only after coverage is proven; until then the source keeps being
 * offered. This is the room-level step a workspace import reuses.
 */
export async function importLegacyRoom(
  client: RepoClient,
  namespace: string,
  room: RoomKey,
  source: string,
  load: () => Promise<LegacyFlockBundle | undefined>
): Promise<LegacyRoomImport> {
  const marker = [room.kind, room.id, source];
  await client.createRoom(namespace, MIGRATIONS_ROOM, 'plaintext');
  if ((await client.flockGet(namespace, MIGRATIONS_ROOM, marker)).found) return 'already-published';
  await client.createRoom(namespace, room, 'plaintext');
  const bundle = await load();
  const entries = bundle ? Object.keys(bundle.entries).length : 0;
  if (bundle && entries > 0) {
    await client.importRoomState(namespace, room, {
      updates: [new TextEncoder().encode(JSON.stringify(bundle))],
      enqueueOutbox: false,
    });
    const missing = await findUncoveredRegisters(client, namespace, room, bundle);
    if (missing.length > 0)
      throw new Error(`native_room_migration_incomplete: ${missing.length} registers`);
  }
  await client.flockBatch(namespace, MIGRATIONS_ROOM, [
    { op: 'put', key: marker, value: { publishedAt: Date.now(), entries } },
  ]);
  return 'imported';
}

/**
 * Returns a source to legacy ownership: its marker is removed, so enabling the
 * native mode again re-imports that replica (an LWW merge of its newer edits).
 */
export async function unpublishLegacyRoom(
  client: RepoClient,
  namespace: string,
  room: RoomKey,
  source: string
) {
  await client.flockBatch(namespace, MIGRATIONS_ROOM, [
    { op: 'delete', key: [room.kind, room.id, source] },
  ]);
}

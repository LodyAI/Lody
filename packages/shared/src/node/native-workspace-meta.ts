import { META_ROOM, RepoRpcError } from '@loro-dev/loro-repo-client';
import type {
  FlockKey,
  FlockOp,
  RoomKey,
  FlockReadSelector,
  FlockStateEntry,
  JsonValue,
  RepoClient,
} from '@loro-dev/loro-repo-client';
import type {
  ExternalMetadataCommand,
  ExternalMetadataSnapshot,
  IncrementalExternalMetadataAdapter,
  IncrementalExternalMetadataUpdate,
  JsonObject,
  RepoDocMeta,
  RepoFlockDocMeta,
} from 'loro-repo';
import { observeFlock, type FlockObservation } from './native-repo';

/**
 * Native Workspace Meta uses the legacy Meta Flock layout unchanged, so the
 * migrated file and new writes share one keyspace: `e/<doc>` existence,
 * `m/<doc>/<field>` metadata, `f|ld/<doc>/...` and `ts/<doc>` body bookkeeping,
 * `ef/<flock>` existence and `efx/<flock>` expiry.
 */
const DOC_BODY_PREFIXES = ['m', 'f', 'ld'] as const;
const READ_BUDGET = { maxRows: 4096, maxBytes: 1024 * 1024 };
const MAX_CONFLICT_RETRIES = 4;

type DocState = { exists?: boolean; meta: JsonObject };
type FlockState = { exists?: boolean; expiresAtMs?: number };

/** Incremental projection; each entry touches one doc or Flock row. */
class Projection {
  readonly docs = new Map<string, DocState>();
  readonly flocks = new Map<string, FlockState>();
  apply(entries: readonly FlockStateEntry[], docIds: Set<string>, flockIds: Set<string>) {
    for (const entry of entries) {
      const [family, id, field] = entry.key;
      if (typeof id !== 'string') continue;
      if (family === 'e' && entry.key.length === 2) {
        const doc = this.doc(id);
        doc.exists = !entry.deleted && typeof entry.value === 'boolean' ? entry.value : undefined;
        docIds.add(id);
      } else if (family === 'm' && entry.key.length === 3 && typeof field === 'string') {
        const doc = this.doc(id);
        if (entry.deleted) delete doc.meta[field];
        // Meta values are JSON written by loro-repo; i64 bigints never occur here.
        else doc.meta[field] = entry.value as JsonObject[string];
        docIds.add(id);
      } else if (family === 'ef' && entry.key.length === 2) {
        this.flock(id).exists =
          !entry.deleted && typeof entry.value === 'boolean' ? entry.value : undefined;
        flockIds.add(id);
      } else if (family === 'efx' && entry.key.length === 2) {
        const value = entry.value;
        this.flock(id).expiresAtMs =
          !entry.deleted && typeof value === 'number' && Number.isFinite(value) && value >= 0
            ? value
            : undefined;
        flockIds.add(id);
      }
    }
  }
  private doc(id: string) {
    let doc = this.docs.get(id);
    if (!doc) this.docs.set(id, (doc = { meta: Object.create(null) as JsonObject }));
    return doc;
  }
  private flock(id: string) {
    let flock = this.flocks.get(id);
    if (!flock) this.flocks.set(id, (flock = {}));
    return flock;
  }
  docRow(id: string): RepoDocMeta<JsonObject> | undefined {
    const doc = this.docs.get(id);
    if (doc?.exists === undefined) return undefined;
    return { docId: id, deleted: !doc.exists, meta: { ...doc.meta } };
  }
  flockRow(id: string): RepoFlockDocMeta | undefined {
    const flock = this.flocks.get(id);
    if (flock?.exists === undefined) return undefined;
    return {
      flockDocId: id,
      deleted: !flock.exists,
      ...(flock.expiresAtMs === undefined ? {} : { expiresAtMs: flock.expiresAtMs }),
    };
  }
  snapshot(revision: number): ExternalMetadataSnapshot<JsonObject> {
    const docs: RepoDocMeta<JsonObject>[] = [];
    const flockDocs: RepoFlockDocMeta[] = [];
    for (const id of this.docs.keys()) {
      const row = this.docRow(id);
      if (row) docs.push(row);
    }
    for (const id of this.flocks.keys()) {
      const row = this.flockRow(id);
      if (row) flockDocs.push(row);
    }
    return { revision, docs, flockDocs };
  }
}

type Listener = (update: IncrementalExternalMetadataUpdate<JsonObject>) => void;

const selectorsFor = (command: ExternalMetadataCommand<JsonObject>): FlockReadSelector[] => {
  if ('flockDocId' in command)
    return [
      { kind: 'key', key: ['ef', command.flockDocId] },
      { kind: 'key', key: ['efx', command.flockDocId] },
    ];
  const id = command.docId;
  if (command.kind === 'purge-doc')
    return [
      { kind: 'key', key: ['e', id] },
      { kind: 'key', key: ['ts', id] },
      ...DOC_BODY_PREFIXES.map((family) => ({ kind: 'prefix' as const, prefix: [family, id] })),
    ];
  if (command.kind === 'upsert-doc')
    return [
      { kind: 'key', key: ['e', id] },
      ...Object.keys(command.patch).map((field) => ({
        kind: 'key' as const,
        key: ['m', id, field],
      })),
    ];
  return [{ kind: 'key', key: ['e', id] }];
};

const live = (rows: FlockStateEntry[] | undefined) => rows?.find((row) => !row.deleted);

/** Ops implementing the loro-repo external command semantics against the read. */
function opsFor(
  command: ExternalMetadataCommand<JsonObject>,
  results: FlockStateEntry[][]
): FlockOp[] {
  const exists = live(results[0])?.value;
  const known = typeof exists === 'boolean';
  if ('docId' in command) {
    const id = command.docId;
    switch (command.kind) {
      case 'ensure-doc':
        return known ? [] : [{ op: 'put', key: ['e', id], value: true }];
      case 'delete-doc':
        return exists === false ? [] : [{ op: 'put', key: ['e', id], value: false }];
      case 'restore-doc':
        return exists === false ? [{ op: 'put', key: ['e', id], value: true }] : [];
      case 'purge-doc':
        return results.flatMap((rows) =>
          rows.filter((row) => !row.deleted).map((row) => ({ op: 'delete' as const, key: row.key }))
        );
      case 'upsert-doc': {
        const ops: FlockOp[] = known ? [] : [{ op: 'put', key: ['e', id], value: true }];
        Object.entries(command.patch).forEach(([field, value], index) => {
          const current = live(results[index + 1]);
          if (value === undefined) {
            if (current) ops.push({ op: 'delete', key: ['m', id, field] });
          } else if (!current || JSON.stringify(current.value) !== JSON.stringify(value)) {
            ops.push({ op: 'put', key: ['m', id, field], value: value as JsonValue });
          }
        });
        return ops;
      }
    }
  }
  const id = command.flockDocId;
  const expiry = live(results[1])?.value;
  switch (command.kind) {
    case 'ensure-flock': {
      const ops: FlockOp[] = known ? [] : [{ op: 'put', key: ['ef', id], value: true }];
      const next = command.expiresAtMs;
      if (
        next !== undefined &&
        Number.isFinite(next) &&
        next >= 0 &&
        !(typeof expiry === 'number' && expiry >= next)
      )
        ops.push({ op: 'put', key: ['efx', id], value: next });
      return ops;
    }
    case 'delete-flock':
      return exists === false ? [] : [{ op: 'put', key: ['ef', id], value: false }];
    case 'restore-flock':
      return exists === false ? [{ op: 'put', key: ['ef', id], value: true }] : [];
    case 'purge-flock':
      return results.flatMap((rows) =>
        rows.filter((row) => !row.deleted).map((row) => ({ op: 'delete' as const, key: row.key }))
      );
  }
}

/** Type-only loro-repo use keeps its WASM out of the Electron main bundle. */
const INCREMENTAL_CAPABILITY = 'loro-external-metadata-v2' as const;

/** Builds the caller's proven-non-commit error (loro-repo's class in the daemon). */
export type NotCommitted = (reason: string) => Error;

export interface NativeWorkspaceMeta extends IncrementalExternalMetadataAdapter<JsonObject> {
  /** Releases the shared observation once every listener has unsubscribed. */
  close(): Promise<void>;
}

/**
 * Workspace Meta over the process-wide native connection. One observation per
 * workspace feeds every listener (a LoroRepo in the daemon, or each window in
 * main). Reads are bounded key/prefix reads; writes are read-set conditional.
 */
export function createNativeWorkspaceMeta(
  client: RepoClient,
  namespace: string,
  notCommitted: NotCommitted
): NativeWorkspaceMeta {
  const projection = new Projection();
  const listeners = new Set<Listener>();
  let revision = 0;
  let observation: FlockObservation | undefined;
  let opening: Promise<void> | undefined;

  const emit = (update: IncrementalExternalMetadataUpdate<JsonObject>) => {
    for (const listener of listeners) {
      try {
        listener(update);
      } catch {}
    }
  };

  const start = () =>
    (opening ??= (async () => {
      await client.createRoom(namespace, META_ROOM, 'plaintext');
      observation = observeFlock(client, namespace, META_ROOM, [], (event) => {
        if (event.kind === 'invalidated') return;
        const docIds = new Set<string>();
        const flockIds = new Set<string>();
        if (event.kind === 'snapshot') {
          projection.docs.clear();
          projection.flocks.clear();
        }
        projection.apply(event.entries, docIds, flockIds);
        revision += 1;
        if (event.kind === 'snapshot') {
          emit({ kind: 'snapshot', snapshot: projection.snapshot(revision), by: 'live' });
          return;
        }
        const docs: RepoDocMeta<JsonObject>[] = [];
        const removedDocIds: string[] = [];
        for (const id of docIds) {
          const row = projection.docRow(id);
          if (row) docs.push(row);
          else removedDocIds.push(id);
        }
        const flockDocs: RepoFlockDocMeta[] = [];
        const removedFlockDocIds: string[] = [];
        for (const id of flockIds) {
          const row = projection.flockRow(id);
          if (row) flockDocs.push(row);
          else removedFlockDocIds.push(id);
        }
        emit({
          kind: 'changes',
          changes: { revision, docs, flockDocs, removedDocIds, removedFlockDocIds },
          by: 'sync',
        });
      });
      await observation.ready;
    })().catch((error: unknown) => {
      opening = undefined;
      const failed = observation;
      observation = undefined;
      void failed?.release().catch(() => {});
      throw error;
    }));

  const commit = async (command: ExternalMetadataCommand<JsonObject>) => {
    await start();
    const selectors = selectorsFor(command);
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
      // Not sent while disconnected, so the outcome is a certain non-commit.
      if (client.connectionState !== 'connected') throw notCommitted('native_repo_disconnected');
      const read = await client.flockReadMany(namespace, META_ROOM, selectors, READ_BUDGET);
      const ops = opsFor(command, read.results);
      if (ops.length === 0) return { outcome: 'committed' as const, revision };
      let txId: number;
      try {
        txId = (await client.flockBatchConditional(namespace, META_ROOM, ops, read.readSet)).txId;
      } catch (error) {
        // A failed read-set check is reported before applying anything.
        if (error instanceof RepoRpcError && error.code === 'precondition_failed') continue;
        throw error;
      }
      await observation!.whenVisible(txId);
      return { outcome: 'committed' as const, revision };
    }
    throw notCommitted('native_meta_conflict');
  };

  return {
    capability: INCREMENTAL_CAPABILITY,
    async open(listener) {
      await start();
      listeners.add(listener);
      return {
        snapshot: projection.snapshot(revision),
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
    commit,
    // Each acknowledged native commit is already durable and visible.
    flush: async () => ({ outcome: 'committed' as const, revision }),
    async close() {
      listeners.clear();
      const current = observation;
      observation = undefined;
      opening = undefined;
      await current?.release();
    },
  };
}

// ---------------------------------------------------------------------------
// Legacy Meta migration

/** A legacy Flock replica's complete JSON export, tombstones and clocks included. */
export interface LegacyFlockBundle {
  readonly version: number;
  readonly entries: Readonly<Record<string, { readonly c: string; readonly d?: unknown }>>;
}

const MIGRATIONS_ROOM: RoomKey = { kind: 'flock', id: 'lody-migrations' };

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

export type LegacyMetaImport = 'imported' | 'already-published';

/**
 * Freeze → import → verify → publish for one legacy Meta source. The caller
 * freezes the source: no legacy writer for that replica runs in native mode,
 * so the bundle is final. Import is an LWW merge that keeps tombstones, clocks
 * and unknown fields, so a retry after any failure is safe. The marker is
 * written only after coverage is proven; until then the source keeps being
 * offered. This is the room-level step a workspace import reuses.
 */
export async function importLegacyMeta(
  client: RepoClient,
  namespace: string,
  source: string,
  load: () => Promise<LegacyFlockBundle | undefined>
): Promise<LegacyMetaImport> {
  const marker = ['meta', source];
  await client.createRoom(namespace, MIGRATIONS_ROOM, 'plaintext');
  if ((await client.flockGet(namespace, MIGRATIONS_ROOM, marker)).found) return 'already-published';
  await client.createRoom(namespace, META_ROOM, 'plaintext');
  const bundle = await load();
  const entries = bundle ? Object.keys(bundle.entries).length : 0;
  if (bundle && entries > 0) {
    await client.importRoomState(namespace, META_ROOM, {
      updates: [new TextEncoder().encode(JSON.stringify(bundle))],
      enqueueOutbox: false,
    });
    const missing = await findUncoveredRegisters(client, namespace, META_ROOM, bundle);
    if (missing.length > 0)
      throw new Error(`native_meta_migration_incomplete: ${missing.length} registers`);
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
export async function unpublishLegacyMeta(client: RepoClient, namespace: string, source: string) {
  await client.flockBatch(namespace, MIGRATIONS_ROOM, [{ op: 'delete', key: ['meta', source] }]);
}

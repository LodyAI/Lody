import fs from 'fs/promises';
import Database from 'better-sqlite3';
import { z } from 'zod';
import path from 'path';
import { type JsonObject, type RemoteCursor, type RemoteCursorStore } from '@loro-dev/streams-crdt';
import { getLoroStreamsRemoteCursorUrlAliases, type WorkspaceId } from '@lody/shared';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import type { LoroDoc } from 'loro-crdt';
import { sqliteLockReporterLegacy } from './sqlite-lock-diagnostics';

export const getLoroRepoStorageBaseDir = (workspaceId: WorkspaceId): string =>
  path.join(getLodyDataDir(), 'loro-repo', workspaceId);

export const getLoroRepoSqliteDbPath = (workspaceId: WorkspaceId): string =>
  path.join(getLoroRepoStorageBaseDir(workspaceId), 'repo.sqlite3');

// sqliteStore.cursorStore keys cursors by exact stream URL. Keep this wrapper
// because direct/proxy Loro Streams gateway URLs address the same stream but
// produce different cursor keys; rejected: using the raw store would make
// gateway flips lose checkpoints or leave stale invalidated checkpoints behind.
// This is URL-key compatibility only, not migration of pre-SQLite JSON cursors.
// The daemon writes LoroDoc cursors; commands may read covered seeds. Meta
// and named Flock cursors are replica-bound checkpoints owned by
// `SqliteRepoStore` itself (no alias fallback there, so a gateway flip costs
// those rooms one bootstrap).
export class AliasedRemoteCursorStore<
  TVersion extends JsonObject = JsonObject,
> implements RemoteCursorStore<TVersion> {
  constructor(private readonly primary: RemoteCursorStore<TVersion>) {}

  async load(streamUrl: string): Promise<RemoteCursor<TVersion> | null> {
    const cursor = await this.primary.load(streamUrl);
    if (cursor) {
      return cursor;
    }

    for (const alias of getLoroStreamsRemoteCursorUrlAliases(streamUrl)) {
      const aliasCursor = await this.primary.load(alias);
      if (aliasCursor) {
        return { ...aliasCursor, streamUrl };
      }
    }

    return null;
  }

  async save(cursor: RemoteCursor<TVersion>): Promise<void> {
    await this.primary.save(cursor);
  }

  async delete(streamUrl: string): Promise<void> {
    await this.deleteFromPrimary(streamUrl);
    await Promise.all(
      getLoroStreamsRemoteCursorUrlAliases(streamUrl).map((alias) => this.deleteFromPrimary(alias))
    );
  }

  private async deleteFromPrimary(streamUrl: string): Promise<void> {
    await this.primary.delete?.(streamUrl);
  }
}

const checkpointRow = z.object({ generation: z.string().min(1), cursors: z.string() });
const remoteCursor = z.object({
  streamUrl: z.string().url(),
  nextOffset: z
    .string()
    .min(1)
    .refine((offset) => offset !== '-1'),
  serverLowerBoundVersion: z.record(z.string(), z.json()),
  updatedAtMs: z.number(),
});

/**
 * Read-only compatibility with the pinned Repo SQLite checkpoint format.
 * Local row writes and replica acquisition can create a generation, but no cursor.
 * Remote cursor saves follow the matching replica's durable receive barrier.
 */
export function hasPersistedFlockRemoteState(dbPath: string, flockDocId: string): boolean {
  const database = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    const row = checkpointRow.safeParse(
      database
        .prepare('SELECT generation, cursors FROM replica_checkpoints WHERE resource_key = ?')
        .get(`flock:${flockDocId}`)
    );
    if (!row.success) return false;
    let cursors: unknown;
    try {
      cursors = JSON.parse(row.data.cursors);
    } catch {
      return false;
    }
    return (
      Array.isArray(cursors) && cursors.some((cursor) => remoteCursor.safeParse(cursor).success)
    );
  } finally {
    database.close();
  }
}

export type CliSqliteRepoStore = {
  sqliteStore: SqliteRepoStore;
  storageAdapter: SqliteRepoStore['storage'];
  /**
   * LoroDoc room cursors shared by every process opening this file; see
   * `AliasedRemoteCursorStore`. Only the daemon may write them — use
   * `createDocumentRemoteCursorStore`, never this field directly.
   */
  sharedDocumentRemoteCursorStore: RemoteCursorStore;
  dbPath: string;
  baseDir: string;
};

export const createCliSqliteRepoStore = async (
  workspaceId: WorkspaceId,
  onWriteFailure?: (error: Error) => void,
  baseDir = getLoroRepoStorageBaseDir(workspaceId)
): Promise<CliSqliteRepoStore> => {
  await fs.mkdir(baseDir, { recursive: true });

  // Do not import the pre-SQLite remote-cursors.json file. Those cursors were
  // only durable together with FileSystemStorageAdaptor snapshots; migrating
  // cursors without doc/meta state could skip required stream replay.
  const dbPath = path.join(baseDir, 'repo.sqlite3');
  const sqliteStore = new SqliteRepoStore({ path: dbPath, onWriteFailure });
  // Lock contention reported for this database will name its other openers.
  sqliteLockReporterLegacy.register(dbPath);

  return {
    sqliteStore,
    storageAdapter: sqliteStore.storage,
    sharedDocumentRemoteCursorStore: new AliasedRemoteCursorStore(sqliteStore.cursorStore),
    dbPath,
    baseDir,
  };
};

/** Shared cursors are daemon-owned; commands may only seed covered document progress. */
export type DocumentCursorScope = 'shared-durable' | 'process';

export class ProcessDocumentRemoteCursorStore implements RemoteCursorStore {
  private readonly cursors = new Map<string, RemoteCursor | null>();
  private readonly documents = new Map<string, WeakRef<LoroDoc>>();

  constructor(private readonly shared: Pick<RemoteCursorStore, 'load'>) {}

  bindDocument(streamId: string, doc: LoroDoc): void {
    const previous = this.documents.get(streamId);
    if (previous && previous.deref() !== doc) {
      for (const url of this.cursors.keys()) {
        if (this.streamId(url) === streamId) this.cursors.set(url, null);
      }
    }
    this.documents.set(streamId, new WeakRef(doc));
  }

  async load(streamUrl: string): Promise<RemoteCursor | null> {
    if (this.cursors.has(streamUrl)) return this.cursors.get(streamUrl) ?? null;
    const streamId = this.streamId(streamUrl);
    const doc = this.documents.get(streamId)?.deref();
    const cursor = await this.shared.load(streamUrl);
    // A concurrent save/delete wins over the asynchronous disk read.
    if (this.cursors.has(streamUrl)) return this.cursors.get(streamUrl) ?? null;
    if (doc !== this.documents.get(streamId)?.deref()) return null;
    const version = doc ? new Map<string, number>(doc.version().toJSON()) : undefined;
    const hasPending = (doc?.exportPendingUpdates()?.byteLength ?? 0) > 0;
    const clocks = cursor ? Object.entries(cursor.serverLowerBoundVersion) : [];
    const covered =
      version &&
      !hasPending &&
      clocks.length > 0 &&
      clocks.every(
        ([peer, clock]) =>
          typeof clock === 'number' &&
          Number.isSafeInteger(clock) &&
          clock >= 0 &&
          (version.get(peer) ?? 0) >= clock
      );
    const seed = covered ? cursor : null;
    this.cursors.set(streamUrl, seed);
    return seed;
  }

  private streamId(streamUrl: string): string {
    return decodeURIComponent(new URL(streamUrl).pathname.split('/').at(-1) ?? '');
  }

  async save(cursor: RemoteCursor): Promise<void> {
    this.cursors.set(cursor.streamUrl, cursor);
  }

  async delete(streamUrl: string): Promise<void> {
    this.cursors.set(streamUrl, null);
    for (const alias of getLoroStreamsRemoteCursorUrlAliases(streamUrl)) {
      this.cursors.set(alias, null);
    }
  }
}

export const createDocumentRemoteCursorStore = (
  store: CliSqliteRepoStore,
  scope: DocumentCursorScope
): RemoteCursorStore => {
  if (scope === 'shared-durable') return store.sharedDocumentRemoteCursorStore;
  // The pinned SDK's cursor load deletes malformed rows. Commands must remain
  // read-only even on that path, so read the same SQLite format without repair.
  const rowSchema = z.object({
    next_offset: z.string(),
    server_lower_bound_version: z.string(),
    updated_at_ms: z.number(),
  });
  let select: Database.Statement | undefined;
  return new ProcessDocumentRemoteCursorStore({
    load: async (streamUrl) => {
      const database = (store.sqliteStore as unknown as { readonly db: Database.Database }).db;
      if (!database.open) return null;
      try {
        select ??= database.prepare(
          'SELECT next_offset, server_lower_bound_version, updated_at_ms FROM remote_cursors WHERE stream_url = ?'
        );
      } catch {
        return null;
      }
      if (!select.readonly) throw new Error('document_cursor_seed_query_must_be_readonly');
      try {
        for (const url of [streamUrl, ...getLoroStreamsRemoteCursorUrlAliases(streamUrl)]) {
          const row = rowSchema.safeParse(select.get(url));
          if (!row.success) continue;
          let version: unknown;
          try {
            version = JSON.parse(row.data.server_lower_bound_version);
          } catch {
            continue;
          }
          const cursor = remoteCursor.safeParse({
            streamUrl,
            nextOffset: row.data.next_offset,
            serverLowerBoundVersion: version,
            updatedAtMs: row.data.updated_at_ms,
          });
          if (cursor.success) return cursor.data;
        }
        return null;
      } catch {
        return null;
      }
    },
  });
};

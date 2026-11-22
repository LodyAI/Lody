import { createHash, randomUUID } from 'node:crypto';
import { createAliasedIncompleteRecoveryStore } from '@lody/shared/workspace-streams-persistence';
import fs from 'fs/promises';
import Database from 'better-sqlite3';
import { z } from 'zod';
import path from 'path';
import { type JsonObject, type RemoteCursor, type RemoteCursorStore } from '@loro-dev/streams-crdt';
import {
  getLoroStreamsRemoteCursorUrlAliases,
  getLoroStreamIdForDocId,
  createLoroStreamUrl,
  LORO_STREAMS_BUCKET_ID,
  type WorkspaceId,
} from '@lody/shared';
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
// `SqliteRepoStore` itself, including URL alias resolution.
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
  workspaceId: WorkspaceId;
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
  const sqliteStore = new SqliteRepoStore({
    path: dbPath,
    onWriteFailure,
    resolveStreamUrlAliases: getLoroStreamsRemoteCursorUrlAliases,
  });
  // Lock contention reported for this database will name its other openers.
  sqliteLockReporterLegacy.register(dbPath);

  return {
    workspaceId,
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
  scope: DocumentCursorScope,
  bucketId = LORO_STREAMS_BUCKET_ID
): RemoteCursorStore => {
  if (scope === 'shared-durable') return store.sharedDocumentRemoteCursorStore;
  return new ProcessDocumentRemoteCursorStore(
    store.sqliteStore.createProcessDocumentCursorStore({
      // Older Lody writers did not populate docCursorIndex. Resolve only this
      // workspace/document/bucket's existing URLs inside the capture transaction.
      documentStreamUrls: (docId) => {
        const pathname = new URL(
          createLoroStreamUrl({
            bucketId,
            baseUrl: 'https://cursor-mapping.invalid',
            streamId: getLoroStreamIdForDocId(store.workspaceId, docId),
          })
        ).pathname;
        const database = (store.sqliteStore as unknown as { readonly db: Database.Database }).db;
        const rows = database
          .prepare('SELECT stream_url FROM remote_cursors WHERE stream_url LIKE ?')
          .all('%' + pathname) as Array<{ stream_url: string }>;
        return rows
          .filter(({ stream_url }) => {
            try {
              return new URL(stream_url).pathname === pathname;
            } catch {
              return false;
            }
          })
          .map(({ stream_url }) => stream_url);
      },
      resolveStreamUrlAliases: getLoroStreamsRemoteCursorUrlAliases,
    })
  );
};

/** Only the daemon publishes metadata; commands keep their modifications private. */
export function createCliIncompleteRecoveryStore(
  store: CliSqliteRepoStore,
  scope: DocumentCursorScope
) {
  const directory = path.join(store.baseDir, 'incomplete-recovery');
  const local = new Map<string, unknown>();
  const fileOf = (key: string) =>
    path.join(directory, createHash('sha256').update(key).digest('hex') + '.json');
  return createAliasedIncompleteRecoveryStore({
    async load(key) {
      if (local.has(key)) return local.get(key);
      try {
        return JSON.parse(await fs.readFile(fileOf(key), 'utf8')) as unknown;
      } catch {
        return null;
      }
    },
    async save(key, value) {
      if (scope === 'process') {
        local.set(key, value);
        return;
      }
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = fileOf(key) + '.' + randomUUID();
      try {
        await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, fileOf(key));
      } finally {
        await fs.rm(temporary, { force: true });
      }
    },
    async delete(key) {
      if (scope === 'process') {
        local.set(key, null);
        return;
      }
      await fs.rm(fileOf(key), { force: true });
    },
  });
}

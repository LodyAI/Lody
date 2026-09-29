import fs from 'fs/promises';
import path from 'path';
import {
  InMemoryRemoteCursorStore,
  type JsonObject,
  type RemoteCursor,
  type RemoteCursorStore,
} from '@loro-dev/streams-crdt';
import { getLoroStreamsRemoteCursorUrlAliases, type WorkspaceId } from '@lody/shared';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

export const getLoroRepoStorageBaseDir = (workspaceId: WorkspaceId): string =>
  path.join(getLodyDataDir(), 'loro-repo', workspaceId);

export const getLoroRepoSqliteDbPath = (workspaceId: WorkspaceId): string =>
  path.join(getLoroRepoStorageBaseDir(workspaceId), 'repo.sqlite3');

// sqliteStore.cursorStore keys cursors by exact stream URL. Keep this wrapper
// because direct/proxy Loro Streams gateway URLs address the same stream but
// produce different cursor keys; rejected: using the raw store would make
// gateway flips lose checkpoints or leave stale invalidated checkpoints behind.
// This is URL-key compatibility only, not migration of pre-SQLite JSON cursors.
// It serves LoroDoc rooms of the daemon only (see `DocumentCursorScope`): Meta
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

export type CliSqliteRepoStore = {
  sqliteStore: SqliteRepoStore;
  storageAdapter: SqliteRepoStore['storage'];
  /**
   * LoroDoc room cursors shared by every process opening this file; see
   * `AliasedRemoteCursorStore`. Only the daemon may resume from them — use
   * `createDocumentRemoteCursorStore`, never this field directly.
   */
  sharedDocumentRemoteCursorStore: RemoteCursorStore;
  dbPath: string;
  baseDir: string;
};

export const createCliSqliteRepoStore = async (
  workspaceId: WorkspaceId
): Promise<CliSqliteRepoStore> => {
  const baseDir = getLoroRepoStorageBaseDir(workspaceId);
  await fs.mkdir(baseDir, { recursive: true });

  // Do not import the pre-SQLite remote-cursors.json file. Those cursors were
  // only durable together with FileSystemStorageAdaptor snapshots; migrating
  // cursors without doc/meta state could skip required stream replay.
  const dbPath = getLoroRepoSqliteDbPath(workspaceId);
  const sqliteStore = new SqliteRepoStore({ path: dbPath });

  return {
    sqliteStore,
    storageAdapter: sqliteStore.storage,
    sharedDocumentRemoteCursorStore: new AliasedRemoteCursorStore(sqliteStore.cursorStore),
    dbPath,
    baseDir,
  };
};

/**
 * Which LoroDoc Streams progress a process may resume from.
 *
 * LoroDoc cursors are not replica-bound: loro-repo keeps them in a store
 * separate from the doc bytes. The daemon and one-shot commands open the same
 * `repo.sqlite3` with their own in-memory replicas, so a process that loaded a
 * doc before another process advanced its data and shared cursor would resume
 * at that tail and permanently miss the entries it never loaded.
 *
 * - `shared-durable`: the long-lived daemon. It is the only writer of the
 *   shared cursors, so they only ever describe its own replica (data may run
 *   ahead of them, which merely replays).
 * - `process`: every other process. Progress lives in memory with this
 *   process's replicas, so each doc room it opens bootstraps once.
 */
export type DocumentCursorScope = 'shared-durable' | 'process';

export const createDocumentRemoteCursorStore = (
  store: CliSqliteRepoStore,
  scope: DocumentCursorScope
): RemoteCursorStore =>
  scope === 'shared-durable'
    ? store.sharedDocumentRemoteCursorStore
    : new InMemoryRemoteCursorStore();

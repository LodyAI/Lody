import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject, RemoteCursor } from '@loro-dev/streams-crdt';
import {
  DEFAULT_LORO_STREAMS_BASE_URL,
  LEGACY_LORO_STREAMS_BASE_URL,
  type WorkspaceId,
} from '@lody/shared';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import type Database from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import { createRequire } from 'node:module';
import { CliRuntimeStateReporter } from '../cli-runtime-state';
import { createStorageGuard } from '../../../../electron/src/main/services/storage-guard';
import { observeCliStorageWriteFailures } from '../../../../electron/src/main/services/storage-guard-cli';

import {
  AliasedRemoteCursorStore,
  createCliSqliteRepoStore,
  getLoroRepoSqliteDbPath,
  getLoroRepoStorageBaseDir,
} from './sqlite-repo-store';

const createdPaths = new Set<string>();
const openStores = new Set<SqliteRepoStore>();
const originalPlatform = process.env.LODY_PLATFORM;
const originalDataDir = process.env.LODY_DATA_DIR;

beforeEach(() => {
  process.env.LODY_PLATFORM = 'local';
  delete process.env.LODY_DATA_DIR;
});

const createCursor = (streamUrl: string): RemoteCursor<JsonObject> => ({
  streamUrl,
  nextOffset: '42',
  serverLowerBoundVersion: { version: '1' },
  updatedAtMs: 123,
});

const createTempSqliteCursorStore = async (): Promise<{
  tempDir: string;
  sqliteStore: SqliteRepoStore;
  cursorStore: AliasedRemoteCursorStore<JsonObject>;
}> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-sqlite-repo-store-'));
  createdPaths.add(tempDir);

  const sqliteStore = new SqliteRepoStore({ path: path.join(tempDir, 'repo.sqlite3') });
  openStores.add(sqliteStore);

  return {
    tempDir,
    sqliteStore,
    cursorStore: new AliasedRemoteCursorStore(sqliteStore.cursorStore),
  };
};

afterEach(async () => {
  for (const store of openStores) {
    store.close();
  }
  openStores.clear();

  await Promise.all(
    Array.from(createdPaths).map(async (targetPath) => {
      await fs.rm(targetPath, { recursive: true, force: true });
    })
  );
  createdPaths.clear();
  if (originalPlatform === undefined) delete process.env.LODY_PLATFORM;
  else process.env.LODY_PLATFORM = originalPlatform;
  if (originalDataDir === undefined) delete process.env.LODY_DATA_DIR;
  else process.env.LODY_DATA_DIR = originalDataDir;
});

describe('SQLite Loro repo store', () => {
  it.each(['esm', 'cjs'] as const)(
    'keeps %s write failures unchanged across nested storage capabilities',
    async (entry) => {
      const Constructor: typeof SqliteRepoStore =
        entry === 'esm'
          ? SqliteRepoStore
          : (
              createRequire(import.meta.url)('loro-repo/storage/sqlite') as {
                SqliteRepoStore: typeof SqliteRepoStore;
              }
            ).SqliteRepoStore;
      const database = new BetterSqlite3(':memory:');
      const observed: Error[] = [];
      const store = new Constructor({ database, onWriteFailure: (error) => observed.push(error) });
      const { saveMany, migrationState, docCursorIndex, loadMetaReplica } = store.storage;
      if (!saveMany || !migrationState || !docCursorIndex || !loadMetaReplica)
        throw new Error('Missing native storage capability');
      const replica = await loadMetaReplica();
      database.pragma('query_only = ON');
      const writes = [
        () =>
          store.storage.save({ type: 'doc-update', docId: 'session', update: new Uint8Array([1]) }),
        () => saveMany([{ type: 'doc-update', docId: 'session', update: new Uint8Array([1]) }]),
        () => migrationState.save('migration'),
        () => docCursorIndex.add('session', 'https://stream.invalid'),
        () => store.cursorStore.save(createCursor('https://stream.invalid')),
        () => replica.checkpointStore.save(createCursor('https://stream.invalid')),
      ];
      try {
        for (const write of writes) {
          const error = await write().catch((failure: unknown) => failure);
          expect(error).toMatchObject({ code: 'SQLITE_READONLY' });
          expect(observed.at(-1)).toBe(error);
        }
        expect(observed).toHaveLength(writes.length);
        expect(await docCursorIndex.load('session')).toEqual([]);
        expect(observed).toHaveLength(writes.length);
      } finally {
        store.close();
        database.close();
      }
    }
  );
  it('reports a real SQLITE_FULL through runtime state to the desktop guard', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-storage-full-'));
    createdPaths.add(dataDir);
    process.env.LODY_DATA_DIR = dataDir;
    const reporter = new CliRuntimeStateReporter({ now: () => 100 });
    const store = await createCliSqliteRepoStore('disk-full' as WorkspaceId, () =>
      reporter.reportStorageWriteFailure()
    );
    openStores.add(store.sqliteStore);
    // Fault injection only: cap the native connection's page budget rather than
    // filling the machine's disk or mocking the storage result.
    const database = Reflect.get(store.sqliteStore, 'db') as Database.Database;
    database.pragma('max_page_count = 1');
    const guard = createStorageGuard({
      dataDirs: [dataDir],
      readVolume: async () => ({ freeBytes: 1, totalBytes: 100 * 1024 ** 3 }),
      broadcast: () => {},
      quitAndRelaunch: async () => 'quitting',
      quit: () => {},
      log: () => {},
    });
    const observe = observeCliStorageWriteFailures(guard);
    await expect(
      store.storageAdapter.save({
        type: 'doc-update',
        docId: 'session',
        update: new Uint8Array(1024 * 1024),
      })
    ).rejects.toMatchObject({ code: 'SQLITE_FULL' });
    await observe(reporter.snapshot());
    expect(guard.getState()).toMatchObject({ blocked: true, source: 'cli' });
    expect(reporter.snapshot().issues).toMatchObject([{ count: 1, severity: 'warning' }]);
    database.pragma('max_page_count = 1073741823');
    await store.storageAdapter.save({
      type: 'doc-update',
      docId: 'session',
      update: new Uint8Array([1]),
    });
    // The failed write did not close or fence the store; agents may continue.
    expect(await store.sqliteStore.cursorStore.load('missing')).toBeNull();
  });
  it('saves, loads, and deletes remote cursors in SQLite', async () => {
    const { cursorStore, tempDir } = await createTempSqliteCursorStore();
    const cursor = createCursor(`${LEGACY_LORO_STREAMS_BASE_URL}/ds/lody/workspace:meta`);

    expect(await cursorStore.load(cursor.streamUrl)).toBeNull();

    await cursorStore.save(cursor);
    expect(await cursorStore.load(cursor.streamUrl)).toEqual(cursor);
    expect(await fs.stat(path.join(tempDir, 'repo.sqlite3'))).toBeTruthy();

    await cursorStore.delete(cursor.streamUrl);
    expect(await cursorStore.load(cursor.streamUrl)).toBeNull();
  });

  it('loads and deletes cursors saved under the legacy gateway URL', async () => {
    const { cursorStore } = await createTempSqliteCursorStore();
    const legacyUrl = `${LEGACY_LORO_STREAMS_BASE_URL}/ds/lody/workspace:meta`;
    const proxyUrl = `${DEFAULT_LORO_STREAMS_BASE_URL}/ds/lody/workspace:meta`;
    const legacyCursor = createCursor(legacyUrl);

    await cursorStore.save(legacyCursor);

    expect(await cursorStore.load(proxyUrl)).toEqual({ ...legacyCursor, streamUrl: proxyUrl });

    await cursorStore.delete(proxyUrl);
    expect(await cursorStore.load(legacyUrl)).toBeNull();
    expect(await cursorStore.load(proxyUrl)).toBeNull();
  });

  it('loads and deletes cursors saved under the previous proxy gateway URL', async () => {
    const { cursorStore } = await createTempSqliteCursorStore();
    const previousProxyUrl = 'https://previous.streams.invalid/ds/lody/workspace:meta';
    const currentUrl = `${DEFAULT_LORO_STREAMS_BASE_URL}/ds/lody/workspace:meta`;
    const previousProxyCursor = createCursor(previousProxyUrl);

    await cursorStore.save(previousProxyCursor);

    expect(await cursorStore.load(currentUrl)).toEqual({
      ...previousProxyCursor,
      streamUrl: currentUrl,
    });

    await cursorStore.delete(currentUrl);
    expect(await cursorStore.load(previousProxyUrl)).toBeNull();
    expect(await cursorStore.load(currentUrl)).toBeNull();
  });

  it('creates a workspace-scoped SQLite repo store under the Lody storage directory', async () => {
    const previousHome = process.env.HOME;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-sqlite-repo-home-'));
    createdPaths.add(tempHome);
    process.env.HOME = tempHome;

    try {
      const workspaceId = 'workspace-1' as WorkspaceId;
      const cliStore = await createCliSqliteRepoStore(workspaceId);
      openStores.add(cliStore.sqliteStore);

      expect(cliStore.baseDir).toBe(path.join(tempHome, '.lody-oss', 'loro-repo', 'workspace-1'));
      expect(cliStore.dbPath).toBe(path.join(cliStore.baseDir, 'repo.sqlite3'));
      expect(getLoroRepoStorageBaseDir(workspaceId)).toBe(cliStore.baseDir);
      expect(getLoroRepoSqliteDbPath(workspaceId)).toBe(cliStore.dbPath);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });
});

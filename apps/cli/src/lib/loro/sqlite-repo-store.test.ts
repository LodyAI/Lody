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
import { LoroRepo } from 'loro-repo';
import { createCliStreamsPersistence } from './streams-persistence';

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
  it('replays legacy progress while preserving durable Meta and named Flock repairs', async () => {
    const { sqliteStore } = await createTempSqliteCursorStore();
    const cursor = createCursor('https://streams.invalid/meta');
    await sqliteStore.cursorStore.save(cursor);
    const repo = await LoroRepo.create({
      storageAdapter: sqliteStore.storage,
      metaDebounceCommitMs: 0,
    });
    const persistence = createCliStreamsPersistence(repo);
    const named = await repo.openFlockDoc('named');
    const record = (key: string, clock: number) => ({
      version: 0,
      entries: {
        [JSON.stringify([key])]: { d: key, c: `1700000000000,${clock},aa` },
      },
    });
    for (const flock of [repo.getMeta(), named.flock]) {
      flock.importJson(record('B', 2));
      flock.commit();
    }
    await repo.flush();
    for (const flock of [repo.getMeta(), named.flock]) {
      const before = flock.version();
      flock.importJson(record('A', 1));
      flock.commit();
      expect(flock.version()).toEqual(before);
    }
    const checkpoint = persistence.cursorStoreFor({ kind: 'meta', flock: repo.getMeta() });
    expect(await checkpoint.load(cursor.streamUrl)).toBeNull();
    expect(await persistence.documentRemoteCursorStore.load(cursor.streamUrl)).toBeNull();
    if (!persistence.persistMeta || !persistence.persistFlockDoc)
      throw new Error('Missing durability barriers');
    await persistence.persistMeta(repo.getMeta());
    await persistence.persistFlockDoc('named', named.flock);
    await checkpoint.save(cursor);
    // Independent reader sees the persisted repairs before shutdown flushes.
    const reader = await LoroRepo.create({
      storageAdapter: sqliteStore.storage,
      metaDebounceCommitMs: 0,
    });
    expect(reader.getMeta().get(['A'])).toBe('A');
    expect((await reader.openFlockDoc('named')).flock.get(['A'])).toBe('A');
    expect(
      await persistence
        .cursorStoreFor({ kind: 'meta', flock: reader.getMeta() })
        .load(cursor.streamUrl)
    ).toBeNull();
    expect(await checkpoint.load(cursor.streamUrl)).toEqual(cursor);
    await reader.destroy();
    await repo.destroy();
  });

  it('does not resolve the CLI durability barrier until SQLite has accepted the data', async () => {
    const { sqliteStore } = await createTempSqliteCursorStore();
    const save = sqliteStore.storage.save.bind(sqliteStore.storage);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    sqliteStore.storage.save = async (payload) => {
      entered.resolve();
      await release.promise;
      await save(payload);
    };
    const repo = await LoroRepo.create({
      storageAdapter: sqliteStore.storage,
      metaDebounceCommitMs: 0,
    });
    const persistence = createCliStreamsPersistence(repo);
    repo.getMeta().set(['local'], 'keep');
    if (!persistence.persistMeta) throw new Error('Missing Meta durability barrier');
    let completed = false;
    const barrier = persistence.persistMeta(repo.getMeta()).then(() => {
      completed = true;
    });
    await entered.promise;
    expect(completed).toBe(false);
    release.resolve();
    await barrier;
    expect((await sqliteStore.storage.loadMeta?.())?.get(['local'])).toBe('keep');
    await repo.destroy();
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

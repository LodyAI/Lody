import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject, RemoteCursor } from '@loro-dev/streams-crdt';
import {
  DEFAULT_LORO_STREAMS_BASE_URL,
  LEGACY_LORO_STREAMS_BASE_URL,
  type WorkspaceId,
} from '@lody/shared';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';

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
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-sqlite-repo-home-'));
    createdPaths.add(tempHome);
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tempHome);

    try {
      const workspaceId = 'workspace-1' as WorkspaceId;
      const cliStore = await createCliSqliteRepoStore(workspaceId);
      openStores.add(cliStore.sqliteStore);

      expect(cliStore.baseDir).toBe(path.join(tempHome, '.lody-oss', 'loro-repo', 'workspace-1'));
      expect(cliStore.dbPath).toBe(path.join(cliStore.baseDir, 'repo.sqlite3'));
      expect(getLoroRepoStorageBaseDir(workspaceId)).toBe(cliStore.baseDir);
      expect(getLoroRepoSqliteDbPath(workspaceId)).toBe(cliStore.dbPath);
    } finally {
      homeSpy.mockRestore();
    }
  });
});

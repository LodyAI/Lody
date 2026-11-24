import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject, RemoteCursor } from '@loro-dev/streams-crdt';
import {
  createLoroStreamUrl,
  DEFAULT_LORO_STREAMS_BASE_URL,
  getCodeCollabFileIndexFlockDocId,
  getLoroStreamIdForDocId,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  LEGACY_LORO_STREAMS_BASE_URL,
  LORO_STREAMS_BUCKET_ID,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { LoroDoc } from 'loro-crdt';
import { LoroRepo } from 'loro-repo';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import type Database from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import { createRequire } from 'node:module';
import { CliRuntimeStateReporter } from '../cli-runtime-state';
import { createStorageGuard } from '../../../../electron/src/main/services/storage-guard';
import { observeCliStorageWriteFailures } from '../../../../electron/src/main/services/storage-guard-cli';
import { getLogger } from '@/utils/logger';

import {
  AliasedRemoteCursorStore,
  createCliSqliteRepoStore,
  getSqliteRepoDatabase,
} from './sqlite-repo-store';
import { SqliteRepoMaintenance } from './sqlite-repo-maintenance';

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

  it('initializes new SQLite repo stores with incremental auto_vacuum', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-sqlite-autovac-'));
    createdPaths.add(baseDir);

    const store = await createCliSqliteRepoStore('ws-autovac' as WorkspaceId, undefined, baseDir);
    openStores.add(store.sqliteStore);

    const db = getSqliteRepoDatabase(store);
    expect(Number(db.pragma('auto_vacuum', { simple: true }))).toBe(2);
  });

  it('purges deleted doc bodies, deleted session Flocks, compacts doc_updates, and reclaims freelist pages', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-sqlite-maint-'));
    createdPaths.add(baseDir);
    const workspaceId = 'ws-maint' as WorkspaceId;
    const deletedSessionId = 'sess-deleted' as SessionId;
    const activeDeletedSessionId = 'sess-active-deleted' as SessionId;
    const liveSessionId = 'sess-live' as SessionId;

    const store = await createCliSqliteRepoStore(workspaceId, undefined, baseDir);
    openStores.add(store.sqliteStore);
    const repo = await LoroRepo.create({
      storageAdapter: store.storageAdapter,
      metaDebounceCommitMs: 0,
      metaPersistDebounceMs: 0,
    });

    try {
      const deletedRoomId = getSessionRoomId(deletedSessionId);
      const activeDeletedRoomId = getSessionRoomId(activeDeletedSessionId);
      const liveRoomId = getSessionRoomId(liveSessionId);

      // Populate deleted session doc with a large payload + cursor + code-collab Flock.
      const deletedHandle = await repo.openPersistedDoc(deletedRoomId);
      deletedHandle.doc.getText('payload').insert(0, 'x'.repeat(256 * 1024));
      deletedHandle.doc.commit();
      await repo.flush();
      const deletedCursorUrl = createLoroStreamUrl({
        bucketId: LORO_STREAMS_BUCKET_ID,
        baseUrl: DEFAULT_LORO_STREAMS_BASE_URL,
        streamId: getLoroStreamIdForDocId(workspaceId, deletedRoomId),
      });
      await store.sharedDocumentRemoteCursorStore.save(createCursor(deletedCursorUrl));
      await store.storageAdapter.docCursorIndex?.add(deletedRoomId, deletedCursorUrl);

      const deletedFlockId = getCodeCollabFileIndexFlockDocId(workspaceId, deletedSessionId);
      const deletedFlockHandle = await repo.openFlockDoc(deletedFlockId);
      deletedFlockHandle.flock.set(['file', 'a.ts'], 'v1');
      deletedFlockHandle.flock.commit();
      await repo.flush();
      await repo.unloadFlockDoc(deletedFlockId);

      // Populate active-but-deleted session doc (must be skipped while active).
      const activeDeletedHandle = await repo.openPersistedDoc(activeDeletedRoomId);
      activeDeletedHandle.doc.getText('payload').insert(0, 'keep-while-active');
      activeDeletedHandle.doc.commit();
      await repo.flush();

      // Populate live session doc with many incremental doc_updates.
      const liveHandle = await repo.openPersistedDoc(liveRoomId);
      for (let i = 0; i < 40; i += 1) {
        liveHandle.doc.getText('stream').insert(i * 4, `msg${i}`);
        liveHandle.doc.commit();
        await repo.flush();
      }

      // Soft-delete the two deleted sessions via repo.deleteDoc (leaves bodies on disk).
      await repo.deleteDoc(deletedRoomId);
      await repo.deleteDoc(activeDeletedRoomId);
      await repo.flush();

      // Unload handles so maintenance can safely purge/compact.
      await repo.unloadDoc(deletedRoomId);
      await repo.unloadDoc(activeDeletedRoomId);
      await repo.unloadDoc(liveRoomId);

      const db = getSqliteRepoDatabase(store);
      expect(
        (
          db.prepare('SELECT COUNT(*) AS n FROM doc_updates WHERE doc_id = ?').get(liveRoomId) as {
            n: number;
          }
        ).n
      ).toBeGreaterThanOrEqual(32);

      const maintenance = new SqliteRepoMaintenance({
        repo,
        store,
        workspaceId,
        logger: getLogger(),
        isDocActive: (docId) => docId === activeDeletedRoomId,
        minCompactUpdateCount: 32,
      });

      const report = await maintenance.runOnce();
      expect(report.deletedDocsPurged).toBe(1);
      expect(report.deletedSessionFlocksPurged).toBe(1);
      expect(report.docsCompacted).toBe(1);
      expect(report.freelistPagesReclaimed).toBeGreaterThan(0);
      expect(report.ranWalCheckpoint).toBe(true);

      // Deleted doc body, updates, cursor, and code-collab Flock are gone,
      // while metaFlock retains the deleted tombstone for cross-machine sync.
      expect(db.prepare('SELECT 1 FROM docs WHERE doc_id = ?').get(deletedRoomId)).toBeUndefined();
      expect(
        db.prepare('SELECT 1 FROM doc_updates WHERE doc_id = ?').get(deletedRoomId)
      ).toBeUndefined();
      expect(await store.sharedDocumentRemoteCursorStore.load(deletedCursorUrl)).toBeNull();
      expect(
        db.prepare('SELECT 1 FROM flock_docs WHERE flock_doc_id = ?').get(deletedFlockId)
      ).toBeUndefined();
      const deletedMeta = await repo.getDocMeta(deletedRoomId);
      expect(deletedMeta && isLoroRepoDocDeleted(deletedMeta)).toBe(true);

      // Active deleted doc was untouched.
      const activeReloaded = await store.storageAdapter.loadDoc(activeDeletedRoomId);
      expect(activeReloaded?.getText('payload').toString()).toBe('keep-while-active');

      // Live doc updates were folded into docs.snapshot and content survives reopen.
      expect(
        (
          db.prepare('SELECT COUNT(*) AS n FROM doc_updates WHERE doc_id = ?').get(liveRoomId) as {
            n: number;
          }
        ).n
      ).toBe(0);
      const reloaded = await store.storageAdapter.loadDoc(liveRoomId);
      expect(reloaded).toBeInstanceOf(LoroDoc);
      expect(reloaded?.getText('stream').toString()).toContain('msg39');

      await maintenance.stop();
    } finally {
      await repo.destroy();
    }
  });

  it('upgrades legacy auto_vacuum=NONE DBs with VACUUM only when disk space allows', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-sqlite-legacy-vac-'));
    createdPaths.add(baseDir);
    const dbPath = path.join(baseDir, 'repo.sqlite3');
    const workspaceId = 'ws-legacy' as WorkspaceId;

    // Create a legacy DB directly via SqliteRepoStore (auto_vacuum = NONE).
    const sqliteStore = new SqliteRepoStore({ path: dbPath });
    openStores.add(sqliteStore);
    const store = {
      workspaceId,
      sqliteStore,
      storageAdapter: sqliteStore.storage,
      sharedDocumentRemoteCursorStore: new AliasedRemoteCursorStore(sqliteStore.cursorStore),
      dbPath,
      baseDir,
    };
    const db = getSqliteRepoDatabase(store);
    expect(Number(db.pragma('auto_vacuum', { simple: true }))).toBe(0);

    const repo = await LoroRepo.create({
      storageAdapter: store.storageAdapter,
      metaDebounceCommitMs: 0,
      metaPersistDebounceMs: 0,
    });

    try {
      const deadRoomId = getSessionRoomId('sess-big-dead' as SessionId);
      const handle = await repo.openPersistedDoc(deadRoomId);
      handle.doc.getText('blob').insert(0, 'z'.repeat(512 * 1024));
      handle.doc.commit();
      await repo.flush();
      await repo.deleteDoc(deadRoomId);
      await repo.flush();
      await repo.unloadDoc(deadRoomId);

      // First run with insufficient free disk space: deletes doc body, skips VACUUM.
      const lowDiskMaintenance = new SqliteRepoMaintenance({
        repo,
        store,
        workspaceId,
        logger: getLogger(),
        isDocActive: () => false,
        vacuumMinFreelistBytes: 64 * 1024,
        vacuumMinFreelistRatio: 0.1,
        vacuumHeadroomBytes: 1024 * 1024,
        getFreeDiskBytes: async () => 1024,
      });
      const lowDiskReport = await lowDiskMaintenance.runOnce();
      expect(lowDiskReport.deletedDocsPurged).toBe(1);
      expect(lowDiskReport.ranFullVacuum).toBe(false);
      expect(Number(db.pragma('auto_vacuum', { simple: true }))).toBe(0);
      await lowDiskMaintenance.stop();

      // Second run with plenty of disk space: upgrades to auto_vacuum=INCREMENTAL via VACUUM.
      const okDiskMaintenance = new SqliteRepoMaintenance({
        repo,
        store,
        workspaceId,
        logger: getLogger(),
        isDocActive: () => false,
        vacuumMinFreelistBytes: 64 * 1024,
        vacuumMinFreelistRatio: 0.1,
        vacuumHeadroomBytes: 1024 * 1024,
        getFreeDiskBytes: async () => 10 * 1024 * 1024 * 1024,
      });
      const okDiskReport = await okDiskMaintenance.runOnce();
      expect(okDiskReport.ranFullVacuum).toBe(true);
      expect(okDiskReport.freelistPagesReclaimed).toBeGreaterThan(0);
      expect(Number(db.pragma('auto_vacuum', { simple: true }))).toBe(2);
      expect(Number(db.pragma('freelist_count', { simple: true }))).toBe(0);

      // Subsequent repo writes work normally after VACUUM.
      const nextRoomId = getSessionRoomId('sess-after-vac' as SessionId);
      const nextHandle = await repo.openPersistedDoc(nextRoomId);
      nextHandle.doc.getText('ok').insert(0, 'alive');
      nextHandle.doc.commit();
      await repo.flush();
      await repo.unloadDoc(nextRoomId);
      const loaded = await store.storageAdapter.loadDoc(nextRoomId);
      expect(loaded?.getText('ok').toString()).toBe('alive');

      await okDiskMaintenance.stop();
    } finally {
      await repo.destroy();
    }
  });

  it('compacts stale doc_updates older than the idle threshold even with few small rows', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-sqlite-stale-'));
    createdPaths.add(baseDir);
    const workspaceId = 'ws-stale' as WorkspaceId;

    const store = await createCliSqliteRepoStore(workspaceId, undefined, baseDir);
    openStores.add(store.sqliteStore);
    const repo = await LoroRepo.create({
      storageAdapter: store.storageAdapter,
      metaDebounceCommitMs: 0,
      metaPersistDebounceMs: 0,
    });

    try {
      const staleRoomId = getSessionRoomId('sess-stale' as SessionId);
      const freshRoomId = getSessionRoomId('sess-fresh' as SessionId);

      const staleHandle = await repo.openPersistedDoc(staleRoomId);
      staleHandle.doc.getText('msg').insert(0, 'old-message');
      staleHandle.doc.commit();
      await repo.flush();
      await repo.unloadDoc(staleRoomId);

      const freshHandle = await repo.openPersistedDoc(freshRoomId);
      freshHandle.doc.getText('msg').insert(0, 'recent-message');
      freshHandle.doc.commit();
      await repo.flush();
      await repo.unloadDoc(freshRoomId);

      const db = getSqliteRepoDatabase(store);
      const nowMs = Date.now();
      const fortyDaysAgoMs = nowMs - 40 * 24 * 60 * 60 * 1_000;
      db.prepare('UPDATE doc_updates SET created_at = ? WHERE doc_id = ?').run(
        fortyDaysAgoMs,
        staleRoomId
      );

      const maintenance = new SqliteRepoMaintenance({
        repo,
        store,
        workspaceId,
        logger: getLogger(),
        isDocActive: () => false,
        now: () => nowMs,
      });

      const report = await maintenance.runOnce();
      expect(report.docsCompacted).toBe(1);

      expect(
        (
          db.prepare('SELECT COUNT(*) AS n FROM doc_updates WHERE doc_id = ?').get(staleRoomId) as {
            n: number;
          }
        ).n
      ).toBe(0);
      expect(
        (
          db.prepare('SELECT COUNT(*) AS n FROM doc_updates WHERE doc_id = ?').get(freshRoomId) as {
            n: number;
          }
        ).n
      ).toBeGreaterThan(0);

      const reloaded = await store.storageAdapter.loadDoc(staleRoomId);
      expect(reloaded?.getText('msg').toString()).toBe('old-message');

      await maintenance.stop();
    } finally {
      await repo.destroy();
    }
  });
});

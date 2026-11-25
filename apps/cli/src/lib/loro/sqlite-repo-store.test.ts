import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject, RemoteCursor } from '@loro-dev/streams-crdt';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import {
  createLoroStreamUrl,
  DEFAULT_LORO_STREAMS_BASE_URL,
  getCodeCollabFileIndexFlockDocId,
  getLoroStreamIdForDocId,
  getMachineRoomId,
  getSessionRoomId,
  getWorkspaceFlockDocId,
  isLoroRepoDocDeleted,
  LEGACY_LORO_STREAMS_BASE_URL,
  LORO_STREAMS_BUCKET_ID,
  type MachineId,
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
  createSqliteRepoMaintenanceStore,
} from './sqlite-repo-store';
import { makeSqliteRepoMaintenance, SqliteRepoMaintenanceLegacy } from './sqlite-repo-maintenance';

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

  it('purges deleted doc bodies, legacy cursors, and deleted session Flocks while protecting active/machine/workspace data and compacting doc_updates', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-sqlite-maint-'));
    createdPaths.add(baseDir);
    const workspaceId = 'ws-maint' as WorkspaceId;
    const otherWorkspaceId = 'ws-other' as WorkspaceId;
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
      const machineRoomId = getMachineRoomId('machine-1' as MachineId);

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

      const deletedFlockId = getCodeCollabFileIndexFlockDocId(workspaceId, deletedSessionId);
      const deletedFlockHandle = await repo.openFlockDoc(deletedFlockId);
      deletedFlockHandle.flock.set(['file', 'a.ts'], 'v1');
      deletedFlockHandle.flock.commit();
      await repo.flush();
      await repo.unloadFlockDoc(deletedFlockId);

      const workspaceFlockId = getWorkspaceFlockDocId(workspaceId);
      const workspaceFlockHandle = await repo.openFlockDoc(workspaceFlockId);
      workspaceFlockHandle.flock.set(['project', 'p1'], 'keep');
      workspaceFlockHandle.flock.commit();
      const otherWsFlockId = getCodeCollabFileIndexFlockDocId(otherWorkspaceId, deletedSessionId);
      const otherWsFlockHandle = await repo.openFlockDoc(otherWsFlockId);
      otherWsFlockHandle.flock.set(['file', 'b.ts'], 'keep');
      otherWsFlockHandle.flock.commit();
      await repo.flush();
      await repo.unloadFlockDoc(workspaceFlockId);
      await repo.unloadFlockDoc(otherWsFlockId);

      const machineHandle = await repo.openPersistedDoc(machineRoomId);
      machineHandle.doc.getText('m').insert(0, 'keep-machine');
      machineHandle.doc.commit();
      const activeDeletedHandle = await repo.openPersistedDoc(activeDeletedRoomId);
      activeDeletedHandle.doc.getText('payload').insert(0, 'keep-while-active');
      activeDeletedHandle.doc.commit();
      await repo.flush();

      const liveHandle = await repo.openPersistedDoc(liveRoomId);
      for (let i = 0; i < 40; i += 1) {
        liveHandle.doc.getText('stream').insert(i * 4, `msg${i}`);
        liveHandle.doc.commit();
        await repo.flush();
      }

      await repo.deleteDoc(deletedRoomId);
      await repo.deleteDoc(activeDeletedRoomId);
      await repo.deleteDoc(machineRoomId);
      await repo.flush();

      const db = Reflect.get(store.sqliteStore, 'db') as Database.Database;
      expect(
        (
          db.prepare('SELECT COUNT(*) AS n FROM doc_updates WHERE doc_id = ?').get(liveRoomId) as {
            n: number;
          }
        ).n
      ).toBeGreaterThanOrEqual(32);

      const maintenance = new SqliteRepoMaintenanceLegacy({
        repo,
        store: createSqliteRepoMaintenanceStore(store, 'shared-durable'),
        logger: getLogger(),
        isDocActive: (docId) => docId === activeDeletedRoomId,
      });

      const report = await maintenance.runOnce();
      expect(report.deletedDocsPurged).toBe(1);
      expect(report.deletedSessionFlocksPurged).toBe(1);
      expect(report.docsCompacted).toBe(1);
      expect(report.freelistPagesReclaimed).toBeGreaterThan(0);
      expect(report.ranWalCheckpoint).toBe(true);

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

      expect(
        db.prepare('SELECT 1 FROM flock_doc_updates WHERE flock_doc_id = ?').get(workspaceFlockId)
      ).toBeDefined();
      expect(
        db.prepare('SELECT 1 FROM flock_doc_updates WHERE flock_doc_id = ?').get(otherWsFlockId)
      ).toBeDefined();

      const activeReloaded = await store.storageAdapter.loadDoc(activeDeletedRoomId);
      expect(activeReloaded?.getText('payload').toString()).toBe('keep-while-active');
      const machineReloaded = await store.storageAdapter.loadDoc(machineRoomId);
      expect(machineReloaded?.getText('m').toString()).toBe('keep-machine');

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

      await maintenance.close();
    } finally {
      await repo.destroy();
    }
  });

  it('upgrades legacy auto_vacuum=NONE DBs with VACUUM only when disk space allows', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-sqlite-legacy-vac-'));
    createdPaths.add(baseDir);
    const dbPath = path.join(baseDir, 'repo.sqlite3');
    const workspaceId = 'ws-legacy' as WorkspaceId;

    const legacyInit = new SqliteRepoStore({ path: dbPath });
    legacyInit.close();

    const store = await createCliSqliteRepoStore(workspaceId, undefined, baseDir);
    openStores.add(store.sqliteStore);
    const db = Reflect.get(store.sqliteStore, 'db') as Database.Database;
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

      const policy = {
        vacuumMinFreelistBytes: 64 * 1024,
        vacuumMinFreelistRatio: 0.1,
        vacuumHeadroomBytes: 1024 * 1024,
      };
      const lowDiskMaintenance = new SqliteRepoMaintenanceLegacy({
        repo,
        store: createSqliteRepoMaintenanceStore(store, 'shared-durable'),
        logger: getLogger(),
        isDocActive: () => false,
        policy,
        getFreeDiskBytes: async () => 1024,
      });
      const lowDiskReport = await lowDiskMaintenance.runOnce();
      expect(lowDiskReport.deletedDocsPurged).toBe(1);
      expect(lowDiskReport.ranFullVacuum).toBe(false);
      expect(Number(db.pragma('auto_vacuum', { simple: true }))).toBe(0);
      await lowDiskMaintenance.close();

      const okDiskMaintenance = new SqliteRepoMaintenanceLegacy({
        repo,
        store: createSqliteRepoMaintenanceStore(store, 'shared-durable'),
        logger: getLogger(),
        isDocActive: () => false,
        policy,
        getFreeDiskBytes: async () => 10 * 1024 * 1024 * 1024,
      });
      const okDiskReport = await okDiskMaintenance.runOnce();
      expect(okDiskReport.ranFullVacuum).toBe(true);
      expect(okDiskReport.freelistPagesReclaimed).toBeGreaterThan(0);
      expect(Number(db.pragma('auto_vacuum', { simple: true }))).toBe(2);
      expect(Number(db.pragma('freelist_count', { simple: true }))).toBe(0);

      const nextRoomId = getSessionRoomId('sess-after-vac' as SessionId);
      const nextHandle = await repo.openPersistedDoc(nextRoomId);
      nextHandle.doc.getText('ok').insert(0, 'alive');
      nextHandle.doc.commit();
      await repo.flush();
      const loaded = await store.storageAdapter.loadDoc(nextRoomId);
      expect(loaded?.getText('ok').toString()).toBe('alive');

      await okDiskMaintenance.close();
    } finally {
      await repo.destroy();
    }
  });

  it('compacts stale doc_updates on schedule with TestClock and coalesces concurrent passes', async () => {
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

      const freshHandle = await repo.openPersistedDoc(freshRoomId);
      freshHandle.doc.getText('msg').insert(0, 'recent-message');
      freshHandle.doc.commit();
      await repo.flush();

      const db = Reflect.get(store.sqliteStore, 'db') as Database.Database;
      const baseNowMs = 1_800_000_000_000;
      const staleAgeMs = 10_000;
      db.prepare('UPDATE doc_updates SET created_at = ? WHERE doc_id = ?').run(
        baseNowMs - staleAgeMs - 1_000,
        staleRoomId
      );
      db.prepare('UPDATE doc_updates SET created_at = ? WHERE doc_id = ?').run(
        baseNowMs,
        freshRoomId
      );

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* TestClock.setTime(baseNowMs);
            const maintenance = yield* makeSqliteRepoMaintenance({
              repo,
              store: createSqliteRepoMaintenanceStore(store, 'shared-durable'),
              logger: getLogger(),
              isDocActive: () => false,
              policy: {
                initialDelayMs: staleAgeMs + 5_000,
                intervalMs: 60_000,
                staleUpdateAgeMs: staleAgeMs,
              },
            });

            const [first, second] = yield* Effect.all([maintenance.runOnce, maintenance.runOnce], {
              concurrency: 2,
            });
            expect(first.docsCompacted).toBe(1);
            expect(second).toEqual(first);

            expect(
              (
                db
                  .prepare('SELECT COUNT(*) AS n FROM doc_updates WHERE doc_id = ?')
                  .get(staleRoomId) as { n: number }
              ).n
            ).toBe(0);
            expect(
              (
                db
                  .prepare('SELECT COUNT(*) AS n FROM doc_updates WHERE doc_id = ?')
                  .get(freshRoomId) as { n: number }
              ).n
            ).toBeGreaterThan(0);

            yield* TestClock.adjust(staleAgeMs + 5_000);
            expect(
              (
                db
                  .prepare('SELECT COUNT(*) AS n FROM doc_updates WHERE doc_id = ?')
                  .get(freshRoomId) as { n: number }
              ).n
            ).toBe(0);
          })
        ).pipe(Effect.provide(TestClock.layer()))
      );

      const reloaded = await store.storageAdapter.loadDoc(staleRoomId);
      expect(reloaded?.getText('msg').toString()).toBe('old-message');
    } finally {
      await repo.destroy();
    }
  });
});

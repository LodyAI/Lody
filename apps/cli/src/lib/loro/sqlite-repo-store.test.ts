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
import { Flock } from '@loro-dev/flock-wasm';
import { readLegacySqliteFlockSource } from './legacy-sqlite-flock-source';
import type Database from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import { createRequire } from 'node:module';
import { CliRuntimeStateReporter } from '../cli-runtime-state';
import { createStorageGuard } from '../../../../electron/src/main/services/storage-guard';
import { observeCliStorageWriteFailures } from '../../../../electron/src/main/services/storage-guard-cli';

import { AliasedRemoteCursorStore, createCliSqliteRepoStore } from './sqlite-repo-store';

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
  it('preserves queued JSON i64 tokens in frozen Meta without modifying the source database', async () => {
    const { tempDir, sqliteStore } = await createTempSqliteCursorStore();
    const peer = new Flock('synthetic-queued-i64');
    peer.put(['m', 'session-synthetic', 'future'], 314159265);
    const json = JSON.stringify(peer.exportJson()).replace('314159265', '9223372036854775806');
    const exact = new Flock('expected-source');
    exact.importJson(
      JSON.parse(json, (_key, value: unknown) =>
        value === 9223372036854776000 ? 9223372036854775806n : value
      )
    );
    const queued = new TextEncoder().encode(json);
    await sqliteStore.storage.save({ type: 'meta-update', update: queued });
    const file = path.join(tempDir, 'repo.sqlite3');
    const db = new BetterSqlite3(file, { readonly: true, fileMustExist: true });
    try {
      const before = db.prepare('SELECT * FROM meta_updates').all();
      const result = readLegacySqliteFlockSource({
        databasePath: file,
        room: { kind: 'meta', id: 'meta' },
      });
      const normalized = (bytes: Uint8Array) => {
        const flock = new Flock('readonly-proof');
        flock.strictImportFile(bytes);
        return flock.exportFile();
      };
      expect(normalized(result.snapshot)).toEqual(normalized(exact.exportFile()));
      const rounded = new Flock('rounded-control');
      // Plain JSON parsing either fails in WASM or changes the complete binary;
      // it can never be accepted as this source's exact migration evidence.
      let rejected = false;
      try {
        rounded.importJson(JSON.parse(json));
      } catch {
        rejected = true;
      }
      if (!rejected)
        expect(normalized(rounded.exportFile())).not.toEqual(normalized(result.snapshot));
      expect(db.prepare('SELECT * FROM meta_updates').all()).toEqual(before);
    } finally {
      db.close();
    }
  });

  it('exports complete frozen Flock and Meta sources without compacting old SQLite or advancing its checkpoint', async () => {
    const { tempDir, sqliteStore } = await createTempSqliteCursorStore();
    const roomId = 'lw_source:wf:workspace';
    const base = new Flock();
    base.put(['old'], { retained: 'unknown' }, 100);
    const offline = Flock.strictFromFile(base.exportFile());
    offline.delete(['old'], 200);
    offline.put(['future', 'key'], { opaque: ['unchanged'] }, 201);
    const update = new TextEncoder().encode(JSON.stringify(offline.exportJson()));
    await sqliteStore.storage.save({
      type: 'flock-doc-snapshot',
      flockDocId: roomId,
      snapshot: base.exportFile(),
    });
    await sqliteStore.storage.save({ type: 'flock-doc-update', flockDocId: roomId, update });
    await sqliteStore.storage.save({ type: 'meta-snapshot', snapshot: base.exportFile() });
    await sqliteStore.storage.save({ type: 'meta-update', update });
    const file = path.join(tempDir, 'repo.sqlite3');
    const database = new BetterSqlite3(file, { readonly: true, fileMustExist: true });
    try {
      const rows = () =>
        [
          'flock_docs',
          'flock_doc_updates',
          'meta_snapshot',
          'meta_updates',
          'replica_checkpoints',
          'remote_cursors',
        ].map((table) => database.prepare(`SELECT * FROM ${table}`).all());
      const before = rows();
      for (const room of [
        { kind: 'flock' as const, id: roomId },
        { kind: 'meta' as const, id: 'meta' },
      ]) {
        const source = readLegacySqliteFlockSource({ databasePath: file, room });
        expect(source.present).toBe(true);
        expect(Flock.strictFromFile(source.snapshot).exportJson()).toEqual(offline.exportJson());
        const merged = Flock.strictFromFile(source.snapshot);
        merged.strictImportFile(base.exportFile());
        expect(merged.get(['old'])).toBeUndefined();
        expect(merged.get(['future', 'key'])).toEqual({ opaque: ['unchanged'] });
      }
      expect(rows()).toEqual(before);
      expect(() =>
        readLegacySqliteFlockSource({
          databasePath: file,
          room: { kind: 'flock', id: roomId },
          maxBytes: 1,
        })
      ).toThrow(/budget/);
      expect(
        readLegacySqliteFlockSource({ databasePath: file, room: { kind: 'flock', id: 'absent' } })
          .present
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  it('blocks corrupt or unfamiliar legacy source layouts before importing a partial room', async () => {
    const { tempDir, sqliteStore } = await createTempSqliteCursorStore();
    const file = path.join(tempDir, 'repo.sqlite3');
    const room = { kind: 'flock' as const, id: 'lw_source:wf:workspace' };
    await sqliteStore.storage.save({
      type: 'flock-doc-snapshot',
      flockDocId: room.id,
      snapshot: new Uint8Array([1, 2, 3]),
    });
    expect(() => readLegacySqliteFlockSource({ databasePath: file, room })).toThrow();
    const database = new BetterSqlite3(file);
    try {
      database.exec('ALTER TABLE flock_docs ADD COLUMN future_contract TEXT');
    } finally {
      database.close();
    }
    expect(() => readLegacySqliteFlockSource({ databasePath: file, room })).toThrow(/Unsupported/);
  });

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
});

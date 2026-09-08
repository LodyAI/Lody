import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TurnDiffStore } from '../src/client';
import { SqliteTurnDiffStore } from '../src/sqlite-store';

const DAY_MS = 24 * 60 * 60 * 1000;
const TURN_DIFF_APPLICATION_ID = 0x4c544431;
const tempDirectories: string[] = [];
let nextHeadProof = 0;

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SqliteTurnDiffStore', () => {
  it('reconstructs exact snapshots and reuses FastCDC chunks across turns', () => {
    const dbPath = createDbPath();
    const firstText = deterministicText(17, 384 * 1024);
    const secondText = `${firstText.slice(0, 19_000)}inserted near the front\n${firstText.slice(
      19_000
    )}`;
    let store = new SqliteTurnDiffStore({ dbPath });

    const first = store.recordTurn({
      ownerId: 'session-a',
      turnId: 'turn-1',
      capturedAtMs: 1_000,
      recordedAtMs: 1_000,
      events: [event('src/a.ts', null, firstText, 10, 0)],
    });
    const second = store.recordTurn({
      ownerId: 'session-a',
      turnId: 'turn-2',
      capturedAtMs: 2_000,
      recordedAtMs: 2_000,
      events: [event('src/a.ts', firstText, secondText, 1, 0)],
    });

    expect(first.metrics.newChunks).toBeGreaterThan(1);
    expect(second.metrics.reusedChunks).toBeGreaterThan(first.metrics.newChunks);
    expect(
      store.getTurnSnapshot({
        ownerId: 'session-a',
        turnId: 'turn-2',
        path: 'src/a.ts',
        nowMs: 2_000,
      })
    ).toEqual({ status: 'ready', oldText: firstText, newText: secondText });
    expect(store.getLatestText({ ownerId: 'session-a', path: 'src/a.ts' })).toEqual({
      status: 'tracked',
      text: secondText,
    });
    expectHealthy(store);

    store.close();
    store = new SqliteTurnDiffStore({ dbPath });
    expect(
      store.getTurnSnapshot({
        ownerId: 'session-a',
        turnId: 'turn-1',
        path: 'src/a.ts',
        nowMs: 2_000,
      })
    ).toEqual({ status: 'ready', oldText: null, newText: firstText });
    expectHealthy(store);
    store.close();
  });

  it('keeps missing files distinct from empty files', () => {
    const store = new SqliteTurnDiffStore({ dbPath: createDbPath() });
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'create-empty',
      capturedAtMs: 1_000,
      recordedAtMs: 1_000,
      events: [event('empty.txt', null, '', 0, 0)],
    });

    expect(
      store.getTurnSnapshot({
        ownerId: 'session-a',
        turnId: 'create-empty',
        path: 'empty.txt',
        nowMs: 1_000,
      })
    ).toEqual({ status: 'ready', oldText: null, newText: '' });
    expect(
      store.getTurnSnapshot({
        ownerId: 'session-a',
        turnId: 'create-empty',
        path: 'missing.txt',
        nowMs: 1_000,
      })
    ).toEqual({ status: 'unavailable' });
    expect(store.getLatestText({ ownerId: 'session-a', path: 'empty.txt' })).toEqual({
      status: 'tracked',
      text: '',
    });
    expectHealthy(store);
    store.close();
  });

  it('rejects oversized snapshot reads before reconstructing chunks', () => {
    const store = new SqliteTurnDiffStore({ dbPath: createDbPath() });
    const oldText = deterministicText(11, 64 * 1024);
    const newText = `${oldText}\nchanged`;
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'large-turn',
      capturedAtMs: 1_000,
      recordedAtMs: 1_000,
      events: [event('large.txt', oldText, newText, 1, 0)],
    });
    const readSnapshotText = vi.spyOn(
      store as unknown as {
        readSnapshotText(snapshotId: number | null): string | null;
      },
      'readSnapshotText'
    );

    expect(
      store.getEarliestOldSnapshot({
        ownerId: 'session-a',
        path: 'large.txt',
        nowMs: 1_000,
        maxRawBytes: Buffer.byteLength(oldText) - 1,
      })
    ).toEqual({ status: 'too_large', rawBytes: Buffer.byteLength(oldText) });
    expect(
      store.getTurnSnapshot({
        ownerId: 'session-a',
        turnId: 'large-turn',
        path: 'large.txt',
        nowMs: 1_000,
        maxRawBytes: Buffer.byteLength(oldText) + Buffer.byteLength(newText) - 1,
      })
    ).toEqual({
      status: 'too_large',
      rawBytes: Buffer.byteLength(oldText) + Buffer.byteLength(newText),
    });
    expect(
      store.getLatestText({
        ownerId: 'session-a',
        path: 'large.txt',
        maxRawBytes: Buffer.byteLength(newText) - 1,
      })
    ).toEqual({ status: 'too_large', rawBytes: Buffer.byteLength(newText) });
    expect(readSnapshotText).not.toHaveBeenCalled();

    expect(
      store.getEarliestOldSnapshot({
        ownerId: 'session-a',
        path: 'large.txt',
        nowMs: 1_000,
        maxRawBytes: Buffer.byteLength(oldText),
      })
    ).toEqual({ status: 'ready', text: oldText });
    expect(readSnapshotText).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('makes a repeated owner/turn/path write idempotent', () => {
    const store = new SqliteTurnDiffStore({ dbPath: createDbPath() });
    const input = {
      ownerId: 'session-a',
      turnId: 'turn-1',
      capturedAtMs: 1_000,
      recordedAtMs: 1_000,
      events: [event('a.txt', 'before', 'after', 1, 1)],
    } as const;
    store.recordTurn(input);
    const beforeRetry = store.stats();
    const retry = store.recordTurn({
      ...input,
      events: [event('a.txt', 'wrong-before', 'wrong-after', 99, 99)],
    });

    expect(retry.files).toEqual([{ path: 'a.txt', add: 1, del: 1 }]);
    expect(retry.metrics.rawBytes).toBe(0);
    expect(store.stats()).toMatchObject({
      turns: beforeRetry.turns,
      files: beforeRetry.files,
      snapshots: beforeRetry.snapshots,
      chunks: beforeRetry.chunks,
    });
    expect(store.getLatestText({ ownerId: 'session-a', path: 'a.txt' })).toEqual({
      status: 'tracked',
      text: 'after',
    });
    expectHealthy(store);
    store.close();
  });

  it('does not let a late older turn replace a newer path head', () => {
    const store = new SqliteTurnDiffStore({ dbPath: createDbPath() });
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'newer',
      capturedAtMs: 2_000,
      recordedAtMs: 2_000,
      events: [event('a.txt', 'v1', 'v2', 1, 1)],
    });
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'late-older',
      capturedAtMs: 1_000,
      recordedAtMs: 1_000,
      events: [event('a.txt', null, 'old result', 1, 0, false)],
    });

    expect(store.getLatestText({ ownerId: 'session-a', path: 'a.txt' })).toEqual({
      status: 'tracked',
      text: 'v2',
    });
    expect(
      store.getTurnSnapshot({
        ownerId: 'session-a',
        turnId: 'late-older',
        path: 'a.txt',
        nowMs: 2_000,
      })
    ).toEqual({ status: 'ready', oldText: null, newText: 'old result' });
    expectHealthy(store);
    store.close();
  });

  it('uses durable head proofs when an older multi-file turn commits last', () => {
    const store = new SqliteTurnDiffStore({ dbPath: createDbPath() });
    const olderProof = store.allocateHeadProof();
    const newerProof = store.allocateHeadProof();
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'newer-fast-turn',
      orderKey: '0002:newer',
      capturedAtMs: 2,
      recordedAtMs: 2,
      events: [{ ...event('a.txt', 'v1', 'v2', 1, 1), headProof: newerProof }],
    });
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'older-slow-turn',
      orderKey: '0001:older',
      capturedAtMs: 1,
      recordedAtMs: 2,
      events: [{ ...event('a.txt', 'v0', 'stale-v1', 1, 1), headProof: olderProof }],
    });

    expect(store.getLatestText({ ownerId: 'session-a', path: 'a.txt' })).toEqual({
      status: 'tracked',
      text: 'v2',
    });
    expectHealthy(store);
    store.close();
  });

  it('uses the original turn ordering when a retry adds another path', () => {
    const store = new SqliteTurnDiffStore({ dbPath: createDbPath() });
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'older',
      capturedAtMs: 1_000,
      recordedAtMs: 1_000,
      events: [event('a.txt', null, 'from older', 1, 0)],
    });
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'newer',
      capturedAtMs: 2_000,
      recordedAtMs: 2_000,
      events: [event('b.txt', null, 'from newer', 1, 0)],
    });
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'older',
      capturedAtMs: 3_000,
      recordedAtMs: 3_000,
      events: [event('b.txt', null, 'late retry', 1, 0, false)],
    });

    expect(store.getLatestText({ ownerId: 'session-a', path: 'b.txt' })).toEqual({
      status: 'tracked',
      text: 'from newer',
    });
    expect(
      store.getTurnSnapshot({
        ownerId: 'session-a',
        turnId: 'older',
        path: 'b.txt',
        nowMs: 3_000,
      })
    ).toEqual({ status: 'ready', oldText: null, newText: 'late retry' });
    expectHealthy(store);
    store.close();
  });

  it('does not let an expired turn retry add files or update path heads', () => {
    const store = new SqliteTurnDiffStore({ dbPath: createDbPath(), retentionDays: 1 });
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'expired',
      capturedAtMs: 0,
      recordedAtMs: 0,
      events: [event('a.txt', null, 'old head', 1, 0)],
    });

    const retry = store.recordTurn({
      ownerId: 'session-a',
      turnId: 'expired',
      capturedAtMs: 0,
      recordedAtMs: DAY_MS + 1,
      events: [event('b.txt', null, 'must not become a head', 1, 0)],
    });

    expect(retry.files).toEqual([]);
    expect(retry.gcScheduled).toBe(true);
    expect(store.getLatestText({ ownerId: 'session-a', path: 'a.txt' })).toEqual({
      status: 'tracked',
      text: 'old head',
    });
    expect(store.getLatestText({ ownerId: 'session-a', path: 'b.txt' })).toEqual({
      status: 'untracked',
    });
    expect(store.stats()).toMatchObject({ turns: 1, files: 1 });
    expectHealthy(store);
    store.close();
  });

  it('ignores first writes that arrive after their retention window', () => {
    const store = new SqliteTurnDiffStore({ dbPath: createDbPath(), retentionDays: 1 });
    const result = store.recordTurn({
      ownerId: 'session-a',
      turnId: 'already-expired',
      capturedAtMs: 0,
      recordedAtMs: DAY_MS + 1,
      events: [event('a.txt', null, 'stale', 1, 0)],
    });

    expect(result.files).toEqual([]);
    expect(result.gcScheduled).toBe(false);
    expect(store.stats()).toMatchObject({ turns: 0, files: 0 });
    expect(store.getLatestText({ ownerId: 'session-a', path: 'a.txt' })).toEqual({
      status: 'untracked',
    });
    store.close();
  });

  it('expires whole turns but preserves path heads for the next turn', () => {
    const store = new SqliteTurnDiffStore({ dbPath: createDbPath(), retentionDays: 1 });
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'old-turn',
      capturedAtMs: 0,
      recordedAtMs: 0,
      events: [event('a.txt', null, 'v1', 1, 0), event('b.txt', null, 'b1', 1, 0)],
    });
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'live-turn',
      capturedAtMs: DAY_MS,
      recordedAtMs: DAY_MS,
      events: [event('a.txt', 'v1', 'v2', 1, 1)],
    });

    const gc = store.gc(DAY_MS + 1);
    expect(gc.deletedTurns).toBe(1);
    expect(
      store.getTurnSnapshot({
        ownerId: 'session-a',
        turnId: 'old-turn',
        path: 'a.txt',
        nowMs: DAY_MS + 1,
      })
    ).toEqual({ status: 'unavailable' });
    expect(store.getLatestText({ ownerId: 'session-a', path: 'a.txt' })).toEqual({
      status: 'tracked',
      text: 'v2',
    });
    expect(store.getLatestText({ ownerId: 'session-a', path: 'b.txt' })).toEqual({
      status: 'tracked',
      text: 'b1',
    });

    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'next-turn',
      capturedAtMs: DAY_MS + 2,
      recordedAtMs: DAY_MS + 2,
      events: [event('a.txt', 'v2', 'v3', 1, 1)],
    });
    expect(store.getLatestText({ ownerId: 'session-a', path: 'a.txt' })).toEqual({
      status: 'tracked',
      text: 'v3',
    });
    expectHealthy(store);
    store.close();
  });

  it('never reuses turn ordering ids while detached path heads survive', () => {
    const dbPath = createDbPath();
    let store = new SqliteTurnDiffStore({ dbPath, retentionDays: 1 });
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'expired',
      capturedAtMs: 0,
      recordedAtMs: 0,
      events: [event('old.txt', null, 'old head', 1, 0)],
    });
    store.gc(DAY_MS + 1);
    store.close();

    store = new SqliteTurnDiffStore({ dbPath, retentionDays: 1 });
    store.recordTurn({
      ownerId: 'session-b',
      turnId: 'new',
      capturedAtMs: DAY_MS + 2,
      recordedAtMs: DAY_MS + 2,
      events: [event('new.txt', null, 'new head', 1, 0)],
    });
    store.close();

    const database = new Database(dbPath, { readonly: true });
    const oldHead = database
      .prepare("SELECT source_turn_id AS id FROM path_heads WHERE path = 'old.txt'")
      .get() as { readonly id: number };
    const newTurn = database.prepare("SELECT id FROM turns WHERE turn_key = 'new'").get() as {
      readonly id: number;
    };
    expect(newTurn.id).toBeGreaterThan(oldHead.id);
    database.close();
  });

  it('reclaims oldest complete turns after the physical database exceeds its cap', () => {
    const maxStorageBytes = 850 * 1024;
    const gcTargetBytes = 560 * 1024;
    const store = new SqliteTurnDiffStore({
      dbPath: createDbPath(),
      maxStorageBytes,
      gcTargetBytes,
      compression: 'gzip',
    });
    let previous: string | null = null;
    let latest = '';
    for (let index = 0; index < 12; index += 1) {
      latest = deterministicText(1_000 + index, 96 * 1024);
      store.recordTurn({
        ownerId: 'session-a',
        turnId: `turn-${index}`,
        capturedAtMs: index + 1,
        recordedAtMs: index + 1,
        events: [event('large.txt', previous, latest, 100, 100)],
      });
      previous = latest;
    }

    expect(store.stats().storage.total).toBeGreaterThan(maxStorageBytes);
    const gc = store.gc(12);
    expect(gc.deletedTurns).toBeGreaterThan(0);
    expect(gc.blockedByLiveData).toBe(false);
    expect(gc.after.total).toBeLessThanOrEqual(gcTargetBytes);
    expect(
      store.getTurnSnapshot({
        ownerId: 'session-a',
        turnId: 'turn-0',
        path: 'large.txt',
        nowMs: 12,
      })
    ).toEqual({ status: 'unavailable' });
    expect(
      store.getTurnSnapshot({
        ownerId: 'session-a',
        turnId: 'turn-11',
        path: 'large.txt',
        nowMs: 12,
      })
    ).toEqual({
      status: 'ready',
      oldText: deterministicText(1_010, 96 * 1024),
      newText: latest,
    });
    expect(store.getLatestText({ ownerId: 'session-a', path: 'large.txt' })).toEqual({
      status: 'tracked',
      text: latest,
    });
    const evictedRetry = store.recordTurn({
      ownerId: 'session-a',
      turnId: 'turn-0',
      capturedAtMs: 1,
      recordedAtMs: 12,
      events: [event('large.txt', null, 'late stale retry', 1, 0)],
    });
    expect(evictedRetry.files).toEqual([]);
    expect(store.getLatestText({ ownerId: 'session-a', path: 'large.txt' })).toEqual({
      status: 'tracked',
      text: latest,
    });
    expectHealthy(store);
    store.close();
  });

  it('limits each incremental GC step to one turn batch', () => {
    const store = new SqliteTurnDiffStore({ dbPath: createDbPath(), retentionDays: 1 });
    const database = (store as unknown as { readonly db: Database.Database }).db;
    database.transaction(() => {
      for (let index = 0; index < 129; index += 1) {
        store.recordTurn({
          ownerId: 'session-a',
          turnId: `turn-${index}`,
          capturedAtMs: 0,
          recordedAtMs: 0,
          events: [event(`${index}.txt`, null, 'same snapshot', 1, 0)],
        });
      }
    })();

    const cursor = store.beginGc(DAY_MS + 1);
    expect(store.gcStep(cursor)).toBeNull();
    expect(cursor.deletedTurns).toBe(128);
    expect(store.gcStep(cursor)).toBeNull();
    expect(cursor.deletedTurns).toBe(129);
    let result = store.gcStep(cursor);
    while (result === null) result = store.gcStep(cursor);
    expect(result.deletedTurns).toBe(129);
    expect(store.stats()).toMatchObject({ turns: 0, files: 0 });
    expectHealthy(store);
    store.close();
  });

  it('uses gzip for compressible chunks by default', () => {
    const dbPath = createDbPath();
    const store = new SqliteTurnDiffStore({ dbPath });
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'turn-1',
      capturedAtMs: 1_000,
      recordedAtMs: 1_000,
      events: [event('compressed.txt', null, 'compressible line\n'.repeat(16_384), 1, 0)],
    });
    store.close();

    const database = new Database(dbPath, { readonly: true });
    const codecs = database.prepare('SELECT DISTINCT codec FROM chunks').all() as {
      readonly codec: number;
    }[];
    expect(codecs.map((row) => row.codec)).toEqual([2]);
    database.close();
  });

  it('reclaims old single-turn owners instead of pinning one turn per owner', () => {
    const maxStorageBytes = 850 * 1024;
    const gcTargetBytes = 560 * 1024;
    const store = new SqliteTurnDiffStore({
      dbPath: createDbPath(),
      maxStorageBytes,
      gcTargetBytes,
      compression: 'gzip',
    });
    let latest = '';
    for (let index = 0; index < 12; index += 1) {
      latest = deterministicText(2_000 + index, 96 * 1024);
      store.recordTurn({
        ownerId: `session-${index}`,
        turnId: 'only-turn',
        capturedAtMs: index + 1,
        recordedAtMs: index + 1,
        events: [event('large.txt', null, latest, 100, 0)],
      });
    }

    expect(store.stats().storage.total).toBeGreaterThan(maxStorageBytes);
    const gc = store.gc(12);
    expect(gc.deletedTurns).toBeGreaterThan(0);
    expect(gc.blockedByLiveData).toBe(false);
    expect(gc.after.total).toBeLessThanOrEqual(gcTargetBytes);
    expect(store.getLatestText({ ownerId: 'session-0', path: 'large.txt' })).toEqual({
      status: 'untracked',
    });
    expect(store.getLatestText({ ownerId: 'session-11', path: 'large.txt' })).toEqual({
      status: 'tracked',
      text: latest,
    });
    expectHealthy(store);
    store.close();
  });

  it('detects equal-length chunk corruption while reading', () => {
    const dbPath = createDbPath();
    let store = new SqliteTurnDiffStore({ dbPath });
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'turn-1',
      capturedAtMs: 1_000,
      recordedAtMs: 1_000,
      events: [event('a.txt', null, 'small raw chunk', 1, 0)],
    });
    store.close();

    const database = new Database(dbPath);
    const chunk = database.prepare('SELECT hash, payload FROM chunks LIMIT 1').get() as {
      readonly hash: Buffer;
      readonly payload: Buffer;
    };
    const corrupted = Buffer.from(chunk.payload);
    corrupted[0] = (corrupted[0] ?? 0) ^ 1;
    database.prepare('UPDATE chunks SET payload = ? WHERE hash = ?').run(corrupted, chunk.hash);
    database.close();

    store = new SqliteTurnDiffStore({ dbPath });
    expect(() =>
      store.getTurnSnapshot({
        ownerId: 'session-a',
        turnId: 'turn-1',
        path: 'a.txt',
        nowMs: 1_000,
      })
    ).toThrow(/snapshot .* hash mismatch/);
    store.close();
  });

  it('detects a snapshot content-hash mismatch while reading', () => {
    const dbPath = createDbPath();
    let store = new SqliteTurnDiffStore({ dbPath });
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'turn-1',
      capturedAtMs: 1_000,
      recordedAtMs: 1_000,
      events: [event('a.txt', null, 'snapshot text', 1, 0)],
    });
    store.close();

    const database = new Database(dbPath);
    database.prepare('UPDATE snapshots SET content_hash = ?').run(Buffer.alloc(32, 0xff));
    database.close();

    store = new SqliteTurnDiffStore({ dbPath });
    expect(() =>
      store.getTurnSnapshot({
        ownerId: 'session-a',
        turnId: 'turn-1',
        path: 'a.txt',
        nowMs: 1_000,
      })
    ).toThrow(/snapshot .* hash mismatch/);
    store.close();
  });

  it('replaces the known legacy Loro schema in place', () => {
    const dbPath = createDbPath();
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE diff_docs (
        doc_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        owner_session_id TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        snapshot BLOB,
        snapshot_frontiers_json TEXT,
        snapshot_at_ms INTEGER,
        UNIQUE(workspace_id, owner_session_id, path)
      );
      CREATE TABLE diff_doc_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        update_bytes BLOB NOT NULL,
        frontiers_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        FOREIGN KEY(doc_id) REFERENCES diff_docs(doc_id) ON DELETE CASCADE
      );
      CREATE TABLE diff_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        owner_session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        path TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        old_frontiers_json TEXT NOT NULL,
        new_frontiers_json TEXT NOT NULL,
        old_present INTEGER NOT NULL,
        new_present INTEGER NOT NULL,
        add_count INTEGER,
        del_count INTEGER,
        source TEXT NOT NULL,
        captured_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        UNIQUE(workspace_id, owner_session_id, turn_id, path),
        FOREIGN KEY(doc_id) REFERENCES diff_docs(doc_id) ON DELETE CASCADE
      );
      CREATE INDEX diff_events_owner_path_expires_idx
        ON diff_events(workspace_id, owner_session_id, path, expires_at_ms, captured_at_ms, id);
      CREATE INDEX diff_events_owner_expires_idx
        ON diff_events(workspace_id, owner_session_id, expires_at_ms, path);
      CREATE INDEX diff_doc_updates_doc_created_idx
        ON diff_doc_updates(doc_id, created_at_ms, id);
    `);
    legacy.close();

    const store = new SqliteTurnDiffStore({ dbPath });
    expect(store.stats()).toMatchObject({ turns: 0, files: 0, integrity: 'ok' });
    store.close();

    const migrated = new Database(dbPath, { readonly: true });
    const tables = migrated
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { readonly name: string }[];
    expect(tables.map((row) => row.name)).not.toContain('diff_docs');
    expect(tables.map((row) => row.name)).toContain('turns');
    expect(migrated.pragma('application_id', { simple: true })).toBe(TURN_DIFF_APPLICATION_ID);
    migrated.close();
  });

  it('rejects an unowned lookalike schema without deleting its data', () => {
    const dbPath = createDbPath();
    const unrelated = new Database(dbPath);
    unrelated.exec("CREATE TABLE chunks (value TEXT); INSERT INTO chunks VALUES ('keep me');");
    unrelated.close();

    expect(() => new SqliteTurnDiffStore({ dbPath })).toThrow(/unknown SQLite schema/);

    const preserved = new Database(dbPath, { readonly: true });
    expect(preserved.prepare('SELECT value FROM chunks').pluck().get()).toBe('keep me');
    preserved.close();
  });

  it('rejects an unowned partial legacy schema without deleting its data', () => {
    const dbPath = createDbPath();
    const partial = new Database(dbPath);
    partial.exec(`
      CREATE TABLE diff_docs (doc_id TEXT PRIMARY KEY);
      INSERT INTO diff_docs VALUES ('keep-me');
    `);
    partial.close();

    expect(() => new SqliteTurnDiffStore({ dbPath })).toThrow(/unknown SQLite schema/);

    const preserved = new Database(dbPath, { readonly: true });
    expect(preserved.prepare('SELECT doc_id FROM diff_docs').pluck().get()).toBe('keep-me');
    preserved.close();
  });

  it('rejects a view-only unowned database without claiming it', () => {
    const dbPath = createDbPath();
    const unrelated = new Database(dbPath);
    unrelated.exec('CREATE VIEW unrelated_view AS SELECT 42 AS value;');
    unrelated.close();

    expect(() => new SqliteTurnDiffStore({ dbPath })).toThrow(/unknown SQLite schema/);

    const preserved = new Database(dbPath, { readonly: true });
    expect(preserved.prepare('SELECT value FROM unrelated_view').pluck().get()).toBe(42);
    expect(preserved.pragma('application_id', { simple: true })).toBe(0);
    preserved.close();
  });

  it('rebuilds an owned current-version schema when its constraints do not match', () => {
    const dbPath = createDbPath();
    let store = new SqliteTurnDiffStore({ dbPath });
    store.recordTurn({
      ownerId: 'session-a',
      turnId: 'turn-1',
      capturedAtMs: 1,
      recordedAtMs: 1,
      events: [event('a.txt', null, 'evidence', 1, 0)],
    });
    store.close();

    const malformed = new Database(dbPath);
    malformed.unsafeMode(true);
    malformed.pragma('writable_schema = ON');
    malformed
      .prepare(
        `
          UPDATE sqlite_master
          SET sql = replace(sql, ' REFERENCES turns(id) ON DELETE CASCADE', '')
          WHERE type = 'table' AND name = 'turn_files'
        `
      )
      .run();
    malformed.pragma('writable_schema = OFF');
    malformed.close();

    store = new SqliteTurnDiffStore({ dbPath });
    expect(store.stats()).toMatchObject({ turns: 0, files: 0, integrity: 'ok' });
    store.close();

    const repaired = new Database(dbPath, { readonly: true });
    const foreignTables = (
      repaired.prepare('PRAGMA foreign_key_list(turn_files)').all() as {
        readonly table: string;
      }[]
    ).map((row) => row.table);
    expect(foreignTables).toContain('turns');
    repaired.close();
  });

  it('recovers an interrupted schema only after the application marker claims it', () => {
    const dbPath = createDbPath();
    const partial = new Database(dbPath);
    partial.exec('CREATE TABLE turns (id INTEGER PRIMARY KEY);');
    partial.pragma(`application_id = ${TURN_DIFF_APPLICATION_ID}`);
    partial.pragma('user_version = 1');
    partial.close();

    const store = new SqliteTurnDiffStore({ dbPath });
    expect(store.stats()).toMatchObject({ turns: 0, files: 0, integrity: 'ok' });
    store.close();

    const recovered = new Database(dbPath, { readonly: true });
    const turnsSql = recovered
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turns'")
      .pluck()
      .get() as string;
    expect(turnsSql).toMatch(/AUTOINCREMENT/);
    expect(recovered.pragma('user_version', { simple: true })).toBe(2);
    recovered.close();
  });
});

describe('TurnDiffStore worker client', () => {
  it('runs SQLite and snapshot reconstruction in a persistent worker', async () => {
    const store = new TurnDiffStore({
      dbPath: createDbPath(),
      now: () => 1_000,
      workerUrl: new URL('./worker-entry.mjs', import.meta.url),
    });
    try {
      await store.recordTurn({
        ownerId: 'session-a',
        turnId: 'turn-1',
        capturedAtMs: 1_000,
        recordedAtMs: 1_000,
        events: [event('worker.txt', null, 'from worker', 1, 0)],
      });
      await expect(
        store.getTurnSnapshot({
          ownerId: 'session-a',
          turnId: 'turn-1',
          path: 'worker.txt',
          nowMs: 1_000,
        })
      ).resolves.toEqual({ status: 'ready', oldText: null, newText: 'from worker' });
      await expect(store.stats()).resolves.toMatchObject({
        turns: 1,
        files: 1,
        invalidSnapshotRefCounts: 0,
        invalidChunkRefCounts: 0,
        integrity: 'ok',
      });
    } finally {
      await store.close();
    }
  });

  it('uses the calibrated client clock for startup GC and default reads after restart', async () => {
    const dbPath = createDbPath();
    let calibratedNowMs = 99 * DAY_MS;
    const createStore = (): TurnDiffStore =>
      new TurnDiffStore({
        dbPath,
        retentionDays: 100,
        now: () => calibratedNowMs,
        workerUrl: new URL('./worker-entry.mjs', import.meta.url),
      });

    let store = createStore();
    await store.recordTurn({
      ownerId: 'session-a',
      turnId: 'retained-turn',
      capturedAtMs: 0,
      recordedAtMs: calibratedNowMs,
      events: [event('retained.txt', null, 'retained evidence', 1, 0)],
    });
    await store.close();

    store = createStore();
    try {
      await expect(store.listChangedPaths({ ownerId: 'session-a' })).resolves.toEqual([
        'retained.txt',
      ]);
      await expect(
        store.getTurnSnapshot({
          ownerId: 'session-a',
          turnId: 'retained-turn',
          path: 'retained.txt',
        })
      ).resolves.toEqual({
        status: 'ready',
        oldText: null,
        newText: 'retained evidence',
      });
      await expect(store.gc()).resolves.toMatchObject({ deletedTurns: 0 });

      calibratedNowMs = 101 * DAY_MS;
      await expect(store.gc()).resolves.toMatchObject({ deletedTurns: 1 });
    } finally {
      await store.close();
    }
  });

  it('automatically collects expired turns when the worker opens an existing database', async () => {
    const dbPath = createDbPath();
    const seed = new SqliteTurnDiffStore({ dbPath, retentionDays: 1 });
    seed.recordTurn({
      ownerId: 'session-a',
      turnId: 'expired-turn',
      capturedAtMs: 0,
      recordedAtMs: 0,
      events: [event('expired.txt', null, 'old evidence', 1, 0)],
    });
    seed.close();

    let resolveBackgroundGc: ((result: { readonly deletedTurns: number }) => void) | undefined;
    const backgroundGc = new Promise<{ readonly deletedTurns: number }>((resolve) => {
      resolveBackgroundGc = resolve;
    });
    const store = new TurnDiffStore({
      dbPath,
      retentionDays: 1,
      now: () => DAY_MS + 1,
      workerUrl: new URL('./worker-entry.mjs', import.meta.url),
      onBackgroundGc: (result) => resolveBackgroundGc?.(result),
    });
    try {
      await store.stats();
      await expect(backgroundGc).resolves.toMatchObject({ deletedTurns: 1 });
      await expect(
        store.getTurnSnapshot({
          ownerId: 'session-a',
          turnId: 'expired-turn',
          path: 'expired.txt',
        })
      ).resolves.toEqual({ status: 'unavailable' });
    } finally {
      await store.close();
    }
  });

  it('automatically starts size GC after a record crosses the storage cap', async () => {
    let backgroundGcCount = 0;
    let resolveBackgroundGc:
      | ((result: {
          readonly before: { readonly total: number };
          readonly blockedByLiveData: boolean;
        }) => void)
      | undefined;
    const backgroundGc = new Promise<{
      readonly before: { readonly total: number };
      readonly blockedByLiveData: boolean;
    }>((resolve) => {
      resolveBackgroundGc = resolve;
    });
    const maxStorageBytes = 256 * 1024;
    const store = new TurnDiffStore({
      dbPath: createDbPath(),
      maxStorageBytes,
      gcTargetBytes: 128 * 1024,
      now: () => 1_000,
      workerUrl: new URL('./worker-entry.mjs', import.meta.url),
      onBackgroundGc: (result) => {
        backgroundGcCount += 1;
        resolveBackgroundGc?.(result);
      },
    });
    try {
      const recorded = await store.recordTurn({
        ownerId: 'session-a',
        turnId: 'large-live-turn',
        capturedAtMs: 1_000,
        recordedAtMs: 1_000,
        events: [event('large.txt', null, deterministicText(8_888, 512 * 1024), 1, 0)],
      });
      expect(recorded.gcScheduled).toBe(true);
      await expect(backgroundGc).resolves.toMatchObject({
        before: { total: expect.any(Number) },
        blockedByLiveData: true,
      });
      const result = await backgroundGc;
      expect(result.before.total).toBeGreaterThan(maxStorageBytes);
      await expect(store.stats()).resolves.toMatchObject({ turns: 1, files: 1 });
    } finally {
      await store.close();
    }
    expect(backgroundGcCount).toBe(1);
  });
});

function createDbPath(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'lody-turn-diff-store-'));
  tempDirectories.push(directory);
  return path.join(directory, 'turn-diffs.sqlite3');
}

function event(
  workspacePath: string,
  oldText: string | null,
  newText: string | null,
  add: number,
  del: number,
  newIsCurrent = true
) {
  return {
    path: workspacePath,
    oldText,
    newText,
    newIsCurrent,
    headProof: newIsCurrent ? ++nextHeadProof : null,
    add,
    del,
  } as const;
}

function deterministicText(seed: number, byteLength: number): string {
  const bytes = Buffer.allocUnsafe(byteLength);
  let state = seed >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = 32 + ((state >>> 0) % 95);
  }
  return bytes.toString('ascii');
}

function expectHealthy(store: SqliteTurnDiffStore): void {
  expect(store.stats()).toMatchObject({
    invalidSnapshotRefCounts: 0,
    invalidChunkRefCounts: 0,
    integrity: 'ok',
  });
}

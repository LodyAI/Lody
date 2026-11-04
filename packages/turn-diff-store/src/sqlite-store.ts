import { createHash } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import './sqlite-runtime-support';
import Database from 'better-sqlite3';

import { compressChunk, decompressChunk } from './codec';
import { fastCdcV2020 } from './fastcdc';
import {
  DEFAULT_GC_TARGET_BYTES,
  DEFAULT_MAX_STORAGE_BYTES,
  DEFAULT_RETENTION_DAYS,
  type LatestTurnDiffText,
  type ListChangedPathsInput,
  type ListTurnFilesInput,
  type RecordTurnDiffInput,
  type RecordTurnDiffMetrics,
  type RecordTurnDiffResult,
  type SnapshotPathInput,
  type SnapshotDescriptorInput,
  type SnapshotDescriptor,
  type SnapshotBytesInput,
  type SnapshotBytes,
  type TurnDiffCompression,
  type TurnDiffFileSummary,
  type TurnDiffGcResult,
  type TurnDiffSnapshot,
  type TurnDiffSnapshotPair,
  type TurnDiffStorageBytes,
  type TurnDiffStoreOptions,
  type TurnDiffStoreStats,
  type TurnSnapshotInput,
} from './types';

const TURN_DIFF_APPLICATION_ID = 0x4c544431; // "LTD1"
const SCHEMA_VERSION = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;
const GC_TURN_BATCH_SIZE = 128;
const GC_VACUUM_PAGE_BATCH_SIZE = 1024;
const LEGACY_TABLE_NAMES = ['diff_docs', 'diff_doc_updates', 'diff_events'] as const;
const STORE_TABLE_NAMES = [
  'store_counters',
  'turns',
  'chunks',
  'snapshots',
  'snapshot_chunks',
  'turn_files',
  'path_heads',
] as const;
const LEGACY_INDEX_NAMES = [
  'diff_events_owner_path_expires_idx',
  'diff_events_owner_expires_idx',
  'diff_doc_updates_doc_created_idx',
] as const;
const STORE_INDEX_NAMES = [
  'turns_owner_expiry_idx',
  'turns_evicted_order_idx',
  'turn_files_path_idx',
  'turn_files_old_snapshot_idx',
  'turn_files_new_snapshot_idx',
  'snapshot_chunks_hash_idx',
  'path_heads_snapshot_idx',
  'path_heads_source_turn_idx',
] as const;
const KNOWN_SCHEMA_OBJECT_NAMES = new Set<string>([
  ...LEGACY_TABLE_NAMES,
  ...LEGACY_INDEX_NAMES,
  ...STORE_TABLE_NAMES,
  ...STORE_INDEX_NAMES,
]);

const LEGACY_SCHEMA_SQL = `
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
`;

const CURRENT_SCHEMA_SQL = `
  CREATE TABLE store_counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL CHECK(value >= 0)
  ) WITHOUT ROWID;

  CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    turn_key TEXT NOT NULL,
    order_key TEXT NOT NULL,
    captured_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    evicted INTEGER NOT NULL DEFAULT 0 CHECK(evicted IN (0, 1)),
    UNIQUE(owner_id, turn_key),
    UNIQUE(owner_id, order_key)
  );

  CREATE TABLE chunks (
    hash BLOB PRIMARY KEY CHECK(length(hash) = 32),
    codec INTEGER NOT NULL CHECK(codec IN (0, 1, 2)),
    raw_size INTEGER NOT NULL CHECK(raw_size >= 0),
    payload BLOB NOT NULL,
    ref_count INTEGER NOT NULL DEFAULT 0 CHECK(ref_count >= 0)
  ) WITHOUT ROWID;

  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY,
    content_hash BLOB NOT NULL UNIQUE CHECK(length(content_hash) = 32),
    raw_size INTEGER NOT NULL CHECK(raw_size >= 0),
    ref_count INTEGER NOT NULL DEFAULT 0 CHECK(ref_count >= 0)
  );

  CREATE TABLE snapshot_chunks (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    chunk_hash BLOB NOT NULL REFERENCES chunks(hash),
    raw_size INTEGER NOT NULL CHECK(raw_size >= 0),
    PRIMARY KEY(snapshot_id, ordinal)
  ) WITHOUT ROWID;

  CREATE TABLE turn_files (
    id INTEGER PRIMARY KEY,
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    old_snapshot_id INTEGER REFERENCES snapshots(id),
    new_snapshot_id INTEGER REFERENCES snapshots(id),
    add_count INTEGER NOT NULL CHECK(add_count >= 0),
    del_count INTEGER NOT NULL CHECK(del_count >= 0),
    UNIQUE(turn_id, path)
  );

  CREATE TABLE path_heads (
    owner_id TEXT NOT NULL,
    path TEXT NOT NULL,
    snapshot_id INTEGER REFERENCES snapshots(id),
    source_turn_id INTEGER NOT NULL,
    updated_order_key TEXT NOT NULL,
    head_proof INTEGER NOT NULL CHECK(head_proof > 0),
    PRIMARY KEY(owner_id, path)
  ) WITHOUT ROWID;

  CREATE INDEX turns_owner_expiry_idx
    ON turns(owner_id, evicted, expires_at_ms, order_key, id);
  CREATE INDEX turns_evicted_order_idx
    ON turns(evicted, order_key, id);
  CREATE INDEX turn_files_path_idx
    ON turn_files(path, turn_id);
  CREATE INDEX turn_files_old_snapshot_idx
    ON turn_files(old_snapshot_id) WHERE old_snapshot_id IS NOT NULL;
  CREATE INDEX turn_files_new_snapshot_idx
    ON turn_files(new_snapshot_id) WHERE new_snapshot_id IS NOT NULL;
  CREATE INDEX snapshot_chunks_hash_idx
    ON snapshot_chunks(chunk_hash);
  CREATE INDEX path_heads_snapshot_idx
    ON path_heads(snapshot_id) WHERE snapshot_id IS NOT NULL;
  CREATE INDEX path_heads_source_turn_idx
    ON path_heads(source_turn_id);
`;

interface NormalizedOptions {
  readonly dbPath: string;
  readonly retentionDays: number;
  readonly maxStorageBytes: number;
  readonly gcTargetBytes: number;
  readonly compression: TurnDiffCompression;
}

interface IdRow {
  readonly id: number;
}

interface SnapshotRow extends IdRow {
  readonly raw_size: number;
}

interface ReadableSnapshotRow extends SnapshotRow {
  readonly content_hash: Buffer;
}

interface ChunkSizeRow {
  readonly raw_size: number;
}

interface NullableSnapshotRow {
  readonly snapshot_id: number | null;
}

interface NullableSnapshotSizeRow extends NullableSnapshotRow {
  readonly raw_size: number;
}

interface PathHeadRow extends NullableSnapshotRow {
  readonly source_turn_id: number;
  readonly updated_order_key: string;
  readonly head_proof: number;
}

interface TurnIdentity extends IdRow {
  readonly captured_at_ms: number;
  readonly order_key: string;
  readonly expires_at_ms: number;
  readonly evicted: number;
}

interface TurnFileRow {
  readonly old_snapshot_id: number | null;
  readonly new_snapshot_id: number | null;
}

interface TurnFileSizeRow extends TurnFileRow {
  readonly old_raw_size: number;
  readonly new_raw_size: number;
}

interface TurnFileSummaryRow {
  readonly path: string;
  readonly add_count: number;
  readonly del_count: number;
}

interface PathRow {
  readonly path: string;
}

interface ChunkPayloadRow {
  readonly codec: number;
  readonly raw_size: number;
  readonly payload: Buffer;
}

interface DeletablePathHeadRow extends NullableSnapshotRow {
  readonly owner_id: string;
  readonly path: string;
  readonly source_turn_id: number;
  readonly head_proof: number;
}

interface CountRow {
  readonly count: number;
}

interface RefCountRow {
  readonly id: number;
  readonly reference_count: number;
}

interface ChunkRefCountRow {
  readonly hash: Buffer;
  readonly reference_count: number;
}

interface SchemaObjectRow {
  readonly type: string;
  readonly name: string;
  readonly table_name: string;
  readonly sql: string | null;
}

interface IntegrityRow {
  readonly integrity_check: string;
}

interface StoreStatsRow {
  readonly turns: number;
  readonly files: number;
  readonly snapshots: number;
  readonly chunks: number;
  readonly snapshot_references: number;
  readonly chunk_references: number;
  readonly raw_chunk_bytes: number;
  readonly stored_chunk_bytes: number;
  readonly invalid_snapshot_ref_counts: number;
  readonly invalid_chunk_ref_counts: number;
}

interface PreparedChunk {
  readonly hash: Buffer;
  readonly hashKey: string;
  readonly rawSize: number;
  readonly codec: number | null;
  readonly payload: Buffer | null;
}

interface PreparedSnapshot {
  readonly contentHash: Buffer;
  readonly hashKey: string;
  readonly rawSize: number;
  readonly existingId: number | null;
  readonly chunks: readonly PreparedChunk[];
}

interface MutableMetrics {
  rawBytes: number;
  newChunks: number;
  reusedChunks: number;
  encodeMs: number;
  chunkingMs: number;
  hashingMs: number;
  compressionMs: number;
}

type TurnDiffGcPhase = 'expired' | 'turns' | 'heads' | 'vacuum' | 'checkpoint' | 'done';

export interface TurnDiffGcCursor {
  readonly nowMs: number;
  readonly before: TurnDiffStorageBytes;
  readonly sizeGcTriggered: boolean;
  phase: TurnDiffGcPhase;
  deletedTurns: number;
  deletedSnapshots: number;
  deletedChunks: number;
}

export class SqliteTurnDiffStore {
  private readonly db: Database.Database;
  private readonly options: NormalizedOptions;
  private closed = false;
  private readonly readOnly: boolean;

  constructor(options: TurnDiffStoreOptions) {
    this.options = normalizeOptions(options);
    this.readOnly = options.readOnly === true;
    if (!this.readOnly) mkdirSync(path.dirname(this.options.dbPath), { recursive: true });
    this.db = new Database(this.options.dbPath, {
      timeout: 5_000,
      readonly: this.readOnly,
      fileMustExist: this.readOnly,
    });
    try {
      if (this.readOnly) {
        if (
          this.db.pragma('application_id', { simple: true }) !== TURN_DIFF_APPLICATION_ID ||
          this.db.pragma('user_version', { simple: true }) !== SCHEMA_VERSION ||
          schemaFingerprint(readSchemaObjects(this.db)) !==
            expectedSchemaFingerprint(CURRENT_SCHEMA_SQL)
        ) {
          throw this.unknownSchemaError();
        }
      } else this.initializeSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  allocateHeadProof(): number {
    this.assertWritable();
    this.assertOpen();
    const allocate = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `
            UPDATE store_counters
            SET value = value + 1
            WHERE name = 'head_proof'
            RETURNING value AS id
          `
        )
        .get() as IdRow | undefined;
      if (!row || !Number.isSafeInteger(row.id) || row.id <= 0) {
        throw new Error('Failed to allocate a turn-diff head proof token.');
      }
      return row.id;
    });
    return allocate.immediate();
  }

  recordTurn(
    input: RecordTurnDiffInput & { readonly capturedAtMs: number; readonly recordedAtMs: number }
  ): RecordTurnDiffResult {
    this.assertWritable();
    this.assertOpen();
    validateRecordInput(input);
    const startedAt = performance.now();
    const recordedAtMs = input.recordedAtMs;
    const capturedAtMs = input.capturedAtMs;
    const orderKey = input.orderKey ?? defaultTurnOrderKey(capturedAtMs, input.turnId);
    const expiresAtMs = capturedAtMs + this.options.retentionDays * DAY_MS;
    const metrics: MutableMetrics = {
      rawBytes: 0,
      newChunks: 0,
      reusedChunks: 0,
      encodeMs: 0,
      chunkingMs: 0,
      hashingMs: 0,
      compressionMs: 0,
    };
    const existingTurn = this.db
      .prepare(
        `
          SELECT id, captured_at_ms, order_key, expires_at_ms, evicted
          FROM turns
          WHERE owner_id = ? AND turn_key = ?
        `
      )
      .get(input.ownerId, input.turnId) as TurnIdentity | undefined;
    if (
      (existingTurn !== undefined &&
        (existingTurn.evicted !== 0 || existingTurn.expires_at_ms <= recordedAtMs)) ||
      (existingTurn === undefined && expiresAtMs <= recordedAtMs)
    ) {
      return {
        files: [],
        metrics: {
          ...metrics,
          transactionMs: 0,
          totalMs: performance.now() - startedAt,
        },
        gcScheduled:
          (existingTurn !== undefined && existingTurn.expires_at_ms <= recordedAtMs) ||
          this.shouldRunGc(recordedAtMs),
      };
    }
    const existingPaths = new Set(
      existingTurn === undefined
        ? []
        : (
            this.db
              .prepare('SELECT path FROM turn_files WHERE turn_id = ?')
              .all(existingTurn.id) as PathRow[]
          ).map((row) => row.path)
    );
    const pendingEvents = input.events.filter((event) => !existingPaths.has(event.path));
    if (pendingEvents.length === 0) {
      const files = existingTurn
        ? this.listTurnFiles({
            ownerId: input.ownerId,
            turnId: input.turnId,
            nowMs: recordedAtMs,
          })
        : [];
      return {
        files,
        metrics: {
          ...metrics,
          transactionMs: 0,
          totalMs: performance.now() - startedAt,
        },
        gcScheduled: this.shouldRunGc(recordedAtMs),
      };
    }
    const snapshotCache = new Map<string, PreparedSnapshot>();
    const chunkCache = new Map<string, PreparedChunk>();
    const preparedEvents = pendingEvents.map((event) => ({
      path: event.path,
      oldSnapshot: this.prepareSnapshot(event.oldText, snapshotCache, chunkCache, metrics),
      newSnapshot: this.prepareSnapshot(event.newText, snapshotCache, chunkCache, metrics),
      newIsCurrent: event.newIsCurrent,
      headProof: event.headProof,
      add: event.add,
      del: event.del,
    }));

    const transactionStartedAt = performance.now();
    const commit = this.db.transaction(() => {
      const turn = this.getOrCreateTurn(
        input.ownerId,
        input.turnId,
        orderKey,
        capturedAtMs,
        expiresAtMs
      );
      if (turn.evicted !== 0 || turn.expires_at_ms <= recordedAtMs) {
        return false;
      }
      const materializedSnapshots = new Map<string, number>();
      const releasedSnapshotIds = new Set<number>();
      for (const event of preparedEvents) {
        const existing = this.db
          .prepare('SELECT id FROM turn_files WHERE turn_id = ? AND path = ?')
          .get(turn.id, event.path) as IdRow | undefined;
        if (existing) continue;

        const oldSnapshotId = this.materializeSnapshot(event.oldSnapshot, materializedSnapshots);
        const newSnapshotId = this.materializeSnapshot(event.newSnapshot, materializedSnapshots);
        this.db
          .prepare(
            `
              INSERT INTO turn_files (
                turn_id, path, old_snapshot_id, new_snapshot_id, add_count, del_count
              ) VALUES (?, ?, ?, ?, ?, ?)
            `
          )
          .run(turn.id, event.path, oldSnapshotId, newSnapshotId, event.add, event.del);
        this.changeSnapshotRefCount(oldSnapshotId, 1);
        this.changeSnapshotRefCount(newSnapshotId, 1);
        if (event.newIsCurrent) {
          if (event.headProof === null) {
            throw new Error(`Missing head proof for current turn-diff path ${event.path}.`);
          }
          const releasedSnapshotId = this.updatePathHead(
            input.ownerId,
            event.path,
            newSnapshotId,
            turn.id,
            turn.order_key,
            event.headProof
          );
          if (releasedSnapshotId !== undefined) {
            releasedSnapshotIds.add(releasedSnapshotId);
          }
        }
      }
      this.deleteUnreferencedSnapshotsAndChunks(releasedSnapshotIds);
      return true;
    });
    commit.immediate();
    const transactionMs = performance.now() - transactionStartedAt;
    const files = this.listTurnFiles({
      ownerId: input.ownerId,
      turnId: input.turnId,
      nowMs: recordedAtMs,
    });
    const gcScheduled = this.shouldRunGc(recordedAtMs);
    return {
      files,
      metrics: {
        ...metrics,
        transactionMs,
        totalMs: performance.now() - startedAt,
      } satisfies RecordTurnDiffMetrics,
      gcScheduled,
    };
  }

  listChangedPaths(input: ListChangedPathsInput & { readonly nowMs: number }): readonly string[] {
    this.assertOpen();
    const rows = this.db
      .prepare(
        `
          SELECT DISTINCT tf.path
          FROM turn_files AS tf
          JOIN turns AS t ON t.id = tf.turn_id
          WHERE t.owner_id = ? AND t.evicted = 0 AND t.expires_at_ms > ?
          ORDER BY tf.path ASC
        `
      )
      .all(input.ownerId, input.nowMs) as PathRow[];
    return rows.map((row) => row.path);
  }

  getSnapshotDescriptor(
    input: SnapshotDescriptorInput & { readonly nowMs: number }
  ): SnapshotDescriptor {
    this.assertOpen();
    assertSnapshotReadLimit(input.maxRawBytes);
    return this.db.transaction((): SnapshotDescriptor => {
      const row = this.selectSnapshot(input);
      if (!row) return { status: 'unavailable' };
      if (exceedsSnapshotReadLimit(row.raw_size, input.maxRawBytes)) {
        return { status: 'too_large', rawBytes: row.raw_size };
      }
      return {
        status: 'ready',
        snapshot:
          row.snapshot_id === null
            ? null
            : {
                hash: row.content_hash.toString('hex'),
                rawBytes: row.raw_size,
              },
      };
    })();
  }

  getSnapshotBytes(input: SnapshotBytesInput & { readonly nowMs: number }): SnapshotBytes {
    this.assertOpen();
    assertSnapshotReadLimit(input.maxRawBytes);
    if (!/^[0-9a-f]{64}$/u.test(input.hash)) return { status: 'unavailable' };
    return this.db.transaction((): SnapshotBytes => {
      const row = this.selectSnapshot(input);
      if (!row || row.snapshot_id === null || row.content_hash.toString('hex') !== input.hash) {
        return { status: 'unavailable' };
      }
      if (exceedsSnapshotReadLimit(row.raw_size, input.maxRawBytes)) {
        return { status: 'too_large', rawBytes: row.raw_size };
      }
      return { status: 'ready', bytes: this.readSnapshotBytes(row.snapshot_id) };
    })();
  }

  private selectSnapshot(
    input: SnapshotDescriptorInput & { readonly nowMs: number }
  ): (NullableSnapshotSizeRow & { readonly content_hash: Buffer }) | undefined {
    // Column names come from the closed side union, never interpolated input.
    const side =
      input.turnId !== undefined && input.side === 'new' ? 'new_snapshot_id' : 'old_snapshot_id';
    return this.db
      .prepare(`
      SELECT tf.${side} AS snapshot_id, COALESCE(s.raw_size, 0) AS raw_size,
             s.content_hash
      FROM turn_files AS tf JOIN turns AS t ON t.id = tf.turn_id
      LEFT JOIN snapshots AS s ON s.id = tf.${side}
      WHERE t.owner_id = ? AND tf.path = ? AND t.evicted = 0 AND t.expires_at_ms > ?
        ${input.turnId === undefined ? '' : 'AND t.turn_key = ?'}
      ORDER BY t.order_key ASC, t.id ASC LIMIT 1
    `)
      .get(
        ...[
          input.ownerId,
          input.path,
          input.nowMs,
          ...(input.turnId === undefined ? [] : [input.turnId]),
        ]
      ) as (NullableSnapshotSizeRow & { readonly content_hash: Buffer }) | undefined;
  }

  getEarliestOldSnapshot(input: SnapshotPathInput & { readonly nowMs: number }): TurnDiffSnapshot {
    this.assertOpen();
    assertSnapshotReadLimit(input.maxRawBytes);
    return this.db.transaction((): TurnDiffSnapshot => {
      const row = this.db
        .prepare(
          `
            SELECT tf.old_snapshot_id AS snapshot_id, COALESCE(s.raw_size, 0) AS raw_size
            FROM turn_files AS tf
            JOIN turns AS t ON t.id = tf.turn_id
            LEFT JOIN snapshots AS s ON s.id = tf.old_snapshot_id
            WHERE t.owner_id = ? AND t.evicted = 0 AND tf.path = ? AND t.expires_at_ms > ?
            ORDER BY t.order_key ASC, t.id ASC
            LIMIT 1
          `
        )
        .get(input.ownerId, input.path, input.nowMs) as NullableSnapshotSizeRow | undefined;
      if (!row) return { status: 'unavailable' };
      if (exceedsSnapshotReadLimit(row.raw_size, input.maxRawBytes)) {
        return { status: 'too_large', rawBytes: row.raw_size };
      }
      return { status: 'ready', text: this.readSnapshotText(row.snapshot_id) };
    })();
  }

  getTurnSnapshot(input: TurnSnapshotInput & { readonly nowMs: number }): TurnDiffSnapshotPair {
    this.assertOpen();
    assertSnapshotReadLimit(input.maxRawBytes);
    return this.db.transaction((): TurnDiffSnapshotPair => {
      const row = this.db
        .prepare(
          `
            SELECT
              tf.old_snapshot_id,
              tf.new_snapshot_id,
              COALESCE(old_snapshot.raw_size, 0) AS old_raw_size,
              COALESCE(new_snapshot.raw_size, 0) AS new_raw_size
            FROM turn_files AS tf
            JOIN turns AS t ON t.id = tf.turn_id
            LEFT JOIN snapshots AS old_snapshot ON old_snapshot.id = tf.old_snapshot_id
            LEFT JOIN snapshots AS new_snapshot ON new_snapshot.id = tf.new_snapshot_id
            WHERE t.owner_id = ?
              AND t.turn_key = ?
              AND t.evicted = 0
              AND tf.path = ?
              AND t.expires_at_ms > ?
            LIMIT 1
          `
        )
        .get(input.ownerId, input.turnId, input.path, input.nowMs) as TurnFileSizeRow | undefined;
      if (!row) return { status: 'unavailable' };
      const rawBytes = row.old_raw_size + row.new_raw_size;
      if (exceedsSnapshotReadLimit(rawBytes, input.maxRawBytes)) {
        return { status: 'too_large', rawBytes };
      }
      return {
        status: 'ready',
        oldText: this.readSnapshotText(row.old_snapshot_id),
        newText: this.readSnapshotText(row.new_snapshot_id),
      };
    })();
  }

  getLatestText(input: Omit<SnapshotPathInput, 'nowMs'>): LatestTurnDiffText {
    this.assertOpen();
    assertSnapshotReadLimit(input.maxRawBytes);
    return this.db.transaction((): LatestTurnDiffText => {
      const row = this.db
        .prepare(
          `
            SELECT ph.snapshot_id, COALESCE(s.raw_size, 0) AS raw_size
            FROM path_heads AS ph
            LEFT JOIN snapshots AS s ON s.id = ph.snapshot_id
            WHERE ph.owner_id = ? AND ph.path = ?
          `
        )
        .get(input.ownerId, input.path) as NullableSnapshotSizeRow | undefined;
      if (!row) return { status: 'untracked' };
      if (exceedsSnapshotReadLimit(row.raw_size, input.maxRawBytes)) {
        return { status: 'too_large', rawBytes: row.raw_size };
      }
      return { status: 'tracked', text: this.readSnapshotText(row.snapshot_id) };
    })();
  }

  listTurnFiles(
    input: ListTurnFilesInput & { readonly nowMs: number }
  ): readonly TurnDiffFileSummary[] {
    this.assertOpen();
    const rows = this.db
      .prepare(
        `
          SELECT tf.path, tf.add_count, tf.del_count
          FROM turn_files AS tf
          JOIN turns AS t ON t.id = tf.turn_id
          WHERE t.owner_id = ?
            AND t.turn_key = ?
            AND t.evicted = 0
            AND t.expires_at_ms > ?
          ORDER BY tf.path ASC
        `
      )
      .all(input.ownerId, input.turnId, input.nowMs) as TurnFileSummaryRow[];
    return rows.map((row) => ({ path: row.path, add: row.add_count, del: row.del_count }));
  }

  shouldRunGc(nowMs: number): boolean {
    if (this.readOnly) return false;
    this.assertOpen();
    const expired = this.db
      .prepare('SELECT 1 AS id FROM turns WHERE expires_at_ms <= ? LIMIT 1')
      .get(nowMs) as IdRow | undefined;
    return expired !== undefined || this.storageBytes().total > this.options.maxStorageBytes;
  }

  gc(nowMs: number): TurnDiffGcResult {
    const cursor = this.beginGc(nowMs);
    while (true) {
      const result = this.gcStep(cursor);
      if (result !== null) return result;
    }
  }

  beginGc(nowMs: number): TurnDiffGcCursor {
    this.assertWritable();
    this.assertOpen();
    const before = this.storageBytes(true);
    return {
      nowMs,
      before,
      sizeGcTriggered: before.total > this.options.maxStorageBytes,
      phase: 'expired',
      deletedTurns: 0,
      deletedSnapshots: 0,
      deletedChunks: 0,
    };
  }

  gcStep(cursor: TurnDiffGcCursor): TurnDiffGcResult | null {
    this.assertOpen();
    if (cursor.phase === 'expired') {
      const expiredIds = (
        this.db
          .prepare('SELECT id FROM turns WHERE expires_at_ms <= ? ORDER BY id ASC LIMIT ?')
          .all(cursor.nowMs, GC_TURN_BATCH_SIZE) as IdRow[]
      ).map((row) => row.id);
      if (expiredIds.length === 0) {
        cursor.phase = cursor.sizeGcTriggered ? 'turns' : 'vacuum';
        return null;
      }
      this.accumulateDeletedTurns(cursor, expiredIds, 'delete');
      return null;
    }

    if (cursor.phase === 'turns') {
      if (this.estimatedCompactedStorageBytes() <= this.options.gcTargetBytes) {
        cursor.phase = 'vacuum';
        return null;
      }
      const oldestIds = (
        this.db
          .prepare(
            `
              SELECT id
              FROM turns
              WHERE evicted = 0
                AND id != (
                SELECT id
                FROM turns
                WHERE evicted = 0
                ORDER BY order_key DESC, id DESC
                LIMIT 1
              )
              ORDER BY order_key ASC, id ASC
              LIMIT ?
            `
          )
          .all(GC_TURN_BATCH_SIZE) as IdRow[]
      ).map((row) => row.id);
      if (oldestIds.length === 0) {
        cursor.phase = 'heads';
        return null;
      }
      this.accumulateDeletedTurns(cursor, oldestIds, 'evict');
      return null;
    }

    if (cursor.phase === 'heads') {
      if (this.estimatedCompactedStorageBytes() <= this.options.gcTargetBytes) {
        cursor.phase = 'vacuum';
        return null;
      }
      const oldestHeads = this.db
        .prepare(
          `
            SELECT owner_id, path, snapshot_id, source_turn_id, head_proof
            FROM path_heads
            WHERE source_turn_id IS NOT (
              SELECT id
              FROM turns
              WHERE evicted = 0
              ORDER BY order_key DESC, id DESC
              LIMIT 1
            )
            ORDER BY head_proof ASC, source_turn_id ASC, owner_id ASC, path ASC
            LIMIT ?
          `
        )
        .all(GC_TURN_BATCH_SIZE) as DeletablePathHeadRow[];
      if (oldestHeads.length === 0) {
        cursor.phase = 'vacuum';
        return null;
      }
      const deleted = this.deletePathHeads(oldestHeads);
      cursor.deletedSnapshots += deleted.snapshots;
      cursor.deletedChunks += deleted.chunks;
      return null;
    }

    if (cursor.phase === 'vacuum') {
      const freePages = this.db.pragma('freelist_count', { simple: true }) as number;
      if (freePages === 0) {
        cursor.phase = 'checkpoint';
        return null;
      }
      this.db.pragma(`incremental_vacuum(${Math.min(freePages, GC_VACUUM_PAGE_BATCH_SIZE)})`);
      return null;
    }

    if (cursor.phase === 'checkpoint') {
      const after = this.storageBytes(true);
      cursor.phase = 'done';
      return {
        deletedTurns: cursor.deletedTurns,
        deletedSnapshots: cursor.deletedSnapshots,
        deletedChunks: cursor.deletedChunks,
        before: cursor.before,
        after,
        blockedByLiveData: cursor.sizeGcTriggered && after.total > this.options.gcTargetBytes,
      };
    }

    throw new Error('Turn-diff GC cursor has already completed.');
  }

  stats(): TurnDiffStoreStats {
    this.assertOpen();
    const row = this.db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM turns WHERE evicted = 0) AS turns,
            (SELECT COUNT(*) FROM turn_files) AS files,
            (SELECT COUNT(*) FROM snapshots) AS snapshots,
            (SELECT COUNT(*) FROM chunks) AS chunks,
            (SELECT COALESCE(SUM(ref_count), 0) FROM snapshots) AS snapshot_references,
            (SELECT COALESCE(SUM(ref_count), 0) FROM chunks) AS chunk_references,
            (SELECT COALESCE(SUM(raw_size), 0) FROM chunks) AS raw_chunk_bytes,
            (SELECT COALESCE(SUM(length(payload)), 0) FROM chunks) AS stored_chunk_bytes,
            (
              SELECT COUNT(*)
              FROM snapshots AS s
              WHERE s.ref_count != (
                (SELECT COUNT(*) FROM turn_files WHERE old_snapshot_id = s.id) +
                (SELECT COUNT(*) FROM turn_files WHERE new_snapshot_id = s.id) +
                (SELECT COUNT(*) FROM path_heads WHERE snapshot_id = s.id)
              )
            ) AS invalid_snapshot_ref_counts,
            (
              SELECT COUNT(*)
              FROM chunks AS c
              WHERE c.ref_count != (
                SELECT COUNT(*) FROM snapshot_chunks WHERE chunk_hash = c.hash
              )
            ) AS invalid_chunk_ref_counts
        `
      )
      .get() as StoreStatsRow;
    const integrity = this.db.prepare('PRAGMA integrity_check').get() as IntegrityRow;
    return {
      turns: row.turns,
      files: row.files,
      snapshots: row.snapshots,
      chunks: row.chunks,
      snapshotReferences: row.snapshot_references,
      chunkReferences: row.chunk_references,
      rawChunkBytes: row.raw_chunk_bytes,
      storedChunkBytes: row.stored_chunk_bytes,
      invalidSnapshotRefCounts: row.invalid_snapshot_ref_counts,
      invalidChunkRefCounts: row.invalid_chunk_ref_counts,
      integrity: integrity.integrity_check,
      storage: this.storageBytes(),
    };
  }

  private initializeSchema(): void {
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = OFF');
    const initialize = this.db.transaction(() => {
      // Classification must happen after BEGIN IMMEDIATE owns the write lock.
      // Otherwise a second opener can classify a stale fresh DB, wait for the
      // first opener, then drop the schema and data that opener just committed.
      const version = this.db.pragma('user_version', { simple: true }) as number;
      const applicationId = this.db.pragma('application_id', { simple: true }) as number;
      const schemaObjects = readSchemaObjects(this.db);
      const fingerprint = schemaFingerprint(schemaObjects);
      const objectNames = new Set(schemaObjects.map((row) => row.name));
      const isFreshDatabase = applicationId === 0 && version === 0 && schemaObjects.length === 0;
      const isLegacyDatabase =
        applicationId === 0 &&
        version === 0 &&
        fingerprint === expectedSchemaFingerprint(LEGACY_SCHEMA_SQL);
      const isOwnedDatabase = applicationId === TURN_DIFF_APPLICATION_ID;

      if (!isFreshDatabase && !isLegacyDatabase && !isOwnedDatabase) {
        throw this.unknownSchemaError();
      }
      if (isOwnedDatabase) {
        const unknownObjects = [...objectNames].filter(
          (name) => !KNOWN_SCHEMA_OBJECT_NAMES.has(name)
        );
        if (unknownObjects.length > 0) throw this.unknownSchemaError();
        if (version < 0 || version > SCHEMA_VERSION) {
          throw new Error(`Unsupported turn-diff store schema version ${version}.`);
        }
      }

      const hasCurrentSchema =
        isOwnedDatabase &&
        version === SCHEMA_VERSION &&
        fingerprint === expectedSchemaFingerprint(CURRENT_SCHEMA_SQL);
      if (!hasCurrentSchema) {
        this.dropKnownSchema();
        this.createSchema();
      }
      this.db
        .prepare("INSERT OR IGNORE INTO store_counters(name, value) VALUES ('head_proof', 0)")
        .run();
      this.db.pragma(`application_id = ${TURN_DIFF_APPLICATION_ID}`);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    initialize.immediate();

    const autoVacuum = this.db.pragma('auto_vacuum', { simple: true }) as number;
    if (autoVacuum !== 2) {
      this.db.pragma('auto_vacuum = INCREMENTAL');
      this.db.exec('VACUUM');
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('wal_autocheckpoint = 1000');
  }

  private unknownSchemaError(): Error {
    return new Error(
      `Turn-diff store ${this.options.dbPath} has an unknown SQLite schema and was not modified.`
    );
  }

  private dropKnownSchema(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS path_heads;
      DROP TABLE IF EXISTS turn_files;
      DROP TABLE IF EXISTS snapshot_chunks;
      DROP TABLE IF EXISTS snapshots;
      DROP TABLE IF EXISTS chunks;
      DROP TABLE IF EXISTS turns;
      DROP TABLE IF EXISTS store_counters;
      DROP TABLE IF EXISTS diff_events;
      DROP TABLE IF EXISTS diff_doc_updates;
      DROP TABLE IF EXISTS diff_docs;
    `);
  }

  private createSchema(): void {
    this.db.exec(CURRENT_SCHEMA_SQL);
  }

  private getOrCreateTurn(
    ownerId: string,
    turnKey: string,
    orderKey: string,
    capturedAtMs: number,
    expiresAtMs: number
  ): TurnIdentity {
    this.db
      .prepare(
        `
          INSERT INTO turns(owner_id, turn_key, order_key, captured_at_ms, expires_at_ms)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(owner_id, turn_key) DO NOTHING
        `
      )
      .run(ownerId, turnKey, orderKey, capturedAtMs, expiresAtMs);
    const row = this.db
      .prepare(
        `
          SELECT id, captured_at_ms, order_key, expires_at_ms, evicted
          FROM turns
          WHERE owner_id = ? AND turn_key = ?
        `
      )
      .get(ownerId, turnKey) as TurnIdentity | undefined;
    if (!row) throw new Error(`Failed to create turn-diff turn ${turnKey}.`);
    return row;
  }

  private prepareSnapshot(
    text: string | null,
    snapshotCache: Map<string, PreparedSnapshot>,
    chunkCache: Map<string, PreparedChunk>,
    metrics: MutableMetrics
  ): PreparedSnapshot | null {
    if (text === null) return null;
    const encodeStartedAt = performance.now();
    const bytes = Buffer.from(text, 'utf8');
    metrics.encodeMs += performance.now() - encodeStartedAt;
    metrics.rawBytes += bytes.byteLength;

    const fullHashStartedAt = performance.now();
    const contentHash = createHash('sha256').update(bytes).digest();
    metrics.hashingMs += performance.now() - fullHashStartedAt;
    const hashKey = contentHash.toString('hex');
    const cached = snapshotCache.get(hashKey);
    if (cached) return cached;

    const existing = this.db
      .prepare('SELECT id, raw_size FROM snapshots WHERE content_hash = ?')
      .get(contentHash) as SnapshotRow | undefined;
    if (existing) {
      if (existing.raw_size !== bytes.byteLength) {
        throw new Error('SHA-256 snapshot collision detected while storing turn diff.');
      }
      const count = this.db
        .prepare('SELECT COUNT(*) AS count FROM snapshot_chunks WHERE snapshot_id = ?')
        .get(existing.id) as CountRow;
      metrics.reusedChunks += count.count;
      const prepared: PreparedSnapshot = {
        contentHash,
        hashKey,
        rawSize: bytes.byteLength,
        existingId: existing.id,
        chunks: [],
      };
      snapshotCache.set(hashKey, prepared);
      return prepared;
    }

    const chunkingStartedAt = performance.now();
    const boundaries = fastCdcV2020(bytes);
    metrics.chunkingMs += performance.now() - chunkingStartedAt;
    const chunks: PreparedChunk[] = [];
    for (const boundary of boundaries) {
      const view = bytes.subarray(boundary.offset, boundary.offset + boundary.length);
      const hashStartedAt = performance.now();
      const hash = createHash('sha256').update(view).digest();
      metrics.hashingMs += performance.now() - hashStartedAt;
      const chunkHashKey = hash.toString('hex');
      const requestCached = chunkCache.get(chunkHashKey);
      if (requestCached) {
        if (requestCached.rawSize !== view.byteLength) {
          throw new Error('SHA-256 chunk collision detected within a turn-diff request.');
        }
        metrics.reusedChunks += 1;
        chunks.push(requestCached);
        continue;
      }
      const stored = this.db.prepare('SELECT raw_size FROM chunks WHERE hash = ?').get(hash) as
        | ChunkSizeRow
        | undefined;
      if (stored) {
        if (stored.raw_size !== view.byteLength) {
          throw new Error('SHA-256 chunk collision detected while storing turn diff.');
        }
        const prepared: PreparedChunk = {
          hash,
          hashKey: chunkHashKey,
          rawSize: view.byteLength,
          codec: null,
          payload: null,
        };
        metrics.reusedChunks += 1;
        chunkCache.set(chunkHashKey, prepared);
        chunks.push(prepared);
        continue;
      }
      const compressionStartedAt = performance.now();
      const encoded = compressChunk(view, this.options.compression);
      metrics.compressionMs += performance.now() - compressionStartedAt;
      const prepared: PreparedChunk = {
        hash,
        hashKey: chunkHashKey,
        rawSize: view.byteLength,
        codec: encoded.codec,
        payload: encoded.payload,
      };
      metrics.newChunks += 1;
      chunkCache.set(chunkHashKey, prepared);
      chunks.push(prepared);
    }
    const prepared: PreparedSnapshot = {
      contentHash,
      hashKey,
      rawSize: bytes.byteLength,
      existingId: null,
      chunks,
    };
    snapshotCache.set(hashKey, prepared);
    return prepared;
  }

  private materializeSnapshot(
    snapshot: PreparedSnapshot | null,
    materialized: Map<string, number>
  ): number | null {
    if (snapshot === null) return null;
    const cachedId = materialized.get(snapshot.hashKey);
    if (cachedId !== undefined) return cachedId;
    if (snapshot.existingId !== null) {
      materialized.set(snapshot.hashKey, snapshot.existingId);
      return snapshot.existingId;
    }

    const existing = this.db
      .prepare('SELECT id, raw_size FROM snapshots WHERE content_hash = ?')
      .get(snapshot.contentHash) as SnapshotRow | undefined;
    if (existing) {
      if (existing.raw_size !== snapshot.rawSize) {
        throw new Error('SHA-256 snapshot collision detected during turn-diff commit.');
      }
      materialized.set(snapshot.hashKey, existing.id);
      return existing.id;
    }

    const insert = this.db
      .prepare('INSERT INTO snapshots(content_hash, raw_size, ref_count) VALUES (?, ?, 0)')
      .run(snapshot.contentHash, snapshot.rawSize);
    const snapshotId = Number(insert.lastInsertRowid);
    for (let ordinal = 0; ordinal < snapshot.chunks.length; ordinal += 1) {
      const chunk = snapshot.chunks[ordinal];
      if (!chunk) throw new Error(`Missing prepared chunk ${ordinal}.`);
      if (chunk.payload !== null && chunk.codec !== null) {
        this.db
          .prepare(
            `
              INSERT INTO chunks(hash, codec, raw_size, payload, ref_count)
              VALUES (?, ?, ?, ?, 0)
              ON CONFLICT(hash) DO NOTHING
            `
          )
          .run(chunk.hash, chunk.codec, chunk.rawSize, chunk.payload);
      }
      this.db
        .prepare(
          `
            INSERT INTO snapshot_chunks(snapshot_id, ordinal, chunk_hash, raw_size)
            VALUES (?, ?, ?, ?)
          `
        )
        .run(snapshotId, ordinal, chunk.hash, chunk.rawSize);
      const updated = this.db
        .prepare('UPDATE chunks SET ref_count = ref_count + 1 WHERE hash = ?')
        .run(chunk.hash);
      if (updated.changes !== 1) {
        throw new Error(`Failed to reference turn-diff chunk ${chunk.hashKey}.`);
      }
    }
    materialized.set(snapshot.hashKey, snapshotId);
    return snapshotId;
  }

  private updatePathHead(
    ownerId: string,
    workspacePath: string,
    newSnapshotId: number | null,
    sourceTurnId: number,
    orderKey: string,
    headProof: number
  ): number | undefined {
    const previous = this.db
      .prepare(
        `
          SELECT snapshot_id, source_turn_id, updated_order_key, head_proof
          FROM path_heads
          WHERE owner_id = ? AND path = ?
        `
      )
      .get(ownerId, workspacePath) as PathHeadRow | undefined;
    if (previous !== undefined && headProof <= previous.head_proof) return undefined;
    const preserveNewerSource =
      previous !== undefined &&
      previous.snapshot_id === newSnapshotId &&
      previous.updated_order_key > orderKey;
    const nextSourceTurnId = preserveNewerSource ? previous.source_turn_id : sourceTurnId;
    const nextOrderKey = preserveNewerSource ? previous.updated_order_key : orderKey;
    const releasedSnapshotId =
      previous?.snapshot_id !== newSnapshotId ? (previous?.snapshot_id ?? undefined) : undefined;
    if (previous?.snapshot_id !== newSnapshotId) {
      this.changeSnapshotRefCount(previous?.snapshot_id ?? null, -1);
      this.changeSnapshotRefCount(newSnapshotId, 1);
    }
    this.db
      .prepare(
        `
          INSERT INTO path_heads(
            owner_id, path, snapshot_id, source_turn_id, updated_order_key, head_proof
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner_id, path) DO UPDATE SET
            snapshot_id = excluded.snapshot_id,
            source_turn_id = excluded.source_turn_id,
            updated_order_key = excluded.updated_order_key,
            head_proof = excluded.head_proof
        `
      )
      .run(ownerId, workspacePath, newSnapshotId, nextSourceTurnId, nextOrderKey, headProof);
    return releasedSnapshotId;
  }

  private changeSnapshotRefCount(snapshotId: number | null, delta: number): void {
    if (snapshotId === null || delta === 0) return;
    const updated = this.db
      .prepare('UPDATE snapshots SET ref_count = ref_count + ? WHERE id = ?')
      .run(delta, snapshotId);
    if (updated.changes !== 1) {
      throw new Error(`Failed to update turn-diff snapshot reference ${snapshotId}.`);
    }
  }

  private readSnapshotText(snapshotId: number | null): string | null {
    if (snapshotId === null) return null;
    return this.readSnapshotBytes(snapshotId).toString('utf8');
  }

  private readSnapshotBytes(snapshotId: number): Buffer {
    const snapshot = this.db
      .prepare('SELECT id, content_hash, raw_size FROM snapshots WHERE id = ?')
      .get(snapshotId) as ReadableSnapshotRow | undefined;
    if (!snapshot) throw new Error(`Missing turn-diff snapshot ${snapshotId}.`);
    const output = Buffer.allocUnsafe(snapshot.raw_size);
    const rows = this.db
      .prepare(
        `
          SELECT c.codec, sc.raw_size, c.payload
          FROM snapshot_chunks AS sc
          JOIN chunks AS c ON c.hash = sc.chunk_hash
          WHERE sc.snapshot_id = ?
          ORDER BY sc.ordinal ASC
        `
      )
      .all(snapshotId) as ChunkPayloadRow[];
    let offset = 0;
    for (const row of rows) {
      const decoded = decompressChunk(row.codec, row.payload);
      if (decoded.byteLength !== row.raw_size) {
        throw new Error(`Turn-diff chunk length mismatch in snapshot ${snapshotId}.`);
      }
      decoded.copy(output, offset);
      offset += decoded.byteLength;
    }
    if (offset !== snapshot.raw_size) {
      throw new Error(`Turn-diff snapshot ${snapshotId} reconstructed ${offset} bytes.`);
    }
    const contentHash = createHash('sha256').update(output).digest();
    if (!contentHash.equals(snapshot.content_hash)) {
      throw new Error(`Turn-diff snapshot ${snapshotId} hash mismatch.`);
    }
    return output;
  }

  private deleteTurns(turnIds: readonly number[]): { snapshots: number; chunks: number } {
    if (turnIds.length === 0) return { snapshots: 0, chunks: 0 };
    const placeholders = turnIds.map(() => '?').join(', ');
    const run = this.db.transaction(() => {
      const refs = this.db
        .prepare(
          `
            SELECT snapshot_id AS id, COUNT(*) AS reference_count
            FROM (
              SELECT old_snapshot_id AS snapshot_id
              FROM turn_files
              WHERE turn_id IN (${placeholders}) AND old_snapshot_id IS NOT NULL
              UNION ALL
              SELECT new_snapshot_id AS snapshot_id
              FROM turn_files
              WHERE turn_id IN (${placeholders}) AND new_snapshot_id IS NOT NULL
            )
            GROUP BY snapshot_id
          `
        )
        .all(...turnIds, ...turnIds) as RefCountRow[];
      for (const ref of refs) {
        this.changeSnapshotRefCount(ref.id, -ref.reference_count);
      }
      this.db.prepare(`DELETE FROM turns WHERE id IN (${placeholders})`).run(...turnIds);
      return this.deleteUnreferencedSnapshotsAndChunks(refs.map((ref) => ref.id));
    });
    return run.immediate();
  }

  private accumulateDeletedTurns(
    cursor: TurnDiffGcCursor,
    turnIds: readonly number[],
    mode: 'delete' | 'evict'
  ): void {
    const deleted = mode === 'delete' ? this.deleteTurns(turnIds) : this.evictTurns(turnIds);
    cursor.deletedTurns += turnIds.length;
    cursor.deletedSnapshots += deleted.snapshots;
    cursor.deletedChunks += deleted.chunks;
  }

  private evictTurns(turnIds: readonly number[]): { snapshots: number; chunks: number } {
    if (turnIds.length === 0) return { snapshots: 0, chunks: 0 };
    const placeholders = turnIds.map(() => '?').join(', ');
    const run = this.db.transaction(() => {
      const refs = this.db
        .prepare(
          `
            SELECT snapshot_id AS id, COUNT(*) AS reference_count
            FROM (
              SELECT old_snapshot_id AS snapshot_id
              FROM turn_files
              WHERE turn_id IN (${placeholders}) AND old_snapshot_id IS NOT NULL
              UNION ALL
              SELECT new_snapshot_id AS snapshot_id
              FROM turn_files
              WHERE turn_id IN (${placeholders}) AND new_snapshot_id IS NOT NULL
            )
            GROUP BY snapshot_id
          `
        )
        .all(...turnIds, ...turnIds) as RefCountRow[];
      for (const ref of refs) {
        this.changeSnapshotRefCount(ref.id, -ref.reference_count);
      }
      this.db.prepare(`DELETE FROM turn_files WHERE turn_id IN (${placeholders})`).run(...turnIds);
      this.db.prepare(`UPDATE turns SET evicted = 1 WHERE id IN (${placeholders})`).run(...turnIds);
      return this.deleteUnreferencedSnapshotsAndChunks(refs.map((ref) => ref.id));
    });
    return run.immediate();
  }

  private deletePathHeads(pathHeads: readonly DeletablePathHeadRow[]): {
    snapshots: number;
    chunks: number;
  } {
    const run = this.db.transaction(() => {
      const snapshotRefs = new Map<number, number>();
      for (const head of pathHeads) {
        const deleted = this.db
          .prepare(
            `
              DELETE FROM path_heads
              WHERE owner_id = ?
                AND path = ?
                AND source_turn_id = ?
                AND head_proof = ?
                AND snapshot_id IS ?
            `
          )
          .run(head.owner_id, head.path, head.source_turn_id, head.head_proof, head.snapshot_id);
        if (deleted.changes === 1 && head.snapshot_id !== null) {
          snapshotRefs.set(head.snapshot_id, (snapshotRefs.get(head.snapshot_id) ?? 0) + 1);
        }
      }
      for (const [snapshotId, referenceCount] of snapshotRefs) {
        this.changeSnapshotRefCount(snapshotId, -referenceCount);
      }
      return this.deleteUnreferencedSnapshotsAndChunks(snapshotRefs.keys());
    });
    return run.immediate();
  }

  private deleteUnreferencedSnapshotsAndChunks(candidateSnapshotIds: Iterable<number>): {
    snapshots: number;
    chunks: number;
  } {
    const snapshotIds = [...new Set(candidateSnapshotIds)];
    let deletedSnapshots = 0;
    let deletedChunks = 0;
    for (const snapshotId of snapshotIds) {
      const unreferenced = this.db
        .prepare('SELECT id FROM snapshots WHERE id = ? AND ref_count = 0')
        .get(snapshotId) as IdRow | undefined;
      if (!unreferenced) continue;
      const chunkRefs = this.db
        .prepare(
          `
            SELECT chunk_hash AS hash, COUNT(*) AS reference_count
            FROM snapshot_chunks
            WHERE snapshot_id = ?
            GROUP BY chunk_hash
          `
        )
        .all(snapshotId) as ChunkRefCountRow[];
      for (const ref of chunkRefs) {
        const updated = this.db
          .prepare('UPDATE chunks SET ref_count = ref_count - ? WHERE hash = ?')
          .run(ref.reference_count, ref.hash);
        if (updated.changes !== 1) {
          throw new Error('Failed to release a turn-diff chunk reference.');
        }
      }
      const deletedSnapshot = this.db
        .prepare('DELETE FROM snapshots WHERE id = ? AND ref_count = 0')
        .run(snapshotId);
      if (deletedSnapshot.changes !== 1) {
        throw new Error(`Failed to delete unreferenced turn-diff snapshot ${snapshotId}.`);
      }
      deletedSnapshots += 1;
      for (const ref of chunkRefs) {
        deletedChunks += this.db
          .prepare('DELETE FROM chunks WHERE hash = ? AND ref_count = 0')
          .run(ref.hash).changes;
      }
    }
    return { snapshots: deletedSnapshots, chunks: deletedChunks };
  }

  private estimatedCompactedStorageBytes(): number {
    const pageCount = this.db.pragma('page_count', { simple: true }) as number;
    const freePages = this.db.pragma('freelist_count', { simple: true }) as number;
    const pageSize = this.db.pragma('page_size', { simple: true }) as number;
    return (pageCount - freePages) * pageSize + fileSize(`${this.options.dbPath}-shm`);
  }

  private storageBytes(checkpoint = false): TurnDiffStorageBytes {
    if (checkpoint) this.db.pragma('wal_checkpoint(TRUNCATE)');
    const database = fileSize(this.options.dbPath);
    const wal = fileSize(`${this.options.dbPath}-wal`);
    const shm = fileSize(`${this.options.dbPath}-shm`);
    return { database, wal, shm, total: database + wal + shm };
  }

  private assertWritable(): void {
    if (this.readOnly) throw new Error('Turn-diff store is read-only.');
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Turn-diff store is closed.');
  }
}

function assertSnapshotReadLimit(maxRawBytes: number | undefined): void {
  if (
    maxRawBytes !== undefined &&
    (Number.isNaN(maxRawBytes) || maxRawBytes < 0 || !Number.isSafeInteger(maxRawBytes))
  ) {
    throw new RangeError('Turn-diff snapshot maxRawBytes must be a non-negative safe integer.');
  }
}

function exceedsSnapshotReadLimit(rawBytes: number, maxRawBytes: number | undefined): boolean {
  return maxRawBytes !== undefined && rawBytes > maxRawBytes;
}

const expectedSchemaFingerprints = new Map<string, string>();

function readSchemaObjects(db: Database.Database): readonly SchemaObjectRow[] {
  return db
    .prepare(
      `
        SELECT type, name, tbl_name AS table_name, sql
        FROM sqlite_master
        WHERE substr(name, 1, 7) != 'sqlite_' AND sql IS NOT NULL
        ORDER BY type ASC, name ASC
      `
    )
    .all() as SchemaObjectRow[];
}

function schemaFingerprint(rows: readonly SchemaObjectRow[]): string {
  return rows
    .map((row) => `${row.type}:${row.name}:${row.table_name}:${normalizeSchemaSql(row.sql ?? '')}`)
    .join('\n');
}

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().replace(/;$/, '').toLowerCase();
}

function expectedSchemaFingerprint(schemaSql: string): string {
  const cached = expectedSchemaFingerprints.get(schemaSql);
  if (cached !== undefined) return cached;
  const database = new Database(':memory:');
  try {
    database.exec(schemaSql);
    const fingerprint = schemaFingerprint(readSchemaObjects(database));
    expectedSchemaFingerprints.set(schemaSql, fingerprint);
    return fingerprint;
  } finally {
    database.close();
  }
}

function normalizeOptions(options: TurnDiffStoreOptions): NormalizedOptions {
  const retentionDays = clampInteger(
    options.retentionDays ?? DEFAULT_RETENTION_DAYS,
    MIN_RETENTION_DAYS,
    MAX_RETENTION_DAYS
  );
  const maxStorageBytes = positiveInteger(
    options.maxStorageBytes ?? DEFAULT_MAX_STORAGE_BYTES,
    'maxStorageBytes'
  );
  const defaultTarget =
    options.maxStorageBytes === undefined
      ? DEFAULT_GC_TARGET_BYTES
      : Math.max(1, Math.floor(maxStorageBytes * 0.9));
  const gcTargetBytes = positiveInteger(options.gcTargetBytes ?? defaultTarget, 'gcTargetBytes');
  if (gcTargetBytes >= maxStorageBytes) {
    throw new Error('gcTargetBytes must be smaller than maxStorageBytes.');
  }
  return {
    dbPath: options.dbPath,
    retentionDays,
    maxStorageBytes,
    gcTargetBytes,
    // gzip is readable by every Node version supported by the CLI. zstd remains
    // an explicit opt-in because Node 22.14 cannot read codec-1 chunks.
    compression: options.compression ?? 'gzip',
  };
}

function validateRecordInput(
  input: RecordTurnDiffInput & { readonly capturedAtMs: number; readonly recordedAtMs: number }
): void {
  if (!input.ownerId) throw new Error('Turn-diff ownerId must not be empty.');
  if (!input.turnId) throw new Error('Turn-diff turnId must not be empty.');
  if (
    input.orderKey !== undefined &&
    (input.orderKey.length === 0 || input.orderKey.length > 1024 || input.orderKey.includes('\0'))
  ) {
    throw new Error('Turn-diff orderKey must contain 1-1024 non-NUL characters.');
  }
  for (const [name, value] of [
    ['capturedAtMs', input.capturedAtMs],
    ['recordedAtMs', input.recordedAtMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Turn-diff ${name} must be a non-negative safe integer.`);
    }
  }
  const paths = new Set<string>();
  for (const event of input.events) {
    if (!event.path || event.path.includes('\0')) {
      throw new Error('Turn-diff paths must be non-empty and contain no NUL.');
    }
    if (paths.has(event.path)) {
      throw new Error(`Turn-diff record contains duplicate path ${event.path}.`);
    }
    paths.add(event.path);
    if (typeof event.newIsCurrent !== 'boolean') {
      throw new Error(`Turn-diff event newIsCurrent must be boolean for ${event.path}.`);
    }
    if (
      (event.newIsCurrent &&
        (!Number.isSafeInteger(event.headProof) || (event.headProof ?? 0) <= 0)) ||
      (!event.newIsCurrent && event.headProof !== null)
    ) {
      throw new Error(`Turn-diff event headProof does not match newIsCurrent for ${event.path}.`);
    }
    if (!Number.isSafeInteger(event.add) || event.add < 0) {
      throw new Error(`Invalid added-line count for ${event.path}.`);
    }
    if (!Number.isSafeInteger(event.del) || event.del < 0) {
      throw new Error(`Invalid deleted-line count for ${event.path}.`);
    }
  }
}

function defaultTurnOrderKey(capturedAtMs: number, turnId: string): string {
  return `${capturedAtMs.toString().padStart(16, '0')}:${turnId}`;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { LoroRepo } from 'loro-repo';
import {
  getSessionRoomId,
  isCodeCollabFileIndexFlockDocId,
  isCodeCollabFileIndexSignalFlockDocId,
  isLoroRepoDocDeleted,
  isMachineDocRoomId,
  LORO_STREAMS_BUCKET_ID,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import {
  findDocumentRemoteCursorUrls,
  getSqliteRepoDatabase,
  type CliSqliteRepoStore,
} from './sqlite-repo-store';

const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1_000;
const DEFAULT_MIN_COMPACT_UPDATE_COUNT = 32;
const DEFAULT_MIN_COMPACT_UPDATE_BYTES = 256 * 1024;
const DEFAULT_STALE_UPDATE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_COMPACTS_PER_PASS = 50;
const DEFAULT_MAX_DELETED_PURGES_PER_PASS = 200;
const DEFAULT_VACUUM_MIN_FREELIST_BYTES = 64 * 1024 * 1024;
const DEFAULT_VACUUM_MIN_FREELIST_RATIO = 0.25;
const DEFAULT_VACUUM_HEADROOM_BYTES = 256 * 1024 * 1024;
const DEFAULT_INCREMENTAL_VACUUM_PAGES_PER_STEP = 4_096;
const DEFAULT_INCREMENTAL_VACUUM_MAX_STEPS = 16;

const AUTO_VACUUM_NONE = 0;
const AUTO_VACUUM_INCREMENTAL = 2;

export type SqliteRepoMaintenanceOptions = {
  repo: LoroRepo;
  store: CliSqliteRepoStore;
  workspaceId: WorkspaceId;
  bucketId?: string;
  logger: Logger;
  isDocActive: (docId: string) => boolean;
  /** Override for free disk-space checks (used by tests). */
  getFreeDiskBytes?: (dirPath: string) => Promise<number | null>;
  /** Override for current time in ms (used by tests). */
  now?: () => number;
  initialDelayMs?: number;
  intervalMs?: number;
  minCompactUpdateCount?: number;
  minCompactUpdateBytes?: number;
  /** Compact any doc whose latest doc_updates row is at least this old (ms). */
  staleUpdateAgeMs?: number;
  maxCompactsPerPass?: number;
  maxDeletedPurgesPerPass?: number;
  vacuumMinFreelistBytes?: number;
  vacuumMinFreelistRatio?: number;
  vacuumHeadroomBytes?: number;
  incrementalVacuumPagesPerStep?: number;
  incrementalVacuumMaxSteps?: number;
};

export type SqliteRepoMaintenanceReport = {
  deletedDocsPurged: number;
  deletedSessionFlocksPurged: number;
  expiredFlocksPurged: number;
  docsCompacted: number;
  freelistPagesReclaimed: number;
  ranFullVacuum: boolean;
  ranWalCheckpoint: boolean;
};

const emptyReport = (): SqliteRepoMaintenanceReport => ({
  deletedDocsPurged: 0,
  deletedSessionFlocksPurged: 0,
  expiredFlocksPurged: 0,
  docsCompacted: 0,
  freelistPagesReclaimed: 0,
  ranFullVacuum: false,
  ranWalCheckpoint: false,
});

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const isSqliteBusyError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
};

const isResourceBusyError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'ResourceBusyError';

const defaultGetFreeDiskBytes = async (dirPath: string): Promise<number | null> => {
  try {
    const stats = await fs.statfs(dirPath);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
};

/**
 * Daemon-only background maintenance for `repo.sqlite3`.
 *
 * `loro-repo` compacts Flock and Meta update logs automatically, but:
 * - `repo.deleteDoc()` is a soft tombstone in `metaFlock` and retains local doc bodies.
 * - `doc_updates` only compacts on a subsequent `loadDoc(docId)`.
 * - `repo.purgeExpiredFlockDocs()` is opt-in and never runs on its own timer.
 * - SQLite defaults to `auto_vacuum = NONE`, so freed pages stay on disk forever.
 *
 * This controller bounds local storage growth without opening Streams rooms,
 * touching active documents, or surfacing `SQLITE_BUSY` as a write failure.
 */
export class SqliteRepoMaintenance {
  private readonly repo: LoroRepo;
  private readonly store: CliSqliteRepoStore;
  private readonly workspaceId: WorkspaceId;
  private readonly bucketId: string;
  private readonly logger: Logger;
  private readonly isDocActive: (docId: string) => boolean;
  private readonly getFreeDiskBytes: (dirPath: string) => Promise<number | null>;
  private readonly now: () => number;
  private readonly initialDelayMs: number;
  private readonly intervalMs: number;
  private readonly minCompactUpdateCount: number;
  private readonly minCompactUpdateBytes: number;
  private readonly staleUpdateAgeMs: number;
  private readonly maxCompactsPerPass: number;
  private readonly maxDeletedPurgesPerPass: number;
  private readonly vacuumMinFreelistBytes: number;
  private readonly vacuumMinFreelistRatio: number;
  private readonly vacuumHeadroomBytes: number;
  private readonly incrementalVacuumPagesPerStep: number;
  private readonly incrementalVacuumMaxSteps: number;

  private readonly abortController = new AbortController();
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<SqliteRepoMaintenanceReport> | null = null;
  private stopped = false;

  constructor(options: SqliteRepoMaintenanceOptions) {
    this.repo = options.repo;
    this.store = options.store;
    this.workspaceId = options.workspaceId;
    this.bucketId = options.bucketId ?? LORO_STREAMS_BUCKET_ID;
    this.logger = options.logger;
    this.isDocActive = options.isDocActive;
    this.getFreeDiskBytes = options.getFreeDiskBytes ?? defaultGetFreeDiskBytes;
    this.now = options.now ?? Date.now;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.minCompactUpdateCount = options.minCompactUpdateCount ?? DEFAULT_MIN_COMPACT_UPDATE_COUNT;
    this.minCompactUpdateBytes = options.minCompactUpdateBytes ?? DEFAULT_MIN_COMPACT_UPDATE_BYTES;
    this.staleUpdateAgeMs = options.staleUpdateAgeMs ?? DEFAULT_STALE_UPDATE_AGE_MS;
    this.maxCompactsPerPass = options.maxCompactsPerPass ?? DEFAULT_MAX_COMPACTS_PER_PASS;
    this.maxDeletedPurgesPerPass =
      options.maxDeletedPurgesPerPass ?? DEFAULT_MAX_DELETED_PURGES_PER_PASS;
    this.vacuumMinFreelistBytes =
      options.vacuumMinFreelistBytes ?? DEFAULT_VACUUM_MIN_FREELIST_BYTES;
    this.vacuumMinFreelistRatio =
      options.vacuumMinFreelistRatio ?? DEFAULT_VACUUM_MIN_FREELIST_RATIO;
    this.vacuumHeadroomBytes = options.vacuumHeadroomBytes ?? DEFAULT_VACUUM_HEADROOM_BYTES;
    this.incrementalVacuumPagesPerStep =
      options.incrementalVacuumPagesPerStep ?? DEFAULT_INCREMENTAL_VACUUM_PAGES_PER_STEP;
    this.incrementalVacuumMaxSteps =
      options.incrementalVacuumMaxSteps ?? DEFAULT_INCREMENTAL_VACUUM_MAX_STEPS;
  }

  start(): void {
    if (this.stopped || this.initialTimer || this.intervalTimer) return;
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      if (this.stopped) return;
      void this.trigger();
      this.intervalTimer = setInterval(() => {
        if (this.stopped) return;
        void this.trigger();
      }, this.intervalMs);
      this.intervalTimer.unref?.();
    }, this.initialDelayMs);
    this.initialTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController.abort();
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }
  }

  trigger(): Promise<SqliteRepoMaintenanceReport> {
    if (this.stopped) return Promise.resolve(emptyReport());
    if (this.inFlight) return this.inFlight;
    const run = this.runOnceInternal().finally(() => {
      if (this.inFlight === run) {
        this.inFlight = null;
      }
    });
    this.inFlight = run;
    return run;
  }

  runOnce(): Promise<SqliteRepoMaintenanceReport> {
    return this.trigger();
  }

  private getDatabase(): Database.Database | null {
    if (this.stopped || this.abortController.signal.aborted) return null;
    const db = getSqliteRepoDatabase(this.store);
    return db.open ? db : null;
  }

  private async runOnceInternal(): Promise<SqliteRepoMaintenanceReport> {
    const report = emptyReport();
    if (!this.getDatabase()) return report;

    try {
      report.deletedDocsPurged = await this.purgeDeletedDocBodies();
      report.expiredFlocksPurged = await this.purgeExpiredFlockDocs();
      report.deletedSessionFlocksPurged = await this.purgeDeletedSessionFlockDocs();
      report.docsCompacted = await this.compactDocUpdates();
      const reclaim = await this.reclaimSqliteSpace(
        report.deletedDocsPurged > 0 ||
          report.expiredFlocksPurged > 0 ||
          report.deletedSessionFlocksPurged > 0 ||
          report.docsCompacted > 0
      );
      report.freelistPagesReclaimed = reclaim.freelistPagesReclaimed;
      report.ranFullVacuum = reclaim.ranFullVacuum;
      report.ranWalCheckpoint = reclaim.ranWalCheckpoint;

      if (
        report.deletedDocsPurged > 0 ||
        report.expiredFlocksPurged > 0 ||
        report.deletedSessionFlocksPurged > 0 ||
        report.docsCompacted > 0 ||
        report.freelistPagesReclaimed > 0 ||
        report.ranFullVacuum
      ) {
        this.logger.info(
          `[${this.workspaceId}] SQLite repo maintenance completed: ` +
            `deletedDocs=${report.deletedDocsPurged} expiredFlocks=${report.expiredFlocksPurged} ` +
            `deletedSessionFlocks=${report.deletedSessionFlocksPurged} compactedDocs=${report.docsCompacted} ` +
            `freelistPagesReclaimed=${report.freelistPagesReclaimed} fullVacuum=${report.ranFullVacuum}`
        );
      }
    } catch (error) {
      if (!this.stopped) {
        this.logger.debug(
          `[${this.workspaceId}] SQLite repo maintenance skipped: ${formatErrorMessage(error)}`
        );
      }
    }
    return report;
  }

  private async purgeDeletedDocBodies(): Promise<number> {
    const db = this.getDatabase();
    if (!db) return 0;

    let docIds: string[];
    try {
      const rows = db
        .prepare('SELECT doc_id FROM docs UNION SELECT doc_id FROM doc_updates')
        .all() as Array<{ doc_id: string }>;
      docIds = rows.map((row) => row.doc_id);
    } catch (error) {
      if (!isSqliteBusyError(error)) {
        this.logger.debug(
          `[${this.workspaceId}] Failed to list stored doc ids: ${formatErrorMessage(error)}`
        );
      }
      return 0;
    }

    let purged = 0;
    for (const docId of docIds) {
      if (purged >= this.maxDeletedPurgesPerPass) break;
      if (!this.getDatabase()) break;
      if (isMachineDocRoomId(docId) || this.isDocActive(docId)) continue;

      let meta: Awaited<ReturnType<LoroRepo['getDocMeta']>>;
      try {
        meta = await this.repo.getDocMeta(docId);
      } catch {
        continue;
      }
      if (!meta || !isLoroRepoDocDeleted(meta)) continue;

      const currentDb = this.getDatabase();
      if (!currentDb || this.isDocActive(docId)) continue;

      try {
        const cursorUrls = new Set<string>();
        const indexedUrls = (await this.store.storageAdapter.docCursorIndex?.load(docId)) ?? [];
        for (const url of indexedUrls) cursorUrls.add(url);
        for (const url of findDocumentRemoteCursorUrls(
          currentDb,
          this.workspaceId,
          docId,
          this.bucketId
        )) {
          cursorUrls.add(url);
        }
        for (const url of cursorUrls) {
          await this.store.sharedDocumentRemoteCursorStore.delete?.(url);
        }
        await this.store.storageAdapter.docCursorIndex?.delete(docId);
        await this.store.storageAdapter.deleteDoc?.(docId);
        purged += 1;
      } catch (error) {
        if (!isSqliteBusyError(error) && !this.stopped) {
          this.logger.debug(
            `[${this.workspaceId}] Failed to purge deleted doc "${docId}": ${formatErrorMessage(error)}`
          );
        }
      }

      await yieldToEventLoop();
    }

    return purged;
  }

  private async purgeExpiredFlockDocs(): Promise<number> {
    if (!this.getDatabase()) return 0;
    try {
      const purged = await this.repo.purgeExpiredFlockDocs();
      return purged.length;
    } catch (error) {
      if (!isResourceBusyError(error) && !isSqliteBusyError(error) && !this.stopped) {
        this.logger.debug(
          `[${this.workspaceId}] Failed to purge expired Flock docs: ${formatErrorMessage(error)}`
        );
      }
      return 0;
    }
  }

  private async purgeDeletedSessionFlockDocs(): Promise<number> {
    const db = this.getDatabase();
    if (!db) return 0;

    let flockDocIds: string[];
    try {
      const rows = db
        .prepare(
          'SELECT flock_doc_id FROM flock_docs UNION SELECT flock_doc_id FROM flock_doc_updates'
        )
        .all() as Array<{ flock_doc_id: string }>;
      flockDocIds = rows.map((row) => row.flock_doc_id);
    } catch (error) {
      if (!isSqliteBusyError(error)) {
        this.logger.debug(
          `[${this.workspaceId}] Failed to list stored Flock doc ids: ${formatErrorMessage(error)}`
        );
      }
      return 0;
    }

    let purged = 0;
    for (const flockDocId of flockDocIds) {
      if (purged >= this.maxDeletedPurgesPerPass) break;
      if (!this.getDatabase()) break;
      if (
        !isCodeCollabFileIndexFlockDocId(flockDocId) &&
        !isCodeCollabFileIndexSignalFlockDocId(flockDocId)
      ) {
        continue;
      }

      const parts = flockDocId.split(':');
      if (parts[0] !== this.workspaceId) continue;
      const sessionId = parts[2] as SessionId | undefined;
      if (!sessionId) continue;

      let meta: Awaited<ReturnType<LoroRepo['getDocMeta']>>;
      try {
        meta = await this.repo.getDocMeta(getSessionRoomId(sessionId));
      } catch {
        continue;
      }
      if (!meta || !isLoroRepoDocDeleted(meta)) continue;
      if (!this.getDatabase()) break;

      try {
        await this.repo.purgeFlockDoc(flockDocId);
        purged += 1;
      } catch (error) {
        if (!isResourceBusyError(error) && !isSqliteBusyError(error) && !this.stopped) {
          this.logger.debug(
            `[${this.workspaceId}] Failed to purge deleted session Flock "${flockDocId}": ${formatErrorMessage(error)}`
          );
        }
      }

      await yieldToEventLoop();
    }

    return purged;
  }

  private async compactDocUpdates(): Promise<number> {
    const db = this.getDatabase();
    if (!db) return 0;

    let candidates: Array<{ doc_id: string; update_count: number; total_bytes: number }>;
    try {
      const staleCutoffMs = this.now() - this.staleUpdateAgeMs;
      candidates = db
        .prepare(
          `SELECT doc_id, COUNT(*) AS update_count, COALESCE(SUM(LENGTH(update_data)), 0) AS total_bytes
           FROM doc_updates
           GROUP BY doc_id
           HAVING update_count >= ? OR total_bytes >= ? OR MAX(created_at) <= ?
           ORDER BY total_bytes DESC
           LIMIT ?`
        )
        .all(
          this.minCompactUpdateCount,
          this.minCompactUpdateBytes,
          staleCutoffMs,
          this.maxCompactsPerPass
        ) as Array<{ doc_id: string; update_count: number; total_bytes: number }>;
    } catch (error) {
      if (!isSqliteBusyError(error)) {
        this.logger.debug(
          `[${this.workspaceId}] Failed to scan doc_updates for compaction: ${formatErrorMessage(error)}`
        );
      }
      return 0;
    }

    let compacted = 0;
    for (const candidate of candidates) {
      if (!this.getDatabase()) break;
      try {
        const doc = await this.store.storageAdapter.loadDoc(candidate.doc_id);
        (doc as { free?: () => void } | undefined)?.free?.();
        compacted += 1;
      } catch (error) {
        if (!isSqliteBusyError(error) && !this.stopped) {
          this.logger.debug(
            `[${this.workspaceId}] Failed to compact doc "${candidate.doc_id}": ${formatErrorMessage(error)}`
          );
        }
      }
      await yieldToEventLoop();
    }

    return compacted;
  }

  private async reclaimSqliteSpace(hadMutations: boolean): Promise<{
    freelistPagesReclaimed: number;
    ranFullVacuum: boolean;
    ranWalCheckpoint: boolean;
  }> {
    const db = this.getDatabase();
    if (!db) {
      return { freelistPagesReclaimed: 0, ranFullVacuum: false, ranWalCheckpoint: false };
    }

    let freelistPagesReclaimed = 0;
    let ranFullVacuum = false;
    let ranWalCheckpoint = false;

    const readStats = (database: Database.Database) => ({
      pageSize: Number(database.pragma('page_size', { simple: true }) ?? 4096),
      pageCount: Number(database.pragma('page_count', { simple: true }) ?? 0),
      freelistCount: Number(database.pragma('freelist_count', { simple: true }) ?? 0),
      autoVacuum: Number(database.pragma('auto_vacuum', { simple: true }) ?? AUTO_VACUUM_NONE),
    });

    try {
      const stats = readStats(db);
      const totalBytes = stats.pageCount * stats.pageSize;
      const freelistBytes = stats.freelistCount * stats.pageSize;
      const liveBytes = Math.max(0, totalBytes - freelistBytes);

      if (
        stats.autoVacuum === AUTO_VACUUM_NONE &&
        stats.freelistCount > 0 &&
        totalBytes > 0 &&
        freelistBytes >= this.vacuumMinFreelistBytes &&
        freelistBytes / totalBytes >= this.vacuumMinFreelistRatio
      ) {
        const freeDiskBytes = await this.getFreeDiskBytes(path.dirname(this.store.dbPath));
        const requiredFreeBytes = Math.ceil(liveBytes * 1.5) + this.vacuumHeadroomBytes;
        const currentDb = this.getDatabase();
        if (currentDb && freeDiskBytes !== null && freeDiskBytes >= requiredFreeBytes) {
          try {
            currentDb.pragma('auto_vacuum = INCREMENTAL');
            currentDb.exec('VACUUM');
            const after = readStats(currentDb);
            freelistPagesReclaimed = Math.max(0, stats.freelistCount - after.freelistCount);
            ranFullVacuum = true;
          } catch (error) {
            if (!isSqliteBusyError(error) && !this.stopped) {
              this.logger.debug(
                `[${this.workspaceId}] SQLite VACUUM skipped: ${formatErrorMessage(error)}`
              );
            }
          }
        }
      } else if (stats.autoVacuum === AUTO_VACUUM_INCREMENTAL && stats.freelistCount > 0) {
        let remaining = stats.freelistCount;
        for (let step = 0; step < this.incrementalVacuumMaxSteps && remaining > 0; step += 1) {
          const currentDb = this.getDatabase();
          if (!currentDb) break;
          try {
            currentDb.pragma(`incremental_vacuum(${this.incrementalVacuumPagesPerStep})`);
          } catch (error) {
            if (!isSqliteBusyError(error) && !this.stopped) {
              this.logger.debug(
                `[${this.workspaceId}] SQLite incremental_vacuum skipped: ${formatErrorMessage(error)}`
              );
            }
            break;
          }
          const nextRemaining = Number(currentDb.pragma('freelist_count', { simple: true }) ?? 0);
          if (nextRemaining >= remaining) break;
          freelistPagesReclaimed += remaining - nextRemaining;
          remaining = nextRemaining;
          await yieldToEventLoop();
        }
      }

      const checkpointDb = this.getDatabase();
      if (checkpointDb && (hadMutations || freelistPagesReclaimed > 0 || ranFullVacuum)) {
        try {
          checkpointDb.pragma('wal_checkpoint(TRUNCATE)');
          ranWalCheckpoint = true;
        } catch (error) {
          if (!isSqliteBusyError(error) && !this.stopped) {
            this.logger.debug(
              `[${this.workspaceId}] SQLite wal_checkpoint skipped: ${formatErrorMessage(error)}`
            );
          }
        }
      }
    } catch (error) {
      if (!isSqliteBusyError(error) && !this.stopped) {
        this.logger.debug(
          `[${this.workspaceId}] SQLite space reclamation failed: ${formatErrorMessage(error)}`
        );
      }
    }

    return { freelistPagesReclaimed, ranFullVacuum, ranWalCheckpoint };
  }
}

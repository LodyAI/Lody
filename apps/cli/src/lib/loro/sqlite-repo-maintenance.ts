import path from 'node:path';
import { Clock, Deferred, Effect, Exit, Fiber, Schedule, Scope } from 'effect';
import { ResourceBusyError, type LoroRepo } from 'loro-repo';
import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  isMachineDocRoomId,
  parseCodeCollabFileIndexFlockDocId,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { readVolumeFreeBytes } from '@/lib/machine-disk';
import type { SqliteRepoMaintenanceStore } from './sqlite-repo-store';

export type SqliteMaintenancePolicy = {
  readonly initialDelayMs: number;
  readonly intervalMs: number;
  readonly minCompactUpdateCount: number;
  readonly minCompactUpdateBytes: number;
  readonly staleUpdateAgeMs: number;
  readonly maxCompactsPerPass: number;
  readonly maxDeletedPurgesPerPass: number;
  readonly vacuumMinFreelistBytes: number;
  readonly vacuumMinFreelistRatio: number;
  readonly vacuumHeadroomBytes: number;
  readonly incrementalVacuumPagesPerStep: number;
  readonly incrementalVacuumMaxSteps: number;
};

export const DEFAULT_SQLITE_MAINTENANCE_POLICY: SqliteMaintenancePolicy = {
  initialDelayMs: 30_000,
  intervalMs: 30 * 60 * 1_000,
  minCompactUpdateCount: 32,
  minCompactUpdateBytes: 256 * 1024,
  staleUpdateAgeMs: 30 * 24 * 60 * 60 * 1_000,
  maxCompactsPerPass: 50,
  maxDeletedPurgesPerPass: 200,
  vacuumMinFreelistBytes: 64 * 1024 * 1024,
  vacuumMinFreelistRatio: 0.25,
  vacuumHeadroomBytes: 256 * 1024 * 1024,
  incrementalVacuumPagesPerStep: 4_096,
  incrementalVacuumMaxSteps: 16,
};

export type SqliteRepoMaintenanceOptions = {
  readonly repo: LoroRepo;
  readonly store: SqliteRepoMaintenanceStore;
  readonly logger: Logger;
  readonly isDocActive: (docId: string) => boolean;
  readonly getFreeDiskBytes?: (dirPath: string) => Promise<number | null>;
  readonly policy?: Partial<SqliteMaintenancePolicy>;
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

export type SqliteRepoMaintenance = {
  readonly runOnce: Effect.Effect<SqliteRepoMaintenanceReport>;
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

const isSqliteBusyError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
};

const trySync = <A>(
  run: () => A,
  fallback: A,
  onError: (error: unknown) => void
): Effect.Effect<A> =>
  Effect.sync(() => {
    try {
      return run();
    } catch (error) {
      if (!isSqliteBusyError(error)) onError(error);
      return fallback;
    }
  });

const tryPromise = <A>(
  run: () => Promise<A>,
  fallback: A,
  onError: (error: unknown) => void
): Effect.Effect<A> =>
  Effect.tryPromise({ try: run, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        if (!(error instanceof ResourceBusyError) && !isSqliteBusyError(error)) onError(error);
        return fallback;
      })
    )
  );

export const makeSqliteRepoMaintenance = Effect.fnUntraced(function* (
  options: SqliteRepoMaintenanceOptions
): Effect.fn.Return<SqliteRepoMaintenance, never, Scope.Scope> {
  const scope = yield* Effect.scope;
  const { repo, store, logger, isDocActive } = options;
  const getFreeDiskBytes = options.getFreeDiskBytes ?? readVolumeFreeBytes;
  const policy: SqliteMaintenancePolicy = {
    ...DEFAULT_SQLITE_MAINTENANCE_POLICY,
    ...options.policy,
  };
  const logSkip = (detail: string, error: unknown) => {
    logger.debug(`[${store.workspaceId}] ${detail}: ${formatErrorMessage(error)}`);
  };

  let inFlight: Deferred.Deferred<SqliteRepoMaintenanceReport> | null = null;
  let loopFiber: Fiber.Fiber<void> | undefined;

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (loopFiber) yield* Fiber.await(loopFiber);
      if (inFlight) yield* Deferred.succeed(inFlight, emptyReport());
    })
  );

  const purgeDeletedDocBodies = Effect.gen(function* () {
    if (!store.isOpen()) return 0;
    const docIds = yield* trySync(
      () => store.listStoredDocIds(),
      [],
      (error) => logSkip('Failed to list stored doc ids', error)
    );
    let purged = 0;
    for (const docId of docIds) {
      if (purged >= policy.maxDeletedPurgesPerPass || !store.isOpen()) break;
      if (isMachineDocRoomId(docId) || isDocActive(docId)) continue;
      const meta = yield* tryPromise(
        () => repo.getDocMeta(docId),
        undefined,
        () => {}
      );
      if (!meta || !isLoroRepoDocDeleted(meta) || !store.isOpen() || isDocActive(docId)) continue;
      const deleted = yield* tryPromise(
        async () => {
          await store.purgeStoredDoc(docId);
          return true;
        },
        false,
        (error) => logSkip(`Failed to purge deleted doc "${docId}"`, error)
      );
      if (deleted) purged += 1;
      yield* Effect.yieldNow;
    }
    return purged;
  });

  const purgeExpiredFlockDocs = Effect.gen(function* () {
    if (!store.isOpen()) return 0;
    const purged = yield* tryPromise(
      () => repo.purgeExpiredFlockDocs(),
      [],
      (error) => logSkip('Failed to purge expired Flock docs', error)
    );
    return purged.length;
  });

  const purgeDeletedSessionFlockDocs = Effect.gen(function* () {
    if (!store.isOpen()) return 0;
    const flockDocIds = yield* trySync(
      () => store.listStoredFlockDocIds(),
      [],
      (error) => logSkip('Failed to list stored Flock doc ids', error)
    );
    let purged = 0;
    for (const flockDocId of flockDocIds) {
      if (purged >= policy.maxDeletedPurgesPerPass || !store.isOpen()) break;
      const parsed = parseCodeCollabFileIndexFlockDocId(flockDocId);
      if (!parsed || parsed.workspaceId !== store.workspaceId) continue;
      const meta = yield* tryPromise(
        () => repo.getDocMeta(getSessionRoomId(parsed.sessionId)),
        undefined,
        () => {}
      );
      if (!meta || !isLoroRepoDocDeleted(meta) || !store.isOpen()) continue;
      const ok = yield* tryPromise(
        async () => {
          await repo.purgeFlockDoc(flockDocId);
          return true;
        },
        false,
        (error) => logSkip(`Failed to purge deleted session Flock "${flockDocId}"`, error)
      );
      if (ok) purged += 1;
      yield* Effect.yieldNow;
    }
    return purged;
  });

  const compactDocUpdates = Effect.gen(function* () {
    if (!store.isOpen()) return 0;
    const nowMs = yield* Clock.currentTimeMillis;
    const staleCutoffMs = nowMs - policy.staleUpdateAgeMs;
    const candidates = yield* trySync(
      () =>
        store.listCompactionCandidates(
          policy.minCompactUpdateCount,
          policy.minCompactUpdateBytes,
          staleCutoffMs,
          policy.maxCompactsPerPass
        ),
      [],
      (error) => logSkip('Failed to scan doc_updates for compaction', error)
    );
    let compacted = 0;
    for (const docId of candidates) {
      if (!store.isOpen()) break;
      const ok = yield* tryPromise(
        async () => {
          await store.compactStoredDoc(docId);
          return true;
        },
        false,
        (error) => logSkip(`Failed to compact doc "${docId}"`, error)
      );
      if (ok) compacted += 1;
      yield* Effect.yieldNow;
    }
    return compacted;
  });

  const reclaimSqliteSpace = (hadMutations: boolean) =>
    Effect.gen(function* () {
      if (!store.isOpen()) {
        return { freelistPagesReclaimed: 0, ranFullVacuum: false, ranWalCheckpoint: false };
      }
      const stats = yield* trySync(
        () => store.readSpaceStats(),
        null,
        (error) => logSkip('Failed to read SQLite space stats', error)
      );
      if (!stats) {
        return { freelistPagesReclaimed: 0, ranFullVacuum: false, ranWalCheckpoint: false };
      }

      let freelistPagesReclaimed = 0;
      let ranFullVacuum = false;
      let ranWalCheckpoint = false;

      const totalBytes = stats.pageCount * stats.pageSize;
      const freelistBytes = stats.freelistCount * stats.pageSize;
      const liveBytes = Math.max(0, totalBytes - freelistBytes);

      if (
        stats.autoVacuum === 'none' &&
        stats.freelistCount > 0 &&
        totalBytes > 0 &&
        freelistBytes >= policy.vacuumMinFreelistBytes &&
        freelistBytes / totalBytes >= policy.vacuumMinFreelistRatio
      ) {
        const freeDiskBytes = yield* tryPromise(
          () => getFreeDiskBytes(path.dirname(store.dbPath)),
          null,
          () => {}
        );
        const requiredFreeBytes = Math.ceil(liveBytes * 1.5) + policy.vacuumHeadroomBytes;
        if (store.isOpen() && freeDiskBytes !== null && freeDiskBytes >= requiredFreeBytes) {
          const reclaimed = yield* trySync(
            () => store.upgradeToIncrementalAndVacuum(),
            null,
            (error) => logSkip('SQLite VACUUM skipped', error)
          );
          if (reclaimed !== null) {
            freelistPagesReclaimed = reclaimed;
            ranFullVacuum = true;
          }
        }
      } else if (stats.autoVacuum === 'incremental' && stats.freelistCount > 0) {
        for (let step = 0; step < policy.incrementalVacuumMaxSteps && store.isOpen(); step += 1) {
          const reclaimed = yield* trySync(
            () => store.runIncrementalVacuumStep(policy.incrementalVacuumPagesPerStep),
            0,
            (error) => logSkip('SQLite incremental_vacuum skipped', error)
          );
          if (reclaimed <= 0) break;
          freelistPagesReclaimed += reclaimed;
          yield* Effect.yieldNow;
        }
      }

      if (store.isOpen() && (hadMutations || freelistPagesReclaimed > 0 || ranFullVacuum)) {
        ranWalCheckpoint = yield* trySync(
          () => {
            store.runWalCheckpoint();
            return true;
          },
          false,
          (error) => logSkip('SQLite wal_checkpoint skipped', error)
        );
      }

      return { freelistPagesReclaimed, ranFullVacuum, ranWalCheckpoint };
    });

  const executePass = Effect.gen(function* () {
    const report = emptyReport();
    if (!store.isOpen()) return report;

    report.deletedDocsPurged = yield* purgeDeletedDocBodies;
    report.expiredFlocksPurged = yield* purgeExpiredFlockDocs;
    report.deletedSessionFlocksPurged = yield* purgeDeletedSessionFlockDocs;
    report.docsCompacted = yield* compactDocUpdates;
    const reclaim = yield* reclaimSqliteSpace(
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
      logger.info(
        `[${store.workspaceId}] SQLite repo maintenance completed: ` +
          `deletedDocs=${report.deletedDocsPurged} expiredFlocks=${report.expiredFlocksPurged} ` +
          `deletedSessionFlocks=${report.deletedSessionFlocksPurged} compactedDocs=${report.docsCompacted} ` +
          `freelistPagesReclaimed=${report.freelistPagesReclaimed} fullVacuum=${report.ranFullVacuum}`
      );
    }
    return report;
  });

  const runOnce: Effect.Effect<SqliteRepoMaintenanceReport> = Effect.suspend(() => {
    if (inFlight) return Deferred.await(inFlight);
    const done = Deferred.makeUnsafe<SqliteRepoMaintenanceReport>();
    inFlight = done;
    return executePass.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (inFlight === done) inFlight = null;
          yield* Deferred.succeed(done, Exit.isSuccess(exit) ? exit.value : emptyReport());
        })
      )
    );
  });

  loopFiber = yield* Effect.forkIn(
    runOnce.pipe(
      Effect.repeat({ schedule: Schedule.spaced(policy.intervalMs) }),
      Effect.asVoid,
      Effect.delay(policy.initialDelayMs)
    ),
    scope
  );

  return { runOnce } satisfies SqliteRepoMaintenance;
});

/** @deprecated Promise document-manager entry. Remove with LoroDocumentManager native migration. */
export class SqliteRepoMaintenanceLegacy {
  private readonly scope = Effect.runSync(Scope.make());
  private readonly maintenance: SqliteRepoMaintenance;
  private closing?: Promise<void>;

  constructor(options: SqliteRepoMaintenanceOptions) {
    this.maintenance = Effect.runSync(
      Scope.provide(makeSqliteRepoMaintenance(options), this.scope)
    );
  }

  runOnce(): Promise<SqliteRepoMaintenanceReport> {
    return this.closing
      ? Promise.resolve(emptyReport())
      : Effect.runPromise(this.maintenance.runOnce);
  }

  close(): Promise<void> {
    return (this.closing ??= Effect.runPromise(Scope.close(this.scope, Exit.void)));
  }
}

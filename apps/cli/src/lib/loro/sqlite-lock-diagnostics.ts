import path from 'path';
import { Effect } from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import {
  READ_ONLY_ABANDON_POLICY,
  makeProcessRunnerLegacy,
  runCommand,
} from '@lody/shared/node/process';
import { toShared } from '@/platform/process-options';
import { getLogger } from '@/utils/logger';

/**
 * Names the processes holding `repo.sqlite3` open when SQLite reports lock
 * contention. Another process keeping the write lock past loro-repo's retry
 * budget is what fails persistence (`database is locked`). The failing process
 * cannot see the holder, so this records every process that has the database
 * files open. Diagnostics only: it never retries, blocks or changes storage.
 */

/** One process with a database file open, as `lsof -F pcR` reports it. */
export interface SqliteFileOpener {
  readonly pid: number;
  readonly ppid?: number;
  readonly command: string;
}

export type SqliteOpenersProbe =
  | { readonly kind: 'ok'; readonly openers: readonly SqliteFileOpener[] }
  | { readonly kind: 'unavailable'; readonly reason: string };

const PROBE_TIMEOUT = '5 seconds';
const PROBE_MAX_OUTPUT_BYTES = 256 * 1024;
/** At most one probe per window: contention arrives in bursts of failures. */
export const SQLITE_LOCK_PROBE_MIN_INTERVAL_MS = 60_000;
const MAX_LOGGED_OPENERS = 20;

/** Parses `lsof -F pcR` field output; files with several descriptors repeat a pid. */
export const parseLsofOpeners = (output: string): SqliteFileOpener[] => {
  const openers = new Map<number, { pid: number; ppid?: number; command: string }>();
  let current: { pid: number; ppid?: number; command: string } | undefined;
  for (const line of output.split('\n')) {
    const field = line[0];
    const value = line.slice(1).trim();
    if (field === 'p') {
      const pid = Number(value);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        current = undefined;
        continue;
      }
      current = openers.get(pid) ?? { pid, command: '' };
      openers.set(pid, current);
    } else if (current && field === 'c') {
      current.command = value;
    } else if (current && field === 'R') {
      const ppid = Number(value);
      if (Number.isSafeInteger(ppid) && ppid > 0) current.ppid = ppid;
    }
  }
  return [...openers.values()].sort((a, b) => a.pid - b.pid);
};

/**
 * Lists processes with the database, its WAL or its shared-memory file open.
 * lsof exits non-zero when one of the files does not exist, so its output is
 * read whatever the exit status.
 */
export const probeSqliteOpeners = (
  dbPath: string
): Effect.Effect<SqliteOpenersProbe, never, ChildProcessSpawner.ChildProcessSpawner> =>
  runCommand({
    command: 'lsof',
    args: ['+c', '0', '-F', 'pcR', '--', dbPath, `${dbPath}-wal`, `${dbPath}-shm`],
    timeout: PROBE_TIMEOUT,
    maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
    abandonPolicy: READ_ONLY_ABANDON_POLICY,
  }).pipe(
    Effect.map((output): SqliteOpenersProbe => ({
      kind: 'ok',
      openers: parseLsofOpeners(output.stdout.toString('utf8')),
    })),
    Effect.catch((error) =>
      Effect.succeed<SqliteOpenersProbe>({ kind: 'unavailable', reason: error._tag })
    )
  );

/** One log line; the workspace directory name identifies the database. */
export const formatSqliteOpeners = (
  dbPath: string,
  probe: SqliteOpenersProbe,
  selfPid: number,
  source: string
): string => {
  const workspace = path.basename(path.dirname(dbPath));
  const prefix = `[sqlite-lock] ${path.basename(dbPath)} busy (workspace=${workspace}, source=${source})`;
  if (probe.kind === 'unavailable') return `${prefix}; openers unknown: lsof ${probe.reason}`;
  const others = probe.openers.filter((opener) => opener.pid !== selfPid);
  if (others.length === 0) return `${prefix}; no other process has it open`;
  const listed = others
    .slice(0, MAX_LOGGED_OPENERS)
    .map(
      (opener) =>
        `pid=${opener.pid}${opener.ppid === undefined ? '' : ` ppid=${opener.ppid}`} command=${JSON.stringify(opener.command)}`
    );
  const omitted = others.length - listed.length;
  return `${prefix}; other processes with it open: ${listed.join('; ')}${omitted > 0 ? `; +${omitted} more` : ''}`;
};

/** True when a diagnostic line reports SQLite lock contention. */
export const mentionsSqliteBusy = (values: readonly unknown[]): boolean =>
  values.some((value) => {
    const text =
      typeof value === 'string'
        ? value
        : value instanceof Error
          ? `${value.message} ${'code' in value && typeof value.code === 'string' ? value.code : ''}`
          : (() => {
              try {
                return JSON.stringify(value) ?? '';
              } catch {
                return '';
              }
            })();
    return text.includes('database is locked') || text.includes('SQLITE_BUSY');
  });

export interface SqliteLockReporterOptions {
  readonly probe: (dbPath: string) => Promise<SqliteOpenersProbe>;
  readonly log: (line: string) => void;
  readonly now: () => number;
  readonly selfPid: number;
  readonly minIntervalMs?: number;
}

export interface SqliteLockReporter {
  /** Tracks a repo database this process opened; returns its removal. */
  register(dbPath: string): () => void;
  /**
   * Starts one rate-limited probe of every tracked database and resolves
   * once its lines are logged. Returns undefined when nothing was started.
   */
  reportBusy(source: string): Promise<void> | undefined;
}

export const createSqliteLockReporter = (
  options: SqliteLockReporterOptions
): SqliteLockReporter => {
  const minIntervalMs = options.minIntervalMs ?? SQLITE_LOCK_PROBE_MIN_INTERVAL_MS;
  const dbPaths = new Set<string>();
  let lastStartedAt: number | undefined;
  let inFlight = false;
  return {
    register(dbPath) {
      dbPaths.add(dbPath);
      return () => {
        dbPaths.delete(dbPath);
      };
    },
    reportBusy(source) {
      if (inFlight || dbPaths.size === 0) return undefined;
      const now = options.now();
      if (lastStartedAt !== undefined && now - lastStartedAt < minIntervalMs) return undefined;
      lastStartedAt = now;
      inFlight = true;
      const targets = [...dbPaths];
      return (async () => {
        try {
          for (const dbPath of targets) {
            const probe = await options.probe(dbPath);
            options.log(formatSqliteOpeners(dbPath, probe, options.selfPid, source));
          }
        } finally {
          inFlight = false;
        }
      })();
    },
  };
};

const runProbeLegacy = makeProcessRunnerLegacy(toShared());

/**
 * The CLI process's reporter. The probe is a separate read-only process with
 * its own timeout, so contention reporting never waits on the event loop.
 * @deprecated Legacy execution boundary for the Promise console hook and repo
 * store factory; native callers compose `probeSqliteOpeners`.
 */
export const sqliteLockReporterLegacy: SqliteLockReporter = createSqliteLockReporter({
  probe: (dbPath) =>
    runProbeLegacy(probeSqliteOpeners(dbPath)).catch((error: unknown): SqliteOpenersProbe => ({
      kind: 'unavailable',
      reason: error instanceof Error ? error.name : 'unknown',
    })),
  log: (line) => getLogger().warn(line),
  now: () => Date.now(),
  selfPid: process.pid,
});

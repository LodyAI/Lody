import { mkdirSync, rmSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

/**
 * Persistent scheduling state for the PR reconciler (spec
 * `specs/pr-status-reconciler.md` — 本机持久化状态), stored in a dedicated
 * SQLite database following the house store pattern (`operation-store.ts`,
 * `code-collab-v2-diff-store.ts`): own file, WAL, busy_timeout, migrate on
 * open.
 *
 * This holds ONLY disposable scheduling memory: per-scope quota, per-repo
 * error cooldowns, per-target last-success stamps, per-owner discovery
 * fingerprints. PR status itself is never cached here — fresh session meta
 * is the write predicate — so deleting the database is always safe (the
 * cost is one conservative re-poll round). Writes are row-level
 * write-through (no whole-state serialization) and best-effort: a failed
 * write must never break polling.
 */

export type PrPollScopeQuotaState = {
  /** Remaining token-bucket points at `updatedAtMs`. */
  tokens: number;
  updatedAtMs: number;
  /** Scope is frozen (rate-limited / provider safety floor) until this epoch-ms stamp. */
  frozenUntilMs?: number;
};

export type PrPollRepoCooldownState = {
  /** Consecutive repo-level failures; drives exponential backoff, reset on success. */
  consecutiveFailures: number;
  nextRetryAtMs: number;
  /** Last error-taxonomy kind seen (`rate-limited` scopes live in `scopes` instead). */
  lastErrorKind: string;
};

export type PrPollTargetState = {
  /** Last successful refresh; dueness = lastSuccess + current desired interval. */
  lastSuccessAtMs: number;
};

/** In-memory runtime view; the store keeps it in sync via write-through rows. */
export type PrPollerState = {
  /** Keyed by credentialScope. */
  scopes: Record<string, PrPollScopeQuotaState>;
  /** Keyed by `${credentialScope}:${repoFullName}`. */
  repoCooldowns: Record<string, PrPollRepoCooldownState>;
  /** Keyed by the schedulable target key (`ws|owner|repo|kind|qualifier`). */
  targets: Record<string, PrPollTargetState>;
  /**
   * Keyed by `${workspaceId}:${ownerSessionId}`; value is the `repo|branch`
   * fingerprint of the owner's last successful discovery (idle-terminal).
   */
  discoveryFingerprints: Record<string, string>;
};

export function emptyPrPollerState(): PrPollerState {
  return { scopes: {}, repoCooldowns: {}, targets: {}, discoveryFingerprints: {} };
}

export function getDefaultPrPollerStateDbPath(): string {
  return path.join(getLodyDataDir(), 'pr-poller-state.sqlite3');
}

/** Legacy JSON state file (pre-SQLite); imported once, then deleted. */
export function getLegacyPrPollerStateJsonPath(): string {
  return path.join(getLodyDataDir(), 'pr-poller-state.json');
}

export class PrPollerStateStore {
  private readonly logger: Logger;
  readonly dbPath: string;
  private readonly legacyJsonPath: string;
  private db: Database.Database | null = null;
  /** Set when the database cannot be opened; the store degrades to memory-only. */
  private disabled = false;

  constructor(options: { logger: Logger; dbPath?: string; legacyJsonPath?: string }) {
    this.logger = options.logger;
    this.dbPath = options.dbPath ?? getDefaultPrPollerStateDbPath();
    this.legacyJsonPath = options.legacyJsonPath ?? getLegacyPrPollerStateJsonPath();
  }

  /**
   * Load the full state into the in-memory shape. Opens the database lazily
   * (a disabled poller never creates the file) and imports the legacy JSON
   * state exactly once so a restart never re-mints spent quota.
   */
  load(): PrPollerState {
    const db = this.ensureDb();
    if (!db) {
      return emptyPrPollerState();
    }
    this.importLegacyJsonOnce(db);
    const state = emptyPrPollerState();
    try {
      for (const row of db
        .prepare('SELECT scope, tokens, updated_at_ms, frozen_until_ms FROM scopes')
        .all() as Array<{
        scope: string;
        tokens: number;
        updated_at_ms: number;
        frozen_until_ms: number | null;
      }>) {
        state.scopes[row.scope] = {
          tokens: row.tokens,
          updatedAtMs: row.updated_at_ms,
          ...(row.frozen_until_ms === null ? {} : { frozenUntilMs: row.frozen_until_ms }),
        };
      }
      for (const row of db
        .prepare(
          'SELECT key, consecutive_failures, next_retry_at_ms, last_error_kind FROM repo_cooldowns'
        )
        .all() as Array<{
        key: string;
        consecutive_failures: number;
        next_retry_at_ms: number;
        last_error_kind: string;
      }>) {
        state.repoCooldowns[row.key] = {
          consecutiveFailures: row.consecutive_failures,
          nextRetryAtMs: row.next_retry_at_ms,
          lastErrorKind: row.last_error_kind,
        };
      }
      for (const row of db.prepare('SELECT key, last_success_at_ms FROM targets').all() as Array<{
        key: string;
        last_success_at_ms: number;
      }>) {
        state.targets[row.key] = { lastSuccessAtMs: row.last_success_at_ms };
      }
      for (const row of db
        .prepare('SELECT key, fingerprint FROM discovery_fingerprints')
        .all() as Array<{ key: string; fingerprint: string }>) {
        state.discoveryFingerprints[row.key] = row.fingerprint;
      }
    } catch (error) {
      this.logger.debug(`[pr-poller] Failed to load state db: ${formatErrorMessage(error)}`);
      return emptyPrPollerState();
    }
    return state;
  }

  upsertScope(scope: string, quota: PrPollScopeQuotaState): void {
    this.run(
      `INSERT INTO scopes (scope, tokens, updated_at_ms, frozen_until_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET tokens = excluded.tokens,
         updated_at_ms = excluded.updated_at_ms, frozen_until_ms = excluded.frozen_until_ms`,
      [scope, quota.tokens, quota.updatedAtMs, quota.frozenUntilMs ?? null]
    );
  }

  upsertRepoCooldown(key: string, cooldown: PrPollRepoCooldownState): void {
    this.run(
      `INSERT INTO repo_cooldowns (key, consecutive_failures, next_retry_at_ms, last_error_kind)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET consecutive_failures = excluded.consecutive_failures,
         next_retry_at_ms = excluded.next_retry_at_ms, last_error_kind = excluded.last_error_kind`,
      [key, cooldown.consecutiveFailures, cooldown.nextRetryAtMs, cooldown.lastErrorKind]
    );
  }

  deleteRepoCooldown(key: string): void {
    this.run('DELETE FROM repo_cooldowns WHERE key = ?', [key]);
  }

  upsertTarget(key: string, target: PrPollTargetState): void {
    this.run(
      `INSERT INTO targets (key, last_success_at_ms) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET last_success_at_ms = excluded.last_success_at_ms`,
      [key, target.lastSuccessAtMs]
    );
  }

  deleteTarget(key: string): void {
    this.run('DELETE FROM targets WHERE key = ?', [key]);
  }

  upsertDiscoveryFingerprint(key: string, fingerprint: string): void {
    this.run(
      `INSERT INTO discovery_fingerprints (key, fingerprint) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET fingerprint = excluded.fingerprint`,
      [key, fingerprint]
    );
  }

  deleteDiscoveryFingerprint(key: string): void {
    this.run('DELETE FROM discovery_fingerprints WHERE key = ?', [key]);
  }

  close(): void {
    try {
      this.db?.close();
    } catch (error) {
      this.logger.debug(`[pr-poller] Failed to close state db: ${formatErrorMessage(error)}`);
    }
    this.db = null;
    this.disabled = false;
  }

  // ------------------------------------------------------------------ internal

  private run(sql: string, params: ReadonlyArray<string | number | null>): void {
    const db = this.ensureDb();
    if (!db) {
      return;
    }
    try {
      db.prepare(sql).run(...params);
    } catch (error) {
      // Best-effort scheduler memory: never let a persistence failure break polling.
      this.logger.debug(`[pr-poller] State db write failed: ${formatErrorMessage(error)}`);
    }
  }

  private ensureDb(): Database.Database | null {
    if (this.db) {
      return this.db;
    }
    if (this.disabled) {
      return null;
    }
    try {
      this.db = this.open();
      return this.db;
    } catch (error) {
      this.logger.debug(
        `[pr-poller] Failed to open state db; retrying with a fresh file: ${formatErrorMessage(error)}`
      );
    }
    // Corrupt database: the state is disposable, so recreate it.
    try {
      rmSync(this.dbPath, { force: true });
      rmSync(`${this.dbPath}-wal`, { force: true });
      rmSync(`${this.dbPath}-shm`, { force: true });
      this.db = this.open();
      return this.db;
    } catch (error) {
      this.logger.debug(
        `[pr-poller] State db unavailable; scheduling state is memory-only: ${formatErrorMessage(error)}`
      );
      this.disabled = true;
      return null;
    }
  }

  private open(): Database.Database {
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const db = new Database(this.dbPath);
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS scopes (
        scope TEXT PRIMARY KEY,
        tokens REAL NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        frozen_until_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS repo_cooldowns (
        key TEXT PRIMARY KEY,
        consecutive_failures INTEGER NOT NULL,
        next_retry_at_ms INTEGER NOT NULL,
        last_error_kind TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS targets (
        key TEXT PRIMARY KEY,
        last_success_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS discovery_fingerprints (
        key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL
      );
    `);
    return db;
  }

  /**
   * One-shot import of the legacy JSON state file (quota + cooldowns must
   * survive the storage migration — a restart must never re-mint budget).
   * Tolerant parsing; the JSON file is deleted afterwards either way.
   */
  private importLegacyJsonOnce(db: Database.Database): void {
    let raw: string;
    try {
      if (!existsSync(this.legacyJsonPath)) {
        return;
      }
      raw = readFileSync(this.legacyJsonPath, 'utf-8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as {
        scopes?: Record<string, PrPollScopeQuotaState>;
        repoCooldowns?: Record<string, PrPollRepoCooldownState>;
        targets?: Record<string, PrPollTargetState>;
        discoveryFingerprints?: Record<string, string>;
      };
      const importAll = db.transaction(() => {
        for (const [scope, quota] of Object.entries(parsed.scopes ?? {})) {
          if (typeof quota?.tokens !== 'number' || typeof quota.updatedAtMs !== 'number') continue;
          db.prepare(
            'INSERT OR IGNORE INTO scopes (scope, tokens, updated_at_ms, frozen_until_ms) VALUES (?, ?, ?, ?)'
          ).run(
            scope,
            quota.tokens,
            quota.updatedAtMs,
            typeof quota.frozenUntilMs === 'number' ? quota.frozenUntilMs : null
          );
        }
        for (const [key, cooldown] of Object.entries(parsed.repoCooldowns ?? {})) {
          if (
            typeof cooldown?.consecutiveFailures !== 'number' ||
            typeof cooldown.nextRetryAtMs !== 'number'
          ) {
            continue;
          }
          db.prepare(
            'INSERT OR IGNORE INTO repo_cooldowns (key, consecutive_failures, next_retry_at_ms, last_error_kind) VALUES (?, ?, ?, ?)'
          ).run(
            key,
            cooldown.consecutiveFailures,
            cooldown.nextRetryAtMs,
            typeof cooldown.lastErrorKind === 'string' ? cooldown.lastErrorKind : 'unknown'
          );
        }
        for (const [key, target] of Object.entries(parsed.targets ?? {})) {
          if (typeof target?.lastSuccessAtMs !== 'number') continue;
          db.prepare('INSERT OR IGNORE INTO targets (key, last_success_at_ms) VALUES (?, ?)').run(
            key,
            target.lastSuccessAtMs
          );
        }
        for (const [key, fingerprint] of Object.entries(parsed.discoveryFingerprints ?? {})) {
          if (typeof fingerprint !== 'string') continue;
          db.prepare(
            'INSERT OR IGNORE INTO discovery_fingerprints (key, fingerprint) VALUES (?, ?)'
          ).run(key, fingerprint);
        }
      });
      importAll();
      this.logger.debug('[pr-poller] Imported legacy JSON scheduling state into SQLite');
    } catch (error) {
      this.logger.debug(
        `[pr-poller] Legacy JSON state import skipped: ${formatErrorMessage(error)}`
      );
    } finally {
      try {
        unlinkSync(this.legacyJsonPath);
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

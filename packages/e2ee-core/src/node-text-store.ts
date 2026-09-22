import { closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ControlLogError, invariant } from './wire';
const MAX_BYTES = 16 * 1024 * 1024;
export interface SyncTextLease {
  load(): string | null;
  save(text: string): void;
  close(): void;
}

export interface TextTransaction {
  load(): Promise<string | null>;
  save(text: string): Promise<void>;
}

function databasePath(path: string, createFile: boolean): string {
  invariant(isAbsolute(path), 'journal-path-must-be-absolute');
  const canonical = join(realpathSync(dirname(path)), basename(path));
  // Never open/close an existing SQLite file with ordinary fs IO: on POSIX that
  // could release another connection's locks. Exclusive creation is safe.
  if (createFile) {
    try {
      closeSync(openSync(canonical, 'wx', 0o600));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  }
  const stat = lstatSync(canonical);
  invariant(stat.isFile() && stat.nlink === 1, 'unsafe-journal-file');
  return realpathSync(canonical);
}

/** Internal shared SQLite mechanics; payload codecs and authorization belong to callers. */
export class SqliteTextStore {
  constructor(
    private readonly path: string,
    private readonly applicationId: number,
    private readonly version: number,
    private readonly options: { createFile: boolean; initializeSchema: boolean } = {
      createFile: true,
      initializeSchema: true,
    }
  ) {}

  /** Synchronous SQLite lease; callers own release, including interruption paths. */
  openExclusive(): SyncTextLease {
    const db = new DatabaseSync(databasePath(this.path, this.options.createFile));
    let active = false;
    try {
      db.exec(`PRAGMA busy_timeout=0;
        PRAGMA locking_mode=EXCLUSIVE;
        PRAGMA synchronous=EXTRA;
        PRAGMA fullfsync=ON;
        PRAGMA trusted_schema=OFF;
        BEGIN EXCLUSIVE;`);
      // EXCLUSIVE locking mode retains the file lock across each save's COMMIT,
      // including awaits in work(). Closing the connection releases it, even on
      // process death. Never use a lease or stale-lock timeout to steal this lock.
      invariant(
        db.prepare('PRAGMA journal_mode').get()?.journal_mode === 'delete',
        'unsupported-journal-mode'
      );
      invariant(
        db.prepare('PRAGMA synchronous').get()?.synchronous === 3,
        'unsafe-journal-durability'
      );
      const appId = db.prepare('PRAGMA application_id').get()?.application_id;
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (appId === 0 && version === 0) {
        invariant(this.options.initializeSchema, 'foreign-journal-database');
        invariant(
          db.prepare('SELECT count(*) AS n FROM sqlite_schema').get()?.n === 0,
          'foreign-journal-database'
        );
        db.exec(`CREATE TABLE journal (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL) STRICT;
          PRAGMA application_id=${this.applicationId}; PRAGMA user_version=${this.version};`);
      } else {
        invariant(
          appId === this.applicationId && version === this.version,
          'unsupported-journal-database'
        );
      }
      db.exec('COMMIT');
      active = true;
      const tx: SyncTextLease = {
        load: () => {
          invariant(active, 'journal-transaction-ended');
          // Bound the loaded value before returning a potentially corrupt large row to JS.
          const row = db
            .prepare(
              'SELECT CASE WHEN length(CAST(payload AS BLOB)) <= ? THEN payload END AS payload FROM journal WHERE id=1'
            )
            .get(MAX_BYTES);
          if (!row) return null;
          invariant(typeof row.payload === 'string', 'journal-too-large');
          return row.payload;
        },
        save: (text) => {
          invariant(active, 'journal-transaction-ended');
          invariant(
            typeof text === 'string' && Buffer.byteLength(text) <= MAX_BYTES,
            'journal-too-large'
          );
          // Each save commits independently; a later callback failure must not
          // roll back a pending request that may already have reached the server.
          db.prepare(
            'INSERT INTO journal(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload'
          ).run(text);
        },
        close: () => {
          if (!active) return;
          active = false;
          db.close();
        },
      };
      return tx;
    } catch (error) {
      active = false;
      db.close();
      if (error instanceof Error && 'errcode' in error && error.errcode === 5)
        throw new ControlLogError('journal-busy');
      throw error;
    }
  }

  /** Temporary Promise adapter over the single synchronous SQLite implementation. */
  async exclusive<T>(work: (transaction: TextTransaction) => Promise<T>): Promise<T> {
    const lease = this.openExclusive();
    try {
      return await work({ load: async () => lease.load(), save: async (text) => lease.save(text) });
    } catch (error) {
      if (error instanceof Error && 'errcode' in error && error.errcode === 5)
        throw new ControlLogError('journal-busy');
      throw error;
    } finally {
      lease.close();
    }
  }
}

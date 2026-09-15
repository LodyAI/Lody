import { closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  PublishedSnapshot,
  SnapshotPublicationStore,
  SnapshotPublicationTransaction,
} from './snapshot-publication-store';
import { ControlLogError, invariant } from './wire';

const APPLICATION_ID = 0x4c535030;
const VERSION = 1;
const MAX_BODY = 16 * 1024 * 1024 + 8192;

function configure(db: DatabaseSync): void {
  db.exec(
    'PRAGMA busy_timeout=0; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;'
  );
  invariant(
    db.prepare('PRAGMA journal_mode').get()?.journal_mode === 'delete',
    'unsupported-snapshot-journal-mode'
  );
}

/**
 * Single-host durable admission backend. No secrets or production JWTs.
 * Explicit creation only; opening missing, empty, corrupt or foreign storage
 * never resets publication history. Each transaction has its own connection.
 */
export class SqliteSnapshotPublicationStore implements SnapshotPublicationStore {
  private readonly path: string;

  constructor(path: string, options: { create?: boolean } = {}) {
    invariant(isAbsolute(path), 'snapshot-path-must-be-absolute');
    this.path = join(realpathSync(dirname(path)), basename(path));
    if (options.create) {
      // Never fs-open/close an existing SQLite file: POSIX could release its locks.
      closeSync(openSync(this.path, 'wx', 0o600));
    }
    this.checkFile();
    const db = new DatabaseSync(this.path);
    try {
      configure(db);
      if (options.create) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE admitted (
            stream_key TEXT NOT NULL, offset TEXT NOT NULL, body BLOB NOT NULL,
            PRIMARY KEY(stream_key, offset), CHECK(length(body) > 0 AND length(body) <= ${MAX_BODY})
          ) STRICT;
          CREATE TABLE current_snapshot (
            stream_key TEXT PRIMARY KEY, offset TEXT NOT NULL,
            FOREIGN KEY(stream_key, offset) REFERENCES admitted(stream_key, offset)
          ) STRICT;
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${VERSION};
          COMMIT;`);
      }
      this.checkFormat(db);
    } catch (error) {
      // Format reads can contend with another process's commit too. Preserve
      // the same retryable result as transaction(), never treat busy as damage.
      if (error instanceof Error && 'errcode' in error && error.errcode === 5)
        throw new ControlLogError('snapshot-store-busy');
      throw error;
    } finally {
      db.close();
    }
  }

  private checkFile(): void {
    const stat = lstatSync(this.path); // missing is an error, never auto-create
    invariant(stat.isFile() && stat.nlink === 1, 'unsafe-snapshot-file');
  }

  private checkFormat(db: DatabaseSync): void {
    invariant(
      db.prepare('PRAGMA application_id').get()?.application_id === APPLICATION_ID &&
        db.prepare('PRAGMA user_version').get()?.user_version === VERSION,
      'unsupported-snapshot-database'
    );
    // Validate required schema even when no stream has been published yet.
    db.prepare('SELECT stream_key, offset, body FROM admitted LIMIT 0').all();
    db.prepare('SELECT stream_key, offset FROM current_snapshot LIMIT 0').all();
  }

  transaction<T>(streamKey: string, work: (tx: SnapshotPublicationTransaction) => T): T {
    invariant(typeof streamKey === 'string' && streamKey.length > 0, 'invalid-snapshot-stream');
    this.checkFile();
    const db = new DatabaseSync(this.path);
    let live = false;
    let begun = false;
    try {
      configure(db);
      db.exec('BEGIN IMMEDIATE');
      begun = true;
      this.checkFormat(db);
      live = true;
      const check = () => invariant(live, 'snapshot-transaction-ended');
      const admitted = (offset: string): Uint8Array | undefined => {
        check();
        const row = db
          .prepare(
            'SELECT CASE WHEN length(body) <= ? THEN body END AS body FROM admitted WHERE stream_key=? AND offset=?'
          )
          .get(MAX_BODY, streamKey, offset);
        if (!row) return undefined;
        invariant(
          row.body instanceof Uint8Array && row.body.byteLength > 0,
          'snapshot-store-corrupt'
        );
        return row.body.slice();
      };
      const result = work({
        admitted,
        current: (): PublishedSnapshot | undefined => {
          check();
          const row = db
            .prepare('SELECT offset FROM current_snapshot WHERE stream_key=?')
            .get(streamKey);
          if (!row) {
            invariant(
              !db.prepare('SELECT 1 FROM admitted WHERE stream_key=? LIMIT 1').get(streamKey),
              'snapshot-store-corrupt'
            );
            return undefined;
          }
          invariant(typeof row.offset === 'string', 'snapshot-store-corrupt');
          const body = admitted(row.offset);
          invariant(body !== undefined, 'snapshot-store-corrupt');
          return { offset: row.offset, body };
        },
        save: ({ offset, body }) => {
          check();
          invariant(
            typeof offset === 'string' && offset.length > 0 && offset.length <= 1024,
            'invalid-snapshot-offset'
          );
          invariant(
            body instanceof Uint8Array && body.byteLength > 0 && body.byteLength <= MAX_BODY,
            'invalid-snapshot-body'
          );
          invariant(admitted(offset) === undefined, 'snapshot-identity-conflict');
          db.prepare('INSERT INTO admitted(stream_key,offset,body) VALUES(?,?,?)').run(
            streamKey,
            offset,
            body
          );
          db.prepare(
            'INSERT INTO current_snapshot(stream_key,offset) VALUES(?,?) ON CONFLICT(stream_key) DO UPDATE SET offset=excluded.offset'
          ).run(streamKey, offset);
        },
      });
      invariant(
        !result || typeof (result as { then?: unknown }).then !== 'function',
        'snapshot-async-transaction'
      );
      live = false;
      db.exec('COMMIT');
      begun = false;
      return result;
    } catch (error) {
      if (begun) db.exec('ROLLBACK');
      if (error instanceof Error && 'errcode' in error && error.errcode === 5)
        throw new ControlLogError('snapshot-store-busy');
      throw error;
    } finally {
      live = false;
      db.close();
    }
  }
}

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, existsSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const rowSchema = z.object({
  target: z.string(),
  signer: z.string().regex(/^[0-9a-f]{64}$/),
  frame: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
  digest: z.string(),
});
export type StoredRpcOriginal = { target: string; signer: string; frame: Uint8Array };
const digest = (record: StoredRpcOriginal) =>
  createHash('sha256')
    .update(JSON.stringify([record.target, record.signer]))
    .update(record.frame)
    .digest('hex');

/** Host-only immutable originals. SQLite holds ciphertext and public routing only,
 * never grants authority. No automatic collection, reset, migration or replacement.
 * A failed operation affects that request; the next call can reopen the same file. */
export class E2eeRpcOriginals {
  private pendingClose: DatabaseSync | undefined;
  private closing = false;
  private cleanupError: unknown;
  constructor(private readonly filename: string) {}
  private retryClose(): void {
    if (!this.pendingClose) return;
    try {
      this.pendingClose.close();
      this.pendingClose = undefined;
      this.cleanupError = undefined;
    } catch {
      throw this.cleanupError ?? new Error('e2ee_rpc_store_close');
    }
  }
  /** Retain a failed native close owner; repeated close is its explicit recovery path. */
  close(): void {
    this.closing = true;
    this.retryClose();
  }
  private database<A>(work: (db: DatabaseSync) => A): A {
    if (this.closing) throw new Error('e2ee_rpc_store_closed');
    this.retryClose();
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    const marker = `${this.filename}.initialized`;
    if (!existsSync(this.filename) && existsSync(marker))
      throw new Error('e2ee_rpc_original_missing');
    const db = new DatabaseSync(this.filename);
    try {
      chmodSync(this.filename, 0o600);
      db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (version === 0 && !db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE originals(direction TEXT NOT NULL, key TEXT NOT NULL, target TEXT NOT NULL, signer TEXT NOT NULL,
            frame BLOB NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(direction,key));
          CREATE TABLE responses(key TEXT NOT NULL, sequence INTEGER NOT NULL, frame BLOB NOT NULL, digest TEXT NOT NULL,
            PRIMARY KEY(key,sequence)); PRAGMA user_version=1; COMMIT;`);
      } else if (version !== 1) throw new Error('e2ee_rpc_store_format');
      try {
        closeSync(openSync(marker, 'wx', 0o600));
      } catch (cause) {
        if (!(cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')) throw cause;
      }
      return work(db);
    } finally {
      try {
        db.close();
      } catch (cause) {
        this.pendingClose = db;
        this.cleanupError ??= cause;
      }
    }
  }
  private readRow(row: unknown): StoredRpcOriginal | undefined {
    if (!row) return undefined;
    const parsed = rowSchema.safeParse(row);
    if (!parsed.success || digest(parsed.data) !== parsed.data.digest)
      throw new Error('e2ee_rpc_original_corrupt');
    return {
      target: parsed.data.target,
      signer: parsed.data.signer,
      frame: Uint8Array.from(parsed.data.frame),
    };
  }
  read(direction: 'sent' | 'received', key: string): StoredRpcOriginal | undefined {
    return this.database((db) =>
      this.readRow(
        db.prepare('SELECT * FROM originals WHERE direction=? AND key=?').get(direction, key)
      )
    );
  }
  /** Concurrent send preparation adopts the first original; callers must decrypt
   * and compare its exact intent before publishing it. Incoming replacement refuses. */
  retain(
    direction: 'sent' | 'received',
    key: string,
    record: StoredRpcOriginal
  ): StoredRpcOriginal {
    return this.database((db) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT OR IGNORE INTO originals VALUES(?,?,?,?,?,?)').run(
          direction,
          key,
          record.target,
          record.signer,
          record.frame,
          digest(record)
        );
        const saved = this.readRow(
          db.prepare('SELECT * FROM originals WHERE direction=? AND key=?').get(direction, key)
        );
        if (
          !saved ||
          saved.target !== record.target ||
          (direction === 'received' && digest(saved) !== digest(record))
        )
          throw new Error('e2ee_rpc_original_conflict');
        db.exec('COMMIT');
        return saved;
      } catch (cause) {
        db.exec('ROLLBACK');
        throw cause;
      }
    });
  }
  /** Correlated authenticated replies keep immutable sequence bytes across reopen. */
  retainResponse(key: string, sequence: number, frame: Uint8Array): void {
    const hash = createHash('sha256').update(frame).digest('hex');
    this.database((db) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT OR IGNORE INTO responses VALUES(?,?,?,?)').run(
          key,
          sequence,
          frame,
          hash
        );
        const row = db
          .prepare('SELECT digest FROM responses WHERE key=? AND sequence=?')
          .get(key, sequence);
        if (row?.digest !== hash) throw new Error('e2ee_rpc_response_conflict');
        db.exec('COMMIT');
      } catch (cause) {
        db.exec('ROLLBACK');
        throw cause;
      }
    });
  }
}

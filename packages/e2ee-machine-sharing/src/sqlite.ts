import { DatabaseSync } from 'node:sqlite';
import { Effect } from 'effect';
import { MachineSharingError } from './errors';
import type { MachineSharingPinRow, MachineSharingStore, OpenMachineSharingStore } from './store';

const sql = <A>(f: () => A) =>
  Effect.try({
    try: f,
    catch: (e) =>
      e instanceof MachineSharingError ? e : new MachineSharingError({ code: 'sharing_storage' }),
  });

/** The desktop store: one SQLite file with synchronous full commits. Each step runs in
 * one `BEGIN IMMEDIATE` transaction, which fences other connections to the same file. */
export const openSqliteMachineSharingStore = (filename: string): OpenMachineSharingStore =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      sql(() => {
        const connection = new DatabaseSync(filename);
        try {
          connection.exec(
            'PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sharing_pins(resource TEXT PRIMARY KEY, head TEXT NOT NULL, original TEXT); CREATE TABLE IF NOT EXISTS sharing_requests(resource TEXT NOT NULL, request_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(resource,request_id));'
          );
          return connection;
        } catch (e) {
          connection.close();
          throw e;
        }
      }),
      (connection) => sql(() => connection.close()).pipe(Effect.orDie)
    );
    const transaction = <A>(work: () => A) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    };
    const pin = (resource: string): MachineSharingPinRow | null => {
      const row = db
        .prepare('SELECT head, original FROM sharing_pins WHERE resource=?')
        .get(resource);
      return row
        ? { head: String(row.head), original: row.original === null ? null : String(row.original) }
        : null;
    };
    const request = (resource: string, requestId: string) => {
      const row = db
        .prepare('SELECT value FROM sharing_requests WHERE resource=? AND request_id=?')
        .get(resource, requestId);
      return row ? String(row.value) : null;
    };
    return {
      readPin: (resource, read) => sql(() => read(pin(resource))),
      updatePin: (resource, decide) =>
        sql(() =>
          transaction(() => {
            const step = decide(pin(resource));
            if (step.write)
              db.prepare(
                'INSERT INTO sharing_pins VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET head=excluded.head,original=excluded.original'
              ).run(resource, step.write.head, step.write.original);
            return step.result;
          })
        ),
      readRequest: (resource, requestId, read) => sql(() => read(request(resource, requestId))),
      updateRequest: (resource, requestId, decide) =>
        sql(() =>
          transaction(() => {
            const step = decide(request(resource, requestId));
            if (step.write !== undefined)
              db.prepare(
                'INSERT INTO sharing_requests VALUES(?,?,?) ON CONFLICT(resource,request_id) DO UPDATE SET value=excluded.value'
              ).run(resource, requestId, step.write);
            return step.result;
          })
        ),
      readRequests: (resource, read) =>
        sql(() =>
          read(
            db
              .prepare(
                'SELECT request_id,value FROM sharing_requests WHERE resource=? ORDER BY request_id'
              )
              .all(resource)
              .map((row) => ({ requestId: String(row.request_id), value: String(row.value) }))
          )
        ),
    } satisfies MachineSharingStore;
  });

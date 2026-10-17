import { Effect, Layer } from 'effect';
import { bytesEqual } from '../../internal/foundation/cbor';
import { LocalStoreError } from '../../services/errors';
import { LedgerFeedStore, type LedgerFeedTail } from '../../services/stores';
import { WorkspaceScope } from '../../services/workspace';
import { openSqliteStore, type SqliteFileOptions } from './store';

const APPLICATION_ID = 0x4c454633;
const MAX_ORIGIN_BYTES = 2 * 1024 * 1024;
const fail = (reason: LocalStoreError['reason']) =>
  new LocalStoreError({ store: 'LedgerFeedStore', reason });
const sameTail = (a: LedgerFeedTail, b: LedgerFeedTail) =>
  bytesEqual(a.head, b.head) &&
  a.count === b.count &&
  a.offset === b.offset &&
  a.bootstrap === b.bootstrap &&
  a.bytes === b.bytes;

/**
 * {@link LedgerFeedStore} in a dedicated SQLite file bound to one workspace.
 *
 * @category Node SQLite adapters
 */
export const sqliteLedgerFeedStore = (options: SqliteFileOptions) =>
  Layer.effect(
    LedgerFeedStore,
    Effect.gen(function* () {
      const genesis = (yield* WorkspaceScope).genesis.toBytes();
      const db = yield* openSqliteStore({
        ...options,
        applicationId: APPLICATION_ID,
        version: 1,
        error: fail,
        initialize(connection) {
          connection.exec(`CREATE TABLE feed_meta(id INTEGER PRIMARY KEY CHECK(id=1),genesis BLOB NOT NULL CHECK(length(genesis)=32),origin BLOB CHECK(origin IS NULL OR length(origin) BETWEEN 1 AND ${MAX_ORIGIN_BYTES}),origin_count INTEGER,head BLOB,count INTEGER,offset TEXT,bootstrap INTEGER,bytes INTEGER);
            CREATE TABLE feed_records(position INTEGER PRIMARY KEY,record BLOB NOT NULL CHECK(length(record) BETWEEN 1 AND 8192));`);
          connection.prepare('INSERT INTO feed_meta(id,genesis) VALUES(1,?)').run(genesis);
        },
        validate(connection) {
          const row = connection.prepare('SELECT genesis FROM feed_meta WHERE id=1').get() as
            | { genesis?: unknown }
            | undefined;
          if (!(row?.genesis instanceof Uint8Array) || !bytesEqual(row.genesis, genesis))
            throw fail('corrupt');
        },
      });
      const sql = <A>(work: () => A) =>
        Effect.try({
          try: work,
          catch: (error) =>
            error instanceof LocalStoreError ? error : fail(db.open ? 'storage' : 'closed'),
        });
      const meta = () => {
        const row = db
          .prepare(
            'SELECT genesis,origin,origin_count,head,count,offset,bootstrap,bytes FROM feed_meta WHERE id=1'
          )
          .get() as Record<string, unknown> | undefined;
        if (!row || !(row.genesis instanceof Uint8Array) || !bytesEqual(row.genesis, genesis))
          throw fail('corrupt');
        if (row.origin === null) return null;
        if (
          !(row.origin instanceof Uint8Array) ||
          typeof row.origin_count !== 'number' ||
          !(row.head instanceof Uint8Array) ||
          typeof row.count !== 'number' ||
          typeof row.offset !== 'string' ||
          (row.bootstrap !== 0 && row.bootstrap !== 1) ||
          typeof row.bytes !== 'number'
        )
          throw fail('corrupt');
        return {
          origin: new Uint8Array(row.origin),
          originCount: row.origin_count,
          tail: {
            head: new Uint8Array(row.head),
            count: row.count,
            offset: row.offset,
            bootstrap: row.bootstrap === 1,
            bytes: row.bytes,
          } satisfies LedgerFeedTail,
        };
      };
      const writeTail = (tail: LedgerFeedTail) =>
        db
          .prepare('UPDATE feed_meta SET head=?,count=?,offset=?,bootstrap=?,bytes=? WHERE id=1')
          .run(tail.head, tail.count, tail.offset, tail.bootstrap ? 1 : 0, tail.bytes);
      return LedgerFeedStore.of({
        load: (maxRecords) =>
          sql(() =>
            db
              .transaction(() => {
                const stored = meta();
                if (!stored) return null;
                if (stored.tail.count - stored.originCount > maxRecords) throw fail('capacity');
                const rows = db
                  .prepare('SELECT position,record FROM feed_records ORDER BY position LIMIT ?')
                  .all(maxRecords + 1) as { position: unknown; record: unknown }[];
                const records = rows.map((row, index) => {
                  if (
                    row.position !== stored.originCount + index + 1 ||
                    !(row.record instanceof Uint8Array)
                  )
                    throw fail('corrupt');
                  return new Uint8Array(row.record);
                });
                return { ...stored, records };
              })
              .deferred()
          ),
        tail: () => sql(() => meta()?.tail ?? null),
        initialize: (origin, originCount, tail) =>
          sql(() =>
            db
              .transaction(() => {
                if (meta()) throw fail('conflict');
                db.prepare('UPDATE feed_meta SET origin=?,origin_count=? WHERE id=1').run(
                  origin,
                  originCount
                );
                writeTail(tail);
                const stored = meta();
                if (
                  !stored ||
                  !bytesEqual(stored.origin, origin) ||
                  stored.originCount !== originCount ||
                  !sameTail(stored.tail, tail)
                )
                  throw fail('corrupt');
              })
              .immediate()
          ),
        append: (expected, records, next) =>
          sql(() =>
            db
              .transaction(() => {
                const stored = meta();
                if (!stored || !sameTail(stored.tail, expected)) throw fail('conflict');
                const insert = db.prepare('INSERT INTO feed_records(position,record) VALUES(?,?)');
                const first = expected.count + 1;
                records.forEach((record, index) => {
                  if (insert.run(first + index, record).changes !== 1) throw fail('corrupt');
                });
                if (writeTail(next).changes !== 1) throw fail('corrupt');
                const after = meta();
                if (!after || !sameTail(after.tail, next)) throw fail('corrupt');
                // Read back only the originals written by this transaction.
                const read = db.prepare('SELECT record FROM feed_records WHERE position=?');
                records.forEach((record, index) => {
                  const row = read.get(first + index) as { record?: unknown } | undefined;
                  if (!(row?.record instanceof Uint8Array) || !bytesEqual(row.record, record))
                    throw fail('corrupt');
                });
              })
              .immediate()
          ),
      });
    })
  );

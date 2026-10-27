import { Effect, Layer, Result } from 'effect';
import * as Bytes from '../../internal/foundation/bytes';
import { keyId } from '../../internal/foundation/identifiers';
import { LocalStoreError } from '../../services/errors';
import { LedgerPinStore } from '../../services/ledger';
import { WorkspaceScope } from '../../services/workspace';
import { isSqliteCorruption, openSqliteStore, type SqliteFileOptions } from './store';

const APPLICATION_ID = 0x4c45504e;
const fail = (reason: LocalStoreError['reason']) =>
  new LocalStoreError({ store: 'LedgerPinStore', reason });

/**
 * {@link LedgerPinStore} in a dedicated SQLite file bound to the workspace
 * genesis. Every write is read back before it is reported as durable.
 *
 * @category Node SQLite adapters
 */
export const sqliteLedgerPinStore = (options: SqliteFileOptions) =>
  Layer.effect(
    LedgerPinStore,
    Effect.gen(function* () {
      const genesis = keyId((yield* WorkspaceScope).genesis.toBytes());
      const db = yield* openSqliteStore({
        ...options,
        applicationId: APPLICATION_ID,
        version: 1,
        error: fail,
        initialize(connection) {
          connection.exec(
            'CREATE TABLE ledger_pin(id INTEGER PRIMARY KEY CHECK(id=1),genesis TEXT NOT NULL,head BLOB CHECK(head IS NULL OR length(head)=32),count INTEGER)'
          );
          connection.prepare('INSERT INTO ledger_pin(id,genesis) VALUES(1,?)').run(genesis);
        },
        validate(connection) {
          const row = connection.prepare('SELECT genesis FROM ledger_pin WHERE id=1').get() as
            | { genesis: unknown }
            | undefined;
          if (row?.genesis !== genesis) throw fail('corrupt');
        },
      });
      const select = db.prepare('SELECT genesis,head,count FROM ledger_pin WHERE id=1');
      const decode = () => {
        const row = select.get() as { genesis: unknown; head: unknown; count: unknown } | undefined;
        if (!row || row.genesis !== genesis) throw fail('corrupt');
        if (row.head === null) {
          if (row.count !== null) throw fail('corrupt');
          return null;
        }
        if (
          !(row.head instanceof Uint8Array) ||
          typeof row.count !== 'number' ||
          !Number.isSafeInteger(row.count) ||
          row.count < 1
        )
          throw fail('corrupt');
        const head = Bytes.recordHash(row.head);
        if (Result.isFailure(head)) throw fail('corrupt');
        return { head: head.success, length: row.count };
      };
      const sql = <A>(work: () => A) =>
        Effect.try({
          try: work,
          catch: (error) =>
            error instanceof LocalStoreError
              ? error
              : fail(isSqliteCorruption(error) ? 'corrupt' : db.open ? 'storage' : 'closed'),
        });
      return LedgerPinStore.of({
        read: () => sql(decode),
        write: (checkpoint) =>
          sql(() =>
            db
              .transaction(() => {
                if (
                  db
                    .prepare('UPDATE ledger_pin SET head=?,count=? WHERE id=1')
                    .run(checkpoint.head.toBytes(), checkpoint.length).changes !== 1
                )
                  throw fail('corrupt');
                const saved = decode();
                if (
                  !saved ||
                  saved.length !== checkpoint.length ||
                  !saved.head.equals(checkpoint.head)
                )
                  throw fail('corrupt');
              })
              .immediate()
          ),
      });
    })
  );

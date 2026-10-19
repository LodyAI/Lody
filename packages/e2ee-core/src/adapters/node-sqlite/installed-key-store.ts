import { Effect, Layer } from 'effect';
import { keyId } from '../../internal/foundation/identifiers';
import { MAX_PROTECTED_EPOCH_BYTES } from '../../internal/keys/installed-keys';
import { LocalStoreError } from '../../services/errors';
import { InstalledKeyStore } from '../../services/stores';
import { DeviceIdentity, WorkspaceScope } from '../../services/workspace';
import { openSqliteStore, type SqliteFileOptions } from './store';

const APPLICATION_ID = 0x4c45504b;
const fail = (reason: LocalStoreError['reason']) =>
  new LocalStoreError({ store: 'InstalledKeyStore', reason });

/**
 * {@link InstalledKeyStore} in a dedicated SQLite file bound to one workspace and
 * recipient device. Stores protected blobs only.
 *
 * @category Node SQLite adapters
 */
export const sqliteInstalledKeyStore = (options: SqliteFileOptions) =>
  Layer.effect(
    InstalledKeyStore,
    Effect.gen(function* () {
      const genesis = keyId((yield* WorkspaceScope).genesis.toBytes());
      const recipient = keyId((yield* DeviceIdentity).signer.publicKey.toBytes());
      const db = yield* openSqliteStore({
        ...options,
        applicationId: APPLICATION_ID,
        version: 2,
        error: fail,
        initialize(connection) {
          connection.exec(`CREATE TABLE installed_key_meta(id INTEGER PRIMARY KEY CHECK(id=1),genesis TEXT NOT NULL,recipient TEXT NOT NULL);
            CREATE TABLE installed_epoch_keys(epoch INTEGER PRIMARY KEY CHECK(epoch>=0 AND epoch<=4294967295),blob BLOB NOT NULL CHECK(length(blob) BETWEEN 1 AND ${MAX_PROTECTED_EPOCH_BYTES}));`);
          connection
            .prepare('INSERT INTO installed_key_meta(id,genesis,recipient) VALUES(1,?,?)')
            .run(genesis, recipient);
        },
        validate(connection) {
          const meta = connection
            .prepare('SELECT genesis,recipient FROM installed_key_meta WHERE id=1')
            .get() as { genesis?: unknown; recipient?: unknown } | undefined;
          if (meta?.genesis !== genesis || meta?.recipient !== recipient) throw fail('corrupt');
        },
      });
      const sql = <A>(work: () => A) =>
        Effect.try({
          try: work,
          catch: (error) =>
            error instanceof LocalStoreError ? error : fail(db.open ? 'storage' : 'closed'),
        });
      const read = (epoch: number) => {
        const row = db
          .prepare(
            `SELECT CASE WHEN length(blob) BETWEEN 1 AND ${MAX_PROTECTED_EPOCH_BYTES} THEN blob ELSE NULL END AS blob FROM installed_epoch_keys WHERE epoch=?`
          )
          .get(epoch) as { blob: unknown } | undefined;
        if (!row) return null;
        if (!(row.blob instanceof Uint8Array)) throw fail('corrupt');
        return new Uint8Array(row.blob);
      };
      return InstalledKeyStore.of({
        load: (epoch) => sql(() => read(epoch)),
        insertIfAbsent: (epoch, blob) =>
          sql(() =>
            db
              .transaction(() => {
                db.prepare(
                  'INSERT INTO installed_epoch_keys(epoch,blob) VALUES(?,?) ON CONFLICT(epoch) DO NOTHING'
                ).run(epoch, blob);
              })
              .immediate()
          ),
        replace: (epoch, expected, next) =>
          sql(() =>
            db
              .transaction(() => {
                // A concurrent original wins silently; the caller reloads and verifies.
                db.prepare('UPDATE installed_epoch_keys SET blob=? WHERE epoch=? AND blob=?').run(
                  next,
                  epoch,
                  expected
                );
              })
              .immediate()
          ),
      });
    })
  );

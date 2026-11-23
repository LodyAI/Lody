import { Effect, Layer } from 'effect';
import { LocalStoreError } from '../../services/errors';
import { DeliveryOutbox } from '../../services/stores';
import { openSqliteStore, type SqliteFileOptions } from './store';

const APPLICATION_ID = 0x4c454f31;
const fail = (reason: LocalStoreError['reason']) =>
  new LocalStoreError({ store: 'DeliveryOutbox', reason });
const validSlot = (slot: string) => /^[0-9a-f]{32}$/.test(slot);
const validFrame = (frame: unknown): frame is Uint8Array =>
  frame instanceof Uint8Array && frame.length >= 1 && frame.length <= 512;

/**
 * {@link DeliveryOutbox} in a dedicated ciphertext-only SQLite file.
 *
 * @category Node SQLite adapters
 */
export const sqliteDeliveryOutbox = (options: SqliteFileOptions) =>
  Layer.effect(
    DeliveryOutbox,
    Effect.gen(function* () {
      const db = yield* openSqliteStore({
        ...options,
        applicationId: APPLICATION_ID,
        version: 1,
        error: fail,
        initialize(connection) {
          connection.exec(
            'CREATE TABLE epoch_delivery (slot TEXT PRIMARY KEY, frame BLOB NOT NULL CHECK(length(frame) BETWEEN 1 AND 512));'
          );
        },
      });
      const sql = <A>(slot: string, work: () => A) =>
        validSlot(slot)
          ? Effect.try({
              try: work,
              catch: (error) =>
                error instanceof LocalStoreError ? error : fail(db.open ? 'storage' : 'closed'),
            })
          : Effect.fail(fail('corrupt'));
      const read = (slot: string) => {
        const row = db
          .prepare(
            'SELECT CASE WHEN length(frame) BETWEEN 1 AND 512 THEN frame ELSE NULL END AS frame FROM epoch_delivery WHERE slot=?'
          )
          .get(slot) as { frame: unknown } | undefined;
        if (!row) return null;
        if (!validFrame(row.frame)) throw fail('corrupt');
        return new Uint8Array(row.frame);
      };
      return DeliveryOutbox.of({
        load: (slot) => sql(slot, () => read(slot)),
        saveOriginal: (slot, input) => {
          if (!validFrame(input)) return Effect.fail(fail('corrupt'));
          const frame = new Uint8Array(input);
          return sql(slot, () =>
            db
              .transaction(() => {
                db.prepare(
                  'INSERT INTO epoch_delivery(slot,frame) VALUES(?,?) ON CONFLICT(slot) DO NOTHING'
                ).run(slot, frame);
                const original = read(slot);
                if (!original) throw fail('corrupt');
                return original;
              })
              .immediate()
          );
        },
      });
    })
  );

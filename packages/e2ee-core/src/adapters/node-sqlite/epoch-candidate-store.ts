import { Effect, Layer, Schema } from 'effect';
import { bytesEqual } from '../../internal/foundation/cbor';
import { keyId } from '../../internal/foundation/identifiers';
import { LocalStoreError } from '../../services/errors';
import { EpochCandidateStore, type EpochCandidateRow } from '../../services/stores';
import { DeviceIdentity, WorkspaceScope } from '../../services/workspace';
import { openSqliteStore, type SqliteFileOptions } from './store';

const APPLICATION_ID = 0x4c455243;
const MAX_BLOB = 24576;
const MAX_ENVELOPES = 2 * 1024 * 1024;
const fail = (reason: LocalStoreError['reason']) =>
  new LocalStoreError({ store: 'EpochCandidateStore', reason });
const Row = Schema.Struct({
  id: Schema.String,
  parent: Schema.Uint8Array,
  parent_count: Schema.Int,
  epoch: Schema.Int,
  commitment: Schema.Uint8Array,
  record: Schema.Uint8Array,
  envelopes: Schema.Uint8Array,
  blob: Schema.Uint8Array,
  outcome: Schema.NullOr(Schema.Literals(['Committed', 'Conflict'])),
  binding: Schema.NullOr(Schema.Literals(['current', 'historical'])),
  consumed: Schema.Literals([0, 1]),
});
const SELECT = `SELECT CASE WHEN length(id)=64 THEN id END AS id,
  CASE WHEN length(parent)=32 THEN parent END AS parent,parent_count,epoch,
  CASE WHEN length(commitment)=32 THEN commitment END AS commitment,
  CASE WHEN length(record) BETWEEN 1 AND 8192 THEN record END AS record,
  CASE WHEN length(envelopes) BETWEEN 1 AND ${MAX_ENVELOPES} THEN envelopes END AS envelopes,
  CASE WHEN length(blob) BETWEEN 0 AND ${MAX_BLOB} THEN blob END AS blob,
  outcome,binding,consumed FROM epoch_rotation_candidates`;
const same = (a: EpochCandidateRow, b: EpochCandidateRow) =>
  a.id === b.id &&
  a.parentCount === b.parentCount &&
  a.epoch === b.epoch &&
  bytesEqual(a.parent, b.parent) &&
  bytesEqual(a.commitment, b.commitment) &&
  bytesEqual(a.record, b.record) &&
  bytesEqual(a.envelopes, b.envelopes) &&
  bytesEqual(a.blob, b.blob) &&
  a.outcome === b.outcome &&
  a.binding === b.binding &&
  a.consumed === b.consumed;

/**
 * {@link EpochCandidateStore} in a dedicated SQLite file bound to one workspace
 * and publishing device.
 *
 * @category Node SQLite adapters
 */
export const sqliteEpochCandidateStore = (options: SqliteFileOptions) =>
  Layer.effect(
    EpochCandidateStore,
    Effect.gen(function* () {
      const genesis = keyId((yield* WorkspaceScope).genesis.toBytes());
      const publisher = keyId((yield* DeviceIdentity).signer.publicKey.toBytes());
      const db = yield* openSqliteStore({
        ...options,
        applicationId: APPLICATION_ID,
        version: 3,
        error: fail,
        initialize(connection) {
          connection.exec(`CREATE TABLE epoch_rotation_meta(id INTEGER PRIMARY KEY CHECK(id=1),genesis TEXT NOT NULL,publisher TEXT NOT NULL);
            CREATE TABLE epoch_rotation_candidates(id TEXT PRIMARY KEY,parent BLOB NOT NULL,parent_count INTEGER NOT NULL,epoch INTEGER NOT NULL,commitment BLOB NOT NULL,record BLOB NOT NULL,envelopes BLOB NOT NULL,blob BLOB NOT NULL,outcome TEXT,binding TEXT,consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)));
            CREATE UNIQUE INDEX epoch_rotation_active ON epoch_rotation_candidates(consumed) WHERE consumed=0;`);
          connection
            .prepare('INSERT INTO epoch_rotation_meta(id,genesis,publisher) VALUES(1,?,?)')
            .run(genesis, publisher);
        },
        validate(connection) {
          const meta = connection
            .prepare('SELECT genesis,publisher FROM epoch_rotation_meta WHERE id=1')
            .get() as { genesis?: unknown; publisher?: unknown } | undefined;
          if (meta?.genesis !== genesis || meta?.publisher !== publisher) throw fail('corrupt');
        },
      });
      const sql = <A>(work: () => A) =>
        Effect.try({
          try: work,
          catch: (error) =>
            error instanceof LocalStoreError ? error : fail(db.open ? 'storage' : 'closed'),
        });
      const decode = (raw: unknown): EpochCandidateRow => {
        let row: typeof Row.Type;
        try {
          row = Schema.decodeUnknownSync(Row)(raw);
        } catch {
          throw fail('corrupt');
        }
        return {
          id: row.id,
          parent: new Uint8Array(row.parent),
          parentCount: row.parent_count,
          epoch: row.epoch,
          commitment: new Uint8Array(row.commitment),
          record: new Uint8Array(row.record),
          envelopes: new Uint8Array(row.envelopes),
          blob: new Uint8Array(row.blob),
          outcome: row.outcome,
          binding: row.binding,
          consumed: row.consumed === 1,
        };
      };
      /** The file must still be bound to this workspace and publisher when a write commits. */
      const bound = () => {
        const meta = db
          .prepare('SELECT genesis,publisher FROM epoch_rotation_meta WHERE id=1')
          .get() as { genesis?: unknown; publisher?: unknown } | undefined;
        if (meta?.genesis !== genesis || meta?.publisher !== publisher) throw fail('corrupt');
      };
      const select = (where: string, ...args: unknown[]) => {
        const rows = db.prepare(`${SELECT} WHERE ${where} LIMIT 2`).all(...args);
        if (rows.length > 1) throw fail('corrupt');
        return rows.length ? decode(rows[0]) : null;
      };
      return EpochCandidateStore.of({
        active: () => sql(() => select('consumed=0')),
        load: (id) => sql(() => select('id=?', id)),
        insert: (row) =>
          sql(() =>
            db
              .transaction(() => {
                if (select('consumed=0')) throw fail('conflict');
                db.prepare(
                  'INSERT INTO epoch_rotation_candidates(id,parent,parent_count,epoch,commitment,record,envelopes,blob,outcome,binding,consumed) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
                ).run(
                  row.id,
                  row.parent,
                  row.parentCount,
                  row.epoch,
                  row.commitment,
                  row.record,
                  row.envelopes,
                  row.blob,
                  row.outcome,
                  row.binding,
                  row.consumed ? 1 : 0
                );
                const stored = select('id=?', row.id);
                if (!stored || !same(stored, row)) throw fail('corrupt');
                bound();
              })
              .immediate()
          ),
        replace: (expected, next) =>
          sql(() =>
            db
              .transaction(() => {
                const stored = select('id=?', expected.id);
                if (!stored || !same(stored, expected)) throw fail('conflict');
                if (
                  !same(
                    { ...next, outcome: null, binding: null, blob: expected.blob, consumed: false },
                    { ...expected, outcome: null, binding: null, consumed: false }
                  )
                )
                  throw fail('corrupt');
                db.prepare(
                  'UPDATE epoch_rotation_candidates SET outcome=?,binding=?,blob=?,consumed=? WHERE id=?'
                ).run(next.outcome, next.binding, next.blob, next.consumed ? 1 : 0, expected.id);
                const after = select('id=?', expected.id);
                if (!after || !same(after, next)) throw fail('corrupt');
                bound();
              })
              .immediate()
          ),
      });
    })
  );

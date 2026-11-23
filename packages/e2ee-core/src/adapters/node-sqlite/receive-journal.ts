import { Effect, Layer } from 'effect';
import { bytesEqual } from '../../internal/foundation/cbor';
import { keyId } from '../../internal/foundation/identifiers';
import { LocalStoreError } from '../../services/errors';
import { ReceiveJournal, type ReceiveTaskPhase, type ReceiveTaskRow } from '../../services/stores';
import { DeviceIdentity, WorkspaceScope } from '../../services/workspace';
import { openSqliteStore, type SqliteFileOptions } from './store';

const APPLICATION_ID = 0x4c455231;
const fail = (reason: LocalStoreError['reason']) =>
  new LocalStoreError({ store: 'ReceiveJournal', reason });
const PHASES: readonly ReceiveTaskPhase[] = [
  'Install',
  'Report',
  'Reported',
  'Obsolete',
  'Revoked',
];
const SELECT =
  'SELECT id,CASE WHEN length(body)<=256 THEN body ELSE NULL END AS body,CASE WHEN length(frame)<=512 THEN frame ELSE NULL END AS frame,CASE WHEN length(publication)<=8192 THEN publication ELSE NULL END AS publication,CASE WHEN length(report)<=512 THEN report ELSE NULL END AS report,phase FROM receive_tasks';
const blob = (value: unknown) => (value instanceof Uint8Array ? new Uint8Array(value) : null);

/**
 * {@link ReceiveJournal} in a dedicated SQLite file bound to one workspace and
 * recipient device.
 *
 * @category Node SQLite adapters
 */
export const sqliteReceiveJournal = (options: SqliteFileOptions) =>
  Layer.effect(
    ReceiveJournal,
    Effect.gen(function* () {
      const genesis = keyId((yield* WorkspaceScope).genesis.toBytes());
      const recipient = keyId((yield* DeviceIdentity).signer.publicKey.toBytes());
      const db = yield* openSqliteStore({
        ...options,
        applicationId: APPLICATION_ID,
        version: 3,
        error: fail,
        initialize(connection) {
          connection.exec(`CREATE TABLE receive_meta(id INTEGER PRIMARY KEY CHECK(id=1),genesis TEXT NOT NULL,recipient TEXT NOT NULL);
            CREATE TABLE receive_tasks(id TEXT PRIMARY KEY,body BLOB NOT NULL CHECK(length(body) BETWEEN 1 AND 256),frame BLOB CHECK(length(frame) BETWEEN 1 AND 512),publication BLOB CHECK(length(publication) BETWEEN 1 AND 8192),report BLOB CHECK(length(report) BETWEEN 1 AND 512),phase TEXT NOT NULL CHECK(phase IN ('Install','Report','Reported','Obsolete','Revoked')),consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)));
            CREATE INDEX receive_pending ON receive_tasks(phase,id);`);
          connection
            .prepare('INSERT INTO receive_meta(id,genesis,recipient) VALUES(1,?,?)')
            .run(genesis, recipient);
        },
        validate(connection) {
          const meta = connection
            .prepare('SELECT genesis,recipient FROM receive_meta WHERE id=1')
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
      const row = (raw: Record<string, unknown>): ReceiveTaskRow => {
        const body = blob(raw.body);
        if (typeof raw.id !== 'string' || !body || !PHASES.includes(raw.phase as ReceiveTaskPhase))
          throw fail('corrupt');
        return {
          id: raw.id,
          body,
          frame: blob(raw.frame),
          publication: blob(raw.publication),
          report: blob(raw.report),
          phase: raw.phase as ReceiveTaskPhase,
        };
      };
      const load = (id: string) => {
        const raw = db.prepare(`${SELECT} WHERE id=?`).get(id) as
          | Record<string, unknown>
          | undefined;
        return raw ? row(raw) : null;
      };
      const sameBytes = (a: Uint8Array | null, b: Uint8Array | null) =>
        a === null ? b === null : b !== null && bytesEqual(a, b);
      /** The file must still be bound to this workspace and device when a write commits. */
      const bound = () => {
        const meta = db.prepare('SELECT genesis,recipient FROM receive_meta WHERE id=1').get() as
          | Record<string, unknown>
          | undefined;
        if (meta?.genesis !== genesis || meta?.recipient !== recipient) throw fail('corrupt');
      };
      /** Read back a write inside its transaction; any difference rolls it back. */
      const verify = (expected: ReceiveTaskRow, consumed: 0 | 1) => {
        const after = load(expected.id);
        const flag = db
          .prepare('SELECT consumed FROM receive_tasks WHERE id=?')
          .get(expected.id) as { consumed?: unknown } | undefined;
        if (
          !after ||
          after.phase !== expected.phase ||
          !bytesEqual(after.body, expected.body) ||
          !sameBytes(after.frame, expected.frame) ||
          !sameBytes(after.publication, expected.publication) ||
          !sameBytes(after.report, expected.report) ||
          flag?.consumed !== consumed
        )
          throw fail('corrupt');
        bound();
      };
      /** Apply `write` to the task `id` in `from` phases, verifying the result `to`. */
      const transition = (
        id: string,
        from: readonly ReceiveTaskRow['phase'][],
        write: () => number,
        to: (before: ReceiveTaskRow) => ReceiveTaskRow,
        missing: 'conflict' | 'ignore'
      ) =>
        sql(() =>
          db
            .transaction(() => {
              const before = load(id);
              if (!before || !from.includes(before.phase)) {
                if (missing === 'conflict') throw fail('conflict');
                return;
              }
              if (write() !== 1) throw fail('corrupt');
              verify(to(before), 0);
            })
            .immediate()
        );
      return ReceiveJournal.of({
        insertIfAbsent: (task) =>
          sql(() => {
            db.prepare(
              "INSERT INTO receive_tasks(id,body,frame,publication,phase) VALUES(?,?,?,?,'Install') ON CONFLICT(id) DO NOTHING"
            ).run(task.id, task.body, task.frame, task.publication);
          }),
        load: (id) => sql(() => load(id)),
        queueReport: (id, report) =>
          transition(
            id,
            ['Install'],
            () =>
              db
                .prepare(
                  "UPDATE receive_tasks SET report=?,phase='Report' WHERE id=? AND phase='Install' AND report IS NULL"
                )
                .run(report, id).changes,
            (before) => {
              if (before.report !== null) throw fail('conflict');
              return { ...before, report, phase: 'Report' };
            },
            'conflict'
          ),
        markReported: (id) =>
          transition(
            id,
            ['Report'],
            () =>
              db
                .prepare(
                  "UPDATE receive_tasks SET phase='Reported',consumed=0 WHERE id=? AND phase='Report'"
                )
                .run(id).changes,
            (before) => ({ ...before, phase: 'Reported' }),
            'ignore'
          ),
        end: (id, phase) =>
          transition(
            id,
            ['Install', 'Report'],
            () =>
              db
                .prepare(
                  "UPDATE receive_tasks SET phase=?,consumed=0 WHERE id=? AND phase IN ('Install','Report')"
                )
                .run(phase, id).changes,
            (before) => ({ ...before, phase }),
            'ignore'
          ),
        pending: (phase, cursor, limit) =>
          sql(() => {
            const ids = db
              .prepare('SELECT id FROM receive_tasks WHERE phase=? AND id>? ORDER BY id LIMIT ?')
              .all(phase, cursor ?? '', limit + 1) as { id: string }[];
            return {
              ids: ids.slice(0, limit).map((item) => item.id),
              next: ids.length > limit ? ids[limit - 1]!.id : null,
            };
          }),
        results: (limit) =>
          sql(() =>
            (
              db
                .prepare(
                  `${SELECT} WHERE phase IN ('Reported','Obsolete','Revoked') AND consumed=0 ORDER BY id LIMIT ?`
                )
                .all(limit) as Record<string, unknown>[]
            ).map(row)
          ),
        acknowledge: (id) =>
          sql(() => {
            db.prepare(
              "UPDATE receive_tasks SET consumed=1 WHERE id=? AND phase IN ('Reported','Obsolete','Revoked')"
            ).run(id);
          }),
      });
    })
  );

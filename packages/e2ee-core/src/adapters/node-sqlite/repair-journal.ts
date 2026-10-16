import { Effect, Layer } from 'effect';
import { keyId } from '../../internal/foundation/identifiers';
import { LocalStoreError } from '../../services/errors';
import { RepairJournal, type RepairTaskPhase, type RepairTaskRow } from '../../services/stores';
import { DeviceIdentity, WorkspaceScope } from '../../services/workspace';
import { openSqliteStore, type SqliteFileOptions } from './store';

const APPLICATION_ID = 0x4c455232;
const fail = (reason: LocalStoreError['reason']) =>
  new LocalStoreError({ store: 'RepairJournal', reason });
const PHASES: readonly RepairTaskPhase[] = ['Pending', 'Repaired', 'Obsolete', 'Revoked'];
const SELECT =
  "SELECT CASE WHEN length(id) BETWEEN 1 AND 256 THEN id ELSE NULL END AS id,epoch,CASE WHEN rejected IS NULL OR length(rejected)=64 THEN rejected ELSE '' END AS rejected,phase FROM repair_tasks";

/**
 * {@link RepairJournal} in a dedicated SQLite file bound to one workspace and
 * recipient device.
 *
 * @category Node SQLite adapters
 */
export const sqliteRepairJournal = (options: SqliteFileOptions) =>
  Layer.effect(
    RepairJournal,
    Effect.gen(function* () {
      const genesis = keyId((yield* WorkspaceScope).genesis.toBytes());
      const recipient = keyId((yield* DeviceIdentity).signer.publicKey.toBytes());
      const db = yield* openSqliteStore({
        ...options,
        applicationId: APPLICATION_ID,
        version: 2,
        error: fail,
        initialize(connection) {
          connection.exec(`CREATE TABLE repair_meta(id INTEGER PRIMARY KEY CHECK(id=1),genesis TEXT NOT NULL,recipient TEXT NOT NULL);
            CREATE TABLE repair_tasks(id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256),epoch INTEGER NOT NULL CHECK(epoch BETWEEN 0 AND 4294967295),rejected TEXT CHECK(rejected IS NULL OR length(rejected)=64),phase TEXT NOT NULL CHECK(phase IN ('Pending','Repaired','Obsolete','Revoked')),consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)));
            CREATE INDEX pending_repair ON repair_tasks(phase,id);`);
          connection
            .prepare('INSERT INTO repair_meta(id,genesis,recipient) VALUES(1,?,?)')
            .run(genesis, recipient);
        },
        validate(connection) {
          const meta = connection
            .prepare('SELECT genesis,recipient FROM repair_meta WHERE id=1')
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
      const row = (raw: Record<string, unknown>): RepairTaskRow => {
        if (
          typeof raw.id !== 'string' ||
          typeof raw.epoch !== 'number' ||
          !(raw.rejected === null || typeof raw.rejected === 'string') ||
          !PHASES.includes(raw.phase as RepairTaskPhase)
        )
          throw fail('corrupt');
        return {
          id: raw.id,
          epoch: raw.epoch,
          rejected: raw.rejected,
          phase: raw.phase as RepairTaskPhase,
        };
      };
      const page = (where: string, cursor: string | null, limit: number) => {
        const rows = (
          db
            .prepare(`${SELECT} WHERE ${where} AND (? IS NULL OR id>?) ORDER BY id LIMIT ?`)
            .all(cursor, cursor, limit + 1) as Record<string, unknown>[]
        ).map(row);
        return {
          tasks: rows.slice(0, limit),
          next: rows.length > limit ? rows[limit - 1]!.id : null,
        };
      };
      const load = (id: string) => {
        const raw = db.prepare(`${SELECT} WHERE id=?`).get(id) as
          | Record<string, unknown>
          | undefined;
        return raw ? row(raw) : null;
      };
      /** The file must still be bound to this workspace and device when a write commits. */
      const bound = () => {
        const meta = db.prepare('SELECT genesis,recipient FROM repair_meta WHERE id=1').get() as
          | Record<string, unknown>
          | undefined;
        if (meta?.genesis !== genesis || meta?.recipient !== recipient) throw fail('corrupt');
      };
      /** Read back a write inside its transaction; any difference rolls it back. */
      const verify = (id: string, expected: RepairTaskRow, consumed: 0 | 1) => {
        const after = load(id);
        const flag = db.prepare('SELECT consumed FROM repair_tasks WHERE id=?').get(id) as
          | { consumed?: unknown }
          | undefined;
        if (
          !after ||
          after.id !== expected.id ||
          after.epoch !== expected.epoch ||
          after.rejected !== expected.rejected ||
          after.phase !== expected.phase ||
          flag?.consumed !== consumed
        )
          throw fail('corrupt');
        bound();
      };
      return RepairJournal.of({
        insertIfAbsent: (task) =>
          sql(() => {
            db.prepare(
              "INSERT INTO repair_tasks(id,epoch,rejected,phase) VALUES(?,?,?,'Pending') ON CONFLICT(id) DO NOTHING"
            ).run(task.id, task.epoch, task.rejected);
          }),
        load: (id) => sql(() => load(id)),
        finish: (id, phase) =>
          sql(() =>
            db
              .transaction(() => {
                const before = load(id);
                if (!before || before.phase !== 'Pending') throw fail('conflict');
                if (
                  db
                    .prepare(
                      "UPDATE repair_tasks SET phase=?,consumed=0 WHERE id=? AND phase='Pending'"
                    )
                    .run(phase, id).changes !== 1
                )
                  throw fail('corrupt');
                verify(id, { ...before, phase }, 0);
              })
              .immediate()
          ),
        pending: (cursor, limit) => sql(() => page("phase='Pending'", cursor, limit)),
        results: (cursor, limit) =>
          sql(() => page("phase<>'Pending' AND consumed=0", cursor, limit)),
        acknowledge: (id) =>
          sql(() =>
            db
              .transaction(() => {
                const before = load(id);
                if (!before || before.phase === 'Pending') return;
                db.prepare(
                  "UPDATE repair_tasks SET consumed=1 WHERE id=? AND phase<>'Pending'"
                ).run(id);
                verify(id, before, 1);
              })
              .immediate()
          ),
      });
    })
  );

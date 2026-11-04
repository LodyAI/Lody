import { Effect, Layer } from 'effect';
import { keyId } from '../../internal/foundation/identifiers';
import { LocalStoreError } from '../../services/errors';
import {
  DistributionJournal,
  type DistributionTaskPhase,
  type DistributionTaskRow,
} from '../../services/stores';
import { DeviceIdentity, WorkspaceScope } from '../../services/workspace';
import { openSqliteStore, type SqliteFileOptions } from './store';

const APPLICATION_ID = 0x4c454453;
const fail = (reason: LocalStoreError['reason']) =>
  new LocalStoreError({ store: 'DistributionJournal', reason });
const PHASES: readonly DistributionTaskPhase[] = ['Pending', 'Observed', 'Obsolete', 'Revoked'];
const COLUMNS = 'id,epoch,recipient,revision,phase,consumed';

/** Options of {@link sqliteDistributionJournal}. */
export interface SqliteDistributionJournalOptions extends SqliteFileOptions {
  /** Most unacknowledged tasks kept before `insertIfAbsent` fails with `capacity` (default 10000). */
  readonly maxTasks?: number;
}

/**
 * {@link DistributionJournal} in a dedicated SQLite file bound to one workspace
 * and sender device.
 *
 * @category Node SQLite adapters
 */
export const sqliteDistributionJournal = (options: SqliteDistributionJournalOptions) =>
  Layer.effect(
    DistributionJournal,
    Effect.gen(function* () {
      const maxTasks = options.maxTasks ?? 10000;
      if (!Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > 100000)
        return yield* fail('storage');
      const genesis = keyId((yield* WorkspaceScope).genesis.toBytes());
      const sender = keyId((yield* DeviceIdentity).signer.publicKey.toBytes());
      const db = yield* openSqliteStore({
        path: options.path,
        mode: options.mode,
        applicationId: APPLICATION_ID,
        version: 1,
        error: fail,
        initialize(connection) {
          connection.exec(`CREATE TABLE distribution_meta(id INTEGER PRIMARY KEY CHECK(id=1),genesis TEXT NOT NULL,sender TEXT NOT NULL);
            CREATE TABLE distribution_tasks(id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,recipient TEXT NOT NULL,revision INTEGER NOT NULL,phase TEXT NOT NULL,consumed INTEGER NOT NULL,UNIQUE(epoch,recipient,revision));
            CREATE INDEX distribution_pending ON distribution_tasks(phase,id);
            CREATE INDEX distribution_results ON distribution_tasks(consumed,phase,id);`);
          connection.prepare('INSERT INTO distribution_meta VALUES(1,?,?)').run(genesis, sender);
        },
        validate(connection) {
          const meta = connection
            .prepare('SELECT genesis,sender FROM distribution_meta WHERE id=1')
            .get() as { genesis?: unknown; sender?: unknown } | undefined;
          if (meta?.genesis !== genesis || meta?.sender !== sender) throw fail('corrupt');
        },
      });
      const sql = <A>(work: () => A) =>
        Effect.try({
          try: work,
          catch: (error) =>
            error instanceof LocalStoreError ? error : fail(db.open ? 'storage' : 'closed'),
        });
      const row = (raw: unknown): DistributionTaskRow => {
        const value = raw as Record<string, unknown> | undefined;
        if (
          !value ||
          typeof value.id !== 'string' ||
          typeof value.epoch !== 'number' ||
          typeof value.recipient !== 'string' ||
          typeof value.revision !== 'number' ||
          !PHASES.includes(value.phase as DistributionTaskPhase) ||
          (value.consumed !== 0 && value.consumed !== 1)
        )
          throw fail('corrupt');
        return {
          id: value.id,
          epoch: value.epoch,
          recipient: value.recipient,
          revision: value.revision,
          phase: value.phase as DistributionTaskPhase,
          consumed: value.consumed === 1,
        };
      };
      const load = (id: string) => {
        const raw = db.prepare(`SELECT ${COLUMNS} FROM distribution_tasks WHERE id=?`).get(id);
        return raw === undefined ? null : row(raw);
      };
      const same = (a: DistributionTaskRow, b: DistributionTaskRow) =>
        a.id === b.id &&
        a.epoch === b.epoch &&
        a.recipient === b.recipient &&
        a.revision === b.revision &&
        a.phase === b.phase &&
        a.consumed === b.consumed;
      /** The file must still be bound to this workspace and device when a write commits. */
      const bound = () => {
        const meta = db.prepare('SELECT genesis,sender FROM distribution_meta WHERE id=1').get() as
          | Record<string, unknown>
          | undefined;
        if (meta?.genesis !== genesis || meta?.sender !== sender) throw fail('corrupt');
      };
      /** Read back a write inside its transaction; any difference rolls it back. */
      const verify = (expected: DistributionTaskRow) => {
        const after = load(expected.id);
        if (!after || !same(after, expected)) throw fail('corrupt');
        bound();
      };
      return DistributionJournal.of({
        insertIfAbsent: (task) =>
          sql(() =>
            db
              .transaction(() => {
                if (load(task.id)) return false;
                const { count } = db
                  .prepare('SELECT count(*) AS count FROM distribution_tasks WHERE consumed=0')
                  .get() as { count: number };
                if (count >= maxTasks) throw fail('capacity');
                db.prepare("INSERT INTO distribution_tasks VALUES(?,?,?,?,'Pending',0)").run(
                  task.id,
                  task.epoch,
                  task.recipient,
                  task.revision
                );
                verify({ ...task, phase: 'Pending', consumed: false });
                return true;
              })
              .immediate()
          ),
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
                      "UPDATE distribution_tasks SET phase=?,consumed=0 WHERE id=? AND phase='Pending'"
                    )
                    .run(phase, id).changes !== 1
                )
                  throw fail('corrupt');
                verify({ ...before, phase, consumed: false });
              })
              .immediate()
          ),
        pending: (cursor, limit) =>
          sql(() => {
            const ids = db
              .prepare(
                "SELECT id FROM distribution_tasks WHERE phase='Pending' AND id>? ORDER BY id LIMIT ?"
              )
              .all(cursor ?? '', limit + 1) as { id: string }[];
            return {
              ids: ids.slice(0, limit).map((item) => item.id),
              next: ids.length > limit ? ids[limit - 1]!.id : null,
            };
          }),
        results: (cursor, limit) =>
          sql(() => {
            const tasks = db
              .prepare(
                `SELECT ${COLUMNS} FROM distribution_tasks WHERE consumed=0 AND phase!='Pending' AND id>? ORDER BY id LIMIT ?`
              )
              .all(cursor ?? '', limit + 1)
              .map(row);
            return {
              tasks: tasks.slice(0, limit),
              next: tasks.length > limit ? tasks[limit - 1]!.id : null,
            };
          }),
        acknowledge: (id) =>
          sql(() =>
            db
              .transaction(() => {
                const before = load(id);
                if (!before || before.phase === 'Pending') throw fail('conflict');
                if (
                  db
                    .prepare(
                      "UPDATE distribution_tasks SET consumed=1 WHERE id=? AND phase!='Pending'"
                    )
                    .run(id).changes !== 1
                )
                  throw fail('corrupt');
                verify({ ...before, consumed: true });
              })
              .immediate()
          ),
      });
    })
  );

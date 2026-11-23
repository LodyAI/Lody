import Database from 'better-sqlite3';
import { closeSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Effect, Result } from 'effect';
import * as Bytes from '../../internal/foundation/bytes';
import { keyId } from '../../internal/foundation/identifiers';
import {
  hasVerifiedCheckpoint,
  requireLedgerContinuation,
  type LedgerView,
} from '../../internal/ledger';

/** Location and creation mode of one dedicated SQLite file. `path` must be absolute.
 * `create` refuses an existing file, `open` refuses a missing one. */
export interface SqliteFileOptions {
  readonly path: string;
  readonly mode: 'create' | 'open' | 'create-or-open';
}

/** Borrowed/foreign SQLite observers use the same connection constructor without claiming a store format. */
export const openSqliteConnection = (path: string, options?: Database.Options) =>
  new Database(path, options);

/** SQLite's definite file-corruption codes; busy/locked/permission errors remain retryable I/O. */
export const isSqliteCorruption = (error: unknown) =>
  error instanceof Error &&
  'code' in error &&
  typeof error.code === 'string' &&
  (/^(?:SQLITE_CORRUPT(?:_.*)?|SQLITE_NOTADB)$/.test(error.code) ||
    (error.code === 'ERR_SQLITE_ERROR' &&
      'errcode' in error &&
      typeof error.errcode === 'number' &&
      [11, 26].includes(error.errcode & 0xff)));

class SqliteSetupFailure<E> {
  constructor(readonly error: E) {}
}
/** Own a dedicated current-format file. Validation runs before changing a foreign file. */
export const openSqliteStore = <E>(input: {
  readonly path: string;
  readonly mode: 'create' | 'open' | 'create-or-open';
  readonly applicationId: number;
  readonly version: number;
  readonly initialize: (db: Database.Database) => void;
  readonly validate?: (db: Database.Database) => void;
  readonly error: (code: 'storage' | 'corrupt') => E;
  readonly timeout?: number;
}) =>
  Effect.gen(function* () {
    const sql = <A>(work: () => A) =>
      Effect.try({
        try: work,
        catch: (error) =>
          error instanceof SqliteSetupFailure
            ? (error.error as E)
            : input.error(isSqliteCorruption(error) ? 'corrupt' : 'storage'),
      });
    if (
      typeof input.path !== 'string' ||
      !isAbsolute(input.path) ||
      !['create', 'open', 'create-or-open'].includes(input.mode)
    )
      return yield* Effect.fail(input.error('storage'));
    if (input.mode !== 'open')
      yield* sql(() => {
        try {
          closeSync(openSync(input.path, 'wx', 0o600));
        } catch (error) {
          if (
            input.mode !== 'create-or-open' ||
            !(error instanceof Error) ||
            !('code' in error) ||
            error.code !== 'EEXIST'
          )
            throw error;
        }
      });
    const db = yield* Effect.acquireRelease(
      sql(() =>
        openSqliteConnection(input.path, { fileMustExist: true, timeout: input.timeout ?? 1000 })
      ),
      (handle) => sql(() => handle.close()).pipe(Effect.orDie)
    );
    yield* sql(() => {
      const format = () => {
        const app = db.pragma('application_id', { simple: true }),
          version = db.pragma('user_version', { simple: true });
        if (app === input.applicationId && version === input.version) return 'current';
        if (app === 0 && version === 0 && !db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get())
          return 'empty';
        return 'foreign';
      };
      const corrupt = () => {
        throw new SqliteSetupFailure(input.error('corrupt'));
      };
      const checked = (work: () => void) => {
        try {
          work();
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            typeof error.code === 'string' &&
            error.code.startsWith('SQLITE_')
          )
            throw error;
          throw new SqliteSetupFailure(error as E);
        }
      };
      const validate = () => checked(() => input.validate?.(db));
      const initial = format();
      if (
        initial === 'foreign' ||
        (initial === 'empty' && input.mode === 'open') ||
        (initial === 'current' && input.mode === 'create')
      )
        corrupt();
      if (initial === 'current') validate();
      db.pragma('journal_mode=WAL');
      db.pragma('synchronous=FULL');
      if (initial === 'empty')
        db.transaction(() => {
          // Another create-or-open owner may have finished initialization while we waited.
          const locked = format();
          if (locked === 'current' && input.mode === 'create-or-open') {
            validate();
            return;
          }
          if (locked !== 'empty') corrupt();
          checked(() => input.initialize(db));
          db.pragma(`application_id=${input.applicationId}`);
          db.pragma(`user_version=${input.version}`);
          validate();
        }).immediate();
    });
    return db;
  });

/** A verified public-history pin, never a permission certificate or transport cursor. */
export function makeSqliteLedgerPin<E>(input: {
  readonly db: Database.Database;
  readonly table: string;
  readonly genesis: string;
  readonly bindings?: Readonly<Record<string, string>>;
  readonly error: (code: 'corrupt' | 'rollback') => E;
}) {
  if (
    !/^[a-z_][a-z0-9_]*$/.test(input.table) ||
    Object.keys(input.bindings ?? {}).some((column) => !/^[a-z_][a-z0-9_]*$/.test(column))
  )
    throw input.error('corrupt');
  const bindings = { genesis: input.genesis, ...input.bindings };
  const select = input.db.prepare(
    `SELECT ${Object.keys(bindings).join(',')},head,count FROM ${input.table} WHERE id=1`
  );
  const update = input.db.prepare(`UPDATE ${input.table} SET head=?,count=? WHERE id=1`);
  let observed: LedgerView | undefined;
  return (view: LedgerView) => {
    const genuine = requireLedgerContinuation(view, view);
    if (Result.isFailure(genuine)) throw input.error('rollback');
    if (keyId(view.genesis.toBytes()) !== input.genesis) throw input.error('rollback');
    if (observed) {
      const continuation = requireLedgerContinuation(observed, view);
      if (Result.isFailure(continuation)) throw input.error('rollback');
    }
    // Keep genuine knowledge even if the following transaction cannot persist it.
    observed = view;
    const unchanged = (row: Record<string, unknown> | undefined) => {
      const pin = row;
      if (!pin || Object.entries(bindings).some(([column, expected]) => pin[column] !== expected))
        throw input.error('corrupt');
      if (pin.head !== null) {
        if (
          !(pin.head instanceof Uint8Array) ||
          pin.head.length !== 32 ||
          typeof pin.count !== 'number' ||
          !Number.isSafeInteger(pin.count) ||
          pin.count < 1
        )
          throw input.error('corrupt');
        const accepted = hasVerifiedCheckpoint(view, {
          head: Result.getOrThrow(Bytes.recordHash(pin.head)),
          length: pin.count,
        });
        if (Result.isFailure(accepted) || !accepted.success) throw input.error('rollback');
        if (
          pin.count === view.length &&
          view.head.equals(Result.getOrThrow(Bytes.recordHash(pin.head)))
        )
          return true;
      } else if (pin.count !== null) throw input.error('corrupt');
      return false;
    };
    if (unchanged(select.get() as Record<string, unknown> | undefined)) return;
    input.db
      .transaction(() => {
        if (unchanged(select.get() as Record<string, unknown> | undefined)) return;
        if (update.run(view.head.toBytes(), view.length).changes !== 1)
          throw input.error('corrupt');
        const saved = select.get() as Record<string, unknown> | undefined;
        if (
          !saved ||
          Object.entries(bindings).some(([column, expected]) => saved[column] !== expected) ||
          !(saved.head instanceof Uint8Array) ||
          saved.count !== view.length ||
          !view.head.equals(Result.getOrThrow(Bytes.recordHash(saved.head)))
        )
          throw input.error('corrupt');
      })
      .immediate();
  };
}

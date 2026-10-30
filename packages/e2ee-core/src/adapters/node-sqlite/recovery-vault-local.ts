import { Effect } from 'effect';
import { bytesEqual } from '../../internal/foundation/cbor';
import { LocalStoreError } from '../../services/errors';
import type { RecoveryVaultLocalStore } from '../../services/recovery';
import { isSqliteCorruption, openSqliteStore, type SqliteFileOptions } from './store';

const APPLICATION_ID = 0x4c52564c;
const MAX_KEY = 4096,
  MAX_VALUE = 256 * 1024,
  MAX_ROWS = 4096;
const fail = (reason: LocalStoreError['reason']) =>
  new LocalStoreError({ store: 'RecoveryVaultLocalStore', reason });

/**
 * {@link RecoveryVaultLocalStore} in a dedicated SQLite file, one per account.
 * It holds only what the vault workflows journal (index pins, encrypted intents,
 * original signed records and non-secret progress), never V, U or private keys.
 * `compareAndSwap` compares, writes and reads back inside one immediate
 * transaction. A missing or corrupt row is reported, never reset to absence.
 * The connection closes with the caller's Scope.
 *
 * @category Node SQLite adapters
 */
export const sqliteRecoveryVaultLocalStore = Effect.fnUntraced(function* (
  options: SqliteFileOptions
) {
  const db = yield* openSqliteStore({
    ...options,
    applicationId: APPLICATION_ID,
    version: 1,
    error: fail,
    initialize: (connection) =>
      connection.exec(
        'CREATE TABLE vault_local(key TEXT PRIMARY KEY NOT NULL,body BLOB NOT NULL) STRICT'
      ),
  });
  const sql = <A>(work: () => A) =>
    Effect.try({
      try: work,
      catch: (error) =>
        error instanceof LocalStoreError
          ? error
          : fail(isSqliteCorruption(error) ? 'corrupt' : db.open ? 'storage' : 'closed'),
    });
  const validKey = (key: unknown): key is string =>
    typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY;
  const select = db.prepare('SELECT body FROM vault_local WHERE key=?');
  const read = (key: string) => {
    if (!validKey(key)) throw fail('storage');
    const row = select.get(key) as { body: unknown } | undefined;
    if (row === undefined) return null;
    if (!(row.body instanceof Uint8Array) || row.body.length < 1 || row.body.length > MAX_VALUE)
      throw fail('corrupt');
    return new Uint8Array(row.body);
  };
  return Object.freeze({
    read: (key) => sql(() => db.transaction(() => read(key)).deferred()),
    list: (prefix) =>
      sql(() =>
        db
          .transaction(() => {
            if (!validKey(prefix)) throw fail('storage');
            const keys = db
              .prepare('SELECT key FROM vault_local WHERE substr(key,1,?)=? ORDER BY key LIMIT ?')
              .all(prefix.length, prefix, MAX_ROWS + 1) as { key: unknown }[];
            if (keys.length > MAX_ROWS) throw fail('capacity');
            return keys.map((row) => {
              if (!validKey(row.key)) throw fail('corrupt');
              return { key: row.key, value: read(row.key)! };
            });
          })
          .deferred()
      ),
    compareAndSwap: (key, expected, nextInput) =>
      sql(() => {
        if (
          !(nextInput instanceof Uint8Array) ||
          nextInput.length < 1 ||
          nextInput.length > MAX_VALUE ||
          (expected !== null && !(expected instanceof Uint8Array))
        )
          throw fail('storage');
        const next = new Uint8Array(nextInput),
          compare = expected === null ? null : new Uint8Array(expected);
        return db
          .transaction(() => {
            const before = read(key);
            if (before === null ? compare !== null : !compare || !bytesEqual(before, compare))
              return 'Conflict' as const;
            const changed = before
              ? db.prepare('UPDATE vault_local SET body=? WHERE key=?').run(next, key).changes
              : db.prepare('INSERT INTO vault_local(key,body) VALUES(?,?)').run(key, next).changes;
            const saved = read(key);
            if (changed !== 1 || !saved || !bytesEqual(saved, next)) throw fail('storage');
            return 'Committed' as const;
          })
          .immediate();
      }),
  } satisfies RecoveryVaultLocalStore['Service']);
});

import { openSqliteStore } from '@lody/e2ee-core/internal';
import { isAbsolute } from 'node:path';
import { Data, Effect, Result, Schema } from 'effect';
import {
  type RecoveryVaultStore,
  type RecoveryVaultLocalStore,
  type VaultCiphertext,
} from '@lody/e2ee-core/services';
import {
  ownVaultCiphertext,
  sameVaultCiphertext,
  vaultCiphertextDigest,
} from '@lody/e2ee-core/protocol';
export class LabRecoveryVaultError extends Data.TaggedError('LabRecoveryVaultError')<{
  readonly code: 'storage' | 'corrupt' | 'conflict' | 'closed' | 'invalid-input';
}> {}
const error = (code: LabRecoveryVaultError['code']) => new LabRecoveryVaultError({ code });
const Row = Schema.Struct({
  entryId: Schema.String,
  revision: Schema.Number,
  body: Schema.Uint8Array,
});
const LocalRow = Schema.Struct({ body: Schema.Uint8Array });
const equalBytes = (a: Uint8Array | null, b: Uint8Array | null) =>
  a === null || b === null ? a === b : a.length === b.length && a.every((v, i) => v === b[i]);
const app = 0x4c56544c;
/** One synthetic logged-in user's isolated store. No U/V/private keys reach SQL.
 * Ciphertext originals and all CAS header fields are read back in the same native
 * transaction. A failed comparison/trigger preserves the prior index and entries. */
export const makeLabRecoveryVaultStore = Effect.fnUntraced(function* (input: {
  readonly path: string;
  readonly mode: 'create' | 'open';
}) {
  if (!isAbsolute(input.path) || (input.mode !== 'create' && input.mode !== 'open'))
    return yield* error('invalid-input');
  const sql = <A>(work: () => A) =>
    Effect.try({
      try: work,
      catch: (cause) => (cause instanceof LabRecoveryVaultError ? cause : error('storage')),
    });
  const db = yield* openSqliteStore({
    path: input.path,
    mode: input.mode,
    applicationId: app,
    version: 1,
    error,
    initialize: (connection) =>
      connection.exec(
        `CREATE TABLE vault_entries(vault TEXT NOT NULL,entryId TEXT NOT NULL,revision INTEGER NOT NULL,body BLOB NOT NULL,PRIMARY KEY(vault,entryId)) STRICT;CREATE TABLE vault_index(vault TEXT PRIMARY KEY,entryId TEXT NOT NULL,revision INTEGER NOT NULL,body BLOB NOT NULL) STRICT;CREATE TABLE vault_local(key TEXT PRIMARY KEY,body BLOB NOT NULL) STRICT;`
      ),
  });
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    })
  );
  const guard = () => {
    if (closed) throw error('closed');
  };
  const parse = (raw: unknown): VaultCiphertext | null => {
    if (raw === undefined || raw === null) return null;
    const decoded = Schema.decodeUnknownResult(Row)(raw);
    if (Result.isFailure(decoded)) throw error('corrupt');
    try {
      return ownVaultCiphertext(decoded.success);
    } catch {
      throw error('corrupt');
    }
  };
  const validId = (value: string) => {
    if (!/^[0-9a-f]{64}$/.test(value)) throw error('invalid-input');
  };
  const entry = (vault: string, id: string) => {
    guard();
    validId(vault);
    validId(id);
    return parse(
      db
        .prepare(
          'SELECT entryId,revision,CASE WHEN length(body)<=262144 THEN body END AS body FROM vault_entries WHERE vault=? AND entryId=?'
        )
        .get(vault, id)
    );
  };
  const index = (vault: string) => {
    guard();
    validId(vault);
    return parse(
      db
        .prepare(
          'SELECT entryId,revision,CASE WHEN length(body)<=262144 THEN body END AS body FROM vault_index WHERE vault=?'
        )
        .get(vault)
    );
  };
  const entriesBefore = (vault: string) =>
    db
      .prepare(
        'SELECT entryId,revision,body FROM vault_entries WHERE vault=? ORDER BY entryId LIMIT 4097'
      )
      .all(vault)
      .map((row) => parse(row)!);
  const assertEntries = (vault: string, before: readonly VaultCiphertext[]) => {
    const after = entriesBefore(vault);
    if (
      before.length !== after.length ||
      before.some((row, i) => !sameVaultCiphertext(row, after[i]))
    )
      throw error('storage');
  };
  const readLocal = (key: string) => {
    guard();
    if (!key || key.length > 4096) throw error('invalid-input');
    const raw = db
      .prepare(
        'SELECT CASE WHEN length(body)<=262144 THEN body END AS body FROM vault_local WHERE key=?'
      )
      .get(key);
    if (raw === undefined || raw === null) return null;
    const decoded = Schema.decodeUnknownResult(LocalRow)(raw);
    if (Result.isFailure(decoded)) throw error('corrupt');
    return new Uint8Array(decoded.success.body);
  };
  const store: RecoveryVaultStore['Service'] = {
    putImmutable: (vault, source) =>
      sql(() => {
        const value = ownVaultCiphertext(source);
        db.transaction(() => {
          const before = entry(vault, value.entryId),
            beforeIndex = index(vault);
          if (before) {
            if (!sameVaultCiphertext(before, value)) throw error('conflict');
            return;
          }
          const allBefore = entriesBefore(vault);
          if (allBefore.length >= 4096) throw error('storage');
          const changed = db
            .prepare('INSERT INTO vault_entries VALUES(?,?,?,?)')
            .run(vault, value.entryId, value.revision, value.body).changes;
          const read = entry(vault, value.entryId),
            afterIndex = index(vault);
          if (
            changed !== 1 ||
            !read ||
            !sameVaultCiphertext(read, value) ||
            (beforeIndex === null
              ? afterIndex !== null
              : afterIndex === null || !sameVaultCiphertext(beforeIndex, afterIndex))
          )
            throw error('storage');
          const allAfter = entriesBefore(vault).filter((row) => row.entryId !== value.entryId);
          if (
            allBefore.length !== allAfter.length ||
            allBefore.some((row, i) => !sameVaultCiphertext(row, allAfter[i]))
          )
            throw error('storage');
        }).immediate();
      }),
    readEntry: (vault, id) => sql(() => db.transaction(() => entry(vault, id)).deferred()),
    readIndex: (vault) => sql(() => db.transaction(() => index(vault)).deferred()),
    compareAndSwapIndex: (vault, expected, source, referencedEntryIds) =>
      sql(() =>
        db
          .transaction(() => {
            const next = ownVaultCiphertext(source),
              before = index(vault),
              allBefore = entriesBefore(vault);
            if (
              (expected === null) !== (before === null) ||
              (expected &&
                before &&
                (expected.revision !== before.revision ||
                  expected.digest !== vaultCiphertextDigest(before)))
            )
              return 'Conflict' as const;
            if (
              next.revision !== (before?.revision ?? -1) + 1 ||
              (before && next.entryId !== before.entryId)
            )
              throw error('invalid-input');
            if (
              referencedEntryIds.length > 1024 ||
              new Set(referencedEntryIds).size !== referencedEntryIds.length
            )
              throw error('invalid-input');
            for (const id of referencedEntryIds) {
              validId(id);
              if (!entry(vault, id)) return 'Conflict' as const;
            }
            const changed = before
              ? db
                  .prepare('UPDATE vault_index SET entryId=?,revision=?,body=? WHERE vault=?')
                  .run(next.entryId, next.revision, next.body, vault).changes
              : db
                  .prepare('INSERT INTO vault_index VALUES(?,?,?,?)')
                  .run(vault, next.entryId, next.revision, next.body).changes;
            const read = index(vault);
            if (changed !== 1 || !read || !sameVaultCiphertext(next, read)) throw error('storage');
            assertEntries(vault, allBefore);
            return 'Committed' as const;
          })
          .immediate()
      ),
    deleteUnreferenced: (vault, id, expected) =>
      sql(() =>
        db
          .transaction(() => {
            const current = index(vault),
              target = entry(vault, id);
            if (
              !current ||
              current.revision !== expected.revision ||
              vaultCiphertextDigest(current) !== expected.digest ||
              !target ||
              id === vault ||
              id === current.entryId
            )
              throw error('conflict');
            db.prepare('DELETE FROM vault_entries WHERE vault=? AND entryId=?').run(vault, id);
            const after = index(vault);
            if (entry(vault, id) || !after || !sameVaultCiphertext(current, after))
              throw error('storage');
          })
          .immediate()
      ),
  };
  const local: RecoveryVaultLocalStore['Service'] = {
    read: (key) => sql(() => db.transaction(() => readLocal(key)).deferred()),
    list: (prefix) =>
      sql(() =>
        db
          .transaction(() => {
            guard();
            if (!prefix || prefix.length > 4096) throw error('invalid-input');
            const decodedRows = Schema.decodeUnknownResult(
              Schema.Array(Schema.Struct({ key: Schema.String }))
            )(
              db
                .prepare(
                  'SELECT key FROM vault_local WHERE substr(key,1,?)=? ORDER BY key LIMIT 4097'
                )
                .all(prefix.length, prefix)
            );
            if (Result.isFailure(decodedRows)) throw error('corrupt');
            const rows = decodedRows.success;
            if (rows.length > 4096) throw error('storage');
            return rows.map((row) => ({ key: row.key, value: readLocal(row.key)! }));
          })
          .deferred()
      ),
    compareAndSwap: (key, expected, nextInput) =>
      sql(() => {
        if (!(nextInput instanceof Uint8Array) || nextInput.length < 1 || nextInput.length > 262144)
          throw error('invalid-input');
        const next = new Uint8Array(nextInput);
        return db
          .transaction(() => {
            const before = readLocal(key);
            if (!equalBytes(before, expected)) return 'Conflict' as const;
            const changed = before
              ? db.prepare('UPDATE vault_local SET body=? WHERE key=?').run(next, key).changes
              : db.prepare('INSERT INTO vault_local VALUES(?,?)').run(key, next).changes;
            if (changed !== 1 || !equalBytes(next, readLocal(key))) throw error('storage');
            return 'Committed' as const;
          })
          .immediate();
      }),
  };
  return { store: Object.freeze(store), local: Object.freeze(local) };
});

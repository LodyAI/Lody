import { openSqliteConnection } from '@lody/e2ee-core/internal';
import { Data, Effect, Result, Schema } from 'effect';
import { Bytes } from '@lody/e2ee-core';
export const LabStorageMutation = Schema.Struct({
  kind: Schema.Literals(['deny-writes', 'restore-writes', 'delete-rows', 'flip-blob']),
  table: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/)),
  column: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/))),
  stream: Schema.optional(Schema.Literals(['control', 'loro', 'flock'])),
});
export type LabStorageMutation = typeof LabStorageMutation.Type;
export class LabStorageAttackError extends Data.TaggedError('LabStorageAttackError')<{
  readonly code:
    | 'invalid-input'
    | 'unsupported-stream-table'
    | 'unknown-stream'
    | 'unknown-table'
    | 'unknown-column'
    | 'not-a-blob'
    | 'storage';
  readonly cause?: unknown;
}> {}
const fail = (code: LabStorageAttackError['code'], cause?: unknown) =>
  new LabStorageAttackError({ code, ...(cause === undefined ? {} : { cause }) });
const storageError = (cause: unknown) =>
  cause instanceof LabStorageAttackError ? cause : fail('storage', cause);
/** A narrow synthetic backend/local-file attack capability. The harness selects
 * the file and Org; plans can name only existing tables/columns, never SQL or paths.
 * Native stream selectors require the harness's separately bound Org. */
export const applyLabStorageMutation = Effect.fnUntraced(function* (
  path: string,
  input: LabStorageMutation,
  boundGenesis?: Bytes.GenesisHash
) {
  const mutation = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(LabStorageMutation)(input),
    catch: (cause) => fail('invalid-input', cause),
  });
  const org = boundGenesis
    ? Buffer.from(
        (yield* Effect.fromResult(Bytes.genesisHash(boundGenesis.toBytes()))).toBytes()
      ).toString('hex')
    : undefined;
  if (mutation.stream && org === undefined) return yield* fail('invalid-input');
  if (mutation.stream && !['entries', 'snapshots'].includes(mutation.table))
    return yield* fail('unsupported-stream-table');
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => openSqliteConnection(path, { fileMustExist: true }),
      catch: storageError,
    }),
    (db) =>
      Effect.try({
        try: () =>
          db
            .transaction(() => {
              const table = mutation.table;
              if (
                db
                  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                  .get(table) === undefined
              )
                throw fail('unknown-table');
              let streamId: string | undefined;
              if (mutation.stream) {
                const selected = Schema.decodeUnknownResult(
                  Schema.Struct({
                    id: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,18}$/)),
                  })
                )(
                  db
                    .prepare(
                      'SELECT CAST(id AS TEXT) AS id FROM streams WHERE bucket_id=? AND stream_id=?'
                    )
                    .get(org, mutation.stream)
                );
                if (Result.isFailure(selected)) throw fail('unknown-stream');
                streamId = selected.success.id;
              }
              const trigger = `lab_attack_${table}${streamId !== undefined ? `_stream_${streamId}` : ''}`;
              if (mutation.kind === 'deny-writes')
                for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
                  // SQLite trigger DDL cannot bind parameters. This is only the
                  // validated decimal native ID selected above with bound Org/model.
                  const when =
                    streamId !== undefined
                      ? ` WHEN ${operation === 'INSERT' ? 'NEW' : 'OLD'}.stream_id_fk=${streamId}${operation === 'UPDATE' ? ` OR NEW.stream_id_fk=${streamId}` : ''}`
                      : '';
                  db.exec(
                    `CREATE TRIGGER "${trigger}_${operation}" BEFORE ${operation} ON "${table}"${when} BEGIN SELECT RAISE(ABORT,'Lab storage attack'); END`
                  );
                }
              else if (mutation.kind === 'restore-writes')
                for (const operation of ['INSERT', 'UPDATE', 'DELETE'])
                  db.exec(`DROP TRIGGER IF EXISTS "${trigger}_${operation}"`);
              else if (mutation.kind === 'delete-rows') {
                if (streamId !== undefined)
                  db.prepare(`DELETE FROM "${table}" WHERE stream_id_fk=?`).run(streamId);
                else db.prepare(`DELETE FROM "${table}"`).run();
              } else {
                const column = mutation.column;
                if (
                  column === undefined ||
                  !Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(
                    db.prepare(`PRAGMA table_info("${table}")`).all()
                  ).some((row) => row.name === column)
                )
                  throw fail('unknown-column');
                const select = db.prepare(
                  `SELECT CAST(rowid AS TEXT) AS attackRowId,"${column}" AS value FROM "${table}"${streamId !== undefined ? ' WHERE stream_id_fk=?' : ''}`
                );
                const rows = Schema.decodeUnknownSync(
                  Schema.Array(
                    Schema.Struct({
                      attackRowId: Schema.String.check(
                        Schema.isPattern(/^-?(?:0|[1-9][0-9]{0,18})$/)
                      ),
                      value: Schema.Unknown,
                    })
                  )
                )(streamId !== undefined ? select.all(streamId) : select.all());
                for (const row of rows) {
                  if (!(row.value instanceof Uint8Array) || !row.value.length)
                    throw fail('not-a-blob');
                  const bytes = new Uint8Array(row.value);
                  bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 1;
                  db.prepare(`UPDATE "${table}" SET "${column}"=? WHERE rowid=?`).run(
                    bytes,
                    row.attackRowId
                  );
                }
              }
              return {
                kind: mutation.kind,
                table,
                ...(mutation.stream ? { stream: mutation.stream } : {}),
              };
            })
            .immediate(),
        catch: storageError,
      }),
    (db) => Effect.sync(() => db.close())
  );
});

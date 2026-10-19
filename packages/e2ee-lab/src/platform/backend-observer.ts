import { openSqliteConnection } from '@lody/e2ee-core/internal';
import { isAbsolute } from 'node:path';
import { Data, Effect, Result, Schema } from 'effect';
import { Bytes } from '@lody/e2ee-core';

export class LabBackendObservationError extends Data.TaggedError('LabBackendObservationError')<{
  readonly code: 'invalid-input' | 'storage' | 'budget' | 'corrupt';
  readonly cause?: unknown;
}> {}
const fail = (code: LabBackendObservationError['code'], cause?: unknown) =>
  new LabBackendObservationError({ code, ...(cause === undefined ? {} : { cause }) });
const maxRows = 4096;
const maxBytes = 16 * 1024 * 1024;
const sql = <A>(work: () => A) =>
  Effect.try({
    try: work,
    catch: (cause) =>
      cause instanceof LabBackendObservationError ? cause : fail('storage', cause),
  });
const Metadata = Schema.Struct({
  storageId: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,18}$/)),
  model: Schema.Literals(['loro', 'flock']),
  startOffset: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9]{20}$/))),
  endOffset: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9]{20}$/))),
  snapshotOffset: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9]{20}$/))),
  byteLength: Schema.Int,
  bodyType: Schema.Literal('blob'),
});
export interface LabBackendBytesRow {
  readonly kind: 'entry' | 'snapshot';
  readonly model: 'loro' | 'flock';
  readonly storageId: string;
  /** Native storage metadata only; never a client cursor or authority. */
  readonly startOffset: string | null;
  readonly endOffset: string | null;
  readonly snapshotOffset: string | null;
  readonly body: Uint8Array;
}

/** Read actual raw backend bytes, including physically retained entries hidden
 * by snapshot retention. This is a bounded insider observation, never history
 * recovery, ledger authority, decryption, or a change to backend retention.
 * The locked sqlite-riverrun 0.3.0 schema is the sole native storage format here. */
export const observeLabBackendBytes = Effect.fnUntraced(function* (input: {
  readonly path: string;
  readonly genesis: Bytes.GenesisHash;
  /** Optional smaller observation budget; the fixed caps cannot be raised. */
  readonly budget?: { readonly maxRows: number; readonly maxBytes: number };
}) {
  const path = input.path,
    rowLimit = input.budget?.maxRows ?? maxRows,
    byteLimit = input.budget?.maxBytes ?? maxBytes;
  const genesis = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
  const org = Buffer.from(genesis.toBytes()).toString('hex');
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    !Number.isSafeInteger(rowLimit) ||
    rowLimit < 1 ||
    rowLimit > maxRows ||
    !Number.isSafeInteger(byteLimit) ||
    byteLimit < 1 ||
    byteLimit > maxBytes
  )
    return yield* fail('invalid-input');
  return yield* Effect.acquireUseRelease(
    sql(() => openSqliteConnection(path, { readonly: true, fileMustExist: true })),
    (db) =>
      sql(() =>
        db
          .transaction(() => {
            // The first phase never selects a body. Its bounded lengths are all
            // checked before any payload is materialized from either table.
            const entryMetadata = db
              .prepare(`SELECT CAST(e.id AS TEXT) AS storageId,s.stream_id AS model,
                printf('%020d',e.start_offset) AS startOffset,
                printf('%020d',e.end_offset) AS endOffset,NULL AS snapshotOffset,
                length(e.body) AS byteLength,typeof(e.body) AS bodyType
                FROM streams s JOIN entries e ON e.stream_id_fk=s.id
                WHERE s.bucket_id=? AND s.stream_id IN ('loro','flock') LIMIT ?`)
              .all(org, rowLimit + 1);
            if (entryMetadata.length > rowLimit) throw fail('budget');
            const snapshotMetadata = db
              .prepare(`SELECT CAST(p.id AS TEXT) AS storageId,s.stream_id AS model,
                NULL AS startOffset,NULL AS endOffset,
                printf('%020d',p.snapshot_offset) AS snapshotOffset,
                length(p.body) AS byteLength,typeof(p.body) AS bodyType
                FROM streams s JOIN snapshots p ON p.stream_id_fk=s.id
                WHERE s.bucket_id=? AND s.stream_id IN ('loro','flock') LIMIT ?`)
              .all(org, rowLimit - entryMetadata.length + 1);
            if (entryMetadata.length + snapshotMetadata.length > rowLimit) throw fail('budget');
            const metadata: (typeof Metadata.Type & { kind: 'entry' | 'snapshot' })[] = [];
            let totalBytes = 0;
            for (const [kind, values] of [
              ['entry', entryMetadata],
              ['snapshot', snapshotMetadata],
            ] as const) {
              for (const value of values) {
                const decoded = Schema.decodeUnknownResult(Metadata)(value);
                if (Result.isFailure(decoded)) throw fail('corrupt', decoded.failure);
                const row = decoded.success;
                if (row.byteLength < 0 || !Number.isSafeInteger(row.byteLength))
                  throw fail('corrupt');
                if (row.byteLength > byteLimit - totalBytes) throw fail('budget');
                totalBytes += row.byteLength;
                metadata.push({ ...row, kind });
              }
            }
            const readEntry = db.prepare(`SELECT e.body FROM entries e
              JOIN streams s ON e.stream_id_fk=s.id
              WHERE e.id=? AND s.bucket_id=? AND s.stream_id=? AND length(e.body)=?`);
            const readSnapshot = db.prepare(`SELECT p.body FROM snapshots p
              JOIN streams s ON p.stream_id_fk=s.id
              WHERE p.id=? AND s.bucket_id=? AND s.stream_id=? AND length(p.body)=?`);
            const models = {
              loro: { entries: 0, snapshots: 0, bytes: 0 },
              flock: { entries: 0, snapshots: 0, bytes: 0 },
            };
            const rows: LabBackendBytesRow[] = [];
            for (const row of metadata) {
              const found = Schema.decodeUnknownResult(Schema.Struct({ body: Schema.Uint8Array }))(
                (row.kind === 'entry' ? readEntry : readSnapshot).get(
                  row.storageId,
                  org,
                  row.model,
                  row.byteLength
                )
              );
              if (Result.isFailure(found) || found.success.body.length !== row.byteLength)
                throw fail('corrupt');
              const { kind, model, storageId, startOffset, endOffset, snapshotOffset } = row;
              rows.push(
                Object.freeze({
                  kind,
                  model,
                  storageId,
                  startOffset,
                  endOffset,
                  snapshotOffset,
                  body: new Uint8Array(found.success.body),
                })
              );
              models[model][kind === 'entry' ? 'entries' : 'snapshots']++;
              models[model].bytes += row.byteLength;
            }
            rows.sort(
              (a, b) =>
                a.model.localeCompare(b.model) ||
                a.kind.localeCompare(b.kind) ||
                a.storageId.localeCompare(b.storageId)
            );
            return Object.freeze({
              source: 'sqlite-riverrun-0.3.0' as const,
              genesis: org,
              rows: Object.freeze(rows),
              metadata: Object.freeze({
                rows: rows.length,
                bytes: totalBytes,
                entries: entryMetadata.length,
                snapshots: snapshotMetadata.length,
                models: Object.freeze({
                  loro: Object.freeze(models.loro),
                  flock: Object.freeze(models.flock),
                }),
              }),
            });
          })
          .deferred()
      ),
    (db) => sql(() => db.close()).pipe(Effect.orDie)
  );
});

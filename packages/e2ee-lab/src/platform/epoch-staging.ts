import { openSqliteStore } from '@lody/e2ee-core/internal';
import { isAbsolute } from 'node:path';
import { Data, Effect, Result, Schema } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { decodeRecord } from '@lody/e2ee-core/protocol';
import { type EpochStagedGroup } from '@lody/e2ee-core';
import { type EpochStagedGroupKey } from '@lody/e2ee-core/services';
import {
  ownEpochStagedGroup,
  ownEpochStagedGroupKey,
  sameEpochStagedGroup,
} from '@lody/e2ee-core/protocol';
import { type EpochStagingPort } from '@lody/e2ee-core/internal';

export class LabEpochStagingError extends Data.TaggedError('LabEpochStagingError')<{
  readonly code:
    | 'invalid-input'
    | 'storage'
    | 'corrupt'
    | 'conflict'
    | 'closed'
    | 'not-obsolete'
    | 'unauthorized';
}> {}
export interface LabEpochStagingStore extends EpochStagingPort {
  /** Authenticated server boundary. Read/check/delete is one native transaction. */
  readonly deleteGroupFor: (
    principal: Bytes.SigningPublicKey,
    key: EpochStagedGroupKey,
    occupied: { readonly epoch: number; readonly commitment: string }
  ) => Effect.Effect<void, LabEpochStagingError>;
}
const fail = (code: LabEpochStagingError['code']) => new LabEpochStagingError({ code });
const app = 0x4c455347;
const Row = Schema.Struct({ record: Schema.Uint8Array });
const Envelope = Schema.Struct({ recipient: Schema.String, frame: Schema.Uint8Array });
const args = (key: EpochStagedGroupKey) =>
  [key.genesis, key.epoch, key.commitment, key.recordHash] as const;
/** Synthetic Lab storage only. One transaction commits every original ciphertext
 * and exact readback together. SQL stores no secret key and grants no authority. */
export const makeLabEpochStaging = Effect.fnUntraced(function* (input: {
  readonly path: string;
  readonly mode: 'create' | 'open';
}) {
  const { path, mode } = input;
  const sql = <A>(work: () => A) =>
    Effect.try({
      try: work,
      catch: (error) => (error instanceof LabEpochStagingError ? error : fail('storage')),
    });
  if (typeof path !== 'string' || !isAbsolute(path) || (mode !== 'create' && mode !== 'open'))
    return yield* fail('invalid-input');
  const db = yield* openSqliteStore({
    path,
    mode,
    applicationId: app,
    version: 1,
    error: fail,
    initialize: (connection) => {
      connection
        .transaction(() =>
          connection.exec(`CREATE TABLE staged_groups(genesis TEXT NOT NULL,epoch INTEGER NOT NULL,commitment TEXT NOT NULL,record_hash TEXT NOT NULL,record BLOB NOT NULL CHECK(length(record) BETWEEN 1 AND 8192),PRIMARY KEY(genesis,epoch,commitment,record_hash)) STRICT;
      CREATE TABLE staged_envelopes(genesis TEXT NOT NULL,epoch INTEGER NOT NULL,commitment TEXT NOT NULL,record_hash TEXT NOT NULL,recipient TEXT NOT NULL,frame BLOB NOT NULL CHECK(length(frame) BETWEEN 1 AND 512),PRIMARY KEY(genesis,epoch,commitment,record_hash,recipient),FOREIGN KEY(genesis,epoch,commitment,record_hash) REFERENCES staged_groups ON DELETE CASCADE) STRICT;`)
        )
        .immediate();
    },
  });
  let closed = false;
  const guard = () => {
    if (closed) throw fail('closed');
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    })
  );
  yield* sql(() => db.pragma('foreign_keys=ON'));
  const read = (key: EpochStagedGroupKey): EpochStagedGroup | null => {
    guard();
    const raw = db
      .prepare(
        'SELECT CASE WHEN length(record)<=8192 THEN record END AS record FROM staged_groups WHERE genesis=? AND epoch=? AND commitment=? AND record_hash=?'
      )
      .get(...args(key));
    if (!raw) return null;
    const row = Schema.decodeUnknownResult(Row)(raw);
    const envelopes = Schema.decodeUnknownResult(Schema.Array(Envelope))(
      db
        .prepare(
          'SELECT recipient,CASE WHEN length(frame)<=512 THEN frame END AS frame FROM staged_envelopes WHERE genesis=? AND epoch=? AND commitment=? AND record_hash=? ORDER BY recipient LIMIT 4097'
        )
        .all(...args(key))
    );
    if (Result.isFailure(row) || Result.isFailure(envelopes)) throw fail('corrupt');
    const group = ownEpochStagedGroup({
      ...key,
      record: row.success.record,
      envelopes: envelopes.success,
    });
    if (Result.isFailure(group)) throw fail('corrupt');
    return group.success;
  };
  const remove = (
    key: EpochStagedGroupKey,
    occupied: { readonly epoch: number; readonly commitment: string },
    principal?: Bytes.SigningPublicKey
  ) =>
    sql(() =>
      db
        .transaction(() => {
          guard();
          const original = read(key);
          if (original === null) return;
          if (principal) {
            const record = Result.getOrThrow(decodeRecord(original.record));
            if (record.body.type !== 'ordinary' || !record.body.signer.equals(principal))
              throw fail('unauthorized');
          }
          if (
            occupied.epoch !== key.epoch ||
            !/^[0-9a-f]{64}$/.test(occupied.commitment) ||
            occupied.commitment === key.commitment
          )
            throw fail('not-obsolete');
          db.prepare(
            'DELETE FROM staged_groups WHERE genesis=? AND epoch=? AND commitment=? AND record_hash=?'
          ).run(...args(key));
          if (read(key) !== null) throw fail('storage');
        })
        .immediate()
    );
  const port = {
    stageGroup: Effect.fnUntraced(function* (source: EpochStagedGroup) {
      const group = yield* Effect.fromResult(ownEpochStagedGroup(source));
      yield* sql(() =>
        db
          .transaction(() => {
            const before = read(group);
            if (before && !sameEpochStagedGroup(before, group)) throw fail('conflict');
            db.prepare('INSERT OR IGNORE INTO staged_groups VALUES(?,?,?,?,?)').run(
              ...args(group),
              group.record
            );
            const insert = db.prepare('INSERT OR IGNORE INTO staged_envelopes VALUES(?,?,?,?,?,?)');
            for (const row of group.envelopes) insert.run(...args(group), row.recipient, row.frame);
            const after = read(group);
            if (!after || !sameEpochStagedGroup(after, group)) throw fail('storage');
          })
          .immediate()
      );
    }),
    readGroup: Effect.fnUntraced(function* (source: EpochStagedGroupKey) {
      const key = yield* Effect.fromResult(ownEpochStagedGroupKey(source));
      return yield* sql(() => db.transaction(() => read(key)).deferred());
    }),
    deleteGroup: Effect.fnUntraced(function* (
      source: EpochStagedGroupKey,
      occupied: { readonly epoch: number; readonly commitment: string }
    ) {
      const key = yield* Effect.fromResult(ownEpochStagedGroupKey(source));
      return yield* remove(key, occupied);
    }),
    deleteGroupFor: Effect.fnUntraced(function* (
      principal: Bytes.SigningPublicKey,
      source: EpochStagedGroupKey,
      occupied: { readonly epoch: number; readonly commitment: string }
    ) {
      const caller = yield* Effect.fromResult(Bytes.signingPublicKey(principal.toBytes())).pipe(
        Effect.mapError(() => fail('invalid-input'))
      );
      const key = yield* Effect.fromResult(ownEpochStagedGroupKey(source)).pipe(
        Effect.mapError(() => fail('invalid-input'))
      );
      return yield* remove(key, { epoch: occupied.epoch, commitment: occupied.commitment }, caller);
    }),
  } satisfies LabEpochStagingStore;
  return Object.freeze(port);
});

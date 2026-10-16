import { sha256 } from '@noble/hashes/sha2.js';
import type Database from 'better-sqlite3';
import { isAbsolute } from 'node:path';
import { Data, Effect, Result, Schema } from 'effect';
import * as Bytes from '../../internal/foundation/bytes';
import { bytesEqual } from '../../internal/foundation/cbor';
import { MAX_CONTENT_BYTES } from '../../internal/foundation/content-format';
import { openSqliteStore } from './store';

/** Failure of the reference snapshot publication journal; `code` names the reason. */
export class SnapshotPublicationError extends Data.TaggedError('SnapshotPublicationError')<{
  readonly code:
    | 'invalid-input'
    | 'closed'
    | 'storage'
    | 'corrupt'
    | 'conflict'
    | 'busy'
    | 'capacity';
}> {}
interface SnapshotPublicationIdentity {
  readonly offset: string;
  readonly signer: string;
  readonly digest: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
/** One stored snapshot publication: its identity, state (Pending, Accepted, current) and, while retained, its body. */
export type SnapshotPublicationRow = SnapshotPublicationIdentity &
  (
    | { readonly phase: 'Pending'; readonly body: Uint8Array }
    | { readonly phase: 'Accepted'; readonly body: Uint8Array | null }
  );
type Original = Omit<SnapshotPublicationIdentity, 'digest'> & { readonly body: Uint8Array };
const APP = 0x4c455350;
const fail = (code: SnapshotPublicationError['code']) => new SnapshotPublicationError({ code });
/** SHA-256 identity of a snapshot publication body. */
export const snapshotPublicationDigest = (body: Uint8Array) =>
  Buffer.from(sha256(body)).toString('hex');
const validOffset = (offset: unknown): offset is string =>
  typeof offset === 'string' &&
  offset.length > 0 &&
  offset.length <= 1024 &&
  offset !== 'now' &&
  offset !== '-1' &&
  offset.trim() === offset &&
  !Array.from(offset).some((value) => value.charCodeAt(0) < 32 || value.charCodeAt(0) === 127);
const Meta = Schema.Struct({
  genesis: Schema.Uint8Array,
  resource: Schema.String,
  model: Schema.Literals(['loro', 'flock']),
  currentOffset: Schema.NullOr(Schema.String),
  count: Schema.Int,
  bytes: Schema.Int,
});
const Row = Schema.Struct({
  offset: Schema.String,
  signer: Schema.String,
  digest: Schema.String,
  body: Schema.NullOr(Schema.Uint8Array),
  issuedAt: Schema.Int,
  expiresAt: Schema.Int,
  phase: Schema.Literals(['Pending', 'Accepted']),
});
const sameOriginal = (a: SnapshotPublicationIdentity, b: SnapshotPublicationIdentity) =>
  a.offset === b.offset && a.signer === b.signer && a.digest === b.digest;
const own = (row: SnapshotPublicationRow): SnapshotPublicationRow =>
  Object.freeze({
    ...row,
    body: row.body === null ? null : new Uint8Array(row.body),
  }) as SnapshotPublicationRow;
function captureOriginal(input: Original) {
  return Result.try({
    try: () => {
      const { offset, signer, issuedAt, expiresAt } = input,
        source = input.body;
      if (
        !validOffset(offset) ||
        typeof signer !== 'string' ||
        !/^[0-9a-f]{64}$/.test(signer) ||
        !(source instanceof Uint8Array) ||
        source.length < 1 ||
        source.length > MAX_CONTENT_BYTES ||
        !Number.isSafeInteger(issuedAt) ||
        issuedAt < 0 ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= issuedAt
      )
        throw fail('invalid-input');
      Result.getOrThrow(Bytes.signingPublicKey(new Uint8Array(Buffer.from(signer, 'hex'))));
      const body = new Uint8Array(source);
      return Object.freeze({
        offset,
        signer,
        body,
        digest: snapshotPublicationDigest(body),
        issuedAt,
        expiresAt,
      });
    },
    catch: () => fail('invalid-input'),
  });
}

/** Current and Pending retain exact native ciphertext. Superseded receipts retain
 * only their immutable digest/identity; an old retry cannot republish or rewind current.
 * This single-host journal supplies no permission, offset ordering or native receipt. */
export const makeSqliteSnapshotPublication = Effect.fnUntraced(function* (input: {
  readonly path: string;
  readonly mode: 'create' | 'open';
  readonly genesis: Bytes.GenesisHash;
  readonly resource: string;
  readonly model: 'loro' | 'flock';
  readonly budget?: { readonly maxSnapshots: number; readonly maxBytes: number };
}) {
  const { path, mode, resource, model } = input;
  const genesis = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
  const maxSnapshots = input.budget?.maxSnapshots ?? 10000,
    maxBytes = input.budget?.maxBytes ?? 64 * 1024 * 1024;
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    (mode !== 'create' && mode !== 'open') ||
    typeof resource !== 'string' ||
    resource.length < 1 ||
    resource.length > 1024 ||
    !/^[!-~]+$/.test(resource) ||
    (model !== 'loro' && model !== 'flock') ||
    !Number.isSafeInteger(maxSnapshots) ||
    maxSnapshots < 1 ||
    maxSnapshots > 100000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 64 * 1024 * 1024
  )
    return yield* fail('invalid-input');
  const sql = <A>(work: () => A) =>
    Effect.try({
      try: work,
      catch: (error) => (error instanceof SnapshotPublicationError ? error : fail('storage')),
    });
  const meta = (db: Database.Database) => {
    const parsed = Schema.decodeUnknownResult(Meta)(
      db
        .prepare(
          'SELECT genesis,resource,model,currentOffset,count,bytes FROM snapshot_publication_meta WHERE id=1'
        )
        .get()
    );
    if (Result.isFailure(parsed)) throw fail('corrupt');
    const value = parsed.success;
    if (
      !bytesEqual(value.genesis, genesis.toBytes()) ||
      value.resource !== resource ||
      value.model !== model ||
      (value.currentOffset !== null && !validOffset(value.currentOffset)) ||
      value.count < 0 ||
      value.count > maxSnapshots ||
      value.bytes < 0 ||
      value.bytes > maxBytes
    )
      throw fail('corrupt');
    return value;
  };
  const db = yield* openSqliteStore({
    path,
    mode,
    applicationId: APP,
    version: 1,
    error: fail,
    initialize: (handle) => {
      handle.exec(`CREATE TABLE snapshot_publication_meta(id INTEGER PRIMARY KEY CHECK(id=1),genesis BLOB NOT NULL CHECK(length(genesis)=32),resource TEXT NOT NULL,model TEXT NOT NULL CHECK(model IN ('loro','flock')),currentOffset TEXT,count INTEGER NOT NULL,bytes INTEGER NOT NULL) STRICT;
CREATE TABLE snapshot_publications(offset TEXT PRIMARY KEY,signer TEXT NOT NULL CHECK(length(signer)=64),digest TEXT NOT NULL CHECK(length(digest)=64),body BLOB CHECK(body IS NULL OR length(body) BETWEEN 1 AND ${MAX_CONTENT_BYTES}),issuedAt INTEGER NOT NULL CHECK(issuedAt>=0),expiresAt INTEGER NOT NULL CHECK(expiresAt>issuedAt),phase TEXT NOT NULL CHECK(phase IN ('Pending','Accepted')),CHECK(phase='Accepted' OR body IS NOT NULL)) STRICT;
CREATE UNIQUE INDEX snapshot_one_pending ON snapshot_publications(phase) WHERE phase='Pending';`);
      handle
        .prepare('INSERT INTO snapshot_publication_meta VALUES(1,?,?,?,NULL,0,0)')
        .run(genesis.toBytes(), resource, model);
    },
    validate: (handle) => {
      meta(handle);
    },
  });
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    })
  );
  const guard = () => {
    if (closed) throw fail('closed');
  };
  const parse = (raw: unknown): SnapshotPublicationRow => {
    const parsed = Schema.decodeUnknownResult(Row)(raw);
    if (Result.isFailure(parsed)) throw fail('corrupt');
    const row = parsed.success;
    if (
      !validOffset(row.offset) ||
      !/^[0-9a-f]{64}$/.test(row.signer) ||
      !/^[0-9a-f]{64}$/.test(row.digest) ||
      row.issuedAt < 0 ||
      row.expiresAt <= row.issuedAt ||
      (row.phase === 'Pending' && row.body === null) ||
      (row.body !== null &&
        (row.body.length < 1 ||
          row.body.length > MAX_CONTENT_BYTES ||
          snapshotPublicationDigest(row.body) !== row.digest))
    )
      throw fail('corrupt');
    return own(row as SnapshotPublicationRow);
  };
  const at = (offset: string) => {
    const raw = db
      .prepare(
        'SELECT offset,signer,digest,body,issuedAt,expiresAt,phase FROM snapshot_publications WHERE offset=?'
      )
      .get(offset);
    return raw === undefined ? null : parse(raw);
  };
  const pending = () => {
    const raw = db
      .prepare(
        "SELECT offset,signer,digest,body,issuedAt,expiresAt,phase FROM snapshot_publications WHERE phase='Pending'"
      )
      .get();
    if (raw === undefined) return null;
    const row = parse(raw);
    if (row.phase !== 'Pending') throw fail('corrupt');
    return row;
  };
  const current = () => {
    const position = meta(db).currentOffset;
    if (position === null) return null;
    const row = at(position);
    if (!row || row.phase !== 'Accepted' || row.body === null) throw fail('corrupt');
    return { ...row, body: row.body };
  };
  // Startup validates the two retained originals, not all superseded ciphertexts.
  yield* sql(() =>
    db
      .transaction(() => {
        current();
        pending();
      })
      .deferred()
  );
  const checked = <A>(work: () => A) =>
    sql(() =>
      db
        .transaction(() => {
          guard();
          return work();
        })
        .deferred()
    );
  return Object.freeze({
    lookup: (offset: string) =>
      checked(() => {
        if (!validOffset(offset)) throw fail('invalid-input');
        meta(db);
        return at(offset);
      }),
    pending: () =>
      checked(() => {
        meta(db);
        return pending();
      }),
    current: () => checked(current),
    reserve: Effect.fnUntraced(function* (inputRow: Original) {
      const original = yield* Effect.fromResult(captureOriginal(inputRow));
      return yield* sql(() =>
        db
          .transaction(() => {
            guard();
            const state = meta(db),
              prior = at(original.offset);
            if (prior) {
              if (!sameOriginal(prior, original)) throw fail('conflict');
              return prior; // First credential deadline wins, including archived receipts.
            }
            if (pending()) throw fail('busy');
            if (state.count >= maxSnapshots || state.bytes + original.body.length > maxBytes)
              throw fail('capacity');
            db.prepare(
              'INSERT INTO snapshot_publications VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING'
            ).run(
              original.offset,
              original.signer,
              original.digest,
              original.body,
              original.issuedAt,
              original.expiresAt,
              'Pending'
            );
            const saved = at(original.offset);
            if (!saved || !sameOriginal(saved, original)) throw fail('conflict');
            if (
              db
                .prepare(
                  'UPDATE snapshot_publication_meta SET count=count+1,bytes=bytes+? WHERE id=1'
                )
                .run(original.body.length).changes !== 1
            )
              throw fail('corrupt');
            return saved;
          })
          .immediate()
      );
    }),
    accept: Effect.fnUntraced(function* (expected: SnapshotPublicationRow) {
      const parsed = Schema.decodeUnknownResult(Row)(expected);
      if (Result.isFailure(parsed)) return yield* fail('invalid-input');
      const original = yield* sql(() => parse(parsed.success));
      return yield* sql(() =>
        db
          .transaction(() => {
            guard();
            const state = meta(db),
              prior = at(original.offset);
            if (
              !prior ||
              !sameOriginal(prior, original) ||
              prior.issuedAt !== original.issuedAt ||
              prior.expiresAt !== original.expiresAt
            )
              throw fail('conflict');
            if (prior.phase === 'Accepted') return; // Old accepted offsets never become current again.
            if (original.phase !== 'Pending') throw fail('conflict');
            if (
              db
                .prepare(
                  "UPDATE snapshot_publications SET phase='Accepted' WHERE offset=? AND phase='Pending'"
                )
                .run(prior.offset).changes !== 1
            )
              throw fail('corrupt');
            if (state.currentOffset !== null)
              db.prepare(
                "UPDATE snapshot_publications SET body=NULL WHERE offset=? AND phase='Accepted'"
              ).run(state.currentOffset);
            if (
              db
                .prepare(
                  'UPDATE snapshot_publication_meta SET currentOffset=?,count=1,bytes=? WHERE id=1'
                )
                .run(prior.offset, prior.body.length).changes !== 1
            )
              throw fail('corrupt');
            const saved = at(prior.offset);
            if (!saved || saved.phase !== 'Accepted' || !sameOriginal(saved, prior))
              throw fail('corrupt');
          })
          .immediate()
      );
    }),
  });
});

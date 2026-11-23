import { openSqliteStore } from '@lody/e2ee-core/internal';
import { isAbsolute } from 'node:path';
import { Data, Effect, Result, Schema } from 'effect';
import { type LedgerCheckpoint, type LedgerView } from '@lody/e2ee-core';
import { hasVerifiedCheckpoint } from '@lody/e2ee-core/protocol';
import { LedgerFeedError } from '@lody/e2ee-core';
import { Bytes } from '@lody/e2ee-core';
import { verifyLedgerSnapshot, type SnapshotTrust } from '@lody/e2ee-core/protocol';

export class LabSnapshotCacheError extends Data.TaggedError('LabSnapshotCacheError')<{
  readonly code: 'invalid-input' | 'storage' | 'corrupt' | 'conflict' | 'closed';
}> {}
const fail = (code: LabSnapshotCacheError['code']) => new LabSnapshotCacheError({ code });
const app = 0x4c455331;
const maxBytes = 2 * 1024 * 1024; // Local storage budget; public verifier owns codec limits.
const Row = Schema.Struct({ snapshot: Schema.Uint8Array });
const ownTrust = (trust: SnapshotTrust) =>
  Result.gen(function* () {
    if (
      trust.source !== 'external-confirmation' ||
      trust.kind !== 'personal' ||
      (trust.role !== 'owner' && trust.role !== 'admin') ||
      !Number.isSafeInteger(trust.length) ||
      trust.length < 1
    )
      return yield* Result.fail(fail('invalid-input'));
    return Object.freeze({
      source: trust.source,
      kind: trust.kind,
      role: trust.role,
      length: trust.length,
      genesis: yield* Bytes.genesisHash(trust.genesis.toBytes()),
      head: yield* Bytes.recordHash(trust.head.toBytes()),
      endorser: yield* Bytes.signingPublicKey(trust.endorser.toBytes()),
      membershipId: yield* Bytes.membershipId(trust.membershipId.toBytes()),
      headSignature: yield* Bytes.signature(trust.headSignature.toBytes()),
      ...(trust.stateDigest
        ? { stateDigest: yield* Bytes.recordHash(trust.stateDigest.toBytes()) }
        : {}),
    });
  });
/** Cache of public v1 signed snapshot bytes, not a trust-pin store or latest selector.
 * Every read requires independently qualified identity/role/position/head attestation.
 * SQL contains no trust role, membership or head signature to promote into authority.
 * No vault wrapping, snapshot-v2, offset bootstrap or production feature is selected. */
export const makeLabSnapshotCache = Effect.fnUntraced(function* (input: {
  readonly path: string;
  readonly mode: 'create' | 'open';
}) {
  const { path, mode } = input;
  const sql = <A>(work: () => A) =>
    Effect.try({
      try: work,
      catch: (error) => (error instanceof LabSnapshotCacheError ? error : fail('storage')),
    });
  if (!isAbsolute(path) || (mode !== 'create' && mode !== 'open'))
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
          connection.exec(
            `CREATE TABLE snapshots(genesis BLOB NOT NULL CHECK(length(genesis)=32),head BLOB NOT NULL CHECK(length(head)=32),count INTEGER NOT NULL CHECK(count>0),endorser BLOB NOT NULL CHECK(length(endorser)=32),snapshot BLOB NOT NULL CHECK(length(snapshot)>0 AND length(snapshot)<=${maxBytes}),PRIMARY KEY(genesis,head,count,endorser)) STRICT;`
          )
        )
        .immediate();
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

  const key = (trust: SnapshotTrust) =>
    [
      Buffer.from(trust.genesis.toBytes()),
      Buffer.from(trust.head.toBytes()),
      trust.length,
      Buffer.from(trust.endorser.toBytes()),
    ] as const;
  const read = (trust: SnapshotTrust) => {
    const raw = db
      .prepare(
        'SELECT snapshot FROM snapshots WHERE genesis=? AND head=? AND count=? AND endorser=?'
      )
      .get(...key(trust));
    if (!raw) return undefined;
    const row = Schema.decodeUnknownResult(Row)(raw);
    if (
      Result.isFailure(row) ||
      row.success.snapshot.length < 1 ||
      row.success.snapshot.length > maxBytes
    )
      throw fail('corrupt');
    const snapshot = new Uint8Array(row.success.snapshot);
    const verified = verifyLedgerSnapshot({ snapshot, trust });
    if (Result.isFailure(verified)) throw fail('corrupt');
    return Object.freeze({ view: verified.success, snapshot: () => new Uint8Array(snapshot) });
  };
  return Object.freeze({
    get: Effect.fnUntraced(function* (source: SnapshotTrust) {
      const trust = yield* Effect.fromResult(ownTrust(source));
      return yield* sql(() => {
        guard();
        return read(trust);
      });
    }),
    put: Effect.fnUntraced(function* (candidate: {
      readonly trust: SnapshotTrust;
      readonly snapshot: Uint8Array;
    }) {
      const trust = yield* Effect.fromResult(ownTrust(candidate.trust));
      if (
        !(candidate.snapshot instanceof Uint8Array) ||
        !candidate.snapshot.length ||
        candidate.snapshot.length > maxBytes
      )
        return yield* fail('invalid-input');
      const snapshot = new Uint8Array(candidate.snapshot);
      yield* Effect.fromResult(verifyLedgerSnapshot({ snapshot, trust }));
      return yield* sql(() => {
        guard();
        return db
          .transaction(() => {
            const before = read(trust);
            if (before && !Buffer.from(before.snapshot()).equals(Buffer.from(snapshot)))
              throw fail('conflict');
            db.prepare('INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?,?)').run(
              ...key(trust),
              Buffer.from(snapshot)
            );
            const saved = read(trust);
            if (!saved || !Buffer.from(saved.snapshot()).equals(Buffer.from(snapshot)))
              throw fail('storage');
            return saved;
          })
          .immediate();
      });
    }),
  });
});

/** Caller owns both live cache and full-history resources. A corrupt/missing/stale
 * optional cache may fall back to separately pinned actual full audit. Closed or
 * invalid qualification never initiates recovery, and failed audit never promotes
 * invalid cached claims. No offset is selected or committed by this helper. */
export const restoreLabLedgerFromCacheOrHistory = Effect.fnUntraced(function* <E, R>(input: {
  readonly cache: Effect.Success<ReturnType<typeof makeLabSnapshotCache>>;
  readonly trust: SnapshotTrust;
  readonly expected: LedgerCheckpoint;
  readonly history: () => Effect.Effect<LedgerView, E, R>;
}) {
  const trust = yield* Effect.fromResult(ownTrust(input.trust));
  const expected = {
    head: yield* Effect.fromResult(Bytes.recordHash(input.expected.head.toBytes())),
    length: input.expected.length,
  };
  if (!Number.isSafeInteger(expected.length) || expected.length < 1)
    return yield* new LedgerFeedError({ code: 'wrong-parent' });
  const history = input.history,
    get = input.cache.get.bind(input.cache);
  const cached = yield* Effect.result(get(trust));
  if (Result.isFailure(cached)) {
    const problem = cached.failure;
    if (
      !(problem instanceof LabSnapshotCacheError) ||
      (problem.code !== 'corrupt' && problem.code !== 'storage')
    )
      return yield* problem;
  } else if (cached.success) {
    const view = cached.success.view;
    // Query module provenance BEFORE inspecting even apparently legitimate fields.
    const qualified = yield* Effect.fromResult(hasVerifiedCheckpoint(view, expected));
    if (
      qualified &&
      view.genesis.equals(trust.genesis) &&
      view.length === expected.length &&
      view.head.equals(expected.head)
    )
      return Object.freeze({ source: 'endorsed-cache' as const, view });
  }
  const view = yield* history();
  const qualified = yield* Effect.fromResult(hasVerifiedCheckpoint(view, expected));
  if (
    !qualified ||
    !view.genesis.equals(trust.genesis) ||
    view.length !== expected.length ||
    !view.head.equals(expected.head) ||
    view.verification !== 'full-history'
  )
    return yield* new LedgerFeedError({ code: 'wrong-parent' });
  return Object.freeze({ source: 'full-history' as const, view });
});

import { openSqliteStore } from '@lody/e2ee-core/internal';
import { isAbsolute } from 'node:path';
import { StreamsClient } from '@loro-dev/streams-client';
import { Data, Effect, Result, Semaphore } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { type LedgerCheckpoint } from '@lody/e2ee-core';
import {
  decodeRecord,
  hashRecordBytes,
  hasVerifiedCheckpoint,
  requireLedgerContinuation,
  verifyLedgerEffect,
} from '@lody/e2ee-core/protocol';
import { frameLedgerRecord, validLedgerOffset } from '@lody/e2ee-core/protocol';
import { makeLedgerStreamReader } from '@lody/e2ee-core/adapters/loro-streams';
import type { LabCredential } from './credentials';
import type { makeLabWorkspaceRegistry } from './workspace-registry';
import { makeLabSdkOwner } from './sdk-owner';

export class LabWorkspaceCreationError extends Data.TaggedError('LabWorkspaceCreationError')<{
  readonly code: 'invalid-input' | 'unauthorized' | 'transport' | 'storage' | 'corrupt' | 'closed';
}> {}
const fail = (code: LabWorkspaceCreationError['code']) => new LabWorkspaceCreationError({ code });
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const APP = 0x4c455743;
export interface LabWorkspaceCreationReceipt {
  readonly genesisHex: string;
  readonly headHex: string;
  readonly count: number;
  readonly offset: string;
}

/** Current experimental Lab layout: the real signed genesis is the first control
 * frame, never a metadata-only prefix. One owner/file/workspace; no public runtime
 * or parallel P09. The host's independently supplied minimum is required on reopen.
 * Saved records/offsets are original observations, never a fresh client trust source.
 * Scope aborts admission and awaits raw SDK settlement; StreamsClient.close is EOF.
 */
export const makeLabWorkspaceCreation = Effect.fnUntraced(function* (input: {
  readonly path: string;
  readonly mode: 'create' | 'open';
  readonly genesisRecord: Uint8Array;
  readonly minimum?: LedgerCheckpoint;
  readonly baseUrl: string;
  readonly registry: Effect.Success<ReturnType<typeof makeLabWorkspaceRegistry>>;
  readonly budget: { readonly maxRecords: number; readonly maxBytes: number };
  readonly fetch?: typeof fetch;
}) {
  const { path, mode, registry, baseUrl } = input;
  const transport = input.fetch ?? fetch;
  const budget = { ...input.budget };
  const suppliedMinimum = input.minimum;
  const minimum = suppliedMinimum
    ? {
        head: yield* Effect.fromResult(Bytes.recordHash(suppliedMinimum.head.toBytes())),
        length: suppliedMinimum.length,
      }
    : undefined;
  const sql = <A>(work: () => A) =>
    Effect.try({
      try: work,
      catch: (error) => (error instanceof LabWorkspaceCreationError ? error : fail('storage')),
    });
  if (
    !isAbsolute(path) ||
    (mode !== 'create' && mode !== 'open') ||
    !(input.genesisRecord instanceof Uint8Array) ||
    input.genesisRecord.length < 1 ||
    input.genesisRecord.length > 8192
  )
    return yield* fail('invalid-input');
  const original = new Uint8Array(input.genesisRecord);
  const decoded = yield* Effect.fromResult(decodeRecord(original));
  if (decoded.body.type !== 'genesis') return yield* fail('invalid-input');
  const signer = decoded.body.signer;
  const genesis = yield* Effect.fromResult(Bytes.genesisHash(hashRecordBytes(original).toBytes()));
  const initial = { head: hashRecordBytes(original), length: 1 };
  let view = yield* verifyLedgerEffect({
    anchor: genesis,
    records: [original],
    checkpoint: initial,
  });
  if (mode === 'open' && !minimum) return yield* fail('invalid-input');
  if (
    minimum &&
    (!Number.isSafeInteger(minimum.length) ||
      minimum.length < 1 ||
      minimum.length > budget.maxRecords)
  )
    return yield* fail('invalid-input');
  if (
    !Number.isSafeInteger(budget.maxRecords) ||
    budget.maxRecords < 1 ||
    budget.maxRecords > 4096 ||
    !Number.isSafeInteger(budget.maxBytes) ||
    budget.maxBytes < original.length ||
    budget.maxBytes > 16 * 1024 * 1024
  )
    return yield* fail('invalid-input');
  const origin = yield* Effect.try({
    try: () => {
      const value = new URL(baseUrl);
      if (
        value.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname) ||
        value.username ||
        value.password ||
        value.pathname !== '/' ||
        value.search ||
        value.hash
      )
        throw fail('invalid-input');
      return value.origin;
    },
    catch: () => fail('invalid-input'),
  });
  const db = yield* openSqliteStore({
    path,
    mode,
    applicationId: APP,
    version: 1,
    error: fail,
    initialize: (connection) => {
      connection
        .transaction(() => {
          connection.exec(`CREATE TABLE creation(id INTEGER PRIMARY KEY CHECK(id=1),original BLOB NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('Pending','Published')),head BLOB NOT NULL,count INTEGER NOT NULL,offset TEXT NOT NULL) STRICT;
        CREATE TABLE history(position INTEGER PRIMARY KEY,record BLOB NOT NULL) STRICT;`);
          if (
            connection
              .prepare("INSERT INTO creation VALUES(1,?,'Pending',?,1,'-1')")
              .run(original, initial.head.toBytes()).changes !== 1 ||
            connection.prepare('INSERT INTO history VALUES(1,?)').run(original).changes !== 1
          )
            throw fail('storage');
        })
        .immediate();
    },
  });
  // Native owner is acquired after SQLite: abort and join before closing this file.
  const native = yield* makeLabSdkOwner(() => ({ close: async () => undefined }));
  const fetchNative: typeof fetch = (request, init) => {
    native.assertOpen();
    const outgoing = new Request(request, init);
    if (new URL(outgoing.url).origin !== origin) return Promise.reject(fail('invalid-input'));
    return transport(
      new Request(outgoing, {
        redirect: 'error',
        signal: AbortSignal.any([outgoing.signal, native.signal]),
      })
    );
  };
  const org = Buffer.from(genesis.toBytes()).toString('hex');
  const sdk = new StreamsClient({
    url: `${origin}/ds/${org}/control`,
    fetch: fetchNative,
    retry: { maxAttempts: 1 },
  });
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    })
  );
  const guard = () => {
    if (closed || native.signal.aborted) throw fail('closed');
  };

  const read = () => {
    guard();
    const meta = db
      .prepare(
        'SELECT CASE WHEN length(original) BETWEEN 1 AND 8192 THEN original ELSE NULL END AS original,phase,CASE WHEN length(head)=32 THEN head ELSE NULL END AS head,count,CASE WHEN length(offset)<=256 THEN offset ELSE NULL END AS offset FROM creation WHERE id=1'
      )
      .get() as
      | {
          original: unknown;
          phase: unknown;
          head: unknown;
          count: unknown;
          offset: unknown;
        }
      | undefined;
    if (
      !meta ||
      !(meta.original instanceof Uint8Array) ||
      !same(meta.original, original) ||
      !(meta.head instanceof Uint8Array) ||
      (meta.phase !== 'Pending' && meta.phase !== 'Published') ||
      typeof meta.count !== 'number' ||
      !Number.isSafeInteger(meta.count) ||
      meta.count < 1 ||
      meta.count > budget.maxRecords ||
      !validLedgerOffset(meta.offset)
    )
      throw fail('corrupt');
    const aggregate = db
      .prepare('SELECT COUNT(*) AS count,COALESCE(SUM(length(record)),0) AS bytes FROM history')
      .get() as { count: number; bytes: number };
    if (aggregate.count !== meta.count || aggregate.bytes > budget.maxBytes) throw fail('corrupt');
    const rows = db
      .prepare(
        'SELECT position,CASE WHEN length(record) BETWEEN 1 AND 8192 THEN record ELSE NULL END AS record FROM history ORDER BY position LIMIT ?'
      )
      .all(budget.maxRecords) as { position: number; record: unknown }[];
    const records: Uint8Array[] = [];
    for (const row of rows) {
      if (
        row.position !== records.length + 1 ||
        !(row.record instanceof Uint8Array) ||
        row.record.length < 1 ||
        row.record.length > 8192
      )
        throw fail('corrupt');
      records.push(new Uint8Array(row.record));
    }
    if (
      !same(records[0]!, original) ||
      !same(hashRecordBytes(records.at(-1)!).toBytes(), meta.head) ||
      (meta.phase === 'Pending' && (meta.count !== 1 || meta.offset !== '-1'))
    )
      throw fail('corrupt');
    return {
      records,
      phase: meta.phase,
      head: new Uint8Array(meta.head),
      offset: meta.offset,
      count: meta.count,
    };
  };
  const loaded = yield* sql(() => db.transaction(read).deferred());
  view = yield* verifyLedgerEffect({
    anchor: genesis,
    records: loaded.records,
    checkpoint: {
      head: yield* Effect.fromResult(Bytes.recordHash(loaded.head)),
      length: loaded.count,
    },
  });
  const minimumObserved = minimum
    ? yield* Effect.fromResult(hasVerifiedCheckpoint(view, minimum))
    : true;
  let saved = loaded;
  // A genuine suffix can be known before its checkpoint is durable. Keep that
  // knowledge even if SQL fails: the older durable prefix must not authorize
  // anything while a newer observed revocation remains unconfirmed locally.
  let observedFloor = view;
  const requireConfirmedObservation = () => {
    if (!observedFloor.head.equals(view.head) || observedFloor.length !== view.length)
      throw fail('storage');
  };
  const matches = (actual: ReturnType<typeof read>, expected: typeof saved) =>
    actual.phase === expected.phase &&
    actual.offset === expected.offset &&
    actual.count === expected.count &&
    same(actual.head, expected.head) &&
    actual.records.every((record, index) => same(record, expected.records[index]!));
  const reader = yield* makeLedgerStreamReader({ read: (request) => sdk.read(request) });
  const serial = yield* Semaphore.make(1);
  const refresh = Effect.fnUntraced(function* () {
    yield* sql(guard);
    const before = saved;
    const records: Uint8Array[] = [];
    let offset = '-1',
      size = 0;
    const visited = new Set([offset]);
    for (let pages = 0; pages < 4096; pages++) {
      const page = yield* reader.readAfter(offset);
      if (
        (!page.records.length && page.nextOffset !== offset) ||
        (!page.upToDate && !page.records.length)
      )
        return yield* fail('corrupt');
      for (const record of page.records) {
        size += record.length;
        if (records.length >= budget.maxRecords || size > budget.maxBytes)
          return yield* fail('invalid-input');
        records.push(new Uint8Array(record));
      }
      if (page.records.length && visited.has(page.nextOffset)) return yield* fail('corrupt');
      offset = page.nextOffset;
      if (!page.upToDate) {
        visited.add(offset);
        continue;
      }
      if (!records.length || !same(records[0]!, original)) return yield* fail('corrupt');
      const head = hashRecordBytes(records.at(-1)!);
      const next = yield* verifyLedgerEffect({
        anchor: genesis,
        records,
        checkpoint: { head, length: records.length },
      });
      yield* Effect.fromResult(requireLedgerContinuation(observedFloor, next));
      if (minimum && !(yield* Effect.fromResult(hasVerifiedCheckpoint(next, minimum))))
        return yield* fail('corrupt');
      observedFloor = next;
      const candidate: typeof saved = {
        records,
        phase: 'Published',
        head: head.toBytes(),
        count: records.length,
        offset,
      };
      if (matches(candidate, before)) {
        view = next;
        return { view, offset };
      }
      yield* sql(() =>
        db
          .transaction(() => {
            for (let index = before.count; index < records.length; index++)
              if (
                db.prepare('INSERT INTO history VALUES(?,?)').run(index + 1, records[index]!)
                  .changes !== 1
              )
                throw fail('storage');
            if (
              db
                .prepare("UPDATE creation SET phase='Published',head=?,count=?,offset=? WHERE id=1")
                .run(head.toBytes(), records.length, offset).changes !== 1
            )
              throw fail('storage');
            const retained = db
              .prepare('SELECT head,count,offset FROM creation WHERE id=1')
              .get() as { head: Uint8Array; count: number; offset: string } | undefined;
            if (
              !retained ||
              !same(retained.head, head.toBytes()) ||
              retained.count !== records.length ||
              retained.offset !== offset
            )
              throw fail('storage');
          })
          .immediate()
      );
      saved = candidate;
      view = next;
      return { view, offset };
    }
    return yield* fail('invalid-input');
  });
  // A crash may leave local observations behind the caller's independently witnessed
  // minimum. Reconcile the real remote before publishing any current authority.
  if (!minimumObserved) yield* refresh();
  const checkpoint = () => ({ head: view.head, length: view.length });
  return Object.freeze({
    genesis,
    record: () => new Uint8Array(original),
    status: () =>
      sql(() => {
        guard();
        return { phase: saved.phase };
      }),
    current: () =>
      sql(() => {
        guard();
        if (saved.phase !== 'Published') throw fail('unauthorized');
        requireConfirmedObservation();
        return { view, offset: saved.offset, phase: saved.phase };
      }),
    checkpoint: () =>
      sql(() => {
        guard();
        if (saved.phase !== 'Published') throw fail('unauthorized');
        requireConfirmedObservation();
        return checkpoint();
      }),
    refresh: () => serial.withPermit(refresh()),
    create: Effect.fnUntraced(function* (credential: LabCredential, record: Uint8Array = original) {
      if (!(record instanceof Uint8Array) || !same(new Uint8Array(record), original))
        return yield* fail('invalid-input');
      const device = yield* Effect.fromResult(Bytes.signingPublicKey(credential.device.toBytes()));
      const bound =
        credential.genesis === null
          ? null
          : yield* Effect.fromResult(Bytes.genesisHash(credential.genesis.toBytes()));
      const captured = { ...credential, device, genesis: bound };
      if (!device.equals(signer) || (bound !== null && !bound.equals(genesis)))
        return yield* fail('unauthorized');
      return yield* serial.withPermit(
        Effect.gen(function* () {
          yield* sql(guard);
          yield* registry.register(captured, original);
          if (saved.phase === 'Pending') {
            const bucket = yield* native.invoke(async () => {
              const response = await fetchNative(`${origin}/ds/${org}`, { method: 'PUT' });
              await response.body?.cancel();
              return response.ok || response.status === 409;
            });
            if (!bucket) return yield* fail('transport');
            const result = yield* native.invoke(() =>
              sdk.create({
                part: {
                  contentType: 'application/octet-stream',
                  body: Result.getOrThrow(frameLedgerRecord(original)),
                },
              })
            );
            if (!result.ok) return yield* fail('transport');
          }
          yield* refresh();
          return {
            genesisHex: org,
            headHex: Buffer.from(view.head.toBytes()).toString('hex'),
            count: view.length,
            offset: saved.offset,
          } satisfies LabWorkspaceCreationReceipt;
        })
      );
    }),
    /** Borrowed raw SDK ports for an existing P09 owner in this enclosing Scope.
     * That owner must await raw CAS before this owner releases. Host gateway's
     * afterAppend hook refreshes the durable floor before returning its ACK. */
    stream: Object.freeze({
      read: sdk.read.bind(sdk),
      appendCas: sdk.appendCas.bind(sdk),
    }),
  });
});

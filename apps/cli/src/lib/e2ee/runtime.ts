import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Context, Data, Effect, Exit, Layer, Result, Scope, Semaphore } from 'effect';
import {
  InstalledEpochHistory,
  InstalledEpochKeys,
  KeyReceiver,
  KeyRepair,
  LedgerFeed,
  VerifiedLedger,
} from '@lody/e2ee-core';
import {
  Bytes,
  LedgerError,
  hashRecordBytes,
  getCommittedEpochStagingKey,
  hasVerifiedCheckpoint,
  restoreVerifiedState,
  verifyLedgerEffect,
  type RetainedLedgerState,
} from '@lody/e2ee-core/protocol';
import {
  CandidateProtector,
  DeviceIdentity,
  InstalledKeyStore,
  KeyProtector,
  KeyMailbox,
  EpochStagingStore,
  LedgerFeedStore,
  LedgerPinStore,
  LocalStoreError,
  WorkspaceScope,
} from '@lody/e2ee-core/services';
import { type NodeE2eeCustody, type NodeE2eeDevice } from '@lody/e2ee-core/adapters/node-custody';
import {
  sqliteInstalledKeyStore,
  sqliteLedgerFeedStore,
  sqliteLedgerPinStore,
  sqliteReceiveJournal,
  sqliteRepairJournal,
} from '@lody/e2ee-core/adapters/node-sqlite';
import {
  makeStreamsUpdateBinding,
  makeRealtimeContentBinding,
} from '@lody/e2ee-core/adapters/loro-streams';

/** Safe local failures. Raw errors and decrypted material never cross this boundary. */
export class CliE2eeRuntimeError extends Data.TaggedError('CliE2eeRuntimeError')<{
  readonly code:
    | 'invalid-input'
    | 'storage'
    | 'local-evidence-conflict'
    | 'closed'
    | 'local-history-recovery-required'
    | 'trusted-pin-unavailable';
}> {}
const failure = (code: CliE2eeRuntimeError['code']) => new CliE2eeRuntimeError({ code });
const pinFailure = (error: LocalStoreError) =>
  error.store === 'LedgerPinStore' && error.reason === 'corrupt'
    ? failure('trusted-pin-unavailable')
    : error;
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const unhex = (value: string) => {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw failure('invalid-input');
  return new Uint8Array(Buffer.from(value, 'hex'));
};
const sql = <A>(work: () => A) =>
  Effect.try({
    try: work,
    catch: (error) =>
      error instanceof CliE2eeRuntimeError
        ? error
        : failure(
            error instanceof Error &&
              'code' in error &&
              typeof error.code === 'string' &&
              (/^(?:SQLITE_CORRUPT(?:_.*)?|SQLITE_NOTADB)$/.test(error.code) ||
                (error.code === 'ERR_SQLITE_ERROR' &&
                  'errcode' in error &&
                  typeof error.errcode === 'number' &&
                  [11, 26].includes(error.errcode & 0xff)))
              ? 'local-history-recovery-required'
              : 'storage'
          ),
  });
type FeedOrigin = Parameters<typeof LedgerFeed.layer>[0]['origin'];
type HistoryRow = { position: number; record: Uint8Array; locator: string | null };
const SavedOriginSchema = z
  .object({
    bytes: z.string().regex(/^(?:[0-9a-f]{2})+$/),
    genesis: z.string().regex(/^[0-9a-f]{64}$/),
    head: z.string().regex(/^[0-9a-f]{64}$/),
    length: z.number().int().positive(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    offset: z.string().min(1).max(1024),
  })
  .strict();
type SavedOrigin = z.infer<typeof SavedOriginSchema>;
const encodeOrigin = (origin: Extract<FeedOrigin, { kind: 'retained' }>) =>
  JSON.stringify({
    bytes: hex(origin.state.bytes),
    genesis: hex(origin.state.genesis.toBytes()),
    head: hex(origin.state.head.toBytes()),
    length: origin.state.length,
    digest: hex(origin.state.stateDigest.toBytes()),
    offset: origin.offset,
  } satisfies SavedOrigin);
const decodeOrigin = (value: string): Extract<FeedOrigin, { kind: 'retained' }> => {
  const decoded = SavedOriginSchema.parse(JSON.parse(value));
  const state: RetainedLedgerState = {
    bytes: unhex(decoded.bytes),
    genesis: Result.getOrThrow(Bytes.genesisHash(unhex(decoded.genesis))),
    head: Result.getOrThrow(Bytes.recordHash(unhex(decoded.head))),
    length: decoded.length,
    stateDigest: Result.getOrThrow(Bytes.recordHash(unhex(decoded.digest))),
  };
  Result.getOrThrow(restoreVerifiedState(state));
  return { kind: 'retained', state, offset: decoded.offset };
};

/** One machine workspace's offline owner. Opening performs only local I/O. Network
 * refresh and key receipt are explicit callers, never prerequisites for local use.
 * The containing Scope must outlive every binding borrowed by a Streams room.
 */
export const makeCliE2eeRuntime = Effect.fn('CliE2eeRuntime.open')(function* (options: {
  directory: string;
  workspaceId: string;
  custody: Pick<NodeE2eeCustody, 'protection' | 'installed' | 'candidate' | 'deviceCredential'>;
  device: NodeE2eeDevice;
  genesisRecord: Uint8Array;
  mailbox?: KeyMailbox['Service'];
  staging?: Pick<EpochStagingStore['Service'], 'readGroup'>;
}) {
  const genesisRecord = new Uint8Array(options.genesisRecord);
  const genesis = yield* Effect.fromResult(
    Bytes.genesisHash(hashRecordBytes(genesisRecord).toBytes())
  );
  yield* Effect.tryPromise({
    try: () => mkdir(options.directory, { recursive: true, mode: 0o700 }),
    catch: () => failure('storage'),
  });
  const scope = yield* Effect.scope;
  const serial = yield* Semaphore.make(1);
  let closed = false;
  let executionGeneration = 0;

  const db = yield* Effect.acquireRelease(
    sql(() => {
      const connection = new DatabaseSync(join(options.directory, 'history.sqlite'));
      try {
        connection.exec(
          'PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records(position INTEGER PRIMARY KEY,record BLOB NOT NULL,locator TEXT); CREATE TABLE IF NOT EXISTS cache(id INTEGER PRIMARY KEY CHECK(id=1),name TEXT NOT NULL,origin TEXT)'
        );
      } catch (error) {
        connection.close();
        throw error;
      }
      connection
        .prepare('INSERT OR IGNORE INTO records(position,record) VALUES(0,?)')
        .run(genesisRecord);
      connection
        .prepare('INSERT OR IGNORE INTO cache(id,name) VALUES(1,?)')
        .run('ledger-feed.sqlite');
      const first = connection.prepare('SELECT record FROM records WHERE position=0').get();
      if (!(first?.record instanceof Uint8Array) || hex(first.record) !== hex(genesisRecord)) {
        connection.close();
        throw failure('local-evidence-conflict');
      }
      return connection;
    }),
    (connection) => Effect.sync(() => connection.close())
  );
  const base = Layer.mergeAll(
    KeyProtector.layerFromPromises(options.custody.installed),
    CandidateProtector.layerFromPromises(options.custody.candidate),
    Layer.succeed(DeviceIdentity, {
      signer: options.device,
      encryptionKeyPair: options.device.encryption,
    }),
    Layer.succeed(WorkspaceScope, { genesis })
  );
  const stores = Layer.mergeAll(
    sqliteLedgerPinStore({
      path: join(options.directory, 'ledger-pin.sqlite'),
      mode: 'create-or-open',
    }),
    sqliteInstalledKeyStore({
      path: join(options.directory, 'installed-keys.sqlite'),
      mode: 'create-or-open',
    })
  ).pipe(Layer.provideMerge(base));
  const local = yield* Layer.buildWithScope(stores, scope).pipe(Effect.mapError(pinFailure));
  const pins = Context.get(local, LedgerPinStore);
  const pin = yield* pins.read().pipe(Effect.mapError(pinFailure));
  const originals = yield* sql(
    () =>
      db
        .prepare('SELECT position,record,locator FROM records ORDER BY position')
        .all() as unknown as HistoryRow[]
  );
  // Creation journals the genesis original and the cache row; their absence is local damage.
  const lastOriginal = originals.at(-1);
  if (!lastOriginal) return yield* failure('storage');
  const endpoint = {
    head: hashRecordBytes(lastOriginal.record),
    length: originals.length,
  };
  const cache = yield* sql(() => db.prepare('SELECT name,origin FROM cache WHERE id=1').get());
  if (!cache) return yield* failure('storage');
  const journalStore = (name: string) =>
    Layer.effect(
      LedgerFeedStore,
      Effect.gen(function* () {
        const store = yield* LedgerFeedStore;
        return LedgerFeedStore.of({
          ...store,
          append: (expected, records, tail) =>
            Effect.gen(function* () {
              yield* sql(() => {
                db.exec('BEGIN IMMEDIATE');
                try {
                  for (const [index, record] of records.entries()) {
                    const position = expected.count + index;
                    const prior = db
                      .prepare('SELECT record FROM records WHERE position=?')
                      .get(position);
                    if (
                      prior &&
                      (!(prior.record instanceof Uint8Array) || hex(prior.record) !== hex(record))
                    )
                      throw failure('local-evidence-conflict');
                    db.prepare('INSERT OR IGNORE INTO records(position,record) VALUES(?,?)').run(
                      position,
                      record
                    );
                  }
                  db.prepare('UPDATE records SET locator=? WHERE position=?').run(
                    tail.offset,
                    tail.count - 1
                  );
                  db.exec('COMMIT');
                } catch (error) {
                  db.exec('ROLLBACK');
                  throw error;
                }
              }).pipe(
                Effect.mapError(
                  () => new LocalStoreError({ store: 'LedgerFeedStore', reason: 'storage' })
                )
              );
              yield* store.append(expected, records, tail);
            }),
        });
      })
    ).pipe(
      Layer.provide(
        sqliteLedgerFeedStore({ path: join(options.directory, name), mode: 'create-or-open' })
      )
    );
  const openFeed = Effect.fnUntraced(function* (
    name: string,
    origin: FeedOrigin,
    expected = endpoint
  ) {
    if (!/^ledger-feed(?:-[0-9a-f-]{36})?\.sqlite$/.test(name)) return yield* failure('storage');
    const feedScope = yield* Scope.make();
    const opened = yield* Effect.result(
      Layer.buildWithScope(
        LedgerFeed.layer({
          origin,
          expected,
          budget: { maxRecords: 1_000_000, maxBytes: 64 * 1024 * 1024 },
        }).pipe(Layer.provideMerge(journalStore(name)), Layer.provideMerge(base)),
        feedScope
      )
    );
    if (Result.isFailure(opened)) {
      yield* Scope.close(feedScope, Exit.void);
      return yield* opened.failure;
    }
    yield* Effect.addFinalizer(() => Scope.close(feedScope, Exit.void));
    return Context.get(opened.success, LedgerFeed);
  });
  let compactedAt = 1;
  const cached = yield* Effect.result(
    Effect.gen(function* () {
      const origin = yield* sql(() =>
        typeof cache.origin === 'string'
          ? decodeOrigin(cache.origin)
          : { kind: 'genesis' as const, record: genesisRecord }
      );
      if (origin.kind === 'retained') {
        if (!pin || pin.length < origin.state.length) return yield* failure('storage');
        compactedAt = origin.state.length;
      }
      return yield* openFeed(String(cache.name), origin);
    })
  );
  let feed: LedgerFeed['Service'];
  if (Result.isSuccess(cached)) feed = cached.success;
  else {
    const view = yield* verifyLedgerEffect({
      anchor: genesis,
      records: originals.map((row) => row.record),
      checkpoint: endpoint,
    }).pipe(
      Effect.mapError((error) =>
        error instanceof LedgerError &&
        ![
          'native-unavailable',
          'upgrade-required',
          'unknown-version',
          'unknown-operation',
        ].includes(error.code)
          ? failure('local-history-recovery-required')
          : error
      )
    );
    if (pin && !Result.getOrThrow(hasVerifiedCheckpoint(view, pin)))
      return yield* failure('local-evidence-conflict');
    const name = `ledger-feed-${randomUUID()}.sqlite`;
    feed = yield* openFeed(
      name,
      { kind: 'genesis', record: genesisRecord },
      { length: 1, head: hashRecordBytes(genesisRecord) }
    );
    if (lastOriginal.locator)
      yield* feed.accept(
        {
          requestOffset: '-1',
          nextOffset: lastOriginal.locator,
          records: originals.map((row) => row.record),
          upToDate: true,
        },
        endpoint
      );
    yield* sql(() => db.prepare('UPDATE cache SET name=?,origin=NULL WHERE id=1').run(name));
    // A retired cache is disposable. Cleanup must never undo a verified rebuild.
    for (const suffix of /^ledger-feed(?:-[0-9a-f-]{36})?\.sqlite$/.test(String(cache.name))
      ? ['', '-wal', '-shm']
      : [])
      yield* Effect.tryPromise({
        try: () => unlink(join(options.directory, String(cache.name) + suffix)),
        catch: () => failure('storage'),
      }).pipe(Effect.catch(() => Effect.void));
  }
  const verifiedLayer = VerifiedLedger.layer.pipe(
    Layer.provideMerge(LedgerFeed.viewSource.pipe(Layer.provide(Layer.succeed(LedgerFeed, feed)))),
    Layer.provideMerge(Layer.succeed(LedgerPinStore, pins)),
    Layer.provideMerge(base)
  );
  const keysLayer = InstalledEpochKeys.layer.pipe(
    Layer.provideMerge(verifiedLayer),
    Layer.provideMerge(Layer.succeed(InstalledKeyStore, Context.get(local, InstalledKeyStore)))
  );
  const context = yield* Layer.buildWithScope(
    InstalledEpochHistory.layer.pipe(Layer.provideMerge(keysLayer)),
    scope
  );
  const verified = Context.get(context, VerifiedLedger);
  const installed = Context.get(context, InstalledEpochKeys);
  const history = Context.get(context, InstalledEpochHistory);
  yield* verified.current();
  const receiving = options.mailbox
    ? yield* Layer.buildWithScope(
        Layer.mergeAll(KeyReceiver.layer, KeyRepair.layer).pipe(
          Layer.provideMerge(Layer.succeed(KeyMailbox, options.mailbox)),
          Layer.provideMerge(
            sqliteReceiveJournal({
              path: join(options.directory, 'receive.sqlite'),
              mode: 'create-or-open',
            })
          ),
          Layer.provideMerge(
            sqliteRepairJournal({
              path: join(options.directory, 'repair.sqlite'),
              mode: 'create-or-open',
            })
          ),
          Layer.provideMerge(Layer.succeed(InstalledEpochKeys, installed)),
          Layer.provideMerge(Layer.succeed(VerifiedLedger, verified)),
          Layer.provideMerge(base)
        ),
        scope
      )
    : undefined;
  const receiver = receiving ? Context.get(receiving, KeyReceiver) : undefined;
  const repair = receiving ? Context.get(receiving, KeyRepair) : undefined;
  const guard = () => (closed ? Effect.fail(failure('closed')) : Effect.void);
  let retainedWriteEpoch: number | undefined;
  const status = Effect.fnUntraced(function* () {
    yield* guard();
    const state = yield* feed.current();
    const view = yield* verified.current();
    const epoch = view.inspectState().epoch.number;
    const key = yield* Effect.result(installed.check(epoch));
    if (Result.isFailure(key) && !['missing-key', 'unauthorized'].includes(key.failure.reason))
      return yield* key.failure;
    let writeEpoch: number | null = Result.isSuccess(key) ? epoch : null;
    if (Result.isFailure(key) && key.failure.reason === 'missing-key') {
      for (let candidate = retainedWriteEpoch ?? epoch - 1; candidate >= 0; candidate -= 1) {
        const older = yield* Effect.result(installed.check(candidate));
        if (Result.isSuccess(older)) {
          writeEpoch = candidate;
          break;
        }
        if (older.failure.reason === 'unauthorized') break;
        if (older.failure.reason !== 'missing-key') return yield* older.failure;
      }
    }
    if (writeEpoch !== null) retainedWriteEpoch = writeEpoch;
    return {
      writeEpoch,
      length: view.length,
      headHash: hex(view.head.toBytes()),
      position: state.bootstrap ? null : state.offset,
      epoch,
      rotationRequired: view.inspectState().epoch.rotationRequired,
      hasCurrentKey: Result.isSuccess(key),
      devicePublicKey: hex(options.device.publicKey.toBytes()),
      membershipId: (() => {
        const device = view.inspectState().devices.get(hex(options.device.publicKey.toBytes()));
        return device ? hex(device.membershipId.toBytes()) : null;
      })(),
      protection: options.custody.protection,
    };
  });
  // Fence new callers, then drain admitted local writes before SQLite closes.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      yield* serial.withPermit(Effect.void);
    })
  );
  return {
    status: () => serial.withPermit(status()),
    /** Current verified authority only; execution freshness must come from an authenticated read. */
    executionLedger: () =>
      serial.withPermit(
        Effect.gen(function* () {
          yield* guard();
          return yield* verified.current();
        })
      ),
    pairingEvidence: () =>
      serial.withPermit(
        Effect.gen(function* () {
          yield* guard();
          const view = yield* verified.current();
          const records = yield* sql(() =>
            db
              .prepare('SELECT record FROM records WHERE position < ? ORDER BY position')
              .all(view.length)
              .map((row) => new Uint8Array(row.record as Uint8Array))
          );
          return { view, records };
        })
      ),
    /** The caller supplies raw, bounded cloud DTO pages. Every suffix is verified locally. */
    ingest: (page: {
      startIndex: number;
      recordsHex: readonly string[];
      position: string;
      nextCursor: string | null;
      checkpoint: { length: number; headHash: string };
    }) =>
      serial.withPermit(
        Effect.gen(function* () {
          yield* guard();
          const state = yield* feed.current();
          const start = state.bootstrap ? 0 : state.view.length;
          if (
            !Number.isSafeInteger(page.startIndex) ||
            page.startIndex < 0 ||
            page.startIndex > start ||
            page.recordsHex.length > 64 ||
            !page.position.startsWith(
              `p1:${options.workspaceId}:${page.startIndex + page.recordsHex.length}:`
            )
          )
            return yield* failure('invalid-input');
          executionGeneration++;
          const records = yield* sql(() => page.recordsHex.map(unhex));
          const length = page.startIndex + records.length;
          if (
            length > page.checkpoint.length ||
            (page.nextCursor === null) !== (length === page.checkpoint.length)
          )
            return yield* failure('invalid-input');
          const previous =
            records.length === 0 && length < start
              ? yield* sql(() =>
                  db.prepare('SELECT record FROM records WHERE position=?').get(length - 1)
                )
              : undefined;
          const lastRecord = records.at(-1);
          const head = lastRecord
            ? hashRecordBytes(lastRecord)
            : previous
              ? hashRecordBytes(previous.record as Uint8Array)
              : state.view.head;
          if (length === page.checkpoint.length && hex(head.toBytes()) !== page.checkpoint.headHash)
            return yield* failure('local-evidence-conflict');
          const overlap = Math.max(0, Math.min(length, start) - page.startIndex);
          if (overlap) {
            const existing = yield* sql(() =>
              db
                .prepare(
                  'SELECT record FROM records WHERE position>=? AND position<? ORDER BY position'
                )
                .all(page.startIndex, page.startIndex + overlap)
            );
            if (
              existing.length !== overlap ||
              existing.some((row, index) => {
                const incoming = records[index];
                return (
                  !(row.record instanceof Uint8Array) ||
                  incoming === undefined ||
                  hex(row.record) !== hex(incoming)
                );
              })
            )
              return yield* failure('local-evidence-conflict');
          }
          // A concurrent refresh may have already accepted exactly these bytes.
          if (!state.bootstrap && length <= start) return yield* status();
          yield* feed.accept(
            {
              requestOffset: state.offset,
              nextOffset: page.position,
              records: records.slice(overlap),
              upToDate: page.nextCursor === null,
            },
            { length, head }
          );
          yield* verified.current();
          if (length - compactedAt >= 64) {
            const origin = yield* feed
              .rebase()
              .pipe(Effect.provideService(VerifiedLedger, verified));
            yield* sql(() =>
              db.prepare('UPDATE cache SET origin=? WHERE id=1').run(encodeOrigin(origin))
            );
            compactedAt = length;
          }
          return yield* status();
        })
      ),
    executionGeneration: () => executionGeneration,
    readSharingEpochKey: (epoch: number) => history.read(epoch),
    binding: (resource: string, model: 'loro' | 'flock', writeEpoch: number | 'current') =>
      makeStreamsUpdateBinding({
        genesis,
        resource,
        model,
        writeEpoch,
        signer: options.device,
        ledger: () => verified.current(),
        readEpochKey: (epoch) => history.read(epoch),
      }),
    realtimeBinding: (resource: string) =>
      makeRealtimeContentBinding({
        genesis,
        resource,
        signer: options.device,
        ledger: () => guard().pipe(Effect.andThen(verified.current())),
        readEpochKey: (epoch) => history.read(epoch),
      }),
    /** Coalescing belongs to the caller's single background refresh owner. */
    receiveKeys: () =>
      receiver
        ? Effect.gen(function* () {
            yield* guard();
            const view = yield* verified.current();
            const epoch = view.inspectState().epoch.number;
            const checked = yield* Effect.result(installed.check(epoch));
            if (options.staging && epoch > 0 && Result.isFailure(checked)) {
              if (checked.failure.reason !== 'missing-key') return yield* checked.failure;
              const located = getCommittedEpochStagingKey(view, epoch);
              if (Result.isSuccess(located)) {
                // Staging access is optional (late recipients are denied). Mailbox
                // reception independently authenticates and installs its own envelopes.
                const group = yield* options.staging
                  .readGroup(located.success)
                  .pipe(Effect.catch(() => Effect.succeed(null)));
                if (
                  group?.envelopes.some(
                    (row) => row.recipient === hex(options.device.publicKey.toBytes())
                  )
                )
                  yield* receiver.receiveStagedGroup(group);
              } else if (view.verification !== 'endorsed-snapshot') return yield* located.failure;
            }
            if (repair) yield* repair.flush();
            yield* receiver.resume();
            for (let cursor: string | null = null; ;) {
              const page: { readonly processed: number; readonly next: string | null } =
                yield* receiver.fetchAndInstall(cursor, 100).pipe(
                  Effect.catchTag('MailboxInstallError', (error) =>
                    Effect.gen(function* () {
                      if (repair && error.cryptographicRejection) {
                        yield* repair.enqueue(
                          `rejected:${error.epoch}:${error.frameDigest}`,
                          error.frameDigest
                        );
                        yield* repair.flush();
                      }
                      return yield* Effect.fail(error);
                    })
                  )
                );
              if (!page.next) break;
              cursor = page.next;
            }
            yield* receiver.flushReports();
            return undefined;
          })
        : Effect.fail(failure('invalid-input')),
    credential: () => options.custody.deviceCredential(genesis, options.device.publicKey),
  };
});
export type CliE2eeRuntime = Effect.Success<ReturnType<typeof makeCliE2eeRuntime>>;

/** Browser persistence only. Stored bytes and receipts never establish approval or ledger authority. @module */
import { Context, Effect, Layer, Result, Schema } from 'effect';
import * as Bytes from '../../internal/foundation/bytes';
import { bytesEqual } from '../../internal/foundation/cbor';
import { keyId } from '../../internal/foundation/identifiers';
import { LedgerPinStore, SubmissionJournal, type SubmissionOutcome } from '../../services/ledger';
import { LedgerFeedStore, type LedgerFeedTail } from '../../services/stores';
import { WorkspaceScope } from '../../services/workspace';
import { LocalStoreError } from '../../services/errors';
import {
  ClientPairingOriginalStore,
  type ClientPairingKey,
  type ClientPairingOriginal,
} from '../../services/client-pairing';
import type { ClientCustodyBinding } from '../../services/client-custody';
import type { LedgerCheckpoint } from '../../internal/ledger';
import { DatabaseOwner, failure, type Transaction, type TABLES } from './database';

/** Stable database routing. Never change the name on device replacement or ordinary cache cleanup. */
export interface IndexedDbStoreOptions {
  /** Stable browser-profile database name; belongs to one account/workspace/genesis, not one device. */
  readonly databaseName: string;
  /** Captured account routing id; it grants no membership. */
  readonly accountId: string;
  /** Captured workspace routing id; WorkspaceScope independently supplies the pinned genesis. */
  readonly workspaceId: string;
  /** Only explicit provisioning may create storage. Existing-mode absence blocks instead of resetting state. */
  readonly mode: 'create-or-open' | 'open-existing';
}
const MAX_BLOB = 16 * 1024 * 1024;
const Meta = Schema.Struct({
  version: Schema.Literal(1),
  accountId: Schema.String,
  workspaceId: Schema.String,
  genesis: Schema.String,
});
const Checkpoint = Schema.Struct({ head: Schema.Uint8Array, length: Schema.Int });
const Tail = Schema.Struct({
  head: Schema.Uint8Array,
  count: Schema.Int,
  offset: Schema.String,
  bootstrap: Schema.Boolean,
  bytes: Schema.Int,
});
const Pin = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Int,
  checkpoint: Schema.NullOr(Checkpoint),
});
const Feed = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Int,
  origin: Schema.NullOr(Schema.Uint8Array),
  originCount: Schema.Int,
  tail: Schema.NullOr(Tail),
});
const Submission = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Int,
  record: Schema.NullOr(Schema.Uint8Array),
  outcome: Schema.NullOr(Schema.Literals(['Committed', 'Conflict'])),
  checkpoint: Schema.NullOr(Checkpoint),
});
const Binding = Schema.Struct({
  accountId: Schema.String,
  workspaceId: Schema.String,
  genesis: Schema.String,
  device: Schema.String,
  installationId: Schema.String,
});
const Pairing = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  binding: Binding,
  purpose: Schema.Literals(['request', 'approval', 'claim']),
  pairingSessionId: Schema.String,
  revision: Schema.Int,
  original: Schema.Uint8Array,
  receipt: Schema.NullOr(Schema.Uint8Array),
});
const decodeMeta = Schema.decodeUnknownSync(Meta, { onExcessProperty: 'error' }),
  decodePin = Schema.decodeUnknownSync(Pin, { onExcessProperty: 'error' }),
  decodeFeed = Schema.decodeUnknownSync(Feed, { onExcessProperty: 'error' }),
  decodeSubmission = Schema.decodeUnknownSync(Submission, { onExcessProperty: 'error' }),
  decodePairing = Schema.decodeUnknownSync(Pairing, { onExcessProperty: 'error' });
const parse = <A>(store: string, work: () => A): A => {
  try {
    return work();
  } catch (cause) {
    throw cause instanceof LocalStoreError ? cause : failure(store, 'corrupt');
  }
};
const integer = (n: number, min = 0) => Number.isSafeInteger(n) && n >= min;
const blob = (value: Uint8Array, max = MAX_BLOB) => value.length > 0 && value.length <= max;
const sameBytes = (a: Uint8Array | null, b: Uint8Array | null) =>
  a === null ? b === null : b !== null && bytesEqual(a, b);
const validCheckpoint = (v: typeof Checkpoint.Type) => v.head.length === 32 && integer(v.length, 1);
const sameCheckpoint = (a: typeof Checkpoint.Type | null, b: typeof Checkpoint.Type | null) =>
  a === null ? b === null : b !== null && a.length === b.length && bytesEqual(a.head, b.head);
const sameTail = (a: LedgerFeedTail | null, b: LedgerFeedTail | null) =>
  a === null
    ? b === null
    : b !== null &&
      a.count === b.count &&
      a.offset === b.offset &&
      a.bootstrap === b.bootstrap &&
      a.bytes === b.bytes &&
      bytesEqual(a.head, b.head);
const nextRevision = (store: string, revision: number) => {
  if (!integer(revision) || revision === Number.MAX_SAFE_INTEGER) throw failure(store, 'capacity');
  return revision + 1;
};
const rawCheckpoint = (store: string, value: LedgerCheckpoint) =>
  parse(store, () => {
    const next = { head: value.head.toBytes(), length: value.length };
    if (!validCheckpoint(next)) throw failure(store, 'corrupt');
    return next;
  });
const publicCheckpoint = (value: typeof Checkpoint.Type | null) =>
  value === null
    ? null
    : { head: Result.getOrThrow(Bytes.recordHash(value.head)), length: value.length };
const copyTail = (store: string, input: LedgerFeedTail) =>
  parse(store, () => {
    if (
      !(input.head instanceof Uint8Array) ||
      input.head.length !== 32 ||
      !integer(input.count, 1) ||
      !integer(input.bytes, 1) ||
      typeof input.offset !== 'string' ||
      input.offset.length < 1 ||
      input.offset.length > 1024 ||
      typeof input.bootstrap !== 'boolean'
    )
      throw failure(store, 'corrupt');
    return { ...input, head: new Uint8Array(input.head) };
  });
const pinRow = (value: unknown) =>
  parse('LedgerPinStore', () => {
    const r = decodePin(value);
    if (
      !integer(r.revision) ||
      (r.checkpoint === null) !== (r.revision === 0) ||
      (r.checkpoint && !validCheckpoint(r.checkpoint))
    )
      throw failure('LedgerPinStore', 'corrupt');
    return r;
  });
const feedRow = (value: unknown) =>
  parse('LedgerFeedStore', () => {
    const r = decodeFeed(value);
    if (
      !integer(r.revision) ||
      !integer(r.originCount) ||
      (r.origin === null) !== (r.tail === null) ||
      (r.origin === null) !== (r.revision === 0)
    )
      throw failure('LedgerFeedStore', 'corrupt');
    if (r.origin === null) {
      if (r.originCount !== 0) throw failure('LedgerFeedStore', 'corrupt');
    } else {
      if (
        !blob(r.origin) ||
        !integer(r.originCount, 1) ||
        !r.tail ||
        r.tail.count < r.originCount ||
        r.tail.bytes < r.origin.length
      )
        throw failure('LedgerFeedStore', 'corrupt');
      copyTail('LedgerFeedStore', r.tail);
    }
    return r;
  });
const submissionRow = (value: unknown) =>
  parse('SubmissionJournal', () => {
    const r = decodeSubmission(value);
    if (
      !integer(r.revision) ||
      (r.record !== null && !blob(r.record, 8192)) ||
      (r.outcome !== null && (r.record === null || r.checkpoint === null)) ||
      (r.revision === 0 && (r.record !== null || r.outcome !== null || r.checkpoint !== null)) ||
      (r.revision > 0 && r.record === null && r.checkpoint === null) ||
      (r.checkpoint !== null && !validCheckpoint(r.checkpoint))
    )
      throw failure('SubmissionJournal', 'corrupt');
    return r;
  });
const sameBinding = (a: typeof Binding.Type, b: typeof Binding.Type) =>
  a.accountId === b.accountId &&
  a.workspaceId === b.workspaceId &&
  a.genesis === b.genesis &&
  a.device === b.device &&
  a.installationId === b.installationId;
const pairingId = (b: typeof Binding.Type, purpose: string, session: string) =>
  JSON.stringify([
    b.accountId,
    b.workspaceId,
    b.genesis,
    b.device,
    b.installationId,
    purpose,
    session,
  ]);
const pairingPrefix = (b: typeof Binding.Type) =>
  JSON.stringify([b.accountId, b.workspaceId, b.genesis, b.device, b.installationId]).slice(0, -1) +
  ',';
const pairingRow = (value: unknown, b: typeof Binding.Type, id: string) =>
  parse('ClientPairingOriginalStore', () => {
    const r = decodePairing(value);
    if (
      r.id !== id ||
      !sameBinding(r.binding, b) ||
      !/^([0-9a-f]{32})$/.test(r.pairingSessionId) ||
      r.id !== pairingId(b, r.purpose, r.pairingSessionId) ||
      !blob(r.original) ||
      (r.receipt !== null && !blob(r.receipt)) ||
      !((r.revision === 1 && r.receipt === null) || (r.revision === 2 && r.receipt !== null))
    )
      throw failure('ClientPairingOriginalStore', 'corrupt');
    return r;
  });
const pairingValue = (r: typeof Pairing.Type): ClientPairingOriginal => ({
  revision: r.revision,
  original: new Uint8Array(r.original),
  receipt: r.receipt === null ? null : new Uint8Array(r.receipt),
});
const samePairing = (a: ClientPairingOriginal, b: ClientPairingOriginal) =>
  a.revision === b.revision && sameBytes(a.original, b.original) && sameBytes(a.receipt, b.receipt);
function verifiedWrite<A>(
  tx: Transaction,
  table: (typeof TABLES)[number],
  key: IDBValidKey,
  next: A,
  read: (v: unknown) => A,
  equal: (a: A, b: A) => boolean,
  done: (v: A) => void,
  store: string
) {
  tx.request(tx.store(table).put(next, key), () =>
    tx.request(tx.store(table).get(key), (v) => {
      const actual = read(v);
      if (!equal(actual, next)) throw failure(store, 'corrupt');
      done(actual);
    })
  );
}

/** Load and destructive rebase must accept exactly the same stored suffix structure. */
function readSuffix(
  tx: Transaction,
  origin: Uint8Array,
  originCount: number,
  tail: LedgerFeedTail,
  accept: ((record: Uint8Array) => void) | undefined,
  done: () => void
) {
  let position = originCount,
    total = origin.length;
  tx.request(tx.store('records').openCursor(), (cursor) => {
    if (!cursor) {
      if (position !== tail.count || total !== tail.bytes)
        throw failure('LedgerFeedStore', 'corrupt');
      done();
      return;
    }
    if (
      position >= tail.count ||
      cursor.key !== position + 1 ||
      !(cursor.value instanceof Uint8Array) ||
      !blob(cursor.value, 8192)
    )
      throw failure('LedgerFeedStore', 'corrupt');
    position += 1;
    total += cursor.value.length;
    if (!integer(total) || total > tail.bytes) throw failure('LedgerFeedStore', 'corrupt');
    accept?.(cursor.value);
    cursor.continue();
  });
}

/**
 * Account/workspace/genesis-bound IDB ledger/feed/submission and pairing-original
 * ports. Short strict-durability transactions read back writes and resolve only
 * on complete; aborts never publish progress. No crypto/network await spans one.
 * Scope release stops admission and drains admitted transactions. Open failures,
 * missing existing state and corrupt bindings never reset storage or authorize use.
 * Pin read captures this owner's revision; write CAS requires that read, and a
 * conflict requires a fresh read and independent continuation check. Provide one
 * sequential VerifiedLedger owner per Layer; independent tabs have separate CAS tokens.
 */
export const indexedDbClientStores = (options: IndexedDbStoreOptions) => {
  const captured = {
    databaseName: options.databaseName,
    accountId: options.accountId,
    workspaceId: options.workspaceId,
    mode: options.mode,
  };
  return Layer.effectContext(
    Effect.gen(function* () {
      const genesis = (yield* WorkspaceScope).genesis;
      const bound = yield* Effect.try({
        try: () => {
          for (const v of [captured.databaseName, captured.accountId, captured.workspaceId])
            if (typeof v !== 'string' || v.length < 1 || v.length > 1024)
              throw failure('IndexedDbClientStores', 'corrupt');
          if (captured.mode !== 'create-or-open' && captured.mode !== 'open-existing')
            throw failure('IndexedDbClientStores', 'corrupt');
          return {
            accountId: captured.accountId,
            workspaceId: captured.workspaceId,
            genesis: keyId(Result.getOrThrow(Bytes.genesisHash(genesis.toBytes())).toBytes()),
          };
        },
        catch: (cause) =>
          cause instanceof LocalStoreError ? cause : failure('IndexedDbClientStores', 'corrupt'),
      });
      const db = new DatabaseOwner(bound, captured.databaseName, captured.mode);
      yield* Effect.addFinalizer(() => db.close);
      yield* db.open;
      const checkBinding = (value: unknown) =>
        parse('IndexedDbClientStores', () => {
          const r = decodeMeta(value);
          if (
            r.accountId !== bound.accountId ||
            r.workspaceId !== bound.workspaceId ||
            r.genesis !== bound.genesis
          )
            throw failure('IndexedDbClientStores', 'corrupt');
        });
      yield* db.run('IndexedDbClientStores', [], 'readonly', checkBinding, (_tx, done) =>
        done(undefined)
      );
      const run = <A>(
        store: string,
        tables: readonly (typeof TABLES)[number][],
        mode: IDBTransactionMode,
        work: (tx: Transaction, finish: (v: A) => void) => void
      ) => db.run(store, tables, mode, checkBinding, work);
      const attempt = <A>(name: string, body: () => Effect.Effect<A, LocalStoreError>) =>
        Effect.suspend(() => {
          try {
            return body();
          } catch (cause) {
            return Effect.fail(cause instanceof LocalStoreError ? cause : failure(name, 'corrupt'));
          }
        });
      let pinRevision: number | undefined;
      const pins = LedgerPinStore.of({
        read: () =>
          run<typeof Pin.Type>('LedgerPinStore', ['pin'], 'readonly', (tx, done) =>
            tx.request(tx.store('pin').get(0), (v) => done(pinRow(v)))
          ).pipe(
            Effect.map((r) => {
              pinRevision = r.revision;
              return publicCheckpoint(r.checkpoint);
            }),
            Effect.tapError(() =>
              Effect.sync(() => {
                pinRevision = undefined;
              })
            )
          ),
        write: (checkpoint) =>
          attempt('LedgerPinStore', () => {
            const next = rawCheckpoint('LedgerPinStore', checkpoint),
              expected = pinRevision;
            if (expected === undefined) return Effect.fail(failure('LedgerPinStore', 'conflict'));
            return run<typeof Pin.Type>('LedgerPinStore', ['pin'], 'readwrite', (tx, done) =>
              tx.request(tx.store('pin').get(0), (v) => {
                const r = pinRow(v);
                if (sameCheckpoint(r.checkpoint, next)) {
                  done(r);
                  return;
                }
                if (r.revision !== expected || (r.checkpoint && next.length <= r.checkpoint.length))
                  throw failure('LedgerPinStore', 'conflict');
                const updated = {
                  version: 1 as const,
                  revision: nextRevision('LedgerPinStore', r.revision),
                  checkpoint: next,
                };
                verifiedWrite(
                  tx,
                  'pin',
                  0,
                  updated,
                  pinRow,
                  (a, b) => a.revision === b.revision && sameCheckpoint(a.checkpoint, b.checkpoint),
                  done,
                  'LedgerPinStore'
                );
              })
            ).pipe(
              Effect.map((r) => {
                pinRevision = r.revision;
              }),
              Effect.tapError(() =>
                Effect.sync(() => {
                  pinRevision = undefined;
                })
              )
            );
          }),
      });
      const feed = LedgerFeedStore.of({
        tail: () =>
          run<LedgerFeedTail | null>('LedgerFeedStore', ['feed'], 'readonly', (tx, done) =>
            tx.request(tx.store('feed').get(0), (v) => {
              const r = feedRow(v);
              done(r.tail ? copyTail('LedgerFeedStore', r.tail) : null);
            })
          ),
        load: (maxRecords) =>
          attempt('LedgerFeedStore', () => {
            if (!integer(maxRecords)) throw failure('LedgerFeedStore', 'capacity');
            return run('LedgerFeedStore', ['feed', 'records'], 'readonly', (tx, done) =>
              tx.request(tx.store('feed').get(0), (v) => {
                const r = feedRow(v);
                if (!r.origin || !r.tail) {
                  done(null);
                  return;
                }
                const origin = new Uint8Array(r.origin),
                  tail = copyTail('LedgerFeedStore', r.tail),
                  originCount = r.originCount;
                if (tail.count - originCount > maxRecords)
                  throw failure('LedgerFeedStore', 'capacity');
                const records: Uint8Array[] = [];
                readSuffix(
                  tx,
                  origin,
                  originCount,
                  tail,
                  (value) => {
                    records.push(new Uint8Array(value));
                  },
                  () => done({ origin, originCount, tail, records })
                );
              })
            );
          }),
        initialize: (input, originCount, tailInput) =>
          attempt('LedgerFeedStore', () => {
            if (!(input instanceof Uint8Array) || !blob(input) || !integer(originCount, 1))
              throw failure('LedgerFeedStore', 'corrupt');
            const origin = new Uint8Array(input),
              tail = copyTail('LedgerFeedStore', tailInput);
            if (tail.count !== originCount || tail.bytes !== origin.length)
              throw failure('LedgerFeedStore', 'corrupt');
            return run<void>('LedgerFeedStore', ['feed', 'records'], 'readwrite', (tx, done) =>
              tx.request(tx.store('feed').get(0), (v) => {
                const r = feedRow(v);
                if (r.origin) throw failure('LedgerFeedStore', 'conflict');
                tx.request(tx.store('records').count(), (count) => {
                  if (count !== 0) throw failure('LedgerFeedStore', 'corrupt');
                  const updated = { version: 1 as const, revision: 1, origin, originCount, tail };
                  verifiedWrite(
                    tx,
                    'feed',
                    0,
                    updated,
                    feedRow,
                    (a, b) =>
                      a.revision === b.revision &&
                      a.originCount === b.originCount &&
                      sameBytes(a.origin, b.origin) &&
                      sameTail(a.tail, b.tail),
                    () => done(undefined),
                    'LedgerFeedStore'
                  );
                });
              })
            );
          }),
        append: (expectedInput, inputs, nextInput) =>
          attempt('LedgerFeedStore', () => {
            const expected = copyTail('LedgerFeedStore', expectedInput),
              next = copyTail('LedgerFeedStore', nextInput);
            const records = inputs.map((input) => {
              if (!(input instanceof Uint8Array) || !blob(input, 8192))
                throw failure('LedgerFeedStore', 'corrupt');
              return new Uint8Array(input);
            });
            if (
              next.count !== expected.count + records.length ||
              next.bytes !== expected.bytes + records.reduce((n, r) => n + r.length, 0) ||
              (!records.length && !bytesEqual(next.head, expected.head))
            )
              throw failure('LedgerFeedStore', 'corrupt');
            return run<void>('LedgerFeedStore', ['feed', 'records'], 'readwrite', (tx, done) =>
              tx.request(tx.store('feed').get(0), (v) => {
                const r = feedRow(v);
                if (!r.origin || !sameTail(r.tail, expected))
                  throw failure('LedgerFeedStore', 'conflict');
                const write = (i: number): void => {
                  if (i === records.length) {
                    const updated = {
                      ...r,
                      revision: nextRevision('LedgerFeedStore', r.revision),
                      tail: next,
                    };
                    verifiedWrite(
                      tx,
                      'feed',
                      0,
                      updated,
                      feedRow,
                      (a, b) =>
                        a.revision === b.revision &&
                        a.originCount === b.originCount &&
                        sameBytes(a.origin, b.origin) &&
                        sameTail(a.tail, b.tail),
                      () => done(undefined),
                      'LedgerFeedStore'
                    );
                    return;
                  }
                  const position = expected.count + i + 1;
                  tx.request(tx.store('records').add(records[i]!, position), () =>
                    tx.request(tx.store('records').get(position), (actual) => {
                      if (!(actual instanceof Uint8Array) || !bytesEqual(actual, records[i]!))
                        throw failure('LedgerFeedStore', 'corrupt');
                      write(i + 1);
                    })
                  );
                };
                write(0);
              })
            );
          }),
        rebase: (expectedInput, input, originCount, tailInput) =>
          attempt('LedgerFeedStore', () => {
            const expected = copyTail('LedgerFeedStore', expectedInput),
              tail = copyTail('LedgerFeedStore', tailInput);
            if (
              !(input instanceof Uint8Array) ||
              !blob(input) ||
              originCount !== expected.count ||
              tail.count !== originCount ||
              tail.bootstrap ||
              tail.offset !== expected.offset ||
              !bytesEqual(tail.head, expected.head) ||
              tail.bytes !== input.length
            )
              throw failure('LedgerFeedStore', 'corrupt');
            const origin = new Uint8Array(input);
            return run<void>('LedgerFeedStore', ['feed', 'records'], 'readwrite', (tx, done) =>
              tx.request(tx.store('feed').get(0), (v) => {
                const r = feedRow(v);
                if (!r.origin || !sameTail(r.tail, expected))
                  throw failure('LedgerFeedStore', 'conflict');
                const finish = () =>
                  tx.request(tx.store('records').count(), (count) => {
                    if (count !== 0) throw failure('LedgerFeedStore', 'corrupt');
                    const updated = {
                      version: 1 as const,
                      revision: nextRevision('LedgerFeedStore', r.revision),
                      origin,
                      originCount,
                      tail,
                    };
                    verifiedWrite(
                      tx,
                      'feed',
                      0,
                      updated,
                      feedRow,
                      (a, b) =>
                        a.revision === b.revision &&
                        a.originCount === b.originCount &&
                        sameBytes(a.origin, b.origin) &&
                        sameTail(a.tail, b.tail),
                      () => done(undefined),
                      'LedgerFeedStore'
                    );
                  });
                // Validate every row before any deletion, under the same readwrite lock.
                // A count or a numeric range alone misses fractional/extra keys and malformed rows.
                readSuffix(tx, r.origin, r.originCount, expected, undefined, () => {
                  if (originCount === r.originCount) finish();
                  else
                    tx.request(
                      tx.store('records').delete(IDBKeyRange.bound(r.originCount + 1, originCount)),
                      finish
                    );
                });
              })
            );
          }),
      });
      const submission = (work: (tx: Transaction, done: (v: void) => void) => void) =>
        run<void>('SubmissionJournal', ['submission'], 'readwrite', work);
      const writeSubmission = (
        tx: Transaction,
        r: typeof Submission.Type,
        done: (v: void) => void
      ) =>
        verifiedWrite(
          tx,
          'submission',
          0,
          r,
          submissionRow,
          (a, b) =>
            a.revision === b.revision &&
            a.outcome === b.outcome &&
            sameBytes(a.record, b.record) &&
            sameCheckpoint(a.checkpoint, b.checkpoint),
          () => done(undefined),
          'SubmissionJournal'
        );
      const checkAnchor = (anchor: Bytes.GenesisHash) => {
        if (keyId(anchor.toBytes()) !== bound.genesis)
          throw failure('SubmissionJournal', 'corrupt');
      };
      const ownedRecord = (record: Uint8Array) => {
        if (!(record instanceof Uint8Array) || !blob(record, 8192))
          throw failure('SubmissionJournal', 'corrupt');
        return new Uint8Array(record);
      };
      const transition = (
        anchor: Bytes.GenesisHash,
        input: Uint8Array,
        beforeInput: LedgerCheckpoint | null,
        afterInput: LedgerCheckpoint,
        outcome: SubmissionOutcome | null
      ) =>
        attempt('SubmissionJournal', () => {
          checkAnchor(anchor);
          const record = ownedRecord(input),
            before = beforeInput ? rawCheckpoint('SubmissionJournal', beforeInput) : null,
            after = rawCheckpoint('SubmissionJournal', afterInput);
          return submission((tx, done) =>
            tx.request(tx.store('submission').get(0), (v) => {
              const r = submissionRow(v);
              if (
                !sameBytes(r.record, record) ||
                !sameCheckpoint(r.checkpoint, before) ||
                (r.outcome !== null && r.outcome !== outcome) ||
                after.length < (before?.length ?? 0) ||
                (before && after.length === before.length && !bytesEqual(after.head, before.head))
              )
                throw failure('SubmissionJournal', 'conflict');
              writeSubmission(
                tx,
                {
                  ...r,
                  revision: nextRevision('SubmissionJournal', r.revision),
                  record,
                  checkpoint: after,
                  outcome,
                },
                done
              );
            })
          );
        });
      const submissions = SubmissionJournal.of({
        load: (anchor) =>
          attempt('SubmissionJournal', () => {
            checkAnchor(anchor);
            return run('SubmissionJournal', ['submission'], 'readonly', (tx, done) =>
              tx.request(tx.store('submission').get(0), (v) => {
                const r = submissionRow(v);
                done({
                  record: r.record === null ? null : new Uint8Array(r.record),
                  outcome: r.outcome,
                  checkpoint: publicCheckpoint(r.checkpoint),
                });
              })
            );
          }),
        prepare: (anchor, input) =>
          attempt('SubmissionJournal', () => {
            checkAnchor(anchor);
            const record = ownedRecord(input);
            return submission((tx, done) =>
              tx.request(tx.store('submission').get(0), (v) => {
                const r = submissionRow(v);
                if (r.record !== null) {
                  if (!bytesEqual(r.record, record)) throw failure('SubmissionJournal', 'conflict');
                  done(undefined);
                  return;
                }
                writeSubmission(
                  tx,
                  {
                    ...r,
                    revision: nextRevision('SubmissionJournal', r.revision),
                    record,
                    outcome: null,
                  },
                  done
                );
              })
            );
          }),
        observe: (anchor, record, before, after) => transition(anchor, record, before, after, null),
        finish: (anchor, record, outcome, before, after) =>
          attempt('SubmissionJournal', () => {
            if (outcome !== 'Committed' && outcome !== 'Conflict')
              throw failure('SubmissionJournal', 'corrupt');
            return transition(anchor, record, before, after, outcome);
          }),
        acknowledge: (anchor, result) =>
          attempt('SubmissionJournal', () => {
            checkAnchor(anchor);
            const record = ownedRecord(result.record),
              outcome = result.outcome;
            return submission((tx, done) =>
              tx.request(tx.store('submission').get(0), (v) => {
                const r = submissionRow(v);
                if (r.outcome === null || r.outcome !== outcome || !sameBytes(r.record, record))
                  throw failure('SubmissionJournal', 'conflict');
                writeSubmission(
                  tx,
                  {
                    ...r,
                    revision: nextRevision('SubmissionJournal', r.revision),
                    record: null,
                    outcome: null,
                  },
                  done
                );
              })
            );
          }),
      });
      const ownBinding = (binding: ClientCustodyBinding) =>
        parse('ClientPairingOriginalStore', () => {
          const g = Result.getOrThrow(Bytes.genesisHash(binding.genesis.toBytes())),
            device = Result.getOrThrow(Bytes.signingPublicKey(binding.device.toBytes()));
          if (
            binding.accountId !== bound.accountId ||
            binding.workspaceId !== bound.workspaceId ||
            keyId(g.toBytes()) !== bound.genesis ||
            !/^[0-9a-f]{64}$/.test(binding.installationId)
          )
            throw failure('ClientPairingOriginalStore', 'corrupt');
          const raw = {
            ...bound,
            device: keyId(device.toBytes()),
            installationId: binding.installationId,
          };
          return {
            raw,
            binding: {
              accountId: bound.accountId,
              workspaceId: bound.workspaceId,
              genesis: g,
              device,
              installationId: binding.installationId,
            },
          };
        });
      const ownKey = (key: ClientPairingKey) => {
        const b = ownBinding(key);
        if (
          !['request', 'approval', 'claim'].includes(key.purpose) ||
          !/^[0-9a-f]{32}$/.test(key.pairingSessionId)
        )
          throw failure('ClientPairingOriginalStore', 'corrupt');
        return {
          ...b,
          purpose: key.purpose,
          session: key.pairingSessionId,
          id: pairingId(b.raw, key.purpose, key.pairingSessionId),
        };
      };
      const pairings = ClientPairingOriginalStore.of({
        load: (key) =>
          attempt('ClientPairingOriginalStore', () => {
            const k = ownKey(key);
            return run('ClientPairingOriginalStore', ['pairing'], 'readonly', (tx, done) =>
              tx.request(tx.store('pairing').get(k.id), (v) =>
                done(v === undefined ? null : pairingValue(pairingRow(v, k.raw, k.id)))
              )
            );
          }),
        compareAndSet: (key, expectedRevision, next) =>
          attempt('ClientPairingOriginalStore', () => {
            const k = ownKey(key);
            if (expectedRevision !== null && !integer(expectedRevision, 1))
              throw failure('ClientPairingOriginalStore', 'conflict');
            if (
              !integer(next.revision, 1) ||
              !(next.original instanceof Uint8Array) ||
              !blob(next.original) ||
              (next.receipt !== null &&
                (!(next.receipt instanceof Uint8Array) || !blob(next.receipt)))
            )
              throw failure('ClientPairingOriginalStore', 'corrupt');
            const owned = {
              revision: next.revision,
              original: new Uint8Array(next.original),
              receipt: next.receipt === null ? null : new Uint8Array(next.receipt),
            };
            return run<void>('ClientPairingOriginalStore', ['pairing'], 'readwrite', (tx, done) =>
              tx.request(tx.store('pairing').get(k.id), (v) => {
                const r = v === undefined ? null : pairingRow(v, k.raw, k.id);
                if (
                  r &&
                  samePairing(r, owned) &&
                  (expectedRevision === r.revision ||
                    expectedRevision === (r.revision === 1 ? null : r.revision - 1))
                ) {
                  done(undefined);
                  return;
                }
                if (r === null) {
                  if (expectedRevision !== null || owned.revision !== 1 || owned.receipt !== null)
                    throw failure('ClientPairingOriginalStore', 'conflict');
                } else if (
                  r.revision !== expectedRevision ||
                  r.revision !== 1 ||
                  owned.revision !== 2 ||
                  owned.receipt === null ||
                  !bytesEqual(r.original, owned.original)
                )
                  throw failure('ClientPairingOriginalStore', 'conflict');
                const updated = {
                  version: 1 as const,
                  id: k.id,
                  binding: k.raw,
                  purpose: k.purpose,
                  pairingSessionId: k.session,
                  ...owned,
                };
                verifiedWrite(
                  tx,
                  'pairing',
                  k.id,
                  updated,
                  (written) => pairingRow(written, k.raw, k.id),
                  (a, b) => samePairing(a, b),
                  () => done(undefined),
                  'ClientPairingOriginalStore'
                );
              })
            );
          }),
        list: (binding, cursor, limit) =>
          attempt('ClientPairingOriginalStore', () => {
            const b = ownBinding(binding),
              prefix = pairingPrefix(b.raw);
            if (!integer(limit, 1) || limit > 64)
              throw failure('ClientPairingOriginalStore', 'capacity');
            if (
              cursor !== null &&
              (typeof cursor !== 'string' ||
                !cursor.startsWith(prefix) ||
                cursor > prefix + '\uffff')
            )
              throw failure('ClientPairingOriginalStore', 'corrupt');
            return run('ClientPairingOriginalStore', ['pairing'], 'readonly', (tx, done) => {
              const entries: { key: ClientPairingKey; value: ClientPairingOriginal }[] = [];
              let last: string | null = null,
                total = 0;
              tx.request(
                tx
                  .store('pairing')
                  .openCursor(
                    IDBKeyRange.bound(cursor ?? prefix, prefix + '\uffff', cursor !== null, false)
                  ),
                (item) => {
                  if (!item) {
                    done({ entries, next: null });
                    return;
                  }
                  if (entries.length === limit) {
                    done({ entries, next: last });
                    return;
                  }
                  if (typeof item.key !== 'string')
                    throw failure('ClientPairingOriginalStore', 'corrupt');
                  const r = pairingRow(item.value, b.raw, item.key),
                    size = r.original.length + (r.receipt?.length ?? 0);
                  if (total + size > 2 * MAX_BLOB) {
                    done({ entries, next: last });
                    return;
                  }
                  total += size;
                  last = item.key;
                  entries.push({
                    key: { ...b.binding, purpose: r.purpose, pairingSessionId: r.pairingSessionId },
                    value: pairingValue(r),
                  });
                  item.continue();
                }
              );
            });
          }),
      });
      return Context.make(LedgerPinStore, pins).pipe(
        Context.add(LedgerFeedStore, feed),
        Context.add(SubmissionJournal, submissions),
        Context.add(ClientPairingOriginalStore, pairings)
      );
    })
  );
};

export { indexedDbClientInstallationStore } from './client-installation';
export { indexedDbClientKeyStores, type IndexedDbClientKeyStoreOptions } from './client-key-stores';
export {
  indexedDbSnapshotPublication,
  type IndexedDbSnapshotPublicationOptions,
} from './client-snapshots';

export { indexedDbClientRpcOriginals, type IndexedDbClientRpcStoreOptions } from './client-rpc';

export { indexedDbClientApprovalEvidence } from './client-approval-evidence';

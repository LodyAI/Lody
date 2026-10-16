import { own } from '../lifecycle';
import { Context, Effect, Layer, Result, Semaphore } from 'effect';
import * as Bytes from '../foundation/bytes';
import { bytesEqual } from '../foundation/cbor';
import { LedgerViewSource } from '../../services/ledger';
import { LedgerViewSourceError } from '../../services/errors';
import { LedgerFeedStore, type LedgerFeedTail } from '../../services/stores';
import { WorkspaceScope } from '../../services/workspace';
import type { LocalStoreError } from '../../services/errors';
import {
  LedgerFeedError,
  prepareLedgerPageEffect,
  validLedgerOffset,
  type LedgerFeedState,
  type LedgerReadPage,
} from './feed-page';
import {
  extendLedgerEffect,
  hashRecordBytes,
  verifyLedger,
  verifyLedgerEffect,
  type LedgerCheckpoint,
  type LedgerView,
} from './index';
import {
  verifyLedgerSnapshot,
  type SnapshotTrust,
  type VerifiedViewSnapshotTrust,
} from './snapshot';

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const fail = (code: LedgerFeedError['code']) => new LedgerFeedError({ code });
const fromStore = (error: LocalStoreError) =>
  fail(
    error.reason === 'closed'
      ? 'closed'
      : error.reason === 'storage'
        ? 'storage'
        : error.reason === 'conflict'
          ? 'conflict'
          : error.reason === 'capacity'
            ? 'read-too-large'
            : 'corrupt'
  );
const toLedgerError = (error: { readonly code: string }) =>
  fail(error.code === 'native-unavailable' ? 'native-unavailable' : 'wrong-parent');

/**
 * An endorsed snapshot a feed starts from instead of genesis. `trust` qualifies
 * the endorser and is supplied independently on every open; stored bytes and
 * transport offsets never select an endorser or grant authority.
 */
export interface SnapshotFeedOrigin {
  readonly bytes: Uint8Array;
  readonly trust: SnapshotTrust | VerifiedViewSnapshotTrust;
  /** Source offset right after the snapshot's last record. */
  readonly offset: string;
}

/** Where a {@link LedgerFeed} starts: the genesis record, or an endorsed snapshot. */
export type LedgerFeedOrigin =
  | { readonly kind: 'genesis'; readonly record: Uint8Array }
  | { readonly kind: 'snapshot'; readonly snapshot: SnapshotFeedOrigin };

/** Options of {@link LedgerFeed.layer}. */
export interface LedgerFeedOptions {
  readonly origin: LedgerFeedOrigin;
  /**
   * The checkpoint the stored feed must end at, chosen independently of the
   * store (for example from {@link LedgerPinStore} or the application's own
   * record). On first use it must equal the origin.
   */
  readonly expected: LedgerCheckpoint;
  /** Upper bounds on records and bytes kept locally. */
  readonly budget: { readonly maxRecords: number; readonly maxBytes: number };
}

const tailOf = (state: LedgerFeedState, bytes: number): LedgerFeedTail => ({
  head: state.view.head.toBytes(),
  count: state.view.length,
  offset: state.offset,
  bootstrap: state.bootstrap,
  bytes,
});
const sameTail = (a: LedgerFeedTail, b: LedgerFeedTail) =>
  bytesEqual(a.head, b.head) &&
  a.count === b.count &&
  a.offset === b.offset &&
  a.bootstrap === b.bootstrap &&
  a.bytes === b.bytes;

const verifyOrigin = (anchor: Bytes.GenesisHash, origin: LedgerFeedOrigin) =>
  Result.try({
    try: () => {
      if (origin.kind === 'genesis') {
        const record = origin.record;
        if (!(record instanceof Uint8Array) || record.length < 1 || record.length > 8192)
          throw fail('invalid-frame');
        const bytes = new Uint8Array(record);
        const view = Result.getOrThrow(
          verifyLedger({
            anchor,
            records: [bytes],
            checkpoint: { head: hashRecordBytes(bytes), length: 1 },
          })
        );
        return { bytes, view, offset: '-1', bootstrap: true };
      }
      const source = origin.snapshot;
      if (
        !(source.bytes instanceof Uint8Array) ||
        source.bytes.length < 1 ||
        source.bytes.length > MAX_SNAPSHOT_BYTES ||
        !validLedgerOffset(source.offset)
      )
        throw fail('invalid-frame');
      const bytes = new Uint8Array(source.bytes);
      const trustSource = source.trust;
      // A genuine token has private identity. Rebuilding its public shape would
      // discard provenance; external facts instead receive independent copies.
      const trust =
        trustSource.source === 'verified-view'
          ? trustSource
          : Object.freeze({
              source: trustSource.source,
              genesis: Result.getOrThrow(Bytes.genesisHash(trustSource.genesis.toBytes())),
              endorser: Result.getOrThrow(Bytes.signingPublicKey(trustSource.endorser.toBytes())),
              head: Result.getOrThrow(Bytes.recordHash(trustSource.head.toBytes())),
              length: trustSource.length,
              headSignature: Result.getOrThrow(
                Bytes.signature(trustSource.headSignature.toBytes())
              ),
              membershipId: Result.getOrThrow(
                Bytes.membershipId(trustSource.membershipId.toBytes())
              ),
              role: trustSource.role,
              kind: trustSource.kind,
              ...(trustSource.stateDigest
                ? {
                    stateDigest: Result.getOrThrow(
                      Bytes.recordHash(trustSource.stateDigest.toBytes())
                    ),
                  }
                : {}),
            });
      const view = Result.getOrThrow(verifyLedgerSnapshot({ snapshot: bytes, trust }));
      if (!anchor.equals(view.genesis)) throw fail('wrong-parent');
      return { bytes, view, offset: source.offset, bootstrap: false };
    },
    catch: (error) => (error instanceof LedgerFeedError ? error : fail('wrong-parent')),
  });

/**
 * The application's local, verified copy of the ledger, kept up to date from
 * {@link LedgerFeedSource} pages.
 *
 * On open every stored byte is re-verified from the origin up to the
 * independently supplied `expected` checkpoint. `accept(page, checkpoint)`
 * verifies a page against the current view and appends it durably before the
 * new view is returned. Provide {@link LedgerFeed.viewSource} to feed the
 * verified view to every workflow.
 *
 * @category Workflows
 */
export class LedgerFeed extends Context.Service<
  LedgerFeed,
  {
    /** Return the verified in-memory view and durable position; a closed owner fails with LedgerFeedError. */
    current(): Effect.Effect<LedgerFeedState, LedgerFeedError>;
    /** Verify one page against the independently supplied checkpoint, then atomically persist records and position. */
    accept(
      page: LedgerReadPage,
      checkpoint: LedgerCheckpoint
    ): Effect.Effect<LedgerFeedState, LedgerFeedError>;
  }
>()('@lody/e2ee-core/LedgerFeed') {
  /** Requires {@link WorkspaceScope} and {@link LedgerFeedStore}. */
  static readonly layer = (options: LedgerFeedOptions) =>
    Layer.effect(
      LedgerFeed,
      Effect.gen(function* () {
        const anchor = (yield* WorkspaceScope).genesis;
        const store = own(yield* LedgerFeedStore);
        const budget = { ...options.budget };
        if (
          !Number.isSafeInteger(budget.maxRecords) ||
          budget.maxRecords < 1 ||
          budget.maxRecords > 1_000_000 ||
          !Number.isSafeInteger(budget.maxBytes) ||
          budget.maxBytes < 1 ||
          budget.maxBytes > 64 * 1024 * 1024
        )
          return yield* fail('invalid-frame');
        const expected = {
          head: yield* Effect.fromResult(Bytes.recordHash(options.expected.head.toBytes())),
          length: options.expected.length,
        };
        if (!Number.isSafeInteger(expected.length) || expected.length < 1)
          return yield* fail('invalid-frame');
        const origin = yield* Effect.fromResult(verifyOrigin(anchor, options.origin));
        if (origin.view.length > budget.maxRecords || origin.bytes.length > budget.maxBytes)
          return yield* fail('read-too-large');
        const local = <A>(effect: Effect.Effect<A, LocalStoreError>) =>
          effect.pipe(Effect.mapError(fromStore));

        let contents = yield* local(store.load(budget.maxRecords));
        if (!contents) {
          if (!expected.head.equals(origin.view.head) || expected.length !== origin.view.length)
            return yield* fail('wrong-parent');
          const tail = tailOf(origin, origin.bytes.length);
          yield* local(store.initialize(origin.bytes, origin.view.length, tail));
          contents = { origin: origin.bytes, originCount: origin.view.length, tail, records: [] };
        }
        const { tail, records } = contents;
        const recordBytes = records.reduce((size, record) => size + record.length, 0);
        if (
          !bytesEqual(contents.origin, origin.bytes) ||
          contents.originCount !== origin.view.length ||
          !Number.isSafeInteger(tail.count) ||
          tail.count !== origin.view.length + records.length ||
          tail.count > budget.maxRecords ||
          !validLedgerOffset(tail.offset) ||
          tail.bytes !== origin.bytes.length + recordBytes ||
          tail.bytes > budget.maxBytes ||
          records.some((record) => record.length < 1 || record.length > 8192) ||
          (tail.bootstrap && (!origin.bootstrap || tail.offset !== '-1' || records.length !== 0)) ||
          (!origin.bootstrap && records.length === 0 && tail.offset !== origin.offset)
        )
          return yield* fail('corrupt');
        const head = Bytes.recordHash(tail.head);
        if (Result.isFailure(head)) return yield* fail('corrupt');
        if (!expected.head.equals(head.success) || expected.length !== tail.count)
          return yield* fail('wrong-parent');
        // Authenticate all retained bytes on open; later appends verify only the new page.
        const view: LedgerView = origin.bootstrap
          ? yield* verifyLedgerEffect({
              anchor,
              records: [origin.bytes, ...records],
              checkpoint: expected,
            }).pipe(Effect.mapError(toLedgerError))
          : yield* extendLedgerEffect(origin.view, records, expected).pipe(
              Effect.mapError(toLedgerError)
            );
        let state: LedgerFeedState = { view, offset: tail.offset, bootstrap: tail.bootstrap },
          totalBytes = tail.bytes;
        // Verification can yield: reject a concurrent writer at this tail.
        const checkTail = Effect.fnUntraced(function* () {
          const stored = yield* local(store.tail());
          if (!stored || !sameTail(stored, tailOf(state, totalBytes)))
            return yield* fail('conflict');
          return undefined;
        });
        yield* checkTail();
        const serial = yield* Semaphore.make(1);

        const accept = Effect.fnUntraced(function* (
          page: LedgerReadPage,
          checkpoint: LedgerCheckpoint
        ) {
          yield* checkTail();
          const observed = state;
          const incoming = page.records;
          if (!Array.isArray(incoming) || incoming.length > 4096)
            return yield* fail('read-too-large');
          // Index once over a captured length: never invoke caller iterators or getters twice.
          const count = incoming.length,
            copied: Uint8Array[] = [];
          let pageBytes = 0;
          for (let index = 0; index < count; index++) {
            const record = incoming[index];
            if (!(record instanceof Uint8Array) || record.length < 1 || record.length > 8192)
              return yield* fail('invalid-frame');
            pageBytes += record.length;
            if (pageBytes > 16 * 1024 * 1024) return yield* fail('read-too-large');
            copied.push(new Uint8Array(record));
          }
          if (incoming.length !== count) return yield* fail('invalid-frame');
          const next = yield* prepareLedgerPageEffect(
            observed,
            {
              requestOffset: page.requestOffset,
              nextOffset: page.nextOffset,
              upToDate: page.upToDate,
              records: copied,
            },
            checkpoint
          );
          // A bootstrap page repeats the stored genesis record.
          const additions = copied.slice(observed.bootstrap ? 1 : 0);
          const bytes = additions.reduce((size, record) => size + record.length, totalBytes);
          if (next.view.length > budget.maxRecords || bytes > budget.maxBytes)
            return yield* fail('read-too-large');
          if (state !== observed) return yield* fail('conflict');
          yield* local(store.append(tailOf(observed, totalBytes), additions, tailOf(next, bytes)));
          state = next;
          totalBytes = bytes;
          return { ...state };
        });

        return LedgerFeed.of({
          current: Effect.fn('@lody/e2ee-core/LedgerFeed.current')(function* () {
            yield* checkTail();
            return { ...state };
          }),
          accept: Effect.fn('@lody/e2ee-core/LedgerFeed.accept')(function* (page, checkpoint) {
            return yield* serial.withPermit(accept(page, checkpoint));
          }),
        });
      })
    );

  /** {@link LedgerViewSource} backed by the feed's current verified view. */
  static readonly viewSource = Layer.effect(
    LedgerViewSource,
    Effect.gen(function* () {
      const feed = yield* LedgerFeed;
      return LedgerViewSource.of({
        current: () =>
          feed.current().pipe(
            Effect.map((state) => state.view),
            Effect.mapError((cause) => new LedgerViewSourceError({ cause }))
          ),
      });
    })
  );
}

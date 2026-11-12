import { LedgerError } from './errors';
import { VerifiedLedger } from './verified-ledger';
import { own } from '../lifecycle';
import { Context, Effect, Layer, Option, Result, Semaphore } from 'effect';
import * as Bytes from '../foundation/bytes';
import { bytesEqual, decodeRetainedCbor, MAX_RETAINED_STATE_BYTES } from '../foundation/cbor';
import {
  LedgerFeedSource,
  LedgerFeedInvalidation,
  LedgerViewSource,
  LedgerPinStore,
} from '../../services/ledger';
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
  exportVerifiedState,
  restoreVerifiedState,
  hasVerifiedCheckpoint,
  type RetainedLedgerState,
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
const toLedgerError = (error: { readonly code: string; readonly position?: number }) =>
  new LedgerFeedError({
    code:
      error.code === 'native-unavailable' || error.code === 'upgrade-required'
        ? error.code
        : 'wrong-parent',
    ...(error.position === undefined ? {} : { position: error.position }),
  });

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

/** Where a {@link LedgerFeed} starts: genesis, an endorsed snapshot, or this caller's retained v5 state and source position. */
export type LedgerFeedOrigin =
  | { readonly kind: 'genesis'; readonly record: Uint8Array }
  | { readonly kind: 'snapshot'; readonly snapshot: SnapshotFeedOrigin }
  | { readonly kind: 'retained'; readonly state: RetainedLedgerState; readonly offset: string };

/** Options of {@link LedgerFeed.layer}. */
export interface LedgerFeedOptions {
  readonly origin: LedgerFeedOrigin;
  /**
   * The checkpoint the stored feed must end at, chosen independently of the
   * store (for example from {@link LedgerPinStore} or the application's own
   * record). On first use it must equal the origin.
   */
  readonly expected: LedgerCheckpoint;
  /** maxRecords bounds appended records after the verified origin; rebase resets that suffix budget. maxBytes includes the origin and retained suffix. */
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
      if (origin.kind === 'retained') {
        if (!validLedgerOffset(origin.offset)) throw fail('retained-cache-invalid');
        const restored = restoreVerifiedState(origin.state);
        if (Result.isFailure(restored)) {
          if (
            restored.failure.code === 'upgrade-required' ||
            restored.failure.code === 'native-unavailable'
          )
            throw toLedgerError(restored.failure);
          throw fail('retained-cache-invalid');
        }
        if (!anchor.equals(restored.success.genesis)) throw fail('retained-cache-invalid');
        return {
          bytes: new Uint8Array(origin.state.bytes),
          view: restored.success,
          offset: origin.offset,
          bootstrap: false,
        };
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
    catch: (error) =>
      error instanceof LedgerFeedError
        ? error
        : error instanceof LedgerError
          ? toLedgerError(error)
          : fail('wrong-parent'),
  });

/**
 * The application's local, verified copy of the ledger, kept up to date from
 * {@link LedgerFeedSource} pages.
 *
 * On open retained state is restored and every stored suffix byte is re-verified up to the
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
    /** Persist the verified pin first, then atomically replace the origin with the current retained v5 state. Save the returned local-only origin for reopen. */
    rebase(): Effect.Effect<
      Extract<LedgerFeedOrigin, { kind: 'retained' }>,
      LedgerFeedError,
      VerifiedLedger
    >;
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
        const invalidation = Option.map(yield* Effect.serviceOption(LedgerFeedInvalidation), own);
        const budget = { ...options.budget };
        if (
          !Number.isSafeInteger(budget.maxRecords) ||
          budget.maxRecords < 1 ||
          budget.maxRecords > 1_000_000 ||
          !Number.isSafeInteger(budget.maxBytes) ||
          budget.maxBytes < 1 ||
          budget.maxBytes > MAX_RETAINED_STATE_BYTES
        )
          return yield* fail('invalid-frame');
        let expected = {
          head: yield* Effect.fromResult(Bytes.recordHash(options.expected.head.toBytes())),
          length: options.expected.length,
        };
        if (!Number.isSafeInteger(expected.length) || expected.length < 1)
          return yield* fail('invalid-frame');
        const local = <A>(effect: Effect.Effect<A, LocalStoreError>) =>
          effect.pipe(Effect.mapError(fromStore));
        // The pin is independent of the disposable feed cache and is never reset.
        const pins = yield* Effect.serviceOption(LedgerPinStore);
        if (Option.isSome(pins)) {
          const pin = yield* local(pins.value.read());
          if (pin && pin.length >= expected.length) {
            if (pin.length === expected.length && !pin.head.equals(expected.head))
              return yield* fail('local-evidence-conflict');
            expected = pin;
          }
        }
        let retained = options.origin.kind === 'retained';
        let originResult = verifyOrigin(anchor, options.origin);
        if (
          Result.isFailure(originResult) &&
          !(retained && originResult.failure.code === 'retained-cache-invalid')
        )
          return yield* originResult.failure;
        const loaded = yield* Effect.result(local(store.load(budget.maxRecords)));
        if (Result.isFailure(loaded) && loaded.failure.code !== 'corrupt')
          return yield* loaded.failure;
        let contents = Result.isSuccess(loaded) ? loaded.success : null;
        // A successful rebase commits its local origin and suffix in one store transaction.
        // Recover that origin even if the process died before returning it to its caller.
        if (
          contents &&
          (Result.isFailure(originResult) ||
            !bytesEqual(contents.origin, originResult.success.bytes))
        ) {
          const root = decodeRetainedCbor(contents.origin);
          if (
            Result.isSuccess(root) &&
            Array.isArray(root.success) &&
            root.success[3] instanceof Uint8Array
          ) {
            const head = Bytes.recordHash(root.success[3]);
            if (Result.isSuccess(head)) {
              const restored = restoreVerifiedState({
                bytes: contents.origin,
                genesis: anchor,
                head: head.success,
                length: contents.originCount,
              });
              if (Result.isSuccess(restored)) {
                originResult = Result.succeed({
                  bytes: new Uint8Array(contents.origin),
                  view: restored.success,
                  offset: contents.records.length === 0 ? contents.tail.offset : '-1',
                  bootstrap: false,
                });
                retained = true;
              }
            }
          }
        }
        let preverified: LedgerView | undefined;
        let invalidSuffix = false;
        if (contents && Result.isSuccess(originResult)) {
          const base = originResult.success,
            tail = contents.tail;
          const hash = Bytes.recordHash(tail.head);
          invalidSuffix =
            contents.originCount !== base.view.length ||
            tail.count !== base.view.length + contents.records.length ||
            tail.bytes !==
              contents.origin.length + contents.records.reduce((sum, row) => sum + row.length, 0) ||
            !validLedgerOffset(tail.offset) ||
            (tail.bootstrap &&
              (!base.bootstrap || tail.offset !== '-1' || contents.records.length !== 0));
          if (!invalidSuffix && Result.isSuccess(hash)) {
            const checked = yield* Effect.result(
              base.bootstrap
                ? verifyLedgerEffect({
                    anchor,
                    records: [base.bytes, ...contents.records],
                    checkpoint: { head: hash.success, length: tail.count },
                  })
                : extendLedgerEffect(base.view, contents.records, {
                    head: hash.success,
                    length: tail.count,
                  })
            );
            if (Result.isSuccess(checked)) preverified = checked.success;
            else if (
              checked.failure.code === 'native-unavailable' ||
              checked.failure.code === 'upgrade-required'
            )
              return yield* toLedgerError(checked.failure);
            else invalidSuffix = true;
          } else invalidSuffix = true;
        }
        const missingPin =
          preverified &&
          preverified.length >= expected.length &&
          !Result.getOrElse(hasVerifiedCheckpoint(preverified, expected), () => false);
        const needsRebuild =
          missingPin ||
          invalidSuffix ||
          Result.isFailure(loaded) ||
          Result.isFailure(originResult) ||
          (!retained &&
            Result.isSuccess(originResult) &&
            expected.length > (contents?.tail.count ?? originResult.success.view.length)) ||
          (contents !== null &&
            Result.isSuccess(originResult) &&
            !bytesEqual(contents.origin, originResult.success.bytes)) ||
          (Result.isSuccess(originResult) &&
            originResult.success.view.length > expected.length &&
            !Result.getOrElse(
              hasVerifiedCheckpoint(originResult.success.view, expected),
              () => false
            ));
        if (needsRebuild) {
          const source = yield* Effect.serviceOption(LedgerFeedSource);
          const storedTail = yield* local(store.tail());
          if (Option.isNone(source) || (storedTail && !store.rebuild))
            return yield* fail('retained-cache-invalid');
          const target =
            storedTail && storedTail.count > expected.length
              ? {
                  length: storedTail.count,
                  head: yield* Effect.fromResult(Bytes.recordHash(storedTail.head)).pipe(
                    Effect.mapError(toLedgerError)
                  ),
                }
              : expected;
          if (
            storedTail &&
            storedTail.count === expected.length &&
            !bytesEqual(storedTail.head, expected.head.toBytes())
          )
            return yield* fail('local-evidence-conflict');
          let offset = '-1';
          const originals: Uint8Array[] = [];
          let bytes = 0;
          for (let pageIndex = 0; originals.length < target.length; pageIndex++) {
            if (pageIndex >= 256) return yield* fail('read-too-large');
            const page = yield* source.value.readAfter(offset);
            if (
              page.requestOffset !== offset ||
              !validLedgerOffset(page.nextOffset) ||
              !Array.isArray(page.records) ||
              page.records.length === 0 ||
              page.records.length > 4096
            )
              return yield* fail('invalid-frame');
            for (const record of page.records) {
              if (!(record instanceof Uint8Array) || record.length < 1 || record.length > 8192)
                return yield* fail('invalid-frame');
              bytes += record.length;
              if (bytes > budget.maxBytes || originals.length >= budget.maxRecords)
                return yield* fail('read-too-large');
              originals.push(new Uint8Array(record));
            }
            if (page.nextOffset === offset) return yield* fail('invalid-offset');
            offset = page.nextOffset;
          }
          const rebuilt = yield* verifyLedgerEffect({
            anchor,
            records: originals,
            checkpoint: { length: originals.length, head: hashRecordBytes(originals.at(-1)!) },
          }).pipe(Effect.mapError(toLedgerError));
          const evidence = [expected, target];
          if (storedTail)
            evidence.push({
              length: storedTail.count,
              head: yield* Effect.fromResult(Bytes.recordHash(storedTail.head)).pipe(
                Effect.mapError(toLedgerError)
              ),
            });
          for (const point of evidence) {
            const included = hasVerifiedCheckpoint(rebuilt, point);
            if (Result.isFailure(included) || !included.success)
              return yield* fail('local-evidence-conflict');
          }
          const saved = yield* Effect.fromResult(exportVerifiedState(rebuilt)).pipe(
            Effect.mapError(toLedgerError)
          );
          if (saved.bytes.length > budget.maxBytes) return yield* fail('read-too-large');
          const next = tailOf({ view: rebuilt, offset, bootstrap: false }, saved.bytes.length);
          yield* local(
            storedTail
              ? store.rebuild!(storedTail, saved.bytes, saved.length, next)
              : store.initialize(saved.bytes, saved.length, next)
          );
          contents = { origin: saved.bytes, originCount: saved.length, tail: next, records: [] };
          originResult = Result.succeed({
            bytes: new Uint8Array(saved.bytes),
            view: rebuilt,
            offset,
            bootstrap: false,
          });
          retained = true;
          preverified = rebuilt;
        }
        const origin = yield* Effect.fromResult(originResult);
        if (
          retained &&
          expected.length === origin.view.length &&
          !expected.head.equals(origin.view.head)
        )
          return yield* fail('local-evidence-conflict');
        if (origin.bytes.length > budget.maxBytes) return yield* fail('read-too-large');
        if (!contents) {
          if (
            !retained &&
            (!expected.head.equals(origin.view.head) || expected.length !== origin.view.length)
          )
            return yield* fail('wrong-parent');
          const tail = tailOf(origin, origin.bytes.length);
          yield* local(store.initialize(origin.bytes, origin.view.length, tail));
          contents = { origin: origin.bytes, originCount: origin.view.length, tail, records: [] };
        }
        let budgetOriginCount = origin.view.length;
        const { tail, records } = contents;
        const recordBytes = records.reduce((size, record) => size + record.length, 0);
        if (
          !bytesEqual(contents.origin, origin.bytes) ||
          contents.originCount !== origin.view.length ||
          !Number.isSafeInteger(tail.count) ||
          tail.count !== origin.view.length + records.length ||
          records.length > budget.maxRecords ||
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
        if (!retained && (!expected.head.equals(head.success) || expected.length !== tail.count))
          return yield* fail('wrong-parent');
        // Authenticate the local suffix against its stored endpoint, then prove the independent pin.
        let view: LedgerView =
          preverified ??
          (origin.bootstrap
            ? yield* verifyLedgerEffect({
                anchor,
                records: [origin.bytes, ...records],
                checkpoint: { head: head.success, length: tail.count },
              }).pipe(Effect.mapError(toLedgerError))
            : yield* extendLedgerEffect(origin.view, records, {
                head: head.success,
                length: tail.count,
              }).pipe(Effect.mapError(toLedgerError)));
        if (retained && view.length < expected.length) {
          const source = yield* Effect.serviceOption(LedgerFeedSource);
          if (Option.isNone(source)) return yield* fail('local-evidence-conflict');
          let pending: LedgerFeedState = { view, offset: tail.offset, bootstrap: false };
          const additions: Uint8Array[] = [];
          let bytes = tail.bytes;
          while (pending.view.length < expected.length) {
            const page = yield* source.value.readAfter(pending.offset);
            if (
              !Array.isArray(page.records) ||
              page.records.length === 0 ||
              page.records.length > 4096
            )
              return yield* fail('local-evidence-conflict');
            let pageBytes = 0;
            for (const record of page.records) {
              if (!(record instanceof Uint8Array) || record.length < 1 || record.length > 8192)
                return yield* fail('invalid-frame');
              pageBytes += record.length;
              if (pageBytes > 16 * 1024 * 1024) return yield* fail('read-too-large');
            }
            const incoming = page.records.map((record) => new Uint8Array(record));
            const checkpoint = {
              head: hashRecordBytes(incoming[incoming.length - 1]!),
              length: pending.view.length + incoming.length,
            };
            const next = yield* prepareLedgerPageEffect(
              pending,
              { ...page, records: incoming },
              checkpoint
            );
            bytes += incoming.reduce((sum, record) => sum + record.length, 0);
            if (next.view.length - budgetOriginCount > budget.maxRecords || bytes > budget.maxBytes)
              return yield* fail('read-too-large');
            additions.push(...incoming);
            pending = next;
          }
          const included = hasVerifiedCheckpoint(pending.view, expected);
          if (Result.isFailure(included) || !included.success)
            return yield* fail('local-evidence-conflict');
          const nextTail = tailOf(pending, bytes);
          yield* local(store.append(tail, additions, nextTail));
          Object.assign(tail, nextTail);
          view = pending.view;
        }
        if (retained) {
          const included = hasVerifiedCheckpoint(view, expected);
          if (Result.isFailure(included) || !included.success)
            return yield* fail('local-evidence-conflict');
        }
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
        const rebase = Effect.fnUntraced(function* () {
          yield* checkTail();
          if (state.bootstrap) return yield* fail('invalid-offset');
          const verified = yield* VerifiedLedger;
          yield* verified.current().pipe(Effect.mapError(() => fail('local-evidence-conflict')));
          yield* verified
            .ensureCurrent(state.view)
            .pipe(Effect.mapError(() => fail('local-evidence-conflict')));
          const saved = yield* Effect.fromResult(exportVerifiedState(state.view)).pipe(
            Effect.mapError(toLedgerError)
          );
          if (saved.bytes.length > budget.maxBytes) return yield* fail('read-too-large');
          // Never let interruption reverse the required durable ordering.
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* local(
                store.rebase(
                  tailOf(state, totalBytes),
                  saved.bytes,
                  saved.length,
                  tailOf(state, saved.bytes.length)
                )
              );
              totalBytes = saved.bytes.length;
              budgetOriginCount = saved.length;
            })
          );
          return { kind: 'retained' as const, state: saved, offset: state.offset };
        });

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
          if (next.view.length - budgetOriginCount > budget.maxRecords || bytes > budget.maxBytes)
            return yield* fail('read-too-large');
          if (state !== observed) return yield* fail('conflict');
          yield* local(store.append(tailOf(observed, totalBytes), additions, tailOf(next, bytes)));
          state = next;
          totalBytes = bytes;
          // No yield between publication and retirement of dependent RAM grants.
          if (
            (next.view.length !== observed.view.length ||
              !next.view.head.equals(observed.view.head)) &&
            Option.isSome(invalidation)
          )
            invalidation.value.invalidate();
          return { ...state };
        });

        return LedgerFeed.of({
          rebase: Effect.fn('@lody/e2ee-core/LedgerFeed.rebase')(function* () {
            return yield* serial.withPermit(rebase());
          }),
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

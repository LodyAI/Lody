import { Data, Effect, Result } from 'effect';
import { MAX_RECORD_BYTES } from '../foundation/cbor';
import { recordHash } from '../foundation/bytes';
import {
  extendLedger,
  extendLedgerEffect,
  hashRecordBytes,
  requireLedgerContinuation,
  type LedgerView,
  type LedgerCheckpoint,
} from './index';

/** A ledger feed page, frame or local feed operation failed; `code` names the reason. */
export class LedgerFeedError extends Data.TaggedError('LedgerFeedError')<{
  readonly cause?: unknown;
  readonly position?: number;
  readonly code:
    | 'upgrade-required'
    | 'retained-cache-invalid'
    | 'local-evidence-conflict'
    | 'invalid-frame'
    | 'read-too-large'
    | 'invalid-offset'
    | 'offset-mismatch'
    | 'incomplete-frame'
    | 'wrong-parent'
    | 'closed'
    | 'storage'
    | 'corrupt'
    | 'conflict'
    | 'transport'
    | 'native-unavailable';
}> {}
/** Structural check of an opaque feed offset (bounded, no control characters). */
export const validLedgerOffset = (offset: unknown): offset is string =>
  typeof offset === 'string' &&
  offset.length > 0 &&
  offset.length <= 1024 &&
  offset.trim() === offset &&
  !offset.includes('\r') &&
  !offset.includes('\n') &&
  !offset.includes('\0');
/** One untrusted page from a `LedgerFeedSource`: request/next offsets, original records and whether the source was up to date. */
export interface LedgerReadPage {
  readonly requestOffset: string;
  readonly nextOffset: string;
  readonly records: readonly Uint8Array[];
  readonly upToDate: boolean;
}
/** A verified feed position: the view, the source offset to read after, and whether the genesis bootstrap page is still expected. */
export interface LedgerFeedState {
  readonly view: LedgerView;
  readonly offset: string;
  readonly bootstrap: boolean;
}
/** Frame one record as stored in a ledger stream: u32 big-endian length then the record. */
export function frameLedgerRecord(record: Uint8Array): Result.Result<Uint8Array, LedgerFeedError> {
  if (!(record instanceof Uint8Array) || record.length === 0 || record.length > MAX_RECORD_BYTES)
    return Result.fail(new LedgerFeedError({ code: 'invalid-frame' }));
  const frame = new Uint8Array(4 + record.length);
  new DataView(frame.buffer).setUint32(0, record.length, false);
  frame.set(record, 4);
  return Result.succeed(frame);
}
/** Caller persists the resulting verified state AND transport position atomically.
 * No hash-based known-record skipping: an old record at a new position is not an increment.
 * Only the initial exact genesis occurrence can bind a newly created genesis-only feed. */
function captureLedgerPage(
  state: LedgerFeedState,
  page: LedgerReadPage,
  expected: LedgerCheckpoint
) {
  return Result.gen(function* () {
    yield* Result.mapError(
      requireLedgerContinuation(state.view, state.view),
      () => new LedgerFeedError({ code: 'wrong-parent' })
    );
    expected = {
      head: yield* Result.mapError(
        recordHash(expected.head.toBytes()),
        () => new LedgerFeedError({ code: 'wrong-parent' })
      ),
      length: expected.length,
    };
    if (
      typeof state.bootstrap !== 'boolean' ||
      !validLedgerOffset(state.offset) ||
      !validLedgerOffset(page.requestOffset) ||
      !validLedgerOffset(page.nextOffset) ||
      typeof page.upToDate !== 'boolean'
    )
      return yield* Result.fail(new LedgerFeedError({ code: 'invalid-offset' }));
    if (page.requestOffset !== state.offset)
      return yield* Result.fail(new LedgerFeedError({ code: 'offset-mismatch' }));
    if (!Array.isArray(page.records) || page.records.length > 4096)
      return yield* Result.fail(new LedgerFeedError({ code: 'read-too-large' }));
    let bytes = 0;
    const records: Uint8Array[] = [];
    for (const row of page.records) {
      if (!(row instanceof Uint8Array) || row.length === 0 || row.length > MAX_RECORD_BYTES)
        return yield* Result.fail(new LedgerFeedError({ code: 'invalid-frame' }));
      bytes += row.length;
      if (bytes > 16 * 1024 * 1024)
        return yield* Result.fail(new LedgerFeedError({ code: 'read-too-large' }));
      records.push(new Uint8Array(row));
    }
    if (records.length === 0) {
      // An unauthenticated empty-position jump cannot prove progress or rewind the durable cursor.
      if (page.nextOffset !== state.offset || !page.upToDate)
        return yield* Result.fail(new LedgerFeedError({ code: 'invalid-offset' }));
      if (!state.view.head.equals(expected.head) || state.view.length !== expected.length)
        return yield* Result.fail(new LedgerFeedError({ code: 'wrong-parent' }));
      return { retained: state, records: [] as Uint8Array[], expected };
    }
    if (page.nextOffset === state.offset)
      return yield* Result.fail(new LedgerFeedError({ code: 'invalid-offset' }));
    let start = 0;
    if (state.bootstrap) {
      if (
        state.offset !== '-1' ||
        state.view.verification !== 'full-history' ||
        state.view.length !== 1 ||
        !state.view.head.equals(hashRecordBytes(records[0]!))
      )
        return yield* Result.fail(new LedgerFeedError({ code: 'wrong-parent' }));
      start = 1;
    }
    return {
      retained: undefined,
      base: state.view,
      records: records.slice(start),
      expected,
      nextOffset: page.nextOffset,
    };
  });
}
/** Verify a page against a feed state and expected checkpoint, returning the next state (synchronous). */
export function prepareLedgerPage(
  state: LedgerFeedState,
  page: LedgerReadPage,
  expected: LedgerCheckpoint
) {
  return Result.gen(function* () {
    const captured = yield* captureLedgerPage(state, page, expected);
    if (captured.retained) return captured.retained;
    const view = yield* Result.mapError(
      extendLedger(captured.base!, captured.records, captured.expected),
      () => new LedgerFeedError({ code: 'wrong-parent' })
    );
    return { view, offset: captured.nextOffset!, bootstrap: false };
  });
}
/** Effect form of `prepareLedgerPage` that verifies signatures cooperatively. */
export const prepareLedgerPageEffect = Effect.fnUntraced(function* (
  state: LedgerFeedState,
  page: LedgerReadPage,
  expected: LedgerCheckpoint
) {
  const captured = yield* Effect.fromResult(captureLedgerPage(state, page, expected));
  if (captured.retained) return captured.retained;
  const view = yield* extendLedgerEffect(captured.base!, captured.records, captured.expected).pipe(
    Effect.mapError(
      (error) =>
        new LedgerFeedError({
          code:
            error.code === 'native-unavailable'
              ? 'native-unavailable'
              : error.code === 'upgrade-required'
                ? 'upgrade-required'
                : 'wrong-parent',
          ...(error.code === 'upgrade-required' && error.position !== undefined
            ? { position: error.position }
            : {}),
        })
    )
  );
  return { view, offset: captured.nextOffset!, bootstrap: false };
});

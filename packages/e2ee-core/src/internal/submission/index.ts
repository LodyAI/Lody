import { own } from '../lifecycle';
import { Context, Effect, Layer, Schema } from 'effect';
import type { GenesisHash } from '../foundation/bytes';
import { bytesEqual } from '../foundation/cbor';
import {
  decodeRecord,
  extendLedger,
  extendLedgerEffect,
  hashRecordBytes,
  verifyLedgerEffect,
  type LedgerCheckpoint,
  type LedgerError,
} from '../ledger';
import type { LedgerLogError, LocalStoreError } from '../../services/errors';
import {
  LedgerLog,
  SubmissionJournal,
  type SubmissionEntry,
  type SubmissionOutcome,
  type SubmissionResult,
} from '../../services/ledger';
import { WorkspaceScope } from '../../services/workspace';

/**
 * A submission could not proceed.
 *
 * - `busy`: another record is already in flight (or the journal moved
 *   concurrently); finish or acknowledge it first.
 * - `rollback`: the log no longer contains a checkpoint this device observed.
 * - `missing-parent`: the log does not contain the record's parent.
 * - `ordinary-only`: genesis records are never submitted.
 * - `corrupt`: the journal disagrees with the log about a recorded outcome.
 * - `unconfirmed`: the append's outcome is still unknown; call `resume` later.
 *
 * @category Errors
 */
export class SubmissionError extends Schema.TaggedError<SubmissionError>()('SubmissionError', {
  reason: Schema.Literals([
    'storage',
    'busy',
    'rollback',
    'missing-parent',
    'ordinary-only',
    'corrupt',
    'unconfirmed',
  ]),
}) {}
const fail = (reason: SubmissionError['reason']) => new SubmissionError({ reason });
const fromStore = (error: LocalStoreError) =>
  fail(error.reason === 'conflict' ? 'busy' : error.reason === 'corrupt' ? 'corrupt' : 'storage');

/** Every failure a submission step can report. */
export type SubmissionFailure = SubmissionError | LedgerLogError | LedgerError;

/**
 * Submit signed ledger records to the {@link LedgerLog} exactly once.
 *
 * One record per workspace is in flight at a time. `submit` saves the original
 * in {@link SubmissionJournal}, appends it with compare-and-swap at its parent
 * and reads the log back to decide `Committed` (these exact bytes are in the
 * log) or `Conflict` (another record took the parent). Any failure or
 * interruption keeps the original for `resume`, which is the only retry path:
 * it never re-signs. Finite: no timer or background retry.
 *
 * @category Workflows
 */
export class LedgerSubmission extends Context.Service<
  LedgerSubmission,
  {
    /** Submit `record`, or continue it if it is already the one in flight. */
    submit(record: Uint8Array): Effect.Effect<SubmissionResult, SubmissionFailure>;
    /** Continue the in-flight submission, if any. */
    resume(): Effect.Effect<SubmissionResult | null, SubmissionFailure>;
    /** Release a finished result so the next record can be submitted. */
    acknowledge(result: SubmissionResult): Effect.Effect<void, SubmissionError>;
    /** The journal's current entry (pending or finished original), without contacting the log. */
    pending(): Effect.Effect<SubmissionEntry, SubmissionError>;
  }
>()('@lody/e2ee-core/LedgerSubmission') {
  /** Requires {@link WorkspaceScope}, {@link SubmissionJournal} and {@link LedgerLog}. */
  static readonly layer = Layer.effect(
    LedgerSubmission,
    Effect.gen(function* () {
      const anchor: GenesisHash = (yield* WorkspaceScope).genesis;
      const journal = own(yield* SubmissionJournal);
      const log = own(yield* LedgerLog);
      const store = <A>(effect: Effect.Effect<A, LocalStoreError>) =>
        effect.pipe(Effect.mapError(fromStore));

      const inspect = Effect.fnUntraced(function* (
        record: Uint8Array,
        pin: LedgerCheckpoint | null
      ) {
        const incoming = yield* log.read(anchor);
        // Parsing bounds each copy and detaches arrays owned by an asynchronous host.
        const records: Uint8Array[] = [];
        for (const bytes of incoming.records)
          records.push((yield* Effect.fromResult(decodeRecord(bytes))).recordBytes);
        const decoded = yield* Effect.fromResult(decodeRecord(record));
        if (decoded.body.type !== 'ordinary') return yield* fail('ordinary-only');
        const parent = decoded.body.previousHash;
        const parentIndex = records.findIndex((bytes) => hashRecordBytes(bytes).equals(parent));
        if (parentIndex < 0) return yield* fail('missing-parent');
        // Authenticate the predecessor once, then verify only the remote suffix.
        // The pending operation must still be valid at its original parent.
        const predecessor = yield* verifyLedgerEffect({
          anchor,
          records: records.slice(0, parentIndex + 1),
          checkpoint: { head: parent, length: parentIndex + 1 },
        });
        const view = yield* extendLedgerEffect(
          predecessor,
          records.slice(parentIndex + 1),
          incoming.checkpoint
        );
        if (
          pin &&
          (records.length < pin.length ||
            !hashRecordBytes(records[pin.length - 1]!).equals(pin.head))
        )
          return yield* fail('rollback');
        yield* Effect.fromResult(
          extendLedger(predecessor, [record], {
            head: hashRecordBytes(record),
            length: parentIndex + 2,
          })
        );
        const found = records.some((bytes) => bytesEqual(bytes, record));
        const outcome: SubmissionOutcome | null = found
          ? 'Committed'
          : view.head.equals(parent)
            ? null
            : 'Conflict';
        return { outcome, checkpoint: { head: view.head, length: view.length } };
      });

      const recover = Effect.fnUntraced(function* (
        expectedRecord?: Uint8Array
      ): Effect.fn.Return<SubmissionResult | null, SubmissionFailure> {
        const entry = yield* store(journal.load(anchor));
        if (expectedRecord && (!entry.record || !bytesEqual(entry.record, expectedRecord)))
          return yield* fail('busy');
        if (!entry.record) return null;
        const record = entry.record;
        let checked = yield* inspect(record, entry.checkpoint);
        if (entry.outcome) {
          if (checked.outcome !== entry.outcome) return yield* fail('corrupt');
          yield* store(
            journal.finish(anchor, record, entry.outcome, entry.checkpoint, checked.checkpoint)
          );
          return { outcome: entry.outcome, record: new Uint8Array(record) };
        }
        if (!checked.outcome) {
          yield* store(journal.observe(anchor, record, entry.checkpoint, checked.checkpoint));
          // Even a typed lost-response failure requires readback. An interruption leaves
          // the saved original bytes for the next owning Scope to recover.
          yield* Effect.result(log.appendCas(anchor, checked.checkpoint, new Uint8Array(record)));
          checked = yield* inspect(record, checked.checkpoint);
          if (!checked.outcome) return yield* fail('unconfirmed');
          const observed = yield* store(journal.load(anchor));
          yield* store(
            journal.finish(anchor, record, checked.outcome, observed.checkpoint, checked.checkpoint)
          );
        } else {
          yield* store(
            journal.finish(anchor, record, checked.outcome, entry.checkpoint, checked.checkpoint)
          );
        }
        return { outcome: checked.outcome, record: new Uint8Array(record) };
      });

      const acknowledge = Effect.fn('@lody/e2ee-core/LedgerSubmission.acknowledge')(function* (
        result: SubmissionResult
      ) {
        return yield* store(journal.acknowledge(anchor, result));
      });

      return LedgerSubmission.of({
        submit: Effect.fn('@lody/e2ee-core/LedgerSubmission.submit')(function* (input: Uint8Array) {
          const record = (yield* Effect.fromResult(decodeRecord(input))).recordBytes;
          const entry = yield* store(journal.load(anchor));
          if (entry.record && !bytesEqual(entry.record, record)) return yield* fail('busy');
          if (!entry.record) {
            yield* inspect(record, entry.checkpoint);
            yield* store(journal.prepare(anchor, record));
          }
          const result = yield* recover(record);
          if (!result) return yield* fail('corrupt');
          return result;
        }),
        resume: Effect.fn('@lody/e2ee-core/LedgerSubmission.resume')(function* () {
          return yield* recover();
        }),
        // Keep the pre-tracing contract: detach input at invocation, before
        // Effect.fn's lazy body runs or the caller mutates the result.
        acknowledge: (result) =>
          acknowledge({
            outcome: result.outcome,
            record: new Uint8Array(result.record),
          }),
        pending: Effect.fn('@lody/e2ee-core/LedgerSubmission.pending')(function* () {
          return yield* store(journal.load(anchor));
        }),
      });
    })
  );
}

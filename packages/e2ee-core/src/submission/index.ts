import { Context, Data, Effect } from 'effect';
import type { GenesisHash } from '../bytes';
import { bytesEqual } from '../cbor';
import {
  decodeRecord,
  extendLedger,
  hashRecordBytes,
  verifyLedger,
  type LedgerCheckpoint,
  type LedgerError,
} from '../ledger';

export class SubmissionError extends Data.TaggedError('SubmissionError')<{
  readonly code:
    | 'storage'
    | 'busy'
    | 'rollback'
    | 'missing-parent'
    | 'ordinary-only'
    | 'corrupt-journal'
    | 'unconfirmed';
}> {}
export class SubmissionRemoteError extends Data.TaggedError('SubmissionRemoteError')<{}> {}
export type Outcome = 'Committed' | 'Conflict';
export interface SubmissionResult {
  readonly outcome: Outcome;
  readonly record: Uint8Array;
}
export interface JournalEntry {
  readonly record: Uint8Array | null;
  readonly outcome: Outcome | null;
  readonly checkpoint: LedgerCheckpoint | null;
}
export class SubmissionJournal extends Context.Service<
  SubmissionJournal,
  {
    load(anchor: GenesisHash): Effect.Effect<JournalEntry, SubmissionError>;
    prepare(anchor: GenesisHash, record: Uint8Array): Effect.Effect<void, SubmissionError>;
    observe(
      anchor: GenesisHash,
      record: Uint8Array,
      before: LedgerCheckpoint | null,
      after: LedgerCheckpoint
    ): Effect.Effect<void, SubmissionError>;
    finish(
      anchor: GenesisHash,
      record: Uint8Array,
      outcome: Outcome,
      before: LedgerCheckpoint | null,
      after: LedgerCheckpoint
    ): Effect.Effect<void, SubmissionError>;
    acknowledge(
      anchor: GenesisHash,
      result: SubmissionResult
    ): Effect.Effect<void, SubmissionError>;
  }
>()('@lody/e2ee-core/SubmissionJournal') {}
/** Trusted host composition supplies the expected endpoint and complete history.
 * A packet/URL's self-reported endpoint is not independent freshness evidence. */
export class SubmissionRemote extends Context.Service<
  SubmissionRemote,
  {
    read(anchor: GenesisHash): Effect.Effect<
      {
        readonly records: readonly Uint8Array[];
        readonly checkpoint: LedgerCheckpoint;
      },
      SubmissionRemoteError
    >;
    appendCas(
      anchor: GenesisHash,
      expected: LedgerCheckpoint,
      record: Uint8Array
    ): Effect.Effect<void, SubmissionRemoteError>;
  }
>()('@lody/e2ee-core/SubmissionRemote') {}

const inspect = Effect.fnUntraced(function* (
  anchor: GenesisHash,
  record: Uint8Array,
  pin: LedgerCheckpoint | null
) {
  const remote = yield* SubmissionRemote;
  const incoming = yield* remote.read(anchor);
  // Parsing bounds each copy and detaches arrays owned by an asynchronous host.
  const records: Uint8Array[] = [];
  for (const bytes of incoming.records)
    records.push((yield* Effect.fromResult(decodeRecord(bytes))).recordBytes);
  const view = yield* Effect.fromResult(
    verifyLedger({ anchor, records, checkpoint: incoming.checkpoint })
  );
  if (
    pin &&
    (records.length < pin.length || !hashRecordBytes(records[pin.length - 1]!).equals(pin.head))
  )
    return yield* new SubmissionError({ code: 'rollback' });
  const decoded = yield* Effect.fromResult(decodeRecord(record));
  if (decoded.body.type !== 'ordinary')
    return yield* new SubmissionError({ code: 'ordinary-only' });
  const parent = decoded.body.previousHash;
  const parentIndex = records.findIndex((bytes) => hashRecordBytes(bytes).equals(parent));
  if (parentIndex < 0) return yield* new SubmissionError({ code: 'missing-parent' });
  // Revalidate the exact pending operation against its authenticated predecessor,
  // including after a signer was revoked or a terminal row was tampered with.
  const predecessor = yield* Effect.fromResult(
    verifyLedger({
      anchor,
      records: records.slice(0, parentIndex + 1),
      checkpoint: { head: parent, length: parentIndex + 1 },
    })
  );
  yield* Effect.fromResult(
    extendLedger(predecessor, [record], { head: hashRecordBytes(record), length: parentIndex + 2 })
  );
  const found = records.some((bytes) => bytesEqual(bytes, record));
  const outcome: Outcome | null = found
    ? 'Committed'
    : view.head.equals(parent)
      ? null
      : 'Conflict';
  return { outcome, checkpoint: { head: view.head, length: view.length } };
});

/** Finite recovery: the caller invokes again on connectivity return/startup.
 * Failures/interruption retain pending. No timer, runtime or signing capability. */
const recover = Effect.fnUntraced(function* (
  anchor: GenesisHash,
  expectedRecord?: Uint8Array
): Effect.fn.Return<
  SubmissionResult | null,
  SubmissionError | SubmissionRemoteError | LedgerError,
  SubmissionJournal | SubmissionRemote
> {
  const journal = yield* SubmissionJournal;
  const entry = yield* journal.load(anchor);
  if (expectedRecord && (!entry.record || !bytesEqual(entry.record, expectedRecord)))
    return yield* new SubmissionError({ code: 'busy' });
  if (!entry.record) return null;
  const record = entry.record;
  let checked = yield* inspect(anchor, record, entry.checkpoint);
  if (entry.outcome) {
    if (checked.outcome !== entry.outcome)
      return yield* new SubmissionError({ code: 'corrupt-journal' });
    yield* journal.finish(anchor, record, entry.outcome, entry.checkpoint, checked.checkpoint);
    return { outcome: entry.outcome, record: new Uint8Array(record) };
  }
  if (!checked.outcome) {
    yield* journal.observe(anchor, record, entry.checkpoint, checked.checkpoint);
    const remote = yield* SubmissionRemote;
    // Even a typed lost-response failure requires readback. An interruption leaves
    // the saved original bytes for the next owning Scope to recover.
    yield* Effect.result(remote.appendCas(anchor, checked.checkpoint, new Uint8Array(record)));
    checked = yield* inspect(anchor, record, checked.checkpoint);
    if (!checked.outcome) return yield* new SubmissionError({ code: 'unconfirmed' });
    yield* journal.finish(
      anchor,
      record,
      checked.outcome,
      (yield* journal.load(anchor)).checkpoint,
      checked.checkpoint
    );
  } else {
    yield* journal.finish(anchor, record, checked.outcome, entry.checkpoint, checked.checkpoint);
  }
  return { outcome: checked.outcome, record: new Uint8Array(record) };
});

export const resumeSubmission = (anchor: GenesisHash) => recover(anchor);

export const submitRecord = Effect.fnUntraced(function* (
  anchor: GenesisHash,
  input: Uint8Array
): Effect.fn.Return<
  SubmissionResult,
  SubmissionError | SubmissionRemoteError | LedgerError,
  SubmissionJournal | SubmissionRemote
> {
  const record = (yield* Effect.fromResult(decodeRecord(input))).recordBytes;
  const journal = yield* SubmissionJournal;
  const entry = yield* journal.load(anchor);
  if (entry.record && !bytesEqual(entry.record, record))
    return yield* new SubmissionError({ code: 'busy' });
  if (!entry.record) {
    yield* inspect(anchor, record, entry.checkpoint);
    yield* journal.prepare(anchor, record);
  }
  const result = yield* recover(anchor, record);
  if (!result) return yield* new SubmissionError({ code: 'corrupt-journal' });
  return result;
});

export const acknowledgeSubmission = Effect.fnUntraced(function* (
  anchor: GenesisHash,
  result: SubmissionResult
) {
  const journal = yield* SubmissionJournal;
  yield* journal.acknowledge(anchor, {
    outcome: result.outcome,
    record: new Uint8Array(result.record),
  });
});

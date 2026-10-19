import { Context, type Effect } from 'effect';
import type { GenesisHash } from '../internal/foundation/bytes';
import type { LedgerCheckpoint, LedgerView } from '../internal/ledger';
import type {
  LedgerFeedError,
  LedgerFeedState,
  LedgerReadPage,
} from '../internal/ledger/feed-page';
import type {
  BackendError,
  LedgerLogError,
  LedgerViewSourceError,
  LocalStoreError,
} from './errors';

/**
 * The remote append-only log that stores a workspace's signed ledger records.
 *
 * This is the only remote write the protocol depends on for authority, and it is
 * deliberately small: read the complete history, and append one record only if
 * the log still ends at `expected` (compare-and-swap).
 *
 * Contract for implementers:
 * - `read` returns every record from genesis in order, plus the head/count the
 *   log claims. The library re-verifies every signature and permission, so the
 *   log is trusted only for availability and for not hiding newer records.
 * - `appendCas` must append atomically if and only if the current tail equals
 *   `expected`; it must never append unconditionally. Appending the exact same
 *   bytes twice must be idempotent or rejected, never duplicated.
 * - Failures are reported as {@link LedgerLogError}. After a failed append the
 *   library reads back to learn whether its original record was committed.
 *
 * The Loro Streams adapter (`@lody/e2ee-core/adapters/loro-streams`) implements
 * this over a Durable Streams control stream.
 *
 * @category Backend ports
 */
export class LedgerLog extends Context.Service<
  LedgerLog,
  {
    /** Read original records from genesis and the claimed endpoint; failures are transport outcomes, not authority. */
    read(anchor: GenesisHash): Effect.Effect<
      {
        readonly records: readonly Uint8Array[];
        readonly checkpoint: LedgerCheckpoint;
      },
      LedgerLogError
    >;
    /** Atomically append at `expected`; an error may follow a committed write, so callers must read back. */
    appendCas(
      anchor: GenesisHash,
      expected: LedgerCheckpoint,
      record: Uint8Array
    ): Effect.Effect<void, LedgerLogError>;
  }
>()('@lody/e2ee-core/LedgerLog') {}

/**
 * Paged, offset-addressed reads of the same ledger log, used to keep a local
 * verified feed up to date without re-downloading the whole history.
 *
 * Offsets are opaque tokens chosen by the log; the library never orders or
 * computes them. A page is untrusted input: every record is verified against
 * the already verified prefix before the feed advances.
 *
 * @category Backend ports
 */
export class LedgerFeedSource extends Context.Service<
  LedgerFeedSource,
  {
    /** Read after the opaque offset (`'-1'` starts at genesis); return an untrusted page or LedgerFeedError. */
    readAfter(offset: string): Effect.Effect<LedgerReadPage, LedgerFeedError>;
  }
>()('@lody/e2ee-core/LedgerFeedSource') {}

/**
 * Supplies the newest genuine (library-verified) ledger view the application
 * has. Typically backed by a {@link LedgerFeedSource}-driven feed.
 *
 * Only views produced by this library's verifiers are accepted; the
 * `VerifiedLedger` workflow additionally rejects rollback and forks against the
 * last durably pinned checkpoint before any workflow acts on a view.
 *
 * @category Application ports
 */
export class LedgerViewSource extends Context.Service<
  LedgerViewSource,
  {
    /** Return the newest genuine view available; wrap expected source failures in LedgerViewSourceError. */
    current(): Effect.Effect<LedgerView, LedgerViewSourceError>;
  }
>()('@lody/e2ee-core/LedgerViewSource') {}

/**
 * Durable local memory of the newest ledger checkpoint this device accepted.
 *
 * It is a rollback guard, not a permission certificate: after restart the
 * device refuses any ledger view that does not contain the pinned checkpoint.
 * `write` is only called with checkpoints that extend the previous pin.
 *
 * @category Local storage ports
 */
export class LedgerPinStore extends Context.Service<
  LedgerPinStore,
  {
    /** Read the last durable checkpoint, or `null` on first use; a read failure must not reset it. */
    read(): Effect.Effect<LedgerCheckpoint | null, LocalStoreError>;
    /** Atomically persist and verify the checkpoint; callers have already established continuation. */
    write(checkpoint: LedgerCheckpoint): Effect.Effect<void, LocalStoreError>;
  }
>()('@lody/e2ee-core/LedgerPinStore') {}

/**
 * Original bytes of the record that published the current epoch: the genesis
 * record at epoch 0, otherwise the `publishEpoch` or
 * `removeMemberAndPublishEpoch` record for `view`'s epoch. Return `null` if it
 * is not available locally.
 *
 * The result is untrusted. The library only uses it to record this device's
 * own publication, and verifies it against `view` first. Typical
 * implementations scan the application's local ledger feed backwards.
 *
 * @category Application ports
 */
export class EpochPublicationSource extends Context.Service<
  EpochPublicationSource,
  {
    /** Return original publication bytes for `view`'s epoch, or `null`; callers authenticate them before use. */
    current(view: LedgerView): Effect.Effect<Uint8Array | null, LocalStoreError | BackendError>;
  }
>()('@lody/e2ee-core/EpochPublicationSource') {}

/** Final outcome of one ledger submission: the exact record was appended, or another record took its place. */
export type SubmissionOutcome = 'Committed' | 'Conflict';

/** A finished submission: its outcome and the exact original record bytes. */
export interface SubmissionResult {
  readonly outcome: SubmissionOutcome;
  readonly record: Uint8Array;
}

/**
 * State of the single in-flight submission of one workspace: the pending or
 * finished original record, its outcome once known, and the newest log
 * checkpoint observed while submitting (a local rollback guard).
 */
export interface SubmissionEntry {
  readonly record: Uint8Array | null;
  readonly outcome: SubmissionOutcome | null;
  readonly checkpoint: LedgerCheckpoint | null;
}

/**
 * Durable journal of this device's ledger submissions, one slot per workspace.
 *
 * The original signed record is saved before the first append attempt, so a
 * crash or a lost response always retries the *same bytes* and learns the
 * outcome by reading the log back, never by re-signing. A finished result stays
 * until the application acknowledges it.
 *
 * Contract for implementers (each method is one atomic step):
 * - `prepare` stores `record` if the slot is empty; the same bytes again is a
 *   no-op; a different record fails with `conflict`.
 * - `observe`/`finish` apply only while the slot still holds `record` with
 *   checkpoint `before` (else `conflict`), and must refuse an `after` that is
 *   shorter than `before`, or equally long with another head (`conflict`).
 *   `finish` keeps an already recorded outcome and refuses a different one.
 * - `acknowledge` clears a finished slot whose result equals `result` (else
 *   `conflict`) and keeps the checkpoint.
 *
 * @category Local storage ports
 */
export class SubmissionJournal extends Context.Service<
  SubmissionJournal,
  {
    /** Read the bound workspace's slot and retained checkpoint; an unused slot contains null fields. */
    load(anchor: GenesisHash): Effect.Effect<SubmissionEntry, LocalStoreError>;
    /** Persist a copy before network I/O; identical retries are no-ops and a different occupied record conflicts. */
    prepare(anchor: GenesisHash, record: Uint8Array): Effect.Effect<void, LocalStoreError>;
    /** Record a newer observed checkpoint while the outcome is still unknown. */
    observe(
      anchor: GenesisHash,
      record: Uint8Array,
      before: LedgerCheckpoint | null,
      after: LedgerCheckpoint
    ): Effect.Effect<void, LocalStoreError>;
    /** Atomically retain the terminal outcome and advance the pin only when record and `before` still match. */
    finish(
      anchor: GenesisHash,
      record: Uint8Array,
      outcome: SubmissionOutcome,
      before: LedgerCheckpoint | null,
      after: LedgerCheckpoint
    ): Effect.Effect<void, LocalStoreError>;
    /** Clear only the matching terminal result, retaining its pin; unfinished or mismatched results conflict. */
    acknowledge(
      anchor: GenesisHash,
      result: SubmissionResult
    ): Effect.Effect<void, LocalStoreError>;
  }
>()('@lody/e2ee-core/SubmissionJournal') {}

/**
 * Keeps the application's local verified feed current.
 *
 * `refresh()` selects the target checkpoint independently (never from the
 * feed's own claims) and reads the feed up to it, returning the new state;
 * `current()` returns the stored state without network work. Typically a
 * `LedgerFeedSource` pager driving `LedgerFeed.accept`, with the checkpoint
 * taken from a separately trusted source.
 *
 * @category Application ports
 */
export class LedgerSync extends Context.Service<
  LedgerSync,
  {
    /** Read the retained verified feed without network work; source-specific failures propagate to the application. */
    current(): Effect.Effect<LedgerFeedState, unknown>;
    /** Read and verify up to an independently chosen endpoint, then persist it; never trust a server-selected endpoint implicitly. */
    refresh(): Effect.Effect<LedgerFeedState, unknown>;
  }
>()('@lody/e2ee-core/LedgerSync') {}

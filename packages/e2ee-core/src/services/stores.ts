import { Context, type Effect } from 'effect';
import type { LocalStoreError } from './errors';

/**
 * Durable local storage of this device's installed epoch keys, as opaque
 * protected blobs (see {@link KeyProtector}).
 *
 * The store never sees plaintext keys and decides nothing: the
 * `InstalledEpochKeys` workflow seals, opens and verifies every blob against
 * the ledger commitment. The first durable blob for an epoch wins; `replace`
 * exists only to repair a blob that no longer opens.
 *
 * @category Local storage ports
 */
export class InstalledKeyStore extends Context.Service<
  InstalledKeyStore,
  {
    /** Read an owned protected blob for the epoch, or `null`; never return plaintext or treat a read failure as absence. */
    load(epoch: number): Effect.Effect<Uint8Array | null, LocalStoreError>;
    /** Keep an existing blob for `epoch`; otherwise store `blob`. */
    insertIfAbsent(epoch: number, blob: Uint8Array): Effect.Effect<void, LocalStoreError>;
    /** Replace the blob for `epoch` only if it still equals `expected`; otherwise keep the
     * concurrent original (the caller reloads and verifies whatever is stored). */
    replace(
      epoch: number,
      expected: Uint8Array,
      next: Uint8Array
    ): Effect.Effect<void, LocalStoreError>;
  }
>()('@lody/e2ee-core/InstalledKeyStore') {}

/** Phase of one recipient installation task. */
export type ReceiveTaskPhase = 'Install' | 'Report' | 'Reported' | 'Obsolete' | 'Revoked';

/**
 * One durable recipient installation task, exactly as stored. Every field is
 * re-validated by the `KeyReceiver` workflow when read back.
 */
export interface ReceiveTaskRow {
  /** Digest of `body`; the stable task identity. */
  readonly id: string;
  /** Canonical installation context (what will be reported). */
  readonly body: Uint8Array;
  /** Original envelope frame, for envelope installs. */
  readonly frame: Uint8Array | null;
  /** Original epoch-publication record, for this device's own rotations. */
  readonly publication: Uint8Array | null;
  /** Signed installation report, once queued. */
  readonly report: Uint8Array | null;
  readonly phase: ReceiveTaskPhase;
}

/**
 * Durable journal of the recipient's key installations and their reports.
 *
 * A task moves `Install` → `Report` (signed report queued) → `Reported` (backend
 * acknowledged), or ends `Obsolete`/`Revoked` when the ledger moved on. Ended
 * tasks stay until the application acknowledges their result. Each method is
 * one atomic step; the workflow re-reads and verifies after writing.
 *
 * @category Local storage ports
 */
export class ReceiveJournal extends Context.Service<
  ReceiveJournal,
  {
    /** Store a new `Install` task unless one with the same id exists. */
    insertIfAbsent(task: {
      readonly id: string;
      readonly body: Uint8Array;
      readonly frame: Uint8Array | null;
      readonly publication: Uint8Array | null;
    }): Effect.Effect<void, LocalStoreError>;
    /** Read the original task and its phase, or `null`; return owned byte buffers for workflow verification. */
    load(id: string): Effect.Effect<ReceiveTaskRow | null, LocalStoreError>;
    /** `Install` → `Report` with `report`, only if no report is queued yet (else `conflict`). */
    queueReport(id: string, report: Uint8Array): Effect.Effect<void, LocalStoreError>;
    /** `Report` → `Reported`. No effect in any other phase. */
    markReported(id: string): Effect.Effect<void, LocalStoreError>;
    /** `Install`/`Report` → `phase`. No effect on already ended tasks. */
    end(id: string, phase: 'Obsolete' | 'Revoked'): Effect.Effect<void, LocalStoreError>;
    /** Ids in `phase` after `cursor` in id order, with the next cursor if more remain. */
    pending(
      phase: 'Install' | 'Report',
      cursor: string | null,
      limit: number
    ): Effect.Effect<
      { readonly ids: readonly string[]; readonly next: string | null },
      LocalStoreError
    >;
    /** Unacknowledged `Reported`/`Obsolete`/`Revoked` tasks in id order. */
    results(limit: number): Effect.Effect<readonly ReceiveTaskRow[], LocalStoreError>;
    /** Mark an ended task's result consumed. No effect on unfinished tasks. */
    acknowledge(id: string): Effect.Effect<void, LocalStoreError>;
  }
>()('@lody/e2ee-core/ReceiveJournal') {}

/** Phase of one repair request. */
export type RepairTaskPhase = 'Pending' | 'Repaired' | 'Obsolete' | 'Revoked';

/** One durable repair request, exactly as stored. */
export interface RepairTaskRow {
  /** Caller-chosen stable request id, reused on every retry. */
  readonly id: string;
  readonly epoch: number;
  /** Digest of the envelope frame this device rejects, if any. */
  readonly rejected: string | null;
  readonly phase: RepairTaskPhase;
}

/**
 * Durable journal of repair requests ("send me a fresh envelope for this
 * epoch"). A request is persisted with its stable id before it is sent, so a
 * lost acknowledgement retries the same id instead of creating a second repair.
 *
 * @category Local storage ports
 */
export class RepairJournal extends Context.Service<
  RepairJournal,
  {
    /** Store a `Pending` request unless one with the same id exists. */
    insertIfAbsent(task: {
      readonly id: string;
      readonly epoch: number;
      readonly rejected: string | null;
    }): Effect.Effect<void, LocalStoreError>;
    /** Read the durable request, or `null`; its stable id and rejected digest must survive reopen unchanged. */
    load(id: string): Effect.Effect<RepairTaskRow | null, LocalStoreError>;
    /** `Pending` → `phase` (else `conflict`). */
    finish(
      id: string,
      phase: Exclude<RepairTaskPhase, 'Pending'>
    ): Effect.Effect<void, LocalStoreError>;
    /** Page pending tasks in id order strictly after `cursor`; `next` is the last returned id only when more remain. */
    pending(
      cursor: string | null,
      limit: number
    ): Effect.Effect<
      { readonly tasks: readonly RepairTaskRow[]; readonly next: string | null },
      LocalStoreError
    >;
    /** Unacknowledged finished requests after `cursor` in id order. */
    results(
      cursor: string | null,
      limit: number
    ): Effect.Effect<
      { readonly tasks: readonly RepairTaskRow[]; readonly next: string | null },
      LocalStoreError
    >;
    /** Mark a finished request's result consumed. No effect on pending requests. */
    acknowledge(id: string): Effect.Effect<void, LocalStoreError>;
  }
>()('@lody/e2ee-core/RepairJournal') {}

/**
 * Durable sender-side copy of each epoch-key envelope this device authored,
 * keyed by its delivery slot (one per epoch and recipient).
 *
 * The first saved frame for a slot is kept forever, so a retry after a crash
 * re-sends the exact same ciphertext instead of encrypting a second one. The
 * library re-authenticates every loaded frame against the ledger.
 *
 * @category Local storage ports
 */
export class DeliveryOutbox extends Context.Service<
  DeliveryOutbox,
  {
    /** Return an owned copy of the first saved ciphertext for this slot, or `null`; never replace it on retry. */
    load(slot: string): Effect.Effect<Uint8Array | null, LocalStoreError>;
    /** Keep the first frame stored for `slot` and return it (a racing loser gets the winner's). */
    saveOriginal(slot: string, frame: Uint8Array): Effect.Effect<Uint8Array, LocalStoreError>;
  }
>()('@lody/e2ee-core/DeliveryOutbox') {}

/** Phase of one distribution task. */
export type DistributionTaskPhase = 'Pending' | 'Observed' | 'Obsolete' | 'Revoked';

/** One durable distribution task, exactly as stored. */
export interface DistributionTaskRow {
  /** Derived from (delivery slot, mailbox revision); the stable task identity. */
  readonly id: string;
  readonly epoch: number;
  /** Recipient device id. */
  readonly recipient: string;
  /** Mailbox repair revision the task answers. */
  readonly revision: number;
  readonly phase: DistributionTaskPhase;
  readonly consumed: boolean;
}

/**
 * Durable journal of envelope deliveries this device owes other devices for the
 * current epoch, one task per (recipient, mailbox revision).
 *
 * A task is `Pending` until the delivered envelope is observed by the mailbox,
 * or ends `Obsolete`/`Revoked` when the ledger moved on. Implementations may
 * bound unacknowledged tasks and fail `insertIfAbsent` with `capacity`.
 *
 * @category Local storage ports
 */
export class DistributionJournal extends Context.Service<
  DistributionJournal,
  {
    /** Store a `Pending` task unless one with the same id exists; `true` when inserted. */
    insertIfAbsent(task: {
      readonly id: string;
      readonly epoch: number;
      readonly recipient: string;
      readonly revision: number;
    }): Effect.Effect<boolean, LocalStoreError>;
    /** Read the durable task including consumption state, or `null`; the workflow validates its identity. */
    load(id: string): Effect.Effect<DistributionTaskRow | null, LocalStoreError>;
    /** `Pending` → `phase` (else `conflict`). */
    finish(
      id: string,
      phase: Exclude<DistributionTaskPhase, 'Pending'>
    ): Effect.Effect<void, LocalStoreError>;
    /** Page pending task ids strictly after `cursor`; preserve blocked tasks and return `next` only when more remain. */
    pending(
      cursor: string | null,
      limit: number
    ): Effect.Effect<
      { readonly ids: readonly string[]; readonly next: string | null },
      LocalStoreError
    >;
    /** Unacknowledged finished tasks after `cursor` in id order. */
    results(
      cursor: string | null,
      limit: number
    ): Effect.Effect<
      { readonly tasks: readonly DistributionTaskRow[]; readonly next: string | null },
      LocalStoreError
    >;
    /** Mark a finished task consumed (`conflict` if it is still pending). */
    acknowledge(id: string): Effect.Effect<void, LocalStoreError>;
  }
>()('@lody/e2ee-core/DistributionJournal') {}

/**
 * The single unfinished epoch rotation this device is publishing, exactly as
 * stored: the signed record, every staged envelope and the protected new key.
 * Every field is re-validated by the `EpochPublisher` workflow when read back.
 */
export interface EpochCandidateRow {
  /** Hash of `record`. */
  readonly id: string;
  /** Head hash and record count of the ledger the record extends. */
  readonly parent: Uint8Array;
  readonly parentCount: number;
  readonly epoch: number;
  readonly commitment: Uint8Array;
  /** The signed rotation record. */
  readonly record: Uint8Array;
  /** Canonical CBOR list of (recipient, envelope frame) for the staged group. */
  readonly envelopes: Uint8Array;
  /** The new epoch key sealed by {@link CandidateProtector}; emptied after a `Conflict`. */
  readonly blob: Uint8Array;
  readonly outcome: 'Committed' | 'Conflict' | null;
  /** Whether the epoch was current or already historical when first installed. */
  readonly binding: 'current' | 'historical' | null;
  readonly consumed: boolean;
}

/**
 * Durable local recovery state for epoch rotations this device publishes, so a
 * crash between signing, staging and appending resumes the same rotation with
 * the same key instead of generating another. At most one candidate is
 * unconsumed at a time. Holds only protected key material.
 *
 * @category Local storage ports
 */
export class EpochCandidateStore extends Context.Service<
  EpochCandidateStore,
  {
    /** The unconsumed candidate, if any (`corrupt` if more than one). */
    active(): Effect.Effect<EpochCandidateRow | null, LocalStoreError>;
    /** Read a candidate including terminal or consumed state, or `null`; return owned copies of its original bytes. */
    load(id: string): Effect.Effect<EpochCandidateRow | null, LocalStoreError>;
    /** Store a new candidate (`conflict` if another one is unconsumed). */
    insert(row: EpochCandidateRow): Effect.Effect<void, LocalStoreError>;
    /**
     * Update `outcome`, `binding`, `blob` and `consumed` of the stored candidate
     * only if it still equals `expected` field by field (else `conflict`).
     */
    replace(
      expected: EpochCandidateRow,
      next: EpochCandidateRow
    ): Effect.Effect<void, LocalStoreError>;
  }
>()('@lody/e2ee-core/EpochCandidateStore') {}

/** Position of a local ledger feed: newest head and record count, source offset and size. */
export interface LedgerFeedTail {
  readonly head: Uint8Array;
  readonly count: number;
  /** Opaque {@link LedgerFeedSource} offset to read after. */
  readonly offset: string;
  /** True only before the first page of a genesis-origin feed is accepted. */
  readonly bootstrap: boolean;
  /** Origin bytes plus every stored record's bytes. */
  readonly bytes: number;
}

/** Everything a {@link LedgerFeedStore} holds. */
export interface LedgerFeedContents {
  /** The genesis record, or an endorsed snapshot, the feed starts from. */
  readonly origin: Uint8Array;
  /** Number of ledger records the origin covers (1 for a genesis record). */
  readonly originCount: number;
  readonly tail: LedgerFeedTail;
  /** Original records after the origin, in ledger order. */
  readonly records: readonly Uint8Array[];
}

/**
 * Durable local copy of a workspace's ledger: an origin plus the original
 * records after it, so a restart re-verifies locally instead of downloading the
 * whole history. Holds no secrets; the `LedgerFeed` workflow re-verifies every
 * byte on open and decides what to append.
 *
 * Each write is atomic and conditional on the stored tail, so two writers can
 * never interleave appends.
 *
 * @category Local storage ports
 */
export class LedgerFeedStore extends Context.Service<
  LedgerFeedStore,
  {
    /** All contents, or `null` if never initialized. Fails `capacity` past `maxRecords`. */
    load(maxRecords: number): Effect.Effect<LedgerFeedContents | null, LocalStoreError>;
    /** The stored tail only, or `null` if never initialized. */
    tail(): Effect.Effect<LedgerFeedTail | null, LocalStoreError>;
    /** Store the origin of an empty feed (`conflict` if already initialized). */
    initialize(
      origin: Uint8Array,
      originCount: number,
      tail: LedgerFeedTail
    ): Effect.Effect<void, LocalStoreError>;
    /** Append `records` and move the tail to `next`, only if the tail still equals `expected` (else `conflict`). */
    append(
      expected: LedgerFeedTail,
      records: readonly Uint8Array[],
      next: LedgerFeedTail
    ): Effect.Effect<void, LocalStoreError>;
  }
>()('@lody/e2ee-core/LedgerFeedStore') {}

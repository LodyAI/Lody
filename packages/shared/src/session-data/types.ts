import type { MessageContent, ModelInfo } from '../ai';
import type { AcpSessionNotification } from '../acp/schema';
import type { SessionGoalMessage } from '../goal';
import type { PermissionOutcome } from '../message';
import type { SessionId } from '../ids';
import type { SessionHistoryInput } from '../schema';
import type { SessionSnapshotService } from './snapshot';
import type {
  SessionDirectoryRow,
  SessionTurn,
  SessionTurnRead,
  SessionTurnWritableValues,
  SessionWritableField,
} from './domain';

// # Session data ports
//
// The CRDT-neutral seam between session *business* code (React UI, CLI, MCP)
// and one concrete storage implementation (today Loro + Mirror + repo; later a
// database CRDT). Nothing here names Loro, Mirror, a CID, a container id or a
// storage offset, and its DTOs come from `./domain` rather than the storage
// schema. Adapters keep storage details inside `session-data/loro.ts`.
//
// A field change is explicit. `set` writes a value, `clear` removes it, and an
// omitted field is never a change. Callers do not rely on `undefined` surviving
// a JSON/worker/Rust boundary to mean "delete".
//
// A command result states its phase. A validated pre-write rejection is not the
// same as an accepted change, and an accepted-but-unacknowledged change is not a
// rejection. Only the first is safe to retry blindly.

export type {
  SessionDirectoryRow,
  SessionDirectoryScalars,
  SessionTurn,
  SessionTurnRole,
  SessionTurnStatus,
  SessionTurnRead,
  SessionUnavailableReason,
  SessionWritableField,
  SessionTurnWritableValues,
} from './domain';
export { SESSION_DIRECTORY_INPUT_CONFIG_KEYS } from './domain';

/**
 * An explicit field change. `set` with an explicit value, or `clear` to remove
 * the field from storage (and from the serialized shape). Never "undefined
 * means delete".
 */
export type SessionFieldChange<T> =
  | { readonly kind: 'set'; readonly value: T }
  | { readonly kind: 'clear' };

export const setFieldTo = <T>(value: T): SessionFieldChange<T> => ({ kind: 'set', value });

/**
 * Clear a field. Contextual typing makes `clearField()` usable as the change
 * argument without repeating the field's type.
 */
export const clearField = <T>(): SessionFieldChange<T> => ({ kind: 'clear' });

/** Content-free rejection metadata: paths and codes, never conversation text. */
export type SessionCommandRejection = {
  readonly code: 'invalid_input' | 'not_found' | 'conflict' | 'unsupported';
  readonly issues?: readonly { readonly path: readonly PropertyKey[]; readonly code: string }[];
};

declare const sessionWriteReceiptBrand: unique symbol;

/**
 * An accepted change's receipt. It is a capability issued by the store that
 * applied the change: the brand is not exported, and each store keeps its own
 * issued set, so a caller cannot fabricate a receipt for a different store or a
 * change that was never applied.
 */
export interface SessionWriteReceipt {
  readonly [sessionWriteReceiptBrand]: true;
  readonly sessionId: SessionId;
  /** Business turn ids touched by the accepted change, in the order applied. */
  readonly turnIds: readonly string[];
  readonly kind:
    | 'append'
    | 'replace'
    | 'set-field'
    | 'resume-assistant'
    | 'open-assistant-turn'
    | 'resolve-task-proposal'
    | 'mark-seen'
    | 'respond-permission'
    | 'copy'
    | 'replace-editable-tail'
    | 'import-history'
    | 'apply-agent-batch';
}

/** A user's decision on a task proposal, resolved against the live notice. */
export type TaskProposalResolution = {
  readonly taskId?: string;
  readonly outcome: 'created' | 'dismissed';
};

/**
 * One bound batch of agent output. The target assistant turn is part of the
 * input, never re-selected at flush time. `entryBound` means the caller has
 * already proved every message belongs to `targetAssistantEntryId` (text/thought
 * chunks); the adapter then rewrites only that located turn. Otherwise the
 * adapter routes through the whole history because a tool/subagent update can
 * belong to an older turn.
 */
export type ApplyAgentBatchInput = {
  readonly notifications?: readonly AcpSessionNotification[];
  readonly contents?: readonly MessageContent[];
  readonly targetAssistantEntryId?: string;
  readonly entryBound?: boolean;
  readonly model?: ModelInfo;
  /** Deterministic identity for tests; production derives the target id. */
  readonly createId?: () => string;
  readonly now?: () => string;
};

/**
 * Reopen (or create) the assistant turn for a (re)started execution. When the
 * turn already exists the adapter clears its terminal footprint
 * (`finished`/`endedAt`/`permissionWaitMs`) and fills missing provenance in one
 * conditional commit; unknown stored fields survive. When it does not exist the
 * adapter appends a fresh assistant turn.
 */
export type OpenAssistantTurnInput = {
  readonly turnId: string;
  /** Attached only when the stored turn has none (never overwrites a value). */
  readonly userTurnId?: string;
  /** Applied only when provided. */
  readonly modelInfo?: SessionTurn['modelInfo'];
  /** Timestamp for a freshly created turn. */
  readonly timestamp: string;
};

/**
 * Three phases, deliberately distinct:
 *  - `accepted`   — the store holds the change; retrying would duplicate it.
 *                   `postAcceptError` reports an accepted write whose *side
 *                   effect* (cache notification, evidence) then failed; the
 *                   change itself is applied and must not be re-issued.
 *  - `rejected`   — validated and refused before touching storage; the caller
 *                   may fix and retry.
 *  - `indeterminate` — the implementation cannot say whether the change
 *                   committed. Never auto-retry; surface it.
 */
export type SessionCommandResult =
  | {
      readonly status: 'accepted';
      readonly receipt: SessionWriteReceipt;
      readonly postAcceptError?: unknown;
    }
  | { readonly status: 'rejected'; readonly reason: SessionCommandRejection }
  | { readonly status: 'indeterminate'; readonly cause: unknown };

/**
 * Domain reasons a tail replacement is refused before any write.
 *  - `invalid_input` — the replacement is not a valid authored user turn.
 *  - `active_goal`   — the session has an active goal; replacement would discard it.
 *  - `stale_boundary`— the editable tail or its provider boundary changed since
 *                      the caller resolved it.
 *  - `unsupported`   — the backend cannot perform the guarded replacement.
 */
export type SessionEditableTailRejectionCode =
  | 'invalid_input'
  | 'active_goal'
  | 'stale_boundary'
  | 'unsupported';

export type SessionEditableTailRejection = {
  readonly code: SessionEditableTailRejectionCode;
  readonly issues?: readonly { readonly path: readonly PropertyKey[]; readonly code: string }[];
};

/**
 * Replace the editable tail user turn with `replacement`. The store re-locates
 * the tail and re-checks the session goal inside its own commit, so a change
 * that landed between the caller's eligibility check and this call is refused
 * (`stale_boundary` / `active_goal`) rather than silently overwritten. The
 * accepted result carries `previousUserTurnId` — the last user turn before the
 * replaced tail — which the caller's meta commit needs, plus the awaitable
 * `rollback` compensation that restores only the replaced range and retains rows
 * appended afterwards. Backends without the guarded-write rules reject with
 * `unsupported`.
 */
export type ReplaceEditableTailInput = {
  /** The user turn that must still be the last editable user turn. */
  readonly expectedUserTurnId: string;
  /**
   * The `acpTurnId` of the provider boundary preceding the tail. `undefined`
   * means the tail must have no preceding boundary (first message).
   */
  readonly expectedForkTurnId: string | undefined;
  /** The replacement user turn written at the tail position. */
  readonly replacement: SessionTurn;
  /**
   * Latest goal from session meta, consulted only when the history itself
   * carries no goal item. `null`/`undefined` means "no goal recorded".
   */
  readonly fallbackGoal?: SessionGoalMessage | null;
};

export type SessionEditableTailResult =
  | {
      readonly status: 'accepted';
      readonly receipt: SessionWriteReceipt;
      /** Last user turn before the replaced tail; the meta commit needs it. */
      readonly previousUserTurnId?: string;
      /**
       * Restore the replaced range only; retains rows appended afterwards.
       * Awaitable because a backend's compensation may need to reach durable
       * storage: the caller MUST `await` it (and handle a rejection) before it
       * persists its own follow-up state, or the two can interleave.
       */
      readonly rollback: () => Promise<void>;
      readonly postAcceptError?: unknown;
    }
  | { readonly status: 'rejected'; readonly reason: SessionEditableTailRejection }
  | { readonly status: 'indeterminate'; readonly cause: unknown };

export const sessionTurnReadIsReady = (
  read: SessionTurnRead
): read is { state: 'ready'; turn: SessionTurn } => read.state === 'ready';

/**
 * A change notification after an observation's initial read. `changed` means the
 * consumer should re-read the affected raw positions; `reset` means continuity
 * was lost (for example the source was replaced) and the whole window must be
 * re-read. The token is local only and is never a storage/wire version.
 */
export type SessionDataChange =
  | {
      readonly kind: 'changed';
      readonly from?: number;
      readonly to?: number;
      /**
       * True when membership or order changed (append/insert/delete/replace),
       * so a consumer can fence reads that started before the change. Omitted
       * for a content-only change, which must not invalidate unrelated reads.
       */
      readonly structural?: boolean;
    }
  | { readonly kind: 'reset' };

export type SessionDataChangeListener = (change: SessionDataChange) => void;

/**
 * A gap-free read-and-subscribe. The initial directory is captured at the same
 * point the listener becomes live, so a consumer never has to choose between
 * "subscribe first and miss nothing" and "read first and see the latest": both
 * come from one operation.
 */
export interface SessionObservation {
  /** Directory rows already including every change at or after subscribe. */
  readonly initial: Promise<readonly SessionDirectoryRow[]>;
  /** Idempotent. */
  unsubscribe(): void;
}

/** Windowed authoritative reads. Every method is async so a database adapter
 *  can answer without blocking. */
export interface SessionHistoryReader {
  /** Raw slot count, including slots no domain turn owns. */
  count(): Promise<number>;
  /** Authoritative read of one raw slot. */
  readAt(position: number): Promise<SessionTurnRead>;
  /** Authoritative read of one business turn id. */
  readTurn(turnId: string): Promise<SessionTurnRead>;
  /** Authoritative read of raw slots `[from, to)`. */
  readRange(from: number, to: number): Promise<readonly SessionTurnRead[]>;
  /** Shallow identity/state for raw slots `[from, to)`; never a turn body. */
  readDirectory(from: number, to: number): Promise<readonly SessionDirectoryRow[]>;
  /**
   * One consistent full read of the stored history, detached. Export/replay/hash
   * use this instead of stitching `count()` plus `readRange()` across a changing
   * source. It is a read capability, not copy provenance: a stored copy still
   * goes through the opaque snapshot handle.
   */
  readAll(): Promise<readonly SessionTurn[]>;
  /** Live observation with a gap-free initial directory. */
  observe(listener: SessionDataChangeListener): SessionObservation;
}

export interface SessionHistoryCommands {
  /** Append a new turn. Rejects invalid input before touching storage. */
  appendTurn(turn: SessionTurn): Promise<SessionCommandResult>;
  /** Replace an existing turn by business id. */
  replaceTurn(turnId: string, turn: SessionTurn): Promise<SessionCommandResult>;
  /**
   * Set or clear exactly one field. The adapter re-reads the target and applies
   * the change in one commit, so a peer edit between the caller's read and this
   * call cannot be overwritten outside the named field.
   */
  setTurnField<K extends SessionWritableField>(
    turnId: string,
    key: K,
    change: SessionFieldChange<SessionTurnWritableValues[K]>
  ): Promise<SessionCommandResult>;
  /**
   * Reopen an assistant turn for a re-dispatched execution: clear the terminal
   * footprint (`finished`, `endedAt`, `permissionWaitMs`) while preserving every
   * unknown stored field.
   */
  resumeAssistant(turnId: string): Promise<SessionCommandResult>;
  /**
   * Mark a turn seen: `status = 'seen'` and the legacy `read = true`. Idempotent;
   * the adapter re-locates the turn at commit time. Refuses to regress an
   * advanced execution state (`processing`/`handled`/`failed`/`canceled`/
   * `pending_apply`) that a concurrent writer committed: that is a
   * `rejected('conflict')` precondition failure, never a silent overwrite.
   */
  markTurnSeen(turnId: string): Promise<SessionCommandResult>;
  /** Reopen an existing assistant turn or create it, as one business operation. */
  openAssistantTurn(input: OpenAssistantTurnInput): Promise<SessionCommandResult>;
  /**
   * Resolve a task proposal against the live notice in one entry. The adapter
   * re-locates the proposal inside its commit; a rendered history snapshot is
   * never written back.
   */
  resolveTaskProposal(
    entryId: string,
    proposalId: string,
    resolution: TaskProposalResolution
  ): Promise<SessionCommandResult>;
  /** Answer a permission request located by request id (optionally in one turn). */
  respondPermission(
    requestId: string,
    outcome: PermissionOutcome,
    options?: { readonly turnId?: string }
  ): Promise<SessionCommandResult>;
  /**
   * Apply one bound ACP agent-output batch. The batch's target, ordering and
   * identity are inputs; the adapter never asks for "the current turn". A mixed
   * batch (tool/subagent updates that may belong to an older turn) keeps the
   * whole-history routing, while a caller that proved entry ownership uses the
   * target-local write.
   */
  applyAgentBatch(input: ApplyAgentBatchInput): Promise<SessionCommandResult>;
  /**
   * Replace the editable tail user turn. The eligibility rule (last editable
   * user turn, delivered non-steer, with its provider boundary) and the
   * active-goal guard are applied once in `planner.ts` and re-checked here
   * against the turns read at commit time, so a change that landed after the
   * caller's own eligibility check is refused, not overwritten. On acceptance
   * the caller MUST `await` the returned compensation before persisting its own
   * follow-up state. Backends without guarded-write compensation reject with
   * `unsupported`.
   */
  replaceEditableTail(input: ReplaceEditableTailInput): Promise<SessionEditableTailResult>;
  /**
   * One composed import operation: the guarded history write, the stored
   * snapshot read and the cursor creation happen in one synchronous block with
   * no await gap, so a peer edit can neither fall between them nor be blessed
   * into the baseline. The business callback returns only its decision and the
   * selected history; the cursor write goes through a control-plane setter the
   * adapter received at construction. Backends without import support reject
   * with `unsupported` instead of faking the binding.
   */
  applyHistoryImport<TCursor>(input: {
    readonly update: (
      history: SessionHistoryInput[],
      cursor: TCursor | undefined
    ) => SessionHistoryInput[];
    readonly createCursor: (stored: SessionHistoryInput[]) => TCursor;
  }): Promise<SessionCommandResult>;
}

/**
 * Local persistence, separate from local acceptance and from remote sync.
 * Resolving proves the accepted change is in local durable storage, not that a
 * peer has seen it. An implementation that cannot prove local durability MUST
 * reject with `SessionDurabilityError` instead of resolving: a public promise
 * must never silently stand in for a persistence barrier it did not perform.
 */
export interface SessionDurability {
  /** Await local durability of changes accepted at or before `receipt`. */
  waitDurable(receipt?: SessionWriteReceipt): Promise<void>;
}

export type SessionDurabilityErrorCode = 'unavailable' | 'invalid_receipt';

export class SessionDurabilityError extends Error {
  constructor(
    readonly code: SessionDurabilityErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SessionDurabilityError';
  }
}

export interface SessionData {
  readonly sessionId: SessionId;
  readonly history: SessionHistoryReader;
  readonly commands: SessionHistoryCommands;
  readonly durability: SessionDurability;
  /**
   * The storage-owned stored-history snapshot service. Absent only for a
   * backend that supports no snapshot capture at all; a backend that captures
   * but cannot copy declares `capabilities.copy = false` rather than omitting
   * the service. Handles are opaque capabilities scoped to this store: they are
   * released explicitly and become invalid when the source store closes.
   */
  readonly snapshots?: SessionSnapshotService;
}

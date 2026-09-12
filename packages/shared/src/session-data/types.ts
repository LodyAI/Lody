import type { PermissionOutcome } from '../message';
import type { SessionId } from '../ids';
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
  SessionTurn,
  SessionTurnRole,
  SessionTurnStatus,
  SessionTurnRead,
  SessionUnavailableReason,
  SessionWritableField,
  SessionTurnWritableValues,
} from './domain';

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
    | 'respond-permission';
}

/** A user's decision on a task proposal, resolved against the live notice. */
export type TaskProposalResolution = {
  readonly taskId?: string;
  readonly outcome: 'created' | 'dismissed';
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
  | { readonly kind: 'changed'; readonly from?: number; readonly to?: number }
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
   * the adapter re-locates the turn at commit time.
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
}

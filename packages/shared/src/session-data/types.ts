import type { TaskProposalMeta } from '../ai';
import type { PermissionOutcome } from '../message';
import type { SessionId } from '../ids';
import type { SessionHistory, SessionHistoryInput } from '../schema';

// # Session data ports
//
// The CRDT-neutral seam between session *business* code (React UI, CLI, MCP)
// and one concrete storage implementation (today Loro + Mirror + repo; later a
// database CRDT). Nothing here names Loro, Mirror, a CID, a container id or a
// storage offset: business identity is a turn id, a request id, or an opaque
// cursor. Adapters keep those details inside `session-data/loro.ts`.
//
// Two rules make this seam trustworthy:
//  - A field change is explicit. `set` writes a value, `clear` removes it, and
//    an omitted field is never a change. Callers do not rely on `undefined`
//    surviving a JSON/worker/Rust boundary to mean "delete".
//  - A command result states its phase. A pre-write rejection is not the same as
//    an accepted change, and an accepted-but-unacknowledged change is not a
//    rejection. Only the first is safe to retry blindly.

/** The turn-map fields a domain command may write. Items are edited whole-entry. */
export type SessionWritableField = Exclude<keyof SessionHistoryInput, '$cid' | 'items' | 'id'>;

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

/** Identifies a locally accepted change so a caller can await its durability. */
export type SessionWriteReceipt = {
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
    | 'respond-permission';
};

/** A user's decision on a task proposal, resolved against the live notice. */
export type TaskProposalResolution = Pick<TaskProposalMeta, 'taskId'> & {
  outcome: NonNullable<TaskProposalMeta['outcome']>;
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
  readonly modelInfo?: SessionHistory['modelInfo'];
  /** Timestamp for a freshly created turn. */
  readonly timestamp: string;
};

/**
 * Three phases, deliberately distinct:
 *  - `accepted`   — the store holds the change; retrying would duplicate it.
 *  - `rejected`   — nothing was applied (invalid input, missing target, failed
 *                   precondition); the caller may fix and retry.
 *  - `indeterminate` — the implementation cannot say whether the change
 *                   committed. Never auto-retry; surface it.
 */
export type SessionCommandResult =
  | { readonly status: 'accepted'; readonly receipt: SessionWriteReceipt }
  | { readonly status: 'rejected'; readonly reason: SessionCommandRejection }
  | { readonly status: 'indeterminate'; readonly cause: unknown };

/** One raw storage slot's domain read. `invalid` covers unknown/corrupt slots. */
export type SessionTurnRead =
  | { readonly state: 'ready'; readonly turn: SessionHistory }
  | { readonly state: 'invalid' }
  | { readonly state: 'missing' };

export const sessionTurnReadIsReady = (
  read: SessionTurnRead
): read is { state: 'ready'; turn: SessionHistory } => read.state === 'ready';

/**
 * A page of displayable transcript turns. `limit` counts displayable turns;
 * `cursor` is an opaque *raw* position, so hidden/empty rows between pages do
 * not shift the caller's notion of where it is. `hasMore` is only true when a
 * further raw row exists to continue from.
 */
export type SessionVisiblePage = {
  readonly turns: readonly SessionHistory[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
};

export type SessionVisiblePageRequest = {
  readonly limit: number;
  /** Opaque cursor from a previous page; omit for the newest page. */
  readonly cursor?: string;
  /** Decides whether a raw turn is part of the displayable transcript. */
  readonly isVisible: (turn: SessionHistory) => boolean;
};

/** Windowed authoritative reads. All methods are async so a database adapter
 *  can answer without blocking; a Loro adapter may resolve synchronously. */
export interface SessionHistoryReader {
  /** Raw slot count, including slots no domain turn owns. */
  count(): number;
  /** Authoritative read of one business turn id. */
  readTurn(turnId: string): Promise<SessionTurnRead>;
  /** Authoritative read of raw slots `[from, to)`. */
  readRange(from: number, to: number): Promise<readonly SessionTurnRead[]>;
  /** Business paging: `limit` displayable turns, `cursor` a raw position. */
  readVisiblePage(request: SessionVisiblePageRequest): Promise<SessionVisiblePage>;
}

export interface SessionHistoryCommands {
  /** Append a new turn. Rejects invalid input before touching storage. */
  appendTurn(turn: SessionHistory): Promise<SessionCommandResult>;
  /** Replace an existing turn by business id. */
  replaceTurn(turnId: string, turn: SessionHistory): Promise<SessionCommandResult>;
  /**
   * Set or clear exactly one field. The adapter re-reads the target and applies
   * the change in one commit, so a peer edit between the caller's read and this
   * call cannot be overwritten outside the named field.
   */
  setTurnField<K extends SessionWritableField>(
    turnId: string,
    key: K,
    change: SessionFieldChange<SessionHistoryInput[K]>
  ): Promise<SessionCommandResult>;
  /**
   * Reopen an assistant turn for a re-dispatched execution: clear the terminal
   * footprint (`finished`, `endedAt`, `permissionWaitMs`) while preserving every
   * unknown stored field.
   */
  resumeAssistant(turnId: string): Promise<SessionCommandResult>;
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
 * peer has seen it.
 */
export interface SessionDurability {
  /** Await local durability of changes accepted at or before `receipt`. */
  waitDurable(receipt?: SessionWriteReceipt): Promise<void>;
}

export interface SessionData {
  readonly sessionId: SessionId;
  readonly history: SessionHistoryReader;
  readonly commands: SessionHistoryCommands;
  readonly durability: SessionDurability;
}

import type { HistoryAction } from './history-actions';
import type { SessionGoalMessage } from '../goal';
import type { PermissionOutcome } from '../message';
import type { SessionId } from '../ids';
import type { HistoryImportInput } from './history-import';
import type { SessionSnapshotService } from './snapshot';
import type { SessionEntry, SessionDirectoryRow, SessionTurn, SessionTurnRead } from './domain';

// History reads and shared writes use domain DTOs rather than the storage schema.
// Ordinary commands propagate errors. Import and editable-tail replacement
// distinguish pre-write refusal from an unknown commit outcome; never retry the latter.

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
      /** Last user turn before the replaced tail; the meta commit needs it. */
      readonly previousUserTurnId?: string;
      /**
       * Restore the replaced range only; retains rows appended afterwards.
       * Awaitable because a backend's compensation may need to reach durable
       * storage: the caller MUST `await` it (and handle a rejection) before it
       * persists its own follow-up state, or the two can interleave.
       */
      readonly rollback: () => Promise<void>;
    }
  | { readonly status: 'rejected'; readonly reason: SessionEditableTailRejection }
  | { readonly status: 'indeterminate'; readonly cause: unknown };

export const sessionTurnReadIsReady = (
  read: SessionTurnRead
): read is { state: 'ready'; turn: SessionTurn } => read.state === 'ready';

/** Membership changes carry the shifted range; content edits carry identities,
 * including turns whose bodies are not cached by any reader. */
export type SessionDataChange =
  | { readonly kind: 'structure'; readonly from: number; readonly to: number }
  | { readonly kind: 'changed'; readonly ids: readonly string[] };

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

/** Narrow synchronous projection for metadata observers; never materializes bodies. */
export interface SessionModelSummaryReader {
  count(): number;
  readModelSummaryAt(position: number):
    | {
        role: string | undefined;
        modelInfo: { modelId: string | undefined; name: string | undefined };
        itemCount: number;
        planCount: number;
      }
    | undefined;
}

/** Authoritative reads. In-process storage returns synchronously; the display
 * cache also accepts delayed reads and fences their results against events. */
export interface SessionHistoryReader {
  /** Raw slot count, including slots no domain turn owns. */
  count(): number | Promise<number>;
  /** Authoritative read of one raw slot. */
  readAt(position: number): SessionTurnRead | Promise<SessionTurnRead>;
  /** Authoritative read of one business turn id. */
  readTurn(turnId: string): SessionTurnRead | Promise<SessionTurnRead>;
  /** Authoritative read of raw slots `[from, to)`. */
  readRange(
    from: number,
    to: number
  ): readonly SessionTurnRead[] | Promise<readonly SessionTurnRead[]>;
  /** Shallow identity/state for raw slots `[from, to)`; never a turn body. */
  readDirectory(
    from: number,
    to: number
  ): readonly SessionDirectoryRow[] | Promise<readonly SessionDirectoryRow[]>;
  /**
   * One consistent full read of the stored history, detached. Export/replay/hash
   * use this instead of stitching `count()` plus `readRange()` across a changing
   * source. It is a read capability, not copy provenance: a stored copy still
   * goes through the opaque snapshot handle.
   */
  readAll(): SessionEntry[] | Promise<SessionEntry[]>;
  /** One observation of a user turn's output: user scalars, its first linked
   * assistant body, and later system notices only when the user failed.
   * Never materialize unrelated history bodies or join separate async reads. */
  readTurnOutput(userTurnId: string): SessionEntry[] | Promise<SessionEntry[]>;
  /** Live observation with a gap-free initial directory. */
  observe(listener: SessionDataChangeListener): SessionObservation;
}

export interface SessionHistoryCommands {
  applyHistoryAction(action: HistoryAction): Promise<SessionActionResult>;
  /** Append a new turn. Rejects invalid input before touching storage. */
  appendTurn(turn: SessionTurn): Promise<void>;
  /** Replace an existing turn by business id. */
  replaceTurn(turnId: string, turn: SessionTurn): Promise<void>;
  /** Answer a permission request located by request id (optionally in one turn). */
  respondPermission(
    requestId: string,
    outcome: PermissionOutcome,
    options?: { readonly turnId?: string }
  ): Promise<boolean>;
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
  /** Import inputs are data. The store rechecks history/cursor conflicts at commit
   * time and binds the stored baseline and cursor to that same write. */
  applyHistoryImport(input: HistoryImportInput): Promise<SessionImportResult>;
}

export interface SessionData {
  readonly sessionId: SessionId;
  readonly history: SessionHistoryReader;
  readonly commands: SessionHistoryCommands;
  readonly snapshots: SessionSnapshotService;
}

export type SessionImportResult =
  | { readonly status: 'accepted'; readonly appended: number }
  | {
      readonly status: 'rejected';
      readonly reason: {
        readonly code: string;
        readonly issues?: readonly { path: readonly PropertyKey[]; code: string }[];
      };
    }
  | { readonly status: 'indeterminate'; readonly cause: unknown };

export type SessionActionResult = {
  readonly matched?: boolean;
};

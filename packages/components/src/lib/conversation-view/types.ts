import type { SessionHistory, SessionId, SessionTurnInputConfig } from '@lody/shared';

/**
 * Cheap per-turn facts the outline rail, placeholder rows, and height estimates
 * read without hydrating the turn. Derived once per turn from shallow Loro reads
 * (or from the hydrated object when one exists) and kept on the index row after
 * the turn itself is evicted.
 */
export type TurnSummary = {
  /** Opening prose of the turn (first `text` item), raw markdown, bounded to
   *  {@link TURN_SUMMARY_HEAD_CHARS}. Empty when the turn has no prose. */
  headText: string;
  /** Prose characters (`text`, `thought`, `proposed_plan` markdown) — the same
   *  measure the outline uses for its tick weight. */
  textChars: number;
  toolCalls: number;
  thoughts: number;
};

/**
 * How much raw prose a summary keeps. This IS the outline's read window: a
 * placeholder round and a hydrated round must produce the same title, so the
 * two cannot be separate numbers.
 */
export { SUMMARY_SOURCE_WINDOW as TURN_SUMMARY_HEAD_CHARS } from '../conversation-outline';

/**
 * Send configuration of a user turn, available before its body is hydrated.
 * Read only these scalars and small option/selection collections, never prompt
 * or inputBlocks. Explicit empty selections must not become defaults.
 */
export type TurnIndexInputConfig = Pick<
  SessionTurnInputConfig,
  | 'agentRoleId'
  | 'agentRoleRevision'
  | 'modeId'
  | 'modelId'
  | 'cliType'
  | 'agentType'
  | 'mcpServerIds'
  | 'configOptionValues'
  | 'taskToolsEnabled'
>;

/**
 * What every turn exposes at all times, hydrated or not. Scalars come straight
 * from the turn map's shallow value; the optional fields fill in as the
 * background pass reaches the turn.
 */
/**
 * Turn-map scalars mirrored into the index row. ONE list: `TurnIndexRow` is
 * derived from it and the event path re-reads it, so a scalar cannot be added
 * to the row without also being refreshed on change (or vice versa).
 */
export const INDEX_SCALAR_KEYS = [
  'id',
  'role',
  'timestamp',
  'status',
  'finished',
  'endedAt',
  'sendStatus',
  'userTurnId',
  'acpTurnId',
  'startedAt',
  'permissionWaitMs',
] as const;

export type IndexScalarKey = (typeof INDEX_SCALAR_KEYS)[number];

export type TurnIndexRow = Pick<SessionHistory, IndexScalarKey> & {
  summary?: TurnSummary;
  itemCount?: number;
  /** Plan entries attached to the turn; an assistant turn with a plan and no
   *  items still renders (see `buildChatStreamItems`). */
  planCount?: number;
  inputConfig?: TurnIndexInputConfig;
};

export type ConversationViewChange = {
  /**
   * `index`: rows, ids, or `turnCount` changed (append, delete, scalar update,
   * summary arrival). `tail`: a hydrated turn inside the always-hydrated tail
   * window changed. `range`: a hydrated turn outside the tail changed or was
   * hydrated on demand. `structure`: list membership or order changed; `from`
   * is the first affected position and `to` is the new length. Rebind positional
   * readers on this event, including same-length replacements.
   */
  kind: 'index' | 'range' | 'tail' | 'structure';
  from?: number;
  to?: number;
};

export type ConversationViewListener = (change: ConversationViewChange) => void;

/** Owns the concrete turn containers captured at acquisition, even if they move. */
export type ConversationRange = {
  ready: Promise<void>;
  /** Idempotent; may be called before hydration finishes. */
  release(): void;
};

/**
 * Windowed, index-first access to a session's history.
 *
 * `index(i)` is O(1) and always answers; `turn(i)` answers synchronously only
 * while the turn is hydrated. Hydration is explicit and ref-counted:
 * `acquireRange` captures and pins the containers in `[from, to)` and hydrates
 * them. Its handle releases those same containers even after list edits. The
 * LRU (`maxHydrated`) only evicts turns that are neither pinned nor in the
 * always-hydrated tail (`tailKeep`). `version` bumps on every observable change
 * so React can subscribe with `useSyncExternalStore`.
 *
 * Positional consumers reacquire on `structure`; content updates keep their
 * existing lease. The view does not own a reader's viewport coordinates.
 */
export interface ConversationView {
  readonly sessionId: SessionId;
  readonly turnCount: number;
  /** Bumps on any structural, index, or hydrated-content change. */
  readonly version: number;
  /** Resolves once background summaries/counts finish; user Role config is eager. */
  readonly ready: Promise<void>;
  index(i: number): TurnIndexRow | undefined;
  /** -1 when the id is unknown. */
  indexOf(turnId: string): number;
  /**
   * One consistent full read for export/replay/hash, when the backing reader can
   * provide it. Absent on the raw-Loro/rollback views, which fall back to a
   * lease-guarded read in `readConversationHistory`.
   */
  readAll?(): Promise<SessionHistory[]>;
  /** The hydrated turn, or `undefined` until an acquired range covers it. */
  turn(i: number): SessionHistory | undefined;
  isHydrated(i: number): boolean;
  /** Captures `[from, to)` now. Release the returned handle when done. */
  acquireRange(from: number, to: number): ConversationRange;
  subscribe(listener: ConversationViewListener): () => void;
  dispose(): void;
}

/** First index of the always-hydrated tail window. */
export const conversationTailStart = (turnCount: number, tailKeep: number): number =>
  Math.max(0, turnCount - tailKeep);

export const DEFAULT_MAX_HYDRATED = 200;
export const DEFAULT_TAIL_KEEP = 20;

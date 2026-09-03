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

/** How much raw prose a summary keeps; matches the outline's read window. */
export const TURN_SUMMARY_HEAD_CHARS = 960;

/**
 * Role-selection scalars of a user turn's `inputConfig`, read shallowly
 * (never `prompt`, `inputBlocks`, or option maps). Enough for the sticky Agent
 * Role scan and the conversation source fence over turns that are not hydrated.
 */
export type TurnIndexInputConfig = Pick<
  SessionTurnInputConfig,
  'agentRoleId' | 'agentRoleRevision' | 'modeId' | 'modelId' | 'cliType' | 'agentType'
>;

/**
 * What every turn exposes at all times, hydrated or not. Scalars come straight
 * from the turn map's shallow value; the optional fields fill in as the
 * background pass reaches the turn.
 */
export type TurnIndexRow = Pick<
  SessionHistory,
  | 'id'
  | 'role'
  | 'timestamp'
  | 'status'
  | 'finished'
  | 'endedAt'
  | 'sendStatus'
  | 'userTurnId'
  | 'acpTurnId'
  | 'startedAt'
  | 'permissionWaitMs'
> & {
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
   * hydrated on demand.
   */
  kind: 'index' | 'range' | 'tail';
  from?: number;
  to?: number;
};

export type ConversationViewListener = (change: ConversationViewChange) => void;

/**
 * Windowed, index-first access to a session's history.
 *
 * `index(i)` is O(1) and always answers; `turn(i)` answers synchronously only
 * while the turn is hydrated. Hydration is explicit and ref-counted:
 * `ensureRange` pins `[from, to)` and hydrates it, `release` unpins it, and the
 * LRU (`maxHydrated`) only evicts turns that are neither pinned nor in the
 * always-hydrated tail (`tailKeep`). `version` bumps on every observable change
 * so React can subscribe with `useSyncExternalStore`.
 *
 * Mapping to loro-mirror's upcoming `LazyList`: `index` ↔ `LazyList.index`,
 * `turn` ↔ `LazyList.get`, `ensureRange` ↔ `LazyList.hydrate`, `subscribe` +
 * `ensureRange`/`release` ↔ `LazyList.subscribeRange`. Keep the surface this
 * narrow so the adapter over it stays thin.
 */
export interface ConversationView {
  readonly sessionId: SessionId;
  readonly turnCount: number;
  /** Bumps on any structural, index, or hydrated-content change. */
  readonly version: number;
  /** Resolves once the background index pass (summaries, shallow config) is done. */
  readonly ready: Promise<void>;
  index(i: number): TurnIndexRow | undefined;
  /** -1 when the id is unknown. */
  indexOf(turnId: string): number;
  /** The hydrated turn, or `undefined` until `ensureRange` covers it. */
  turn(i: number): SessionHistory | undefined;
  isHydrated(i: number): boolean;
  /** Pins and hydrates `[from, to)`. Pair every call with `release`. */
  ensureRange(from: number, to: number): Promise<void>;
  release(from: number, to: number): void;
  subscribe(listener: ConversationViewListener): () => void;
  dispose(): void;
}

/** First index of the always-hydrated tail window. */
export const conversationTailStart = (turnCount: number, tailKeep: number): number =>
  Math.max(0, turnCount - tailKeep);

export const DEFAULT_MAX_HYDRATED = 200;
export const DEFAULT_TAIL_KEEP = 20;

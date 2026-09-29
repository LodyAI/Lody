import {
  isSessionHistoryStatusAwaitingStart,
  resolveSessionHistoryStatus,
  type SessionHistory,
} from '@lody/shared';

type SessionHistoryStatusEntry = Pick<SessionHistory, 'role' | 'status' | 'read'> & {
  timestamp?: string;
};

/**
 * How long the frontend optimistically shows the dispatched-but-not-started
 * ("Starting…") state before treating the dispatch as stalled.
 *
 * The window only needs to cover the gap between the local send write and the
 * CLI's FIRST `initializing` presence — the CLI publishes that the moment the
 * turn owns the session (see `session-execution-service.ts`), and every later
 * phase (git clone, managed runtime, ACP spawn) reports its own presence. If no
 * presence arrives within this window the turn is treated as stalled and the
 * pre-start label is dropped, so a crashed daemon or a desynced dispatch pointer
 * can no longer show "Starting…" forever (which read as "the agent is stuck
 * busy"). The durable truth still comes from CLI-side reconciliation on the next
 * daemon start; this timeout only bounds the optimistic UI.
 */
export const UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS = 30_000;

/**
 * Structural check: does history end with a dispatched-but-not-started user
 * turn (trailing `pending`/`seen` user entry). Ignores elapsed time — use
 * {@link resolveUnstartedTrailingDispatchAtMs} + the timeout when the caller
 * needs the bounded pre-start window.
 */
export function hasUnstartedTrailingUserTurn(
  history: readonly SessionHistoryStatusEntry[] | null | undefined
): boolean {
  const last = history?.at(-1);
  if (!last || last.role !== 'user') return false;
  return isSessionHistoryStatusAwaitingStart(resolveSessionHistoryStatus(last));
}

/**
 * Dispatch epoch ms (from the trailing unstarted user turn's durable
 * `timestamp`) used to bound the optimistic pre-start window. Returns `null`
 * when there is no such turn, or when it carries no parseable timestamp — in
 * both cases the caller must NOT show the pre-start state, so a turn we cannot
 * time-bound never lingers.
 *
 * Anchoring on the turn's own durable timestamp (not a component mount time) is
 * what makes the window survive reloads: a genuinely stalled turn reports its
 * full elapsed age immediately after a reload instead of restarting the clock.
 */
export function resolveUnstartedTrailingDispatchAtMs(
  history: readonly SessionHistoryStatusEntry[] | null | undefined
): number | null {
  const last = history?.at(-1);
  if (!last || last.role !== 'user') return null;
  if (!isSessionHistoryStatusAwaitingStart(resolveSessionHistoryStatus(last))) return null;
  const parsed = last.timestamp ? Date.parse(last.timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether the dispatched-but-not-started ("Starting…") state should still show
 * at `nowMs`. Optimistic within {@link UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS}
 * of the turn's dispatch time; stalled (false) afterwards.
 */
export function isUnstartedTrailingDispatchPreStart(
  history: readonly SessionHistoryStatusEntry[] | null | undefined,
  nowMs: number,
  timeoutMs: number = UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS
): boolean {
  const dispatchedAtMs = resolveUnstartedTrailingDispatchAtMs(history);
  if (dispatchedAtMs === null) return false;
  return nowMs - dispatchedAtMs < timeoutMs;
}

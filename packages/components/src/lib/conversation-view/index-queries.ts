import { resolveActiveAssistantTurnId, type SessionHistory } from '@lody/shared';
import { isEmptyAssistantIndexRow } from './index-row';
import {
  conversationTailStart,
  DEFAULT_TAIL_KEEP,
  type ConversationView,
  type TurnIndexRow,
} from './types';

/**
 * Index-only answers to the "latest turn such that…" questions the session
 * surfaces ask at token rate. None of these hydrate a turn.
 */

/** Index of the last row satisfying `predicate`, scanning from the tail; -1 when none. */
export function findLastIndex(
  view: Pick<ConversationView, 'turnCount' | 'index'>,
  predicate: (row: TurnIndexRow, index: number) => boolean,
  options: { limit?: number } = {}
): number {
  const stop = options.limit === undefined ? 0 : Math.max(0, view.turnCount - options.limit);
  for (let i = view.turnCount - 1; i >= stop; i -= 1) {
    const row = view.index(i);
    if (row && predicate(row, i)) return i;
  }
  return -1;
}

export const lastUserTurnIndex = (view: Pick<ConversationView, 'turnCount' | 'index'>): number =>
  findLastIndex(view, (row) => row.role === 'user');

/**
 * The shared `resolveActiveAssistantTurnId` rule applied to the index instead
 * of a materialized array: find the last assistant row, then let the shared
 * function decide whether it is still active, so "active" has one definition.
 */
export function resolveActiveAssistantTurnIdFromIndex(
  view: Pick<ConversationView, 'turnCount' | 'index'>
): string | undefined {
  const index = findLastIndex(view, (row) => row.role === 'assistant');
  return index < 0 ? undefined : resolveActiveAssistantTurnId([view.index(index)!]);
}

/**
 * The ids `buildChatStreamItems` reported: the last rendered assistant turn and
 * the last rendered assistant turn that finished, skipping empty entries.
 */
export function resolveLastAssistantTurnIds(
  view: Pick<ConversationView, 'turnCount' | 'index' | 'indexOf'>
): { lastAssistantMessageId: string | null; lastCompletedAssistantMessageId: string | null } {
  let lastAssistantMessageId: string | null = null;
  let lastCompletedAssistantMessageId: string | null = null;
  for (let i = view.turnCount - 1; i >= 0; i -= 1) {
    const row = view.index(i);
    if (!row || row.role !== 'assistant' || isEmptyAssistantIndexRow(row)) continue;
    // A duplicate id renders once, at its first position; later copies are skipped.
    if (view.indexOf(row.id) !== i) continue;
    if (lastAssistantMessageId === null) lastAssistantMessageId = row.id;
    if (row.finished === true) {
      lastCompletedAssistantMessageId = row.id;
      break;
    }
  }
  return { lastAssistantMessageId, lastCompletedAssistantMessageId };
}

export function countUserTurns(view: Pick<ConversationView, 'turnCount' | 'index'>): number {
  let count = 0;
  for (let i = 0; i < view.turnCount; i += 1) if (view.index(i)?.role === 'user') count += 1;
  return count;
}

/**
 * Where the always-hydrated tail begins, optionally pulled back to the last
 * user turn so "latest user input" readers never miss it.
 */
export function resolveTailStart(
  view: Pick<ConversationView, 'turnCount' | 'index'>,
  options: { tailKeep?: number; extendToLastUserTurn?: boolean } = {}
): number {
  let start = conversationTailStart(view.turnCount, options.tailKeep ?? DEFAULT_TAIL_KEEP);
  if (options.extendToLastUserTurn) {
    // Include the turn before the last user turn too: "editable last user
    // message" looks at the assistant turn that preceded it.
    const lastUser = lastUserTurnIndex(view);
    if (lastUser >= 0) start = Math.min(start, Math.max(0, lastUser - 1));
  }
  return start;
}

/** The hydrated turns in `[from, to)`, contiguous from `from` until the first gap. */
export function collectHydratedRange(
  view: Pick<ConversationView, 'turn'>,
  from: number,
  to: number
): SessionHistory[] {
  const turns: SessionHistory[] = [];
  for (let i = from; i < to; i += 1) {
    const turn = view.turn(i);
    if (!turn) break;
    turns.push(turn);
  }
  return turns;
}

/**
 * Source rows for `resolveSessionConversationConfig` and the source fence: the
 * hydrated tail (full input config) followed by every older user turn as an
 * index row carrying its shallow config, newest last as the resolver expects.
 */
export function collectConversationConfigSources(
  view: Pick<ConversationView, 'turnCount' | 'index' | 'turn'>,
  tailFrom: number
): { id: string; role: unknown; inputConfig?: unknown }[] {
  const sources: { id: string; role: unknown; inputConfig?: unknown }[] = [];
  for (let i = 0; i < tailFrom; i += 1) {
    const row = view.index(i);
    if (!row || row.role !== 'user') continue;
    sources.push({ id: row.id, role: row.role, inputConfig: row.inputConfig });
  }
  for (let i = tailFrom; i < view.turnCount; i += 1) {
    const turn = view.turn(i) ?? view.index(i);
    if (turn) sources.push(turn as { id: string; role: unknown; inputConfig?: unknown });
  }
  return sources;
}

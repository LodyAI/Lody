import type { SessionHistory, SessionId } from '@lody/shared';
import { indexRowFromEntry } from './index-row';
import {
  conversationTailStart,
  DEFAULT_TAIL_KEEP,
  type ConversationView,
  type ConversationViewListener,
  type TurnIndexRow,
} from './types';

export type CreateConversationViewFromHistoryOptions = {
  sessionId: SessionId;
  getHistory: () => readonly SessionHistory[];
  /** Fires whenever `getHistory()` would return a new array. */
  subscribe: (listener: () => void) => () => void;
  tailKeep?: number;
};

/**
 * A fully hydrated `ConversationView` over a materialized history array — the
 * rollback path (feature flag off) where loro-mirror still builds the whole
 * list — and the shape stories and tests use. Every turn is always hydrated,
 * so `ensureRange` resolves immediately and `release` is a no-op.
 */
export function createConversationViewFromHistory(
  options: CreateConversationViewFromHistoryOptions
): ConversationView {
  const tailKeep = options.tailKeep ?? DEFAULT_TAIL_KEEP;
  const rowsByEntry = new WeakMap<SessionHistory, TurnIndexRow>();
  const listeners = new Set<ConversationViewListener>();
  let history = options.getHistory();
  let indexById = buildIndexById(history);
  let version = 0;
  let disposed = false;

  const rowOf = (entry: SessionHistory): TurnIndexRow => {
    const cached = rowsByEntry.get(entry);
    if (cached) return cached;
    const row = indexRowFromEntry(entry);
    rowsByEntry.set(entry, row);
    return row;
  };

  const unsubscribe = options.subscribe(() => {
    if (disposed) return;
    const next = options.getHistory();
    if (next === history) return;
    const previous = history;
    history = next;
    if (previous.length !== next.length || previous.some((entry, i) => entry?.id !== next[i]?.id)) {
      indexById = buildIndexById(next);
    }
    version += 1;
    const tailFrom = conversationTailStart(next.length, tailKeep);
    for (const listener of listeners) listener({ kind: 'index' });
    for (const listener of listeners) listener({ kind: 'tail', from: tailFrom, to: next.length });
    let lo = Number.POSITIVE_INFINITY;
    let hi = -1;
    for (let i = 0; i < Math.min(tailFrom, previous.length); i += 1) {
      if (previous[i] === next[i]) continue;
      lo = Math.min(lo, i);
      hi = Math.max(hi, i);
    }
    if (hi >= 0) for (const listener of listeners) listener({ kind: 'range', from: lo, to: hi + 1 });
  });

  return {
    sessionId: options.sessionId,
    get turnCount() {
      return history.length;
    },
    get version() {
      return version;
    },
    ready: Promise.resolve(),
    index: (i) => {
      const entry = history[i];
      return entry ? rowOf(entry) : undefined;
    },
    indexOf: (turnId) => indexById.get(turnId) ?? -1,
    turn: (i) => history[i],
    isHydrated: (i) => i >= 0 && i < history.length,
    ensureRange: () => Promise.resolve(),
    release: () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      disposed = true;
      unsubscribe();
      listeners.clear();
    },
  };
}

function buildIndexById(history: readonly SessionHistory[]): Map<string, number> {
  const map = new Map<string, number>();
  history.forEach((entry, i) => {
    if (entry && !map.has(entry.id)) map.set(entry.id, i);
  });
  return map;
}

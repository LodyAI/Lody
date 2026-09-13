import type { SessionHistory, SessionId } from '@lody/shared';
import { indexRowFromEntry } from './index-row';
import { type ConversationView, type ConversationViewListener, type TurnIndexRow } from './types';

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
 * so `acquireRange` resolves immediately and `release` is a no-op.
 */
export function createConversationViewFromHistory(
  options: CreateConversationViewFromHistoryOptions
): ConversationView {
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
    const structural =
      previous.length !== next.length || previous.some((entry, i) => entry?.id !== next[i]?.id);
    if (structural) {
      indexById = buildIndexById(next);
    }
    version += 1;
    if (structural) {
      for (const listener of listeners) listener({ kind: 'structure', from: 0, to: next.length });
    } else {
      const ids = next.filter((entry, i) => entry !== previous[i]).map((entry) => entry.id);
      for (const listener of listeners) listener({ kind: 'changed', ids });
    }
  });

  return {
    readAll: async () => history.slice(),
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
    acquireRange: () => ({ ready: Promise.resolve(), release: () => {} }),
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

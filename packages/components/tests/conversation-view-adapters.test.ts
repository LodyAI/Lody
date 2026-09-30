import { describe, expect, it } from 'vitest';
import type { SessionHistory, SessionId } from '@lody/shared';
import { createConversationViewFromHistory } from '../src/lib/conversation-view';
import { buildFixtureHistory } from './conversation-view-fixtures';

const sessionId = 'session-adapters' as SessionId;

const entry = (id: string): SessionHistory =>
  ({
    id,
    role: 'user',
    timestamp: '2026-01-01T00:00:00.000Z',
    fileDiff: [],
    items: [],
  }) as unknown as SessionHistory;

describe('createConversationViewFromHistory', () => {
  it('is fully hydrated and republishes on history changes', async () => {
    let history = buildFixtureHistory(3);
    const listeners = new Set<() => void>();
    const view = createConversationViewFromHistory({
      sessionId,
      getHistory: () => history,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      tailKeep: 2,
    });
    expect(view.turnCount).toBe(6);
    expect(view.isHydrated(0)).toBe(true);
    expect(view.turn(0)).toBe(history[0]);
    expect(view.index(1)?.summary?.toolCalls).toBe(1);
    expect(view.indexOf('a-2')).toBe(5);
    const range = view.acquireRange(0, 6);
    await range.ready;
    range.release();

    const changes: string[] = [];
    view.subscribe((change) => changes.push(change.kind));
    history = [...history, entry('u-new')];
    for (const listener of listeners) listener();
    expect(view.turnCount).toBe(7);
    expect(view.indexOf('u-new')).toBe(6);
    expect(changes).toEqual(['structure']);
  });
});

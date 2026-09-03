import { describe, expect, it } from 'vitest';
import type { SessionHistory, SessionId, WorkspaceId } from '@lody/shared';
import {
  createConversationViewFromHistory,
  createProjectedConversationView,
} from '../src/lib/conversation-view';
import { buildFixtureHistory } from './conversation-view-fixtures';

const sessionId = 'session-adapters' as SessionId;
const workspaceId = 'workspace-adapters' as WorkspaceId;

const projection = (entry: SessionHistory, afterHistoryId?: string | null) => ({
  workspaceId,
  sessionId,
  entry,
  afterHistoryId,
});

const entry = (id: string): SessionHistory =>
  ({ id, role: 'user', timestamp: '2026-01-01T00:00:00.000Z', fileDiff: [], items: [] }) as unknown as SessionHistory;

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
    await view.ensureRange(0, 6);

    const changes: string[] = [];
    view.subscribe((change) => changes.push(change.kind));
    history = [...history, entry('u-new')];
    for (const listener of listeners) listener();
    expect(view.turnCount).toBe(7);
    expect(view.indexOf('u-new')).toBe(6);
    expect(changes).toEqual(['index', 'tail']);
  });
});

describe('createProjectedConversationView', () => {
  const baseOf = (history: SessionHistory[]) =>
    createConversationViewFromHistory({ sessionId, getHistory: () => history, subscribe: () => () => {} });

  it('returns the base view when there is nothing to project', () => {
    const base = baseOf([entry('a')]);
    expect(createProjectedConversationView(base, [])).toBe(base);
  });

  it('places head, anchored, and tail projections like projectAcceptedSessionHistory', () => {
    const base = baseOf([entry('a'), entry('b')]);
    const view = createProjectedConversationView(base, [
      projection(entry('head'), null),
      projection(entry('after-a'), 'a'),
      projection(entry('orphan'), 'missing'),
      projection(entry('tail')),
      projection(entry('a'), 'b'), // already authoritative: dropped
    ]);
    const ids = Array.from({ length: view.turnCount }, (_, i) => view.index(i)?.id);
    expect(ids).toEqual(['head', 'a', 'after-a', 'b', 'orphan', 'tail']);
    expect(view.indexOf('after-a')).toBe(2);
    expect(view.turn(2)?.id).toBe('after-a');
    expect(view.turn(3)?.id).toBe('b');
    expect(view.isHydrated(0)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { SessionHistory, SessionId } from '@lody/shared';
import { buildChatStreamItems as buildChatStreamItemsFromView } from '../src/components/ai-gui/build-chat-stream-items';
import { createConversationViewFromHistory } from '../src/lib/conversation-view';

const sessionId = 'session-test' as SessionId;

/** The builder over a fully hydrated view of `history`, as the rollback path feeds it. */
const buildChatStreamItems = (
  history: readonly SessionHistory[],
  id: SessionId,
  previousCache?: Parameters<typeof buildChatStreamItemsFromView>[2]
) =>
  buildChatStreamItemsFromView(
    createConversationViewFromHistory({ sessionId: id, getHistory: () => history, subscribe: () => () => {} }),
    id,
    previousCache
  );

const entry = (partial: {
  id: string;
  role: 'user' | 'assistant';
  items?: unknown[];
  plan?: unknown[];
}): SessionHistory =>
  ({
    timestamp: '2026-06-18T00:00:00.000Z',
    fileDiff: [],
    items: partial.items ?? [],
    ...partial,
  }) as unknown as SessionHistory;

const text = (value: string) => ({ type: 'text', text: value });

const renderedIds = (items: ReturnType<typeof buildChatStreamItems>['items']): string[] =>
  items.map((item) => (item.type === 'message' ? item.message.id : 'empty'));

describe('buildChatStreamItems', () => {
  it('preserves the ACP turn id on rendered assistant messages', () => {
    const { items } = buildChatStreamItems(
      [
        {
          ...entry({ id: 'assistant-1', role: 'assistant', items: [text('answer')] }),
          acpTurnId: 'turn_answer_1',
        },
      ],
      sessionId
    );

    expect(items[0]).toMatchObject({
      type: 'message',
      message: { id: 'assistant-1', acpTurnId: 'turn_answer_1' },
    });
  });

  it('maps history to items 1:1 in order and tracks the last assistant id', () => {
    const { items, lastAssistantMessageId, lastCompletedAssistantMessageId } = buildChatStreamItems(
      [
        entry({ id: 'u1', role: 'user', items: [text('hello')] }),
        {
          ...entry({ id: 'a1', role: 'assistant', items: [text('hi there')] }),
          finished: true,
        },
      ],
      sessionId
    );

    expect(renderedIds(items)).toEqual(['u1', 'a1']);
    expect(lastAssistantMessageId).toBe('a1');
    expect(lastCompletedAssistantMessageId).toBe('a1');
  });

  it('tracks the last completed assistant separately from a streaming suffix', () => {
    const { lastAssistantMessageId, lastCompletedAssistantMessageId } = buildChatStreamItems(
      [
        {
          ...entry({ id: 'a1', role: 'assistant', items: [text('done')] }),
          finished: true,
        },
        entry({ id: 'a2', role: 'assistant', items: [text('streaming')] }),
      ],
      sessionId
    );

    expect(lastAssistantMessageId).toBe('a2');
    expect(lastCompletedAssistantMessageId).toBe('a1');
  });

  it('drops empty assistant entries (no items, no plan) left by interrupted turns', () => {
    const { items } = buildChatStreamItems(
      [
        entry({ id: 'u1', role: 'user', items: [text('do something')] }),
        entry({ id: 'a-aborted', role: 'assistant', items: [] }),
      ],
      sessionId
    );

    expect(renderedIds(items)).toEqual(['u1']);
  });

  it('keeps an assistant entry that has a plan even when it has no items', () => {
    const { items, lastAssistantMessageId } = buildChatStreamItems(
      [entry({ id: 'a-plan', role: 'assistant', items: [], plan: [{ step: 'one' }] })],
      sessionId
    );

    expect(renderedIds(items)).toEqual(['a-plan']);
    expect(lastAssistantMessageId).toBe('a-plan');
  });

  it('de-duplicates entries that share an id, keeping the first occurrence', () => {
    const { items } = buildChatStreamItems(
      [
        entry({ id: 'dup', role: 'assistant', items: [text('first')] }),
        entry({ id: 'dup', role: 'assistant', items: [text('second')] }),
      ],
      sessionId
    );

    expect(renderedIds(items)).toEqual(['dup']);
    const first = items[0];
    expect(first?.type === 'message' && first.message.items[0]).toMatchObject(text('first'));
  });

  it('returns a single empty placeholder for empty history', () => {
    const { items, lastAssistantMessageId } = buildChatStreamItems([], sessionId);

    expect(items).toEqual([{ type: 'empty' }]);
    expect(lastAssistantMessageId).toBeNull();
  });

  it('returns the empty placeholder when every entry is an empty assistant', () => {
    const { items, lastAssistantMessageId } = buildChatStreamItems(
      [
        entry({ id: 'a1', role: 'assistant', items: [] }),
        entry({ id: 'a2', role: 'assistant', items: [] }),
      ],
      sessionId
    );

    expect(items).toEqual([{ type: 'empty' }]);
    expect(lastAssistantMessageId).toBeNull();
  });

  it('points lastAssistantMessageId at the last rendered (non-empty) assistant', () => {
    const { lastAssistantMessageId } = buildChatStreamItems(
      [
        entry({ id: 'a1', role: 'assistant', items: [text('done')] }),
        entry({ id: 'a2-trailing-empty', role: 'assistant', items: [] }),
      ],
      sessionId
    );

    expect(lastAssistantMessageId).toBe('a1');
  });

  it('reuses unchanged message item objects across shallow history array copies', () => {
    const assistantTurn = entry({
      id: 'assistant-1',
      role: 'assistant',
      items: [text('hello')],
    });
    const first = buildChatStreamItems([assistantTurn], sessionId);
    const second = buildChatStreamItems([assistantTurn], sessionId, first.cache);

    expect(second.items[0]).toBe(first.items[0]);
    expect(second.lastAssistantMessageId).toBe('assistant-1');
  });

  it('does not reuse a message item when render-relevant entry fields change', () => {
    const assistantTurn = entry({
      id: 'assistant-1',
      role: 'assistant',
      items: [text('hello')],
    });
    const changedAssistantTurn = entry({
      id: 'assistant-1',
      role: 'assistant',
      items: [text('hello again')],
    });
    const first = buildChatStreamItems([assistantTurn], sessionId);
    const second = buildChatStreamItems([changedAssistantTurn], sessionId, first.cache);

    expect(second.items[0]).not.toBe(first.items[0]);
  });

  it('tracks the last rendered assistant when reusing cached duplicate ids', () => {
    const firstAssistant = entry({
      id: 'assistant-1',
      role: 'assistant',
      items: [text('first')],
    });
    const secondAssistant = entry({
      id: 'assistant-2',
      role: 'assistant',
      items: [text('second')],
    });
    const first = buildChatStreamItems(
      [firstAssistant, secondAssistant, firstAssistant],
      sessionId
    );
    const second = buildChatStreamItems(
      [firstAssistant, secondAssistant, firstAssistant],
      sessionId,
      first.cache
    );

    expect(renderedIds(second.items)).toEqual(['assistant-1', 'assistant-2']);
    expect(second.lastAssistantMessageId).toBe('assistant-2');
  });
});

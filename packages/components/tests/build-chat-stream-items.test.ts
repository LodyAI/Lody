import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import type { SessionHistory, SessionHistoryInput, SessionId } from '@lody/shared';
import {
  buildChatStreamItems,
  buildChatStreamItemsFromView,
} from '../src/components/ai-gui/build-chat-stream-items';
import { appendHistoryEntry, createConversationViewFromDoc } from '../src/lib/conversation-view';

const sessionId = 'session-test' as SessionId;

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

describe('buildChatStreamItemsFromView', () => {
  const viewSessionId = 'session-view' as SessionId;
  const turn = (index: number): SessionHistoryInput =>
    index % 2 === 0
      ? {
          id: `u${index}`,
          role: 'user',
          timestamp: '2026-01-01T00:00:00.000Z',
          status: 'seen',
          read: true,
          finished: true,
          fileDiff: [],
          items: [{ type: 'text', text: `prompt ${index}` }] as never,
          inputConfig: {
            prompt: `prompt ${index}`,
            cliType: 'builtin',
            agentType: 'claude',
          } as never,
        }
      : {
          id: `a${index}`,
          role: 'assistant',
          timestamp: '2026-01-01T00:01:00.000Z',
          finished: index !== 9,
          fileDiff: [],
          items: index === 5 ? [] : ([{ type: 'text', text: `answer ${index}` }] as never),
        };
  const docWithTurns = (count: number): LoroDoc => {
    const doc = new LoroDoc();
    for (let index = 0; index < count; index += 1) appendHistoryEntry(doc, turn(index));
    return doc;
  };

  it('renders placeholders outside the hydrated window under the entry id, and messages inside', async () => {
    const doc = docWithTurns(12);
    const view = createConversationViewFromDoc(doc, { sessionId: viewSessionId, tailKeep: 2 });
    const first = buildChatStreamItemsFromView(view, viewSessionId);

    // a5 is an empty assistant turn: dropped from its index row, as the array path drops it.
    expect(
      first.items.map((item) =>
        item.type === 'placeholder'
          ? `p:${item.row.id}`
          : item.type === 'message'
            ? `m:${item.message.id}`
            : 'empty'
      )
    ).toEqual([
      'p:u0',
      'p:a1',
      'p:u2',
      'p:a3',
      'p:u4',
      'p:u6',
      'p:a7',
      'p:u8',
      'p:a9',
      'm:u10',
      'm:a11',
    ]);
    expect(first.items.map((item) => (item.type === 'empty' ? -1 : item.turnIndex))).toEqual([
      0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11,
    ]);
    // Last-assistant ids come from index rows, so they do not wait on hydration.
    expect(first.lastAssistantMessageId).toBe('a11');
    expect(first.lastCompletedAssistantMessageId).toBe('a11');

    await view.ensureRange(2, 4);
    const second = buildChatStreamItemsFromView(view, viewSessionId, first.cache);
    expect(second.items[2]).toMatchObject({ type: 'message', message: { id: 'u2' }, turnIndex: 2 });
    expect(second.items[3]).toMatchObject({ type: 'message', message: { id: 'a3' }, turnIndex: 3 });
    // Untouched placeholders and hydrated tail messages keep their identity.
    expect(second.items[0]).toBe(first.items[0]);
    expect(second.items[9]).toBe(first.items[9]);
    expect(second.items[10]).toBe(first.items[10]);
    view.dispose();
  });

  it('tracks the open tail turn and index-only completion state', () => {
    const doc = docWithTurns(10);
    const view = createConversationViewFromDoc(doc, { sessionId: viewSessionId, tailKeep: 0 });
    const result = buildChatStreamItemsFromView(view, viewSessionId);
    expect(result.items.every((item) => item.type === 'placeholder')).toBe(true);
    expect(result.lastAssistantMessageId).toBe('a9');
    expect(result.lastCompletedAssistantMessageId).toBe('a7');
    view.dispose();
  });

  it('gives the array path the same turn indexes', () => {
    const history = [0, 1, 2].map((index) => turn(index)) as unknown as SessionHistory[];
    const { items } = buildChatStreamItems(history, viewSessionId);
    expect(items.map((item) => (item.type === 'message' ? item.turnIndex : -1))).toEqual([0, 1, 2]);
  });
});

import { describe, expect, it } from 'vitest';
import type { SessionHistory, SessionId } from '@lody/shared';
import { buildChatStreamItems as buildChatStreamItemsFromView } from '../src/components/ai-gui/build-chat-stream-items';
import {
  createConversationViewFromHistory,
  inQuestionFirstOrder,
} from '../src/lib/conversation-view';
import { resolveSessionHistoryDurationMs } from '../src/lib/session-history-duration';

const sessionId = 'session-test' as SessionId;

/** The builder over a fully hydrated view of `history`, as the rollback path feeds it. */
const buildChatStreamItems = (
  history: readonly SessionHistory[],
  id: SessionId,
  previousCache?: Parameters<typeof buildChatStreamItemsFromView>[2]
) =>
  buildChatStreamItemsFromView(
    createConversationViewFromHistory({
      sessionId: id,
      getHistory: () => history,
      subscribe: () => () => {},
    }),
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
  it('preserves authors through projection and refreshes cached identity when metadata arrives', () => {
    const human = { v: 1, kind: 'human', userId: 'human' } as const;
    const agent = {
      v: 1,
      kind: 'agent',
      sessionId: 'source',
      turnId: 'source-turn',
      name: 'Agent',
      role: { id: 'reviewer', revision: 1, name: 'Reviewer', emoji: '🔎' },
    } as const;
    const turns = [
      { ...entry({ id: 'input', role: 'user', items: [text('task')] }), author: human },
      { ...entry({ id: 'output', role: 'assistant', items: [text('answer')] }), author: agent },
    ] as SessionHistory[];
    const first = buildChatStreamItems(turns, sessionId);
    expect(first.items.map((item) => item.type === 'message' && item.message.author)).toEqual([
      human,
      agent,
    ]);
    // A live mirror can retain the entry object while replacing metadata.
    Object.assign(turns[0]!, { author: agent });
    const second = buildChatStreamItems(turns, sessionId, first.cache);
    expect(second.items.map((item) => item.type === 'message' && item.message.author)).toEqual([
      agent,
      agent,
    ]);
    expect(first.items[0]?.type === 'message' && first.items[0].message.author).toEqual(human);
  });
  it('keeps offscreen bodies as placeholders while inheriting their user configuration', () => {
    const question = {
      ...entry({ id: 'question', role: 'user', items: [text('question')] }),
      inputConfig: { cliType: 'builtin', agentType: 'claude', modelId: 'test-model' },
    } as SessionHistory;
    const answer = entry({ id: 'answer', role: 'assistant', items: [text('answer')] });
    const view = createConversationViewFromHistory({
      sessionId,
      getHistory: () => [question, answer],
      subscribe: () => () => {},
    });
    const cached = buildChatStreamItemsFromView(view, sessionId);
    const result = buildChatStreamItemsFromView(
      view,
      sessionId,
      cached.cache,
      (index) => index === 1
    );
    expect(result.items[0]).toMatchObject({ type: 'placeholder', row: { id: 'question' } });
    expect(result.items[1]).toMatchObject({
      type: 'message',
      message: {
        id: 'answer',
        inputConfig: { modelId: 'test-model' },
      },
    });
    expect(result.cache.has('question')).toBe(false);
    view.dispose();
  });

  it('shows a question before its reply when the stored history is reversed', () => {
    const config = { cliType: 'builtin', agentType: 'claude', modelId: 'reply-model' };
    const history = [
      entry({ id: 'first', role: 'user', items: [text('first')] }),
      entry({ id: 'assistant:first', role: 'assistant', items: [text('one')] }),
      entry({ id: 'assistant:second', role: 'assistant', items: [text('two')] }),
      {
        id: 'notice',
        role: 'system',
        timestamp: '2026-06-18T00:00:00.000Z',
        fileDiff: [],
        items: [{ type: 'system_notice', name: 'agent_warning', meta: { message: 'slow' } }],
      } as unknown as SessionHistory,
      { ...entry({ id: 'second', role: 'user', items: [text('second')] }), inputConfig: config },
      entry({ id: 'third', role: 'user', items: [text('third')] }),
      {
        ...entry({ id: 'assistant-file', role: 'assistant', items: [text('file')] }),
        userTurnId: 'fourth',
      } as SessionHistory,
      entry({ id: 'fourth', role: 'user', items: [text('fourth')] }),
    ] as SessionHistory[];

    const { items } = buildChatStreamItems(history, sessionId);

    expect(renderedIds(items)).toEqual([
      'first',
      'assistant:first',
      'second',
      'assistant:second',
      'third',
      'fourth',
      'assistant-file',
    ]);
    expect(items.map((item) => (item.type === 'message' ? item.turnIndex : -1))).toEqual([
      0, 1, 4, 2, 5, 7, 6,
    ]);
    const reply = items[3];
    expect(reply?.type === 'message' && reply.message.inputConfig).toEqual(config);
    expect(reply?.type === 'message' && reply.message.items.map((item) => item.type)).toEqual([
      'text',
      'system_notice',
    ]);
  });

  it('does not move a question ahead of earlier turns for a reply that renders nothing', () => {
    const history = [
      entry({ id: 'assistant:question', role: 'assistant', items: [] }),
      entry({ id: 'previous', role: 'user', items: [text('previous')] }),
      entry({ id: 'assistant:previous', role: 'assistant', items: [text('answer')] }),
      entry({ id: 'question', role: 'user', items: [text('question')] }),
    ] as SessionHistory[];

    expect(renderedIds(buildChatStreamItems(history, sessionId).items)).toEqual([
      'previous',
      'assistant:previous',
      'question',
    ]);
  });

  it('orders a full history for copy and share like the chat stream', () => {
    const history = [
      entry({ id: 'previous', role: 'user', items: [text('previous')] }),
      entry({ id: 'assistant:question', role: 'assistant', items: [text('reply')] }),
      {
        ...entry({ id: 'assistant-file', role: 'assistant', items: [text('file')] }),
        userTurnId: 'question',
      } as SessionHistory,
      entry({ id: 'question', role: 'user', items: [text('question')] }),
    ] as SessionHistory[];

    const ordered = inQuestionFirstOrder(history).map((turn) => turn.id);
    expect(ordered).toEqual(['previous', 'question', 'assistant:question', 'assistant-file']);
    expect(renderedIds(buildChatStreamItems(history, sessionId).items)).toEqual(ordered);
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

  it('copies permissionWaitMs onto rendered assistant messages so Worked-for can subtract it', () => {
    const opened = '2026-06-18T00:00:00.000Z';
    const { items } = buildChatStreamItems(
      [
        {
          ...entry({ id: 'assistant-1', role: 'assistant', items: [text('done')] }),
          timestamp: opened,
          endedAt: Date.parse(opened) + 87_000,
          permissionWaitMs: 62_269,
          finished: true,
        },
      ],
      sessionId
    );

    const item = items[0];
    expect(item?.type).toBe('message');
    if (item?.type !== 'message') return;
    expect(item.message.permissionWaitMs).toBe(62_269);
    expect(resolveSessionHistoryDurationMs(item.message)).toBe(87_000 - 62_269);
  });
});

describe('live create progress in the stream', () => {
  describe('agent notices fold onto the turn that emitted them', () => {
    const notice = (id: string, name: string, message: string): SessionHistory =>
      ({
        id,
        role: 'system',
        timestamp: '2026-06-18T00:00:00.000Z',
        fileDiff: [],
        items: [{ type: 'system_notice', name, meta: { message } }],
      }) as unknown as SessionHistory;

    const itemTypes = (items: ReturnType<typeof buildChatStreamItems>['items'], id: string) =>
      items
        .flatMap((item) =>
          item.type === 'message' && item.message.id === id ? [item.message] : []
        )
        .flatMap((message) => message.items.map((entryItem) => entryItem.type));

    it('keeps a notice in place when the previous turn is not an assistant turn', () => {
      const { items } = buildChatStreamItems(
        [
          entry({ id: 'user-1', role: 'user', items: [text('go')] }),
          notice('fail-1', 'chat_failed', 'the agent exited'),
        ],
        sessionId
      );

      expect(renderedIds(items)).toEqual(['user-1', 'fail-1']);
    });

    it('does not lose a later notice to a cached copy of its host turn', () => {
      const history = [
        entry({ id: 'user-1', role: 'user', items: [text('go')] }),
        entry({ id: 'assistant-1', role: 'assistant', items: [text('answer')] }),
      ];
      const first = buildChatStreamItems(history, sessionId);
      // The host entry is untouched by the notice arriving, so a cache keyed on
      // it alone would happily serve the pre-merge copy forever.
      const { items } = buildChatStreamItems(
        [...history, notice('warn-1', 'agent_warning', 'fell back')],
        sessionId,
        first.cache
      );

      expect(itemTypes(items, 'assistant-1')).toEqual(['text', 'system_notice']);
    });
  });
});

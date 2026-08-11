// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { MessageContent, SessionHistoryParsed, SessionId } from '@lody/shared';
import {
  buildChatVirtualRows,
  resolveAssistantMessageActions,
  type AssistantMessageAction,
  type ChatStreamItem,
} from '../src/components/ai-gui/view';

// Guards the per-turn row cache behind view.tsx `buildChatVirtualRows`: rows for
// unchanged turns must be reference-stable across rebuilds, or the shallow-compare
// memo on AssistantChatItem fails for every mounted row on every streaming delta
// and long sessions saturate the renderer event loop (the v0.70–v0.72 macOS
// "Lody is not responding" regression).

const sessionId = 'session-identity' as SessionId;

const text = (value: string): MessageContent => ({ type: 'text', text: value }) as MessageContent;

let toolSeq = 0;
const toolCall = (): MessageContent =>
  ({
    type: 'tool_call',
    toolCallId: `tool-${(toolSeq += 1)}`,
    status: 'completed',
    title: 'ran a tool',
  }) as unknown as MessageContent;

const makeMessage = (
  id: string,
  role: 'user' | 'assistant',
  items: MessageContent[],
  finished?: boolean
): SessionHistoryParsed =>
  ({
    id,
    items,
    role,
    read: true,
    timestamp: 1,
    finished,
  }) as unknown as SessionHistoryParsed;

const wrap = (message: SessionHistoryParsed): ChatStreamItem => ({
  type: 'message',
  sessionId,
  message,
});

const build = (items: ChatStreamItem[], overrides?: { expansionVersion?: number }) =>
  buildChatVirtualRows({
    items,
    lastAssistantMessageId:
      [...items]
        .reverse()
        .find(
          (item): item is ChatStreamItem & { type: 'message' } =>
            item.type === 'message' && item.message.role === 'assistant'
        )?.message.id ?? null,
    expansionVersion: overrides?.expansionVersion ?? 0,
  });

const makeConversation = () => {
  const finishedTurn = wrap(
    makeMessage('turn-a', 'assistant', [toolCall(), toolCall(), text('done')], true)
  );
  const streamingTurn = wrap(
    makeMessage('turn-b', 'assistant', [toolCall(), text('streaming…')], false)
  );
  return { finishedTurn, streamingTurn, items: [finishedTurn, streamingTurn] };
};

describe('buildChatVirtualRows per-turn row identity', () => {
  it('keeps actions on their plan reply when a newer assistant reply exists', () => {
    const actions: AssistantMessageAction[] = [
      { id: 'implement-plan', label: 'Implement plan', onClick: () => undefined },
    ];

    expect(resolveAssistantMessageActions('plan-reply', 'plan-reply', actions)).toBe(actions);
    expect(
      resolveAssistantMessageActions('new-plain-reply', 'plan-reply', actions)
    ).toBeUndefined();
  });

  it('returns reference-identical rows when inputs are unchanged', () => {
    const { items } = makeConversation();
    const first = build(items);
    const second = build(items);
    expect(second.length).toBe(first.length);
    second.forEach((row, index) => {
      expect(row).toBe(first[index]);
    });
  });

  it('a streaming delta rebuilds only the changed turn', () => {
    const { finishedTurn, items } = makeConversation();
    const first = build(items);

    // Simulate a delta: the streaming turn gets a fresh wrapper + message (as
    // buildChatStreamItems produces), the finished turn keeps its identity.
    const streamingNext = wrap(
      makeMessage('turn-b', 'assistant', [toolCall(), text('streaming… more')], false)
    );
    const second = build([finishedTurn, streamingNext]);

    const firstTurnARows = first.filter((row) => row.key.includes('turn-a'));
    const secondTurnARows = second.filter((row) => row.key.includes('turn-a'));
    expect(secondTurnARows.length).toBe(firstTurnARows.length);
    secondTurnARows.forEach((row, index) => {
      expect(row).toBe(firstTurnARows[index]);
    });

    const firstTurnBRows = first.filter((row) => row.key.includes('turn-b'));
    const secondTurnBRows = second.filter((row) => row.key.includes('turn-b'));
    secondTurnBRows.forEach((row) => {
      expect(firstTurnBRows).not.toContain(row);
    });
  });

  it('an expansion-version bump invalidates cached rows', () => {
    const { items } = makeConversation();
    const first = build(items);
    const second = build(items, { expansionVersion: 1 });
    expect(second.length).toBe(first.length);
    second.forEach((row, index) => {
      expect(row).not.toBe(first[index]);
      expect(row.key).toBe(first[index]?.key);
    });
  });

  it('an index shift (prepended message) invalidates cached rows', () => {
    const { finishedTurn, streamingTurn, items } = makeConversation();
    const first = build(items);
    const userTurn = wrap(makeMessage('turn-user', 'user', [text('hi')]));
    const second = build([userTurn, finishedTurn, streamingTurn]);
    const secondAssistantRows = second.filter((row) => row.type === 'assistant');
    secondAssistantRows.forEach((row) => {
      expect(first).not.toContain(row);
      expect(row.messageIndex).toBeGreaterThan(0);
    });
  });
});

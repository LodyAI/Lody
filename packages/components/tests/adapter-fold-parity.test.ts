import { describe, expect, it } from 'vitest';
import {
  applyNotificationOnHistory,
  parseSessionNotifications,
  type MessageContent,
} from '@lody/shared';
import { buildAssistantTurnRenderLayout } from '../src/components/ai-gui/assistant-turn-render-blocks';

/**
 * Every ACP adapter streams assistant text in one of a few shapes and none of them
 * may lose the answer. This runs each shape through the real ingest and the real
 * fold so a future folding change cannot regress a provider that looks fine today.
 */
const visibleTexts = (items: MessageContent[]): string[] => {
  const layout = buildAssistantTurnRenderLayout('message-1', items, true);
  const texts: string[] = [];
  for (const block of layout.blocks) {
    if (layout.workBlockKeys.has(block.key)) continue;
    if (block.kind !== 'content') continue;
    if (block.entry.content.type !== 'text') continue;
    texts.push(block.entry.content.text);
  }
  return texts;
};

const ingest = (updates: unknown[]): MessageContent[] => {
  const notifications = parseSessionNotifications(
    updates.map((update) => ({ sessionId: 'session-1', update }))
  );
  const history = applyNotificationOnHistory([], notifications);
  const items = history[0]?.items;
  return Array.isArray(items) ? (items as MessageContent[]) : [];
};

const text = (value: string, messagePhase?: 'commentary' | 'final_answer') => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: value },
  ...(messagePhase === undefined ? {} : { _meta: { lody: { messagePhase } } }),
});

const toolCall = (id: string) => ({
  sessionUpdate: 'tool_call',
  toolCallId: id,
  title: 'Read src/parser.ts',
  kind: 'read',
  status: 'completed',
  locations: [{ path: 'src/parser.ts' }],
});

describe('assistant text folding across adapter shapes', () => {
  it('keeps an answer that was written before more tool work (Pi/Sorbet deltas)', () => {
    const items = ingest([text('The bug is in the parser.'), toolCall('call-1'), text('Done.')]);

    expect(visibleTexts(items)).toEqual(['The bug is in the parser.', 'Done.']);
  });

  it('keeps commentary and the answer visible when the adapter streams phases (Codex)', () => {
    const items = ingest([
      text('Checking the parser.', 'commentary'),
      toolCall('call-1'),
      text('The bug is in the parser.', 'final_answer'),
    ]);

    expect(visibleTexts(items)).toEqual(['Checking the parser.', 'The bug is in the parser.']);
  });

  it('still folds the tool work of a finished turn', () => {
    const items = ingest([text('Looking at the parser.'), toolCall('call-1'), text('Fixed.')]);
    const layout = buildAssistantTurnRenderLayout('message-1', items, true);

    expect(layout.blocks.some((block) => block.kind === 'activity_group')).toBe(true);
    expect(layout.workBlockKeys.size).toBeGreaterThan(0);
  });
});

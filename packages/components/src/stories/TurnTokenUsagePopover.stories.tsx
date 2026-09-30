/**
 * The turn details popover (ⓘ in a finished assistant turn's footer) with the
 * per-turn token section: compact product-language units, exact values on hover.
 */
import type { Meta, StoryObj } from '@storybook/react';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import type { ChatStreamItem, SessionChatStreamViewProps } from '@/components/ai-gui/view';
import { MessageRowView, SessionChatStreamView } from '@/components/ai-gui/view';

const meta = {
  title: 'Sessions/TurnTokenUsagePopover',
  component: SessionChatStreamView,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SessionChatStreamView>;

export default meta;
type Story = StoryObj<typeof meta>;

const sessionId = 'session-turn-token-usage-storybook' as SessionId;

const renderMessageRow: SessionChatStreamViewProps['renderMessageRow'] = ({
  message,
  sessionId: storySessionId,
}) => <MessageRowView message={message} sessionId={storySessionId} />;

const finishedTurn: SessionHistoryParsed = {
  id: 'token-usage-assistant',
  role: 'assistant',
  timestamp: '2026-09-25T09:00:00.000Z',
  endedAt: Date.parse('2026-09-25T09:01:12.000Z'),
  read: true,
  finished: true,
  modelInfo: { modelId: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  inputConfig: { modeId: 'default', configOptionValues: { effort: 'high' } },
  tokenUsage: {
    inputTokens: 1_234,
    outputTokens: 8_640,
    cacheReadInputTokens: 1_482_310,
    cacheCreationInputTokens: 36_904,
    reasoningOutputTokens: 2_112,
  },
  items: [{ type: 'text', text: '已修复 resume 后的重复计数，并补上了回归测试。' }],
};

const items: ChatStreamItem[] = [
  { type: 'message', sessionId, message: finishedTurn, turnIndex: 0 } as const,
];

const render = () => (
  <div className="h-[520px] w-full bg-background">
    <SessionChatStreamView
      items={items}
      sessionId={sessionId}
      renderMessageRow={renderMessageRow}
      lastAssistantMessageId={finishedTurn.id}
      lastCompletedAssistantMessageId={finishedTurn.id}
    />
  </div>
);

export const English: Story = {
  args: { sessionId, items, renderMessageRow },
  globals: { theme: 'dark', locale: 'en' },
  render,
};

export const Chinese: Story = {
  args: { sessionId, items, renderMessageRow },
  globals: { theme: 'dark', locale: 'zh_CN' },
  render,
};

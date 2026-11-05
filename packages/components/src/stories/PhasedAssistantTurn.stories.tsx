import type { Meta, StoryObj } from '@storybook/react';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import { MessageRowView, SessionChatStreamView, type ChatStreamItem } from '@/components/ai-gui/view';

const sessionId = 'synthetic-phased-preview' as SessionId;
const base: SessionHistoryParsed = {
  id: 'synthetic-phased-turn',
  role: 'assistant',
  timestamp: '2026-10-28T10:00:00.000Z',
  endedAt: Date.parse('2026-10-28T10:00:12.000Z'),
  read: true,
  finished: true,
  items: [
    { type: 'text', messagePhase: 'commentary', text: 'I’ll inspect the search index and check the update path.' },
    { type: 'tool_call', toolCallId: 'synthetic-read', kind: 'read', status: 'completed', title: 'Read search-index.ts' },
    { type: 'text', messagePhase: 'commentary', text: 'The index update is in place. I’ll check the tests next.' },
    { type: 'tool_call', toolCallId: 'synthetic-test', kind: 'execute', status: 'completed', title: 'pnpm test search-index' },
    { type: 'text', messagePhase: 'final_answer', text: 'The search index update is complete, and the relevant tests pass.' },
  ],
};

const meta = { title: 'Sessions/PhasedAssistantTurn', component: SessionChatStreamView, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof SessionChatStreamView>;
export default meta;
type Story = StoryObj<typeof meta>;
const storyArgs = {
  sessionId,
  items: [],
  renderMessageRow: ({ message, sessionId: id }) => <MessageRowView message={message} sessionId={id} />,
} satisfies Story['args'];

function Scene({ mode }: { mode: 'finished' | 'streaming' | 'interrupted' | 'legacy' }) {
  const message: SessionHistoryParsed = {
    ...base,
    id: `synthetic-${mode}`,
    finished: mode !== 'streaming',
    items: base.items
      .filter((item) => mode !== 'interrupted' || item.type !== 'text' || item.messagePhase !== 'final_answer')
      .map((item) => mode === 'legacy' && item.type === 'text' ? { ...item, messagePhase: undefined } : item),
  };
  const items: ChatStreamItem[] = [{ type: 'message', sessionId, message, turnIndex: 0 }];
  return <div className="h-[600px] w-full bg-background"><SessionChatStreamView sessionId={sessionId} items={items} lastAssistantMessageId={message.id} lastCompletedAssistantMessageId={message.finished ? message.id : undefined} agentActivityLabel={mode === 'streaming' ? 'Working' : undefined} renderMessageRow={({ message: row, sessionId: id }) => <MessageRowView message={row} sessionId={id} />} /></div>;
}

export const Finished: Story = { args: storyArgs, render: () => <Scene mode="finished" /> };
export const Streaming: Story = { args: storyArgs, render: () => <Scene mode="streaming" /> };
export const Interrupted: Story = { args: storyArgs, render: () => <Scene mode="interrupted" /> };
export const LegacyUnphased: Story = { args: storyArgs, render: () => <Scene mode="legacy" /> };

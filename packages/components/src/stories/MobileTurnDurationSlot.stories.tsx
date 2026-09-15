/**
 * The mobile assistant-turn footer's leading duration slot, live and finished.
 *
 * That slot is reserved unconditionally — its width is what pushes the copy and
 * fork buttons clear of the session drawer's left-edge back-swipe strip — so
 * while a turn was still running the bar rendered two icons beside a visibly
 * empty gutter. These stories show the slot counting up from the turn's own
 * `timestamp` while it runs, and holding the recorded duration once it ends;
 * the number is the same quantity in both, so it stops rather than jumps.
 */
import type { Meta, StoryObj } from '@storybook/react';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import type { ChatStreamItem, SessionChatStreamViewProps } from '@/components/ai-gui/view';
import { MessageRowView, SessionChatStreamView } from '@/components/ai-gui/view';
import { ForceMobileLayoutProvider } from '@/hooks/use-mobile';

const sessionId = 'session-mobile-duration-storybook' as SessionId;

const renderMessageRow: SessionChatStreamViewProps['renderMessageRow'] = ({
  message,
  sessionId: storySessionId,
}) => <MessageRowView message={message} sessionId={storySessionId} />;

/* Anchored to load time so the live story opens on a plausible number and then
   ticks; a fixed timestamp would print however long the story has been open. */
const startedSecondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

const turnItems: SessionHistoryParsed['items'] = [
  { type: 'text', text: '先把 composer 的冲突解掉，再跑一遍 fast gate。' },
  {
    type: 'tool_call',
    toolCallId: 'mobile-duration-tool-1',
    title: 'rg resolveSessionHistoryDurationMs packages/components/src',
    kind: 'search',
    status: 'completed',
  },
  {
    type: 'tool_call',
    toolCallId: 'mobile-duration-tool-2',
    title: 'Edit packages/components/src/components/ai-gui/view.tsx',
    kind: 'edit',
    status: 'completed',
  },
];

const liveTurn: SessionHistoryParsed = {
  id: 'mobile-duration-live',
  role: 'assistant',
  timestamp: startedSecondsAgo(47),
  read: true,
  finished: false,
  items: turnItems,
};

const finishedTurn: SessionHistoryParsed = {
  id: 'mobile-duration-finished',
  role: 'assistant',
  timestamp: startedSecondsAgo(92),
  endedAt: Date.now() - 4_000,
  read: true,
  finished: true,
  items: turnItems,
};

const Phone = ({ children }: { children: React.ReactNode }) => (
  <ForceMobileLayoutProvider force>
    <div className="flex h-dvh w-full items-start justify-center bg-muted/30 py-6">
      <div className="h-[520px] w-[390px] overflow-hidden rounded-2xl border border-border bg-background">
        {children}
      </div>
    </div>
  </ForceMobileLayoutProvider>
);

const meta = {
  title: 'Mobile/MobileTurnDurationSlot',
  component: SessionChatStreamView,
  parameters: { layout: 'fullscreen' },
  globals: { theme: 'dark' },
} satisfies Meta<typeof SessionChatStreamView>;

export default meta;
type Story = StoryObj<typeof meta>;

const liveItems: ChatStreamItem[] = [
  { type: 'message', sessionId, message: liveTurn, turnIndex: 0 } as const,
];
const finishedItems: ChatStreamItem[] = [
  { type: 'message', sessionId, message: finishedTurn, turnIndex: 0 } as const,
];

/** The reason these stories exist: the slot ticks instead of standing empty. */
export const LiveTurn: Story = {
  name: 'Live turn — slot counts up',
  args: { sessionId, items: liveItems, renderMessageRow },
  render: () => (
    <Phone>
      <SessionChatStreamView
        items={liveItems}
        sessionId={sessionId}
        renderMessageRow={renderMessageRow}
        lastAssistantMessageId={liveTurn.id}
        onCopyContext={() => undefined}
        onForkLastAssistant={() => undefined}
        agentActivityLabel="Editing"
      />
    </Phone>
  ),
};

export const FinishedTurn: Story = {
  name: 'Finished turn — slot holds',
  args: { sessionId, items: finishedItems, renderMessageRow },
  render: () => (
    <Phone>
      <SessionChatStreamView
        items={finishedItems}
        sessionId={sessionId}
        renderMessageRow={renderMessageRow}
        lastAssistantMessageId={finishedTurn.id}
        lastCompletedAssistantMessageId={finishedTurn.id}
        onCopyContext={() => undefined}
        onForkLastAssistant={() => undefined}
      />
    </Phone>
  ),
};

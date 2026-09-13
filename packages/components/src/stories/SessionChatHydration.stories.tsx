import { useState, type ComponentProps, type CSSProperties } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import {
  MessageRowView,
  SessionChatStreamView,
  type ChatStreamItem,
} from '@/components/ai-gui/view';
import { Button } from '@/ui/button';

const sessionId = 'hydration-regression' as SessionId;
const platform = createLocalPlatformProvider({
  session: createStaticStore({ status: 'unauthenticated' }),
  workspaces: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
});
const history: SessionHistoryParsed[] = [
  {
    id: 'first-user',
    role: 'user',
    timestamp: '2026-09-13T00:00:00.000Z',
    read: true,
    items: [{ type: 'text', text: 'The first user message must remain visible.' }],
  },
  {
    id: 'first-agent',
    role: 'assistant',
    timestamp: '2026-09-13T00:00:01.000Z',
    read: true,
    finished: true,
    items: [{ type: 'text', text: 'The agent reply must follow the user message.' }],
  },
];
const emptyItems: ChatStreamItem[] = [{ type: 'empty' }];
const loadedItems: ChatStreamItem[] = history.map((message) => ({
  type: 'message',
  sessionId,
  message,
}));

function HydrationStory({
  visibleLeadingContent = false,
  emptyHistory = emptyItems,
  agentActivityLabel,
  agentActivityTone,
  topInset = 0,
}: {
  visibleLeadingContent?: boolean;
  emptyHistory?: ChatStreamItem[];
  agentActivityLabel?: string;
  agentActivityTone?: ComponentProps<typeof SessionChatStreamView>['agentActivityTone'];
  topInset?: number;
}) {
  const [loaded, setLoaded] = useState(false);
  const [active, setActive] = useState(true);
  return (
    <PlatformContext.Provider value={platform}>
      <div className="flex h-screen flex-col" data-testid="chat-hydration-story">
        <div className="shrink-0 p-2">
          <Button onClick={() => setLoaded(true)} disabled={loaded}>
            Load history
          </Button>
          {agentActivityLabel && (
            <Button onClick={() => setActive((value) => !value)}>Toggle activity</Button>
          )}
        </div>
        <div
          className="min-h-0 flex-1"
          data-testid="chat-hydration-viewport"
          style={{ '--conversation-top-inset': `${topInset}px` } as CSSProperties}
        >
          <SessionChatStreamView
            sessionId={sessionId}
            className="h-full"
            items={loaded ? loadedItems : emptyHistory}
            agentActivityLabel={active ? agentActivityLabel : null}
            agentActivityTone={agentActivityTone}
            // A non-null Fragment with no visible children is what the sharing
            // request container supplies to ordinary conversations.
            leadingContent={
              <>{visibleLeadingContent ? <div>Conversation provenance</div> : null}</>
            }
            emptyState={<></>}
            lastAssistantMessageId={loaded ? 'first-agent' : null}
            lastCompletedAssistantMessageId={loaded ? 'first-agent' : null}
            renderMessageRow={(props) => <MessageRowView {...props} />}
          />
        </div>
      </div>
    </PlatformContext.Provider>
  );
}

const meta = {
  title: 'Sessions/SessionChatHydration',
  component: HydrationStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof HydrationStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyLeadingContent: Story = {};
export const VisibleLeadingContent: Story = { args: { visibleLeadingContent: true } };
export const StartingActivity: Story = {
  args: { emptyHistory: [], agentActivityLabel: 'Starting…' },
};
export const PermissionActivity: Story = {
  args: {
    visibleLeadingContent: true,
    agentActivityLabel: 'Waiting for permission',
    agentActivityTone: 'warning',
  },
};
export const MobileLeadingContent: Story = {
  args: { ...PermissionActivity.args, topInset: 64 },
};

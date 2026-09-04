import type { Meta, StoryObj } from '@storybook/react';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import type { ChatStreamItem, SessionChatStreamViewProps } from '@/components/ai-gui/view';
import { MessageRowView, SessionChatStreamView } from '@/components/ai-gui/view';
import { MessageSendStatusContext } from '@/components/ai-gui/message-send-status-context';

const meta = {
  title: 'AI/UserMessageSendStatus',
  component: SessionChatStreamView,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof SessionChatStreamView>;

export default meta;
type Story = StoryObj<typeof meta>;

const sessionId = 'session-storybook' as SessionId;

const user = {
  name: 'Zixuan',
  image: null,
  email: 'zixuan@example.com',
};

const StaticMessageRow = ({
  message,
  sessionId: sid,
  conversationFontSize = 14,
}: {
  message: SessionHistoryParsed;
  sessionId: SessionId;
  conversationFontSize?: SessionChatStreamViewProps['conversationFontSize'];
}) => (
  <MessageRowView
    message={message}
    sessionId={sid}
    user={message.userId ? user : undefined}
    conversationFontSize={conversationFontSize}
  />
);

const renderMessageRow: SessionChatStreamViewProps['renderMessageRow'] = ({
  message,
  sessionId: sid,
}) => <StaticMessageRow message={message} sessionId={sid} />;

const baseTime = Date.parse('2026-03-28T10:00:00.000Z');
const at = (seconds: number) => new Date(baseTime + seconds * 1000).toISOString();

const userMessage = (
  id: string,
  text: string,
  options?: {
    read?: boolean;
    status?: SessionHistoryParsed['status'];
    sendStatus?: SessionHistoryParsed['sendStatus'];
    seconds?: number;
  }
): SessionHistoryParsed => ({
  id,
  role: 'user',
  timestamp: at(options?.seconds ?? 0),
  read: options?.read ?? false,
  status: options?.status,
  sendStatus: options?.sendStatus,
  userId: 'user-1',
  items: [{ type: 'text', text }],
});

const assistantMessage = (
  id: string,
  text: string,
  options?: { seconds?: number }
): SessionHistoryParsed => ({
  id: id,
  role: 'assistant',
  timestamp: at(options?.seconds ?? 5),
  read: true,
  userId: undefined,
  items: [{ type: 'text', text }],
  finished: true,
});

const buildItems = (messages: SessionHistoryParsed[]): ChatStreamItem[] =>
  messages.map((message) => ({ type: 'message', sessionId, message }) as const);

/**
 * Message is being synced to the server (local CRDT written, waitUntilSynced pending).
 * After 500ms, a spinning loader icon appears to the left of the message bubble.
 */
export const Sending: Story = {
  args: {
    sessionId,
    items: buildItems([userMessage('msg-sending', 'Hey, can you help me refactor this function?')]),
    renderMessageRow,
  },
  render: (args) => (
    <MessageSendStatusContext.Provider value={new Set(['msg-sending'])}>
      <div className="h-[300px] w-full max-w-2xl mx-auto">
        <SessionChatStreamView {...args} />
      </div>
    </MessageSendStatusContext.Provider>
  ),
};

/**
 * Message has been synced to the server but the CLI agent hasn't picked it up yet.
 * Shows the empty circle icon (default "not delivered" state).
 * No "Sending..." text since the sync is complete.
 */
export const SentToServer: Story = {
  args: {
    sessionId,
    items: buildItems([
      userMessage('msg-sent', 'Hey, can you help me refactor this function?', { read: false }),
    ]),
    renderMessageRow,
  },
  render: (args) => (
    <div className="h-[300px] w-full max-w-2xl mx-auto">
      <SessionChatStreamView {...args} />
    </div>
  ),
};

/** A guide message is visible in history but has not yet been accepted into the active response. */
export const PendingApplication: Story = {
  args: {
    sessionId,
    items: buildItems([
      userMessage('msg-pending-apply', 'Focus on the error handling first.', {
        status: 'pending_apply',
      }),
    ]),
    renderMessageRow,
  },
  render: (args) => (
    <div className="h-[300px] w-full max-w-2xl mx-auto">
      <SessionChatStreamView {...args} />
    </div>
  ),
};

/**
 * The steer was submitted, but neither application nor refusal could be
 * proven. The destructive label opens a warning before a manual resend.
 */
export const DeliveryUnknown: Story = {
  args: {
    sessionId,
    items: buildItems([
      userMessage('msg-delivery-unknown', 'Focus on the error handling first.', {
        read: true,
        status: 'failed',
        sendStatus: 'delivery_unknown',
      }),
    ]),
    renderMessageRow: ({ message, sessionId: sid }) => (
      <MessageRowView
        message={message}
        sessionId={sid}
        user={message.userId ? user : undefined}
        onResendUndelivered={async () => true}
      />
    ),
  },
  render: (args) => (
    <div className="h-[300px] w-full max-w-2xl mx-auto">
      <SessionChatStreamView {...args} />
    </div>
  ),
};

/**
 * Message has been delivered to the CLI agent (status = 'seen' or read = true).
 * Shows the filled check circle icon.
 */
export const Delivered: Story = {
  args: {
    sessionId,
    items: buildItems([
      userMessage('msg-delivered', 'Hey, can you help me refactor this function?', {
        read: true,
        status: 'seen',
      }),
    ]),
    renderMessageRow,
  },
  render: (args) => (
    <div className="h-[300px] w-full max-w-2xl mx-auto">
      <SessionChatStreamView {...args} />
    </div>
  ),
};

/**
 * Full conversation showing the progression:
 * 1. First message: delivered (agent responded)
 * 2. Second message: sent to server (waiting for agent)
 * 3. Third message: sending (syncing to server)
 */
export const AllStates: Story = {
  args: {
    sessionId,
    items: buildItems([
      userMessage('msg-1', 'Can you add a loading spinner to the dashboard?', {
        read: true,
        status: 'seen',
        seconds: 0,
      }),
      assistantMessage(
        'msg-2',
        "I'll add a loading spinner to the dashboard component. Let me check the current implementation first.",
        { seconds: 5 }
      ),
      userMessage('msg-3', 'Also make sure it handles the error state gracefully.', {
        read: false,
        seconds: 10,
      }),
      userMessage('msg-4', 'And add a retry button when errors occur.', {
        read: false,
        seconds: 15,
      }),
    ]),
    renderMessageRow,
  },
  render: (args) => (
    <MessageSendStatusContext.Provider value={new Set(['msg-4'])}>
      <div className="h-[600px] w-full max-w-2xl mx-auto">
        <SessionChatStreamView {...args} />
      </div>
    </MessageSendStatusContext.Provider>
  ),
};

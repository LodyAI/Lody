import type { Meta, StoryObj } from '@storybook/react';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import { CornerLeftUp } from 'lucide-react';

import type { ChatStreamItem, SessionChatStreamViewProps } from '@/components/ai-gui/view';
import { MessageRowView, SessionChatStreamView } from '@/components/ai-gui/view';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { SessionRelationCard } from '@/components/shared/session-relation-card';

const meta = {
  title: 'Sessions/SessionRelationCard',
  component: SessionRelationCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof SessionRelationCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CreatedConversation: Story = {
  args: {
    relation: 'opened',
    label: 'Session created',
    sessionTitle: 'Audit the sidebar navigation state',
    actionLabel: 'View session',
    onAction: () => {},
    className: 'w-[640px] max-w-[calc(100vw-2rem)]',
  },
};

export const AutomaticallyCreatedBy: Story = {
  args: {
    relation: 'opened-by',
    label: 'This session was automatically created by',
    sessionTitle: 'Plan the MCP session relationship UI',
    actionLabel: 'Back to session',
    actionIcon: CornerLeftUp,
    onAction: () => {},
    className: 'w-[640px] max-w-[calc(100vw-2rem)]',
  },
};

const operationSessionId = 'storybook-created-session' as SessionId;
const operationCompletion: SessionHistoryParsed = {
  id: 'storybook-create-completion',
  role: 'system',
  timestamp: '2026-08-14T12:00:00.000Z',
  read: true,
  items: [
    {
      type: 'operation_completion',
      deliveryId: 'operation:create-sidebar-audit:completion',
      operationId: 'create-sidebar-audit',
      operationKind: 'session_create',
      completion: {
        type: 'result',
        value: {
          items: [
            {
              status: 'succeeded',
              label: 'Audit the sidebar navigation state',
              target: { sessionId: operationSessionId, userTurnId: 'storybook-user-turn' },
              assistantTurnId: 'storybook-assistant-turn',
            },
          ],
        },
      },
    },
  ],
};

export const InCreateOperation: Story = {
  args: {
    relation: 'opened',
    label: '',
    sessionTitle: '',
    actionLabel: '',
    onAction: () => {},
  },
  render: () => (
    <div className="w-[720px] max-w-[calc(100vw-2rem)]">
      <MessageRowView
        message={operationCompletion}
        sessionId={'storybook-opener' as SessionId}
        onNavigateSession={() => {}}
      />
    </div>
  ),
};

const openedSessionId = 'storybook-opened-session' as SessionId;
const openedConversationItems: ChatStreamItem[] = [
  {
    type: 'message',
    sessionId: openedSessionId,
    turnIndex: 0,
    message: {
      id: 'storybook-opened-user-turn',
      role: 'user',
      timestamp: '2026-08-14T12:00:01.000Z',
      read: true,
      items: [{ type: 'text', text: 'Please audit the sidebar navigation state.' }],
    },
  },
];
const renderOpenedConversationMessage: SessionChatStreamViewProps['renderMessageRow'] = ({
  message,
  sessionId,
}) => <MessageRowView message={message} sessionId={sessionId} />;

export const AtConversationStart: Story = {
  args: {
    relation: 'opened-by',
    label: '',
    sessionTitle: '',
    actionLabel: '',
    onAction: () => {},
  },
  render: () => (
    <div className="h-[520px] w-[720px] max-w-[100vw] bg-background">
      <SessionChatStreamView
        sessionId={openedSessionId}
        items={openedConversationItems}
        renderMessageRow={renderOpenedConversationMessage}
        leadingContent={
          <ConversationColumn className="py-2 sm:py-3">
            <SessionRelationCard
              relation="opened-by"
              label="This session was automatically created by"
              sessionTitle="Plan the MCP session relationship UI"
              actionLabel="Back to session"
              actionIcon={CornerLeftUp}
              onAction={() => {}}
            />
          </ConversationColumn>
        }
      />
    </div>
  ),
};

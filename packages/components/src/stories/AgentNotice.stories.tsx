import type { Meta, StoryObj } from '@storybook/react';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';

import { MessageRowView } from '@/components/ai-gui/view';
import { ConversationColumn } from '@/components/shared/conversation-column';

const meta = {
  title: 'Sessions/AgentNotice',
  component: MessageRowView,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[720px] max-w-[100vw] bg-background py-6">
        <ConversationColumn>
          <Story />
        </ConversationColumn>
      </div>
    ),
  ],
} satisfies Meta<typeof MessageRowView>;

export default meta;
type Story = StoryObj<typeof meta>;

const sessionId = 'agent-notice-session' as SessionId;
const informationalMessage = {
  id: 'agent-notice-info',
  role: 'system',
  timestamp: '2026-09-08T00:00:00.000Z',
  read: true,
  items: [
    {
      type: 'system_notice',
      name: 'agent_warning',
      meta: {
        level: 'info',
        source: 'pi',
        message: 'Pi processed this input without starting a model turn.',
      },
    },
  ],
} as SessionHistoryParsed;

export const Informational: Story = {
  args: {
    sessionId,
    message: informationalMessage,
  },
};

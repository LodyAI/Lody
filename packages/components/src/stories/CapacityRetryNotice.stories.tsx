import type { Meta, StoryObj } from '@storybook/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import {
  getSessionRoomId,
  type AgentConfigId,
  type MachineId,
  type SessionHistoryParsed,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';

import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { MessageRowView } from '@/components/ai-gui/view';
import { ConversationColumn } from '@/components/shared/conversation-column';

const meta = {
  title: 'Sessions/CapacityRetryNotice',
  component: MessageRowView,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof MessageRowView>;

export default meta;
type Story = StoryObj<typeof meta>;

const sessionId = 'capacity-retry-session' as SessionId;
const noticeId = 'capacity-retry-notice';
const sessionMeta = {
  id: sessionId,
  machineId: 'story-machine' as MachineId,
  agentConfigId: 'story-codex' as AgentConfigId,
  userId: 'story-user',
  createdAt: '2026-08-31T09:00:00.000Z',
  cliType: 'builtin',
  agentType: 'codex',
  status: { type: 'idle' as const },
} satisfies SessionMeta;

const message = {
  id: noticeId,
  role: 'system',
  timestamp: '2026-08-31T09:00:00.000Z',
  read: true,
  items: [
    {
      type: 'system_notice',
      name: 'chat_failed',
      meta: {
        reason: 'acp_provider_overloaded',
        message: 'Selected model is at capacity. Please try a different model.',
      },
    },
  ],
} as SessionHistoryParsed;

function renderRow(args: React.ComponentProps<typeof MessageRowView>) {
  const store = createStore();
  store.set(sessionMetaCacheAtom, { [getSessionRoomId(sessionId)]: sessionMeta });
  return (
    <JotaiProvider store={store}>
      <div className="w-[760px] max-w-[100vw] bg-background py-6">
        <ConversationColumn>
          <MessageRowView {...args} />
        </ConversationColumn>
      </div>
    </JotaiProvider>
  );
}

export const FirstConsent: Story = {
  args: {
    message,
    sessionId,
    capacityRetry: {
      noticeId,
      retryInSeconds: null,
      retryRemainingRatio: null,
      pending: false,
      canRetry: true,
      autoRetryEnabled: false,
      autoRetryExhausted: false,
      retry: () => undefined,
    },
  },
  render: renderRow,
};

export const Countdown: Story = {
  args: {
    ...FirstConsent.args,
    capacityRetry: {
      noticeId,
      retryInSeconds: 4,
      retryRemainingRatio: 0.8,
      pending: false,
      canRetry: true,
      autoRetryEnabled: true,
      autoRetryExhausted: false,
      retry: () => undefined,
    },
  },
  render: renderRow,
};

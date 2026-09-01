import type { Meta, StoryObj } from '@storybook/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { useTranslation } from 'react-i18next';
import { expect, userEvent, within } from 'storybook/test';
import {
  getSessionRoomId,
  type AgentConfigId,
  type MachineId,
  type SessionHistoryParsed,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';

import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { MessageRowView, type CapacityRetryControl } from '@/components/ai-gui/view';
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

const firstConsentControl = {
  noticeId,
  retryInSeconds: null,
  retryRemainingRatio: null,
  pending: false,
  canRetry: true,
  autoRetryEnabled: false,
  autoRetryExhausted: false,
  retry: () => undefined,
  stopAutoRetry: () => undefined,
} satisfies CapacityRetryControl;

const countdownControl = {
  ...firstConsentControl,
  retryInSeconds: 4,
  retryRemainingRatio: 0.8,
  autoRetryEnabled: true,
} satisfies CapacityRetryControl;

const retryingControl = {
  ...firstConsentControl,
  pending: true,
  autoRetryEnabled: true,
} satisfies CapacityRetryControl;

const exhaustedControl = {
  ...firstConsentControl,
  autoRetryExhausted: true,
} satisfies CapacityRetryControl;

export const FirstConsent: Story = {
  args: {
    message,
    sessionId,
    capacityRetry: firstConsentControl,
  },
  render: renderRow,
};

export const Countdown: Story = {
  args: {
    ...FirstConsent.args,
    capacityRetry: countdownControl,
  },
  render: renderRow,
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Stop auto-retry' });
    const widthBeforeHover = button.getBoundingClientRect().width;

    await userEvent.hover(button);
    await expect(button.getBoundingClientRect().width).toBe(widthBeforeHover);
    await userEvent.unhover(button);
  },
};

export const Retrying: Story = {
  args: {
    ...FirstConsent.args,
    capacityRetry: retryingControl,
  },
  render: renderRow,
};

export const AutomaticRetriesStopped: Story = {
  args: {
    ...FirstConsent.args,
    capacityRetry: exhaustedControl,
  },
  render: renderRow,
};

const galleryStates = [
  { key: 'consent', control: firstConsentControl },
  { key: 'countdown', control: countdownControl },
  { key: 'retrying', control: retryingControl },
  { key: 'exhausted', control: exhaustedControl },
] as const;

function RetryStateGallery() {
  const { i18n } = useTranslation();
  const isChinese = i18n.resolvedLanguage === 'zh_CN' || i18n.language === 'zh_CN';
  const labels = isChinese
    ? ['首次需确认', '自动重试倒数', '正在重试', '自动重试次数已用完']
    : ['First consent', 'Auto-retry countdown', 'Retrying', 'Auto-retries exhausted'];
  const store = createStore();
  store.set(sessionMetaCacheAtom, { [getSessionRoomId(sessionId)]: sessionMeta });

  return (
    <JotaiProvider store={store}>
      <main className="min-h-dvh bg-background px-6 py-8 text-foreground">
        <div className="mx-auto flex w-full max-w-[920px] flex-col gap-4">
          {galleryStates.map(({ key, control }, index) => (
            <section key={key} className="rounded-xl border border-border/70 bg-background py-4">
              <div className="mb-2 px-5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {labels[index]}
              </div>
              <ConversationColumn>
                <MessageRowView
                  message={{ ...message, id: `${noticeId}-${key}` }}
                  sessionId={sessionId}
                  capacityRetry={{ ...control, noticeId: `${noticeId}-${key}` }}
                />
              </ConversationColumn>
            </section>
          ))}
        </div>
      </main>
    </JotaiProvider>
  );
}

export const AllStates: Story = {
  args: FirstConsent.args,
  render: () => <RetryStateGallery />,
};

export const AllStatesChinese: Story = {
  args: FirstConsent.args,
  globals: { locale: 'zh_CN' },
  render: () => <RetryStateGallery />,
};

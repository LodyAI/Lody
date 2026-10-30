import type { Meta, StoryObj } from '@storybook/react';
import { useState, type ReactNode } from 'react';
import { Clock, Copy } from 'lucide-react';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import { AgentNoticeBanner, MessageRowView } from '@/components/ai-gui/view';
import { buildChatFailedNoticeDetail } from '@/components/ai-gui/chat-failed-error-report';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { SessionLimitContinueRow } from '@/components/schedules/quota-continue-action';
import { ChatComposer } from '@/components/chat/chat-composer';
import { Button } from '@lody/ui/button';
import { SettingsStoryProviders } from './settings-story-shell';

/**
 * Final placement for Claude session-limit recovery. The banner and the
 * continuation row are the production components; `MessageRowView` mounts the
 * row through `SessionLimitContinueAction`, which needs the workspace runtime.
 */
const meta = {
  title: 'Sessions/SessionLimitContinue',
  component: MessageRowView,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <SettingsStoryProviders>
        <Story />
      </SettingsStoryProviders>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta<typeof MessageRowView>;

export default meta;
type Story = StoryObj<typeof meta>;

const sessionId = 'session-limit-story' as SessionId;
const internalError = "Internal error: You've hit your session limit · resets 2:30pm (UTC)";
const title = 'Agent internal error';
const detail = buildChatFailedNoticeDetail({ title, message: internalError });
const timeLabel = '2:31 PM UTC';
const timeLabelZh = '下午2:31 UTC';

const failure = {
  id: 'session-limit-failure',
  role: 'system',
  timestamp: '2026-10-27T14:00:00.000Z',
  items: [
    {
      type: 'system_notice',
      name: 'chat_failed',
      meta: {
        reason: 'acp_internal_error',
        message: internalError,
      },
    },
  ],
} as SessionHistoryParsed;

function CopyButton({ label = 'Copy error' }: { label?: string }) {
  return (
    <Button variant="ghost" size="small" onClick={() => undefined}>
      <Copy size={14} aria-hidden="true" />
      {label}
    </Button>
  );
}

function FailureBanner({
  state,
  locale = 'en',
  copyLabel = 'Copy error',
}: {
  state: 'idle' | 'pending' | 'scheduled';
  locale?: 'en' | 'zh_CN';
  copyLabel?: string;
}) {
  const isChinese = locale === 'zh_CN';
  return (
    <AgentNoticeBanner
      tone="error"
      label={isChinese ? 'Agent 内部错误' : title}
      detail={detail}
      footer={<CopyButton label={copyLabel} />}
      afterDetail={
        <SessionLimitContinueRow
          state={state}
          timeLabel={isChinese ? timeLabelZh : timeLabel}
          onSchedule={() => undefined}
          onOpen={() => undefined}
        />
      }
    />
  );
}

function Preview({ children, caption }: { children: ReactNode; caption?: string }) {
  return (
    <div className="min-h-dvh w-full bg-background px-3 py-8 sm:px-6">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3">
        {children}
        {caption ? <p className="text-[12px] text-muted-foreground">{caption}</p> : null}
      </div>
    </div>
  );
}

function ComposerPreview({
  state,
  locale = 'en',
}: {
  state: 'idle' | 'scheduled';
  locale?: 'en' | 'zh_CN';
}) {
  const [text, setText] = useState('Keep this draft while waiting for the quota window.');
  return (
    <div className="min-h-dvh w-full bg-background px-3 py-8 sm:px-6">
      <div className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-[760px] flex-col justify-end">
        <ConversationColumn>
          <FailureBanner
            state={state}
            locale={locale}
            copyLabel={locale === 'zh_CN' ? '复制错误' : 'Copy error'}
          />
        </ConversationColumn>
        <ChatComposer
          variant="session"
          tone="light"
          promptValue={text}
          onPromptChange={setText}
          onAttachmentAddClick={() => undefined}
          onScheduleSend={() => undefined}
          primaryAction={
            <Button icon aria-label="Send">
              <Clock size={16} />
            </Button>
          }
        />
      </div>
    </div>
  );
}

export const Default: Story = {
  args: { message: failure, sessionId },
  render: () => (
    <Preview caption="The row sits inside the terminal failure banner, below the provider detail.">
      <FailureBanner state="idle" />
    </Preview>
  ),
};

export const Scheduled: Story = {
  args: { message: failure, sessionId },
  render: () => (
    <Preview caption="After one click the same row becomes the receipt; View opens the schedule.">
      <FailureBanner state="scheduled" />
    </Preview>
  ),
};

export const Pending: Story = {
  args: { message: failure, sessionId },
  render: () => (
    <Preview caption="While the durable reservation is being confirmed.">
      <FailureBanner state="pending" />
    </Preview>
  ),
};

export const Mobile: Story = {
  args: { message: failure, sessionId },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  render: () => <ComposerPreview state="idle" />,
};

export const MobileScheduled: Story = {
  args: { message: failure, sessionId },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  render: () => <ComposerPreview state="scheduled" />,
};

export const Chinese: Story = {
  args: { message: failure, sessionId },
  globals: { locale: 'zh_CN' },
  render: () => <ComposerPreview state="idle" locale="zh_CN" />,
};

export const ChineseScheduled: Story = {
  args: { message: failure, sessionId },
  globals: { locale: 'zh_CN' },
  render: () => <ComposerPreview state="scheduled" locale="zh_CN" />,
};

export const Dark: Story = {
  args: { message: failure, sessionId },
  globals: { theme: 'dark' },
  render: () => <FailureBanner state="idle" />,
};

export const NoProvenReset: Story = {
  args: { message: failure, sessionId },
  render: () => (
    <Preview caption="No row when the reset is missing, expired, weekly, or another quota stays blocked.">
      <AgentNoticeBanner tone="error" label={title} detail={detail} footer={<CopyButton />} />
    </Preview>
  ),
};

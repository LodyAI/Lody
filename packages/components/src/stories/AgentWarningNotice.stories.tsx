import type { Meta, StoryObj } from '@storybook/react';
import type { CSSProperties } from 'react';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';

import { MessageRowView } from '@/components/ai-gui/view';
import { ConversationColumn } from '@/components/shared/conversation-column';

/**
 * The `agent_warning` system notice, rendered through the real `MessageRowView`
 * system-message path inside the shared conversation column.
 *
 * The real always-open banner colors its triangle and title. Agent-provided
 * detail wraps inside the conversation column, including explicit newlines.
 */
const meta = {
  title: 'Sessions/AgentWarningNotice',
  component: MessageRowView,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[720px] max-w-[100vw] bg-background py-4">
        <ConversationColumn>
          <Story />
        </ConversationColumn>
      </div>
    ),
  ],
} satisfies Meta<typeof MessageRowView>;

export default meta;
type Story = StoryObj<typeof meta>;

const sessionId = 'agent-warning-session' as SessionId;

const warningMessage = (message: string): SessionHistoryParsed => ({
  id: `agent-warning-${message.length}`,
  role: 'system',
  timestamp: '2026-09-20T22:41:00.000Z',
  read: true,
  items: [
    {
      type: 'system_notice',
      name: 'agent_warning',
      meta: { message, source: 'acp' },
    },
  ],
});

/** The ordinary case: one short line beside the triangle. */
export const Short: Story = {
  args: {
    message: warningMessage('Context is nearly full; older turns may be dropped.'),
    sessionId,
  },
};

/** Wraps inside the column instead of widening it. */
export const LongSingleLine: Story = {
  args: {
    message: warningMessage(
      'The configured model is unavailable for this account, so the request fell back to the default model. Billing and rate limits follow the fallback, not the model you selected.'
    ),
    sessionId,
  },
};

/** Agent text arrives with its own newlines; `whitespace-pre-wrap` keeps them. */
export const MultiLine: Story = {
  args: {
    message: warningMessage(
      'Two problems were found:\n  1. `pnpm-lock.yaml` is out of date\n  2. the managed runtime checksum does not match\n\nThe turn continued with the cached runtime.'
    ),
    sessionId,
  },
};

export const ScopedPalette: StoryObj = {
  render: () => (
    <div
      data-warning-palette=""
      style={
        {
          '--color-amber-600': 'rgb(111 47 189)',
          '--color-amber-400': 'rgb(20 142 107)',
        } as CSSProperties
      }
    >
      <div className="dark-scope" data-warning-scope="dark">
        <MessageRowView message={warningMessage('Scoped warning text.')} sessionId={sessionId} />
      </div>
      <div className="dark-scope">
        <div className="light-scope" data-warning-scope="light">
          <MessageRowView message={warningMessage('Scoped warning text.')} sessionId={sessionId} />
        </div>
      </div>
    </div>
  ),
};

export const Neutral: Story = {
  args: {
    sessionId,
    message: {
      ...warningMessage('Provider is currently at capacity.'),
      items: [
        {
          type: 'system_notice',
          name: 'chat_failed',
          meta: {
            reason: 'acp_provider_overloaded',
            message: 'Provider is currently at capacity.',
          },
        },
      ],
    },
  },
};

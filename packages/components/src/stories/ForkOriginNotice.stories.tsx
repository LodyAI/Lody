import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';

import { MessageRowView } from '@/components/ai-gui/view';
import { ConversationColumn } from '@/components/shared/conversation-column';
const storyLayout = stylex.create({
  frame: {
    width: '720px',
    'max-width': '100vw',
    'background-color': 'hsl(var(--background) / 1)',
  },
});

/**
 * The `session_fork_origin` system notice ("This conversation was forked from
 * …"), rendered through the real `MessageRowView` system-message path inside
 * the shared conversation column. The long-title case guards the regression
 * where the middle span (`shrink-0`) pushed past the column and clipped at the
 * pane edge instead of ellipsizing.
 */
const meta = {
  title: 'Sessions/ForkOriginNotice',
  component: MessageRowView,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div {...stylex.props(storyLayout.frame)}>
        <ConversationColumn>
          <Story />
        </ConversationColumn>
      </div>
    ),
  ],
} satisfies Meta<typeof MessageRowView>;

export default meta;
type Story = StoryObj<typeof meta>;

const sessionId = 'fork-origin-session' as SessionId;

const forkMessage = (sourceTitle: string): SessionHistoryParsed => ({
  id: 'fork-origin-notice',
  role: 'system',
  timestamp: '2026-08-15T09:35:00.000Z',
  read: true,
  items: [
    {
      type: 'system_notice',
      name: 'session_fork_origin',
      meta: {
        sourceSessionId: 'fork-origin-source' as SessionId,
        sourceTurnId: 'turn-1',
        sourceTitle,
      },
    },
  ],
});

/** Short title: the label stays on one line between the dashed rules. */
export const ShortTitle: Story = {
  args: {
    message: forkMessage('Plan the MCP session relationship UI'),
    sessionId,
  },
};

/**
 * Long title: must truncate with an ellipsis inside the column. Before the
 * fix this overflowed the column and clipped mid-character at the pane edge.
 */
export const LongTitle: Story = {
  args: {
    message: forkMessage(
      '为什么现在在 AfterRay 中和 Agent 对话时，Agent 调用工具似乎都是失败的，没有返回需要的数据给它，检查这里的 Agent harness 实现和 tool call 的实现路径'
    ),
    sessionId,
  },
};

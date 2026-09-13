import type { Meta, StoryObj } from '@storybook/react';
import { SessionPin } from '@/components/sessions/session-pin';
import type { SessionHistoryParsed } from '@lody/shared';
import { fn } from 'storybook/test';

const mockHistory: SessionHistoryParsed[] = [
  {
    id: 'msg-1',
    role: 'user',
    items: [{ type: 'text', text: 'Fix the login page bug where the form resets on submit' }],
    status: undefined,
    read: true,
    timestamp: '2025-03-28T10:00:00Z',
    endedAt: undefined,
    userId: 'user-1',
    modelInfo: undefined,
    fileDiff: undefined,
    finished: true,
    plan: undefined,
  },
  {
    id: 'msg-2',
    role: 'user',
    items: [{ type: 'text', text: 'Also add input validation to the email field' }],
    status: undefined,
    read: true,
    timestamp: '2025-03-28T10:05:00Z',
    endedAt: undefined,
    userId: 'user-1',
    modelInfo: undefined,
    fileDiff: undefined,
    finished: true,
    plan: undefined,
  },
];

const longTextHistory: SessionHistoryParsed[] = [
  {
    id: 'msg-long',
    role: 'user',
    items: [
      {
        type: 'text',
        text: 'I need you to refactor the entire authentication module. The current implementation uses a legacy session-based auth with cookies, but we need to migrate to JWT tokens with refresh token rotation. Make sure to update all the middleware, the login/logout endpoints, the password reset flow, and the email verification flow. Also update the tests and the API documentation. The frontend auth context and hooks will need to be updated as well to handle the new token-based flow with automatic refresh. Please also add rate limiting to the auth endpoints.',
      },
    ],
    status: undefined,
    read: true,
    timestamp: '2025-03-28T10:00:00Z',
    endedAt: undefined,
    userId: 'user-1',
    modelInfo: undefined,
    fileDiff: undefined,
    finished: true,
    plan: undefined,
  },
];

const meta = {
  title: 'Sessions/SessionPin',
  component: SessionPin,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-full rounded-lg border border-border bg-background">
        <div className="h-10 border-b border-border bg-muted/30 flex items-center px-4 text-xs text-muted-foreground">
          Tab Bar (simulated)
        </div>
        <Story />
        <div className="h-40 bg-muted/20 dark:bg-black/20 flex items-center justify-center text-xs text-muted-foreground">
          Chat area
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof SessionPin>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    pinnedHistoryId: 'msg-1',
    pinnedMessage: mockHistory.find((entry) => entry.id === 'msg-1') ?? null,
    onUnpin: fn(),
    onScrollToMessage: fn(),
  },
};

export const LongText: Story = {
  args: {
    pinnedHistoryId: 'msg-long',
    pinnedMessage: longTextHistory.find((entry) => entry.id === 'msg-long') ?? null,
    onUnpin: fn(),
    onScrollToMessage: fn(),
  },
};

export const NoPinned: Story = {
  args: {
    pinnedHistoryId: null,
    pinnedMessage: null,
    onUnpin: fn(),
    onScrollToMessage: fn(),
  },
};

import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { GitHubReviewErrorNotice } from '@/components/sessions/github-review-error-notice';

const meta = {
  title: 'Sessions/GitHubReviewErrorNotice',
  component: GitHubReviewErrorNotice,
  args: { onRetry: fn() },
} satisfies Meta<typeof GitHubReviewErrorNotice>;
export default meta;
type Story = StoryObj<typeof meta>;

export const UnresolvedIdentity: Story = {
  args: {
    message:
      'Cannot verify this session’s repository identity. GitHub operations are paused. Retry after reconnecting to Lody. If the repository was removed, reinstalled or renamed, ask a workspace administrator to verify the original repository and PR association; a matching name alone is not enough.',
  },
};
export const NetworkFailure: Story = {
  args: { message: 'Failed to fetch GitHub review comments.' },
};

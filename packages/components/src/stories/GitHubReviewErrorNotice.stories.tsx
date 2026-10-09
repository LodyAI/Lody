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
    onOpenGitHubSettings: fn(),
    message:
      'Lody cannot confirm this PR’s repository connection to the current workspace. In Settings > GitHub, ask a workspace administrator to connect the GitHub App and check access to this repository, then retry. If it is already connected, ask them to verify the original repository and PR association. Signing in with the local GitHub CLI does not establish this connection.',
  },
};
export const NetworkFailure: Story = {
  args: { message: 'Failed to fetch GitHub review comments.' },
};

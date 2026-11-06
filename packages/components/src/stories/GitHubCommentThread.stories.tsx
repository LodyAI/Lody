import * as stylex from '@stylexjs/stylex';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { GitHubCommentThread } from '@/ui/diff-viewer/github-comment-thread';
import type {
  GitHubReviewThread,
  GitHubReviewComment,
} from '@/ui/diff-viewer/session-comment-types';

const sceneStyles = stylex.create({
  desktop: {
    marginInline: 'auto',
    maxWidth: '32rem',
    padding: 'calc(var(--spacing) * 4)',
    ':where(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 4)',
    },
  },
  mobile: {
    marginInline: 'auto',
    width: '360px',
    padding: 'calc(var(--spacing) * 3)',
    ':where(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 4)',
    },
  },
});

const now = Date.now();

function makeReviewComment(
  overrides: Partial<GitHubReviewComment> & Pick<GitHubReviewComment, 'id' | 'body'>
): GitHubReviewComment {
  return {
    nodeId: `MDI0OnB1bGxSZXF1ZXN0UmV2aWV3Q29tbWVudA==${overrides.id}`,
    pullRequestReviewId: 100,
    path: 'src/utils/helper.ts',
    commitId: 'abc123',
    originalCommitId: 'abc123',
    diffHunk: '@@ -40,6 +40,8 @@',
    subjectType: 'line',
    user: { login: 'octocat', id: 1, avatarUrl: 'https://github.com/octocat.png', htmlUrl: 'https://github.com/octocat' },
    authorAssociation: 'MEMBER',
    line: 42,
    originalLine: 42,
    side: 'RIGHT',
    startLine: null,
    originalStartLine: null,
    startSide: null,
    createdAt: new Date(now - 86400000).toISOString(),
    updatedAt: new Date(now - 86400000).toISOString(),
    htmlUrl: `https://github.com/example/repo/pull/1#discussion_r${overrides.id}`,
    ...overrides,
  };
}

const mockThread: GitHubReviewThread = {
  id: 12345,
  anchor: { path: 'src/utils/helper.ts', line: 42, side: 'RIGHT' },
  comments: [
    makeReviewComment({
      id: 12345,
      body: 'Could we use a more descriptive variable name here? `x` is too generic for a public API.',
    }),
    makeReviewComment({
      id: 12346,
      body: 'Agreed, maybe `inputValue` or `amount`?\n\n```ts\nexport function calculate(inputValue: number): number {\n```',
      inReplyToId: 12345,
      user: { login: 'contributor', id: 2, avatarUrl: 'https://github.com/contributor.png', htmlUrl: 'https://github.com/contributor' },
      authorAssociation: 'CONTRIBUTOR',
      createdAt: new Date(now - 43200000).toISOString(),
      updatedAt: new Date(now - 43200000).toISOString(),
    }),
  ],
  outdated: false,
  diffHunk: '@@ -40,6 +40,8 @@',
  subjectType: 'line',
};

const singleCommentThread: GitHubReviewThread = {
  id: 67890,
  anchor: { path: 'src/config.ts', line: 10, side: 'LEFT' },
  comments: [
    makeReviewComment({
      id: 67890,
      body: 'This config value should be an environment variable.',
      path: 'src/config.ts',
      line: 10,
      originalLine: 10,
      side: 'LEFT',
      user: { login: 'reviewer', id: 3, avatarUrl: 'https://github.com/reviewer.png', htmlUrl: 'https://github.com/reviewer' },
      createdAt: new Date(now - 172800000).toISOString(),
      updatedAt: new Date(now - 172800000).toISOString(),
    }),
  ],
  outdated: false,
  diffHunk: '@@ -8,6 +8,8 @@',
  subjectType: 'line',
};

const outdatedThread: GitHubReviewThread = {
  ...singleCommentThread,
  id: 99999,
  outdated: true,
  comments: [
    makeReviewComment({
      ...singleCommentThread.comments[0]!,
      id: 99999,
      body: 'This line has been moved since this comment was posted.',
    }),
  ],
};

const wrap = (children: React.ReactNode) => (
  <div {...stylex.props(sceneStyles.desktop)}>{children}</div>
);

const wrapMobile = (children: React.ReactNode) => (
  <div {...stylex.props(sceneStyles.mobile)}>{children}</div>
);

const meta = {
  title: 'SessionComment/GitHubThread',
  component: GitHubCommentThread,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof GitHubCommentThread>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MultipleComments: Story = {
  args: {
    thread: mockThread,
    onReply: (input) => console.log('Reply to GitHub:', input),
    onSendToChat: (ref) => console.log('Send to chat:', ref),
  },
  render: (args) => wrap(<GitHubCommentThread {...args} />),
};

export const SingleComment: Story = {
  args: {
    thread: singleCommentThread,
    onReply: (input) => console.log('Reply to GitHub:', input),
    onSendToChat: (ref) => console.log('Send to chat:', ref),
  },
  render: (args) => wrap(<GitHubCommentThread {...args} />),
};

export const Outdated: Story = {
  args: {
    thread: outdatedThread,
    onReply: (input) => console.log('Reply to GitHub:', input),
    onSendToChat: (ref) => console.log('Send to chat:', ref),
  },
  render: (args) => wrap(<GitHubCommentThread {...args} />),
};

export const ReadOnly: Story = {
  args: {
    thread: mockThread,
  },
  render: (args) => wrap(<GitHubCommentThread {...args} />),
};

export const MobileGitHub: Story = {
  args: {
    thread: mockThread,
    onReply: (input) => console.log('Reply to GitHub:', input),
    onSendToChat: (ref) => console.log('Send to chat:', ref),
  },
  render: (args) => wrapMobile(<GitHubCommentThread {...args} />),
};

import * as stylex from '@stylexjs/stylex';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { SessionCommentDraft } from '@/ui/diff-viewer/session-comment-draft';
import type { CommentAnchor, CommentUser } from '@/ui/diff-viewer/session-comment-types';

const draftFrameStyles = stylex.create({
  desktop: { marginInline: 'auto', maxWidth: '32rem', padding: 'calc(var(--spacing) * 4)' },
  mobile: { marginInline: 'auto', width: '360px', padding: 'calc(var(--spacing) * 3)' },
});

const mockUser: CommentUser = { id: 'u1', name: 'Alice Chen', image: null };

const mockAnchor: CommentAnchor = {
  anchorType: 'diff',
  path: 'src/utils/helper.ts',
  side: 'additions',
  lineNumber: 42,
  lineContent: 'export function calculate(x: number): number {',
};

const wrap = (children: React.ReactNode) => (
  <div {...stylex.props(draftFrameStyles.desktop)}>{children}</div>
);

const wrapMobile = (children: React.ReactNode) => (
  <div {...stylex.props(draftFrameStyles.mobile)}>{children}</div>
);

const meta = {
  title: 'SessionComment/Draft',
  component: SessionCommentDraft,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof SessionCommentDraft>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    anchor: mockAnchor,
    currentUser: mockUser,
    prLinked: true,
    onSubmitToGitHub: (input) => console.log('Submit to GitHub:', input),
    onCancel: () => console.log('Cancel'),
  },
  render: (args) => wrap(<SessionCommentDraft {...args} />),
};

export const GitHubLinked: Story = {
  args: {
    anchor: mockAnchor,
    currentUser: mockUser,
    prLinked: true,
    onSubmitToGitHub: (input) => console.log('Submit to GitHub:', input),
    onCancel: () => console.log('Cancel'),
  },
  render: (args) => wrap(<SessionCommentDraft {...args} />),
};

export const Anonymous: Story = {
  args: {
    anchor: mockAnchor,
    prLinked: true,
    onSubmitToGitHub: (input) => console.log('Submit to GitHub:', input),
    onCancel: () => console.log('Cancel'),
  },
  render: (args) => wrap(<SessionCommentDraft {...args} />),
};

export const MobileDraft: Story = {
  args: {
    anchor: mockAnchor,
    currentUser: mockUser,
    prLinked: true,
    onSubmitToGitHub: (input) => console.log('Submit to GitHub:', input),
    onCancel: () => console.log('Cancel'),
  },
  render: (args) => wrapMobile(<SessionCommentDraft {...args} />),
};

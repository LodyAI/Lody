import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { SessionCommentDraft } from '@/ui/diff-viewer/session-comment-draft';
import type { CommentAnchor, CommentUser } from '@/ui/diff-viewer/session-comment-types';

const mockUser: CommentUser = { id: 'u1', name: 'Alice Chen', image: null };

const mockAnchor: CommentAnchor = {
  anchorType: 'diff',
  path: 'src/utils/helper.ts',
  side: 'additions',
  lineNumber: 42,
  lineContent: 'export function calculate(x: number): number {',
};

const wrap = (children: React.ReactNode) => (
  <div className="mx-auto max-w-lg space-y-4 p-4">{children}</div>
);

const wrapMobile = (children: React.ReactNode) => (
  <div className="mx-auto w-[360px] space-y-4 p-3">{children}</div>
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

export const LocalChat: Story = {
  args: {
    anchor: mockAnchor,
    currentUser: mockUser,
    onSendToChat: (reference) => console.log('Send to chat:', reference),
    onCancel: () => console.log('Cancel'),
  },
  render: (args) => wrap(<SessionCommentDraft {...args} />),
};

export const GitHubLinkedWithChat: Story = {
  args: {
    anchor: mockAnchor,
    currentUser: mockUser,
    prLinked: true,
    onSubmitToGitHub: (input) => console.log('Submit to GitHub:', input),
    onSendToChat: (reference) => console.log('Send to chat:', reference),
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

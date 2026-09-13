import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import {
  SessionShareManager,
  type SessionShareManagerProps,
} from '@/components/sharing/session-share-manager';
import { SessionShareDialogFrame } from '@/components/sharing/session-share-dialog';

const entry = {
  shareId: 'story-share',
  rootSessionId: 'main',
  publisherUserId: 'publisher',
  title: 'Designing static sharing',
  status: 'active' as const,
  revision: 1,
  credentialVersion: 1,
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_000_000,
  sourceIds: [
    { sourceId: 'main', conversationId: 'c1' },
    { sourceId: 'child', conversationId: 'c2' },
  ],
  selectedSourceIds: ['main', 'child'],
  canManage: true,
  canRevoke: true,
};
/** Obviously synthetic: never screenshot a real bearer credential. */
const storyLink = `https://lody.ai/s/demo-share#access=v1.${'demo'.repeat(16)}`;
const noop = async () => {};

const meta = {
  title: 'Sharing/SessionShareManager',
  component: SessionShareManager,
  parameters: { layout: 'fullscreen' },
  render: function Story(args) {
    const [selected, setSelected] = useState(args.selected);
    const [wide, setWide] = useState(false);
    return (
      <SessionShareDialogFrame title="Designing static sharing" wide={wide}>
        <SessionShareManager
          {...args}
          selected={selected}
          onSelect={setSelected}
          onPreviewOpenChange={setWide}
        />
      </SessionShareDialogFrame>
    );
  },
  args: {
    sessionId: 'main',
    entry: null,
    selected: ['main'],
    candidates: [
      { sessionId: 'main', title: 'Designing static sharing' },
      { sessionId: 'child', title: 'Deployment design' },
      { sessionId: 'child-2', title: 'Reader layout notes' },
    ],
    pending: null,
    phase: 'idle',
    progress: 0,
    result: null,
    shareLink: null,
    canCapture: true,
    hasSecret: false,
    busy: false,
    conflict: false,
    error: null,
    notice: null,
    onSelect: () => {},
    onPrepare: noop,
    onPublish: noop,
    onDiscard: () => {},
    onCopy: noop,
    onReset: noop,
    onRevoke: noop,
    onClose: () => {},
  },
} satisfies Meta<SessionShareManagerProps>;
export default meta;
type Story = StoryObj<typeof meta>;

/** First share: one sentence, one choice, two buttons. */
export const NewShare: Story = {};

export const NewShareWithoutSubConversations: Story = {
  args: { candidates: [{ sessionId: 'main', title: 'Designing static sharing' }] },
};

export const Capturing: Story = { args: { busy: true, phase: 'capturing' } };

export const Uploading: Story = { args: { busy: true, phase: 'uploading', progress: 62 } };

export const Publishing: Story = { args: { busy: true, phase: 'publishing', progress: 100 } };

export const Published: Story = {
  args: { entry, hasSecret: true, shareLink: storyLink, result: { url: storyLink, copied: true } },
};

/** A blocked clipboard must never be reported as a successful copy. */
export const PublishedCopyBlocked: Story = {
  args: { entry, hasSecret: true, shareLink: storyLink, result: { url: storyLink, copied: false } },
};

export const AlreadyShared: Story = {
  args: { entry, selected: ['main', 'child'], hasSecret: true, shareLink: storyLink },
};

export const PublishFailed: Story = {
  args: {
    entry,
    selected: ['main', 'child'],
    hasSecret: true,
    shareLink: storyLink,
    error: 'Could not update sharing. Check the current settings and try again.',
    pending: { manifest: { conversations: [], attachments: [] } } as never,
  },
};

export const Conflict: Story = {
  args: {
    entry,
    selected: ['main', 'child'],
    hasSecret: true,
    shareLink: storyLink,
    conflict: true,
    pending: { manifest: { conversations: [], attachments: [] } } as never,
  },
};

export const UnfinishedDraft: Story = {
  args: { entry: { ...entry, status: 'draft' } },
};

export const MissingCredential: Story = {
  args: { entry, selected: ['main', 'child'], hasSecret: false },
};

export const Administrator: Story = {
  args: { entry: { ...entry, canManage: false }, selected: ['main', 'child'] },
};

export const SourceDeleted: Story = {
  args: {
    entry,
    selected: ['main', 'child'],
    hasSecret: true,
    shareLink: storyLink,
    canCapture: false,
  },
};

export const Revoked: Story = {
  args: { entry: { ...entry, status: 'revoked', canManage: false, canRevoke: false } },
};

export const Loading: Story = { args: { entry: undefined } };

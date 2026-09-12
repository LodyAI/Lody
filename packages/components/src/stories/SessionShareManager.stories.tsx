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
const meta = {
  title: 'Sharing/SessionShareManager',
  component: SessionShareManager,
  parameters: { layout: 'fullscreen' },
  render: function Story(args) {
    const [selected, setSelected] = useState(args.selected);
    return (
      <SessionShareDialogFrame title="Designing static sharing">
        <SessionShareManager {...args} selected={selected} onSelect={setSelected} />
      </SessionShareDialogFrame>
    );
  },
  args: {
    sessionId: 'main',
    entry,
    selected: ['main', 'child'],
    candidates: [
      { sessionId: 'main', title: 'Designing static sharing' },
      { sessionId: 'child', title: 'Deployment design' },
    ],
    pending: null,
    progress: 0,
    canCapture: true,
    hasSecret: true,
    busy: false,
    conflict: false,
    error: null,
    notice: null,
    onSelect: () => {},
    onPrepare: async () => {},
    onConfirm: async () => {},
    onDiscard: () => {},
    onReset: async () => {},
    onCopy: async () => {},
    onRevoke: async () => {},
  },
} satisfies Meta<SessionShareManagerProps>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Active: Story = {};
export const NewLink: Story = { args: { entry: null, selected: ['main'], hasSecret: false } };
export const MissingSecret: Story = { args: { hasSecret: false } };
export const Administrator: Story = {
  args: { entry: { ...entry, canManage: false }, hasSecret: false },
};
export const SourceDeleted: Story = { args: { canCapture: false } };
export const Publishing: Story = { args: { busy: true, progress: 45 } };
export const Failed: Story = {
  args: { error: 'Could not publish. The current deployment is unchanged.' },
};
export const Revoked: Story = {
  args: {
    entry: { ...entry, status: 'revoked', canManage: false, canRevoke: false },
    hasSecret: false,
  },
};

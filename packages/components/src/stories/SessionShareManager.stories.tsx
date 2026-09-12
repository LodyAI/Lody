import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import {
  SessionShareManager,
  type SessionShareManagerProps,
} from '@/components/sharing/session-share-manager';
import { SessionShareDialogFrame } from '@/components/sharing/session-share-dialog';

const now = 1_800_000_000_000;
const entry = {
  title: 'Designing conversation sharing',
  shareId: 'story-share',
  rootSessionId: 'main',
  authorUserId: 'author',
  status: 'active' as const,
  scopeVersion: 1,
  credentialVersion: 1,
  sessionIds: ['main', 'child'],
  readableSessionIds: ['main', 'child'],
  validUntil: now + 60_000,
  canManage: true,
  canRevoke: true,
};
const candidates = [
  { sessionId: 'main', title: 'Designing conversation sharing' },
  { sessionId: 'child', title: 'Streaming and attachment behavior' },
  { sessionId: 'next', title: 'Deployment notes' },
  { sessionId: 'local', title: 'Local experiment' },
];
const state = {
  root: entry,
  sources: [
    entry,
    {
      ...entry,
      title: 'Deployment notes',
      shareId: 'other-share',
      rootSessionId: 'next',
      sessionIds: ['next', 'main'],
      readableSessionIds: ['next', 'main'],
    },
  ],
  candidates: candidates.map((candidate) => ({
    ...candidate,
    available: candidate.sessionId !== 'local',
    validUntil: now + 60_000,
  })),
};

const meta = {
  title: 'Sharing/SessionShareManager',
  component: SessionShareManager,
  parameters: { layout: 'fullscreen' },
  render: function ShareManagerStory({ frameTitle, ...args }) {
    const [selected, setSelected] = useState(args.selected);
    return (
      <SessionShareDialogFrame title={frameTitle ?? 'Designing conversation sharing'}>
        <SessionShareManager {...args} selected={selected} onSelect={setSelected} />
      </SessionShareDialogFrame>
    );
  },
  args: {
    sessionId: 'main',
    state,
    candidates,
    selected: ['main', 'child'],
    now,
    copyableShareIds: ['story-share'],
    busy: false,
    conflict: false,
    error: null,
    notice: null,
    onSelect: () => {},
    onReload: () => {},
    onCreate: () => {},
    onSave: () => {},
    onReset: () => {},
    onCopy: () => {},
    onRevoke: () => {},
  },
} satisfies Meta<SessionShareManagerProps & { frameTitle?: string }>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Active: Story = {};
export const NewLink: Story = {
  args: { state: { ...state, root: null, sources: [] }, selected: ['main'] },
};
export const MissingSecret: Story = { args: { copyableShareIds: [] } };
export const Administrator: Story = {
  args: { state: { ...state, root: { ...entry, canManage: false } }, copyableShareIds: [] },
};
export const Conflict: Story = { args: { conflict: true } };
export const SourceUnavailable: Story = {
  args: {
    state: {
      root: null,
      sources: [],
      candidates: state.candidates.map((candidate) => ({
        ...candidate,
        available: false,
        validUntil: null,
      })),
    },
    selected: ['main'],
  },
};
/** A title that cannot fit, alongside a result message. */
export const LongTitleAndNotice: Story = {
  args: {
    frameTitle:
      'Reworking the conversation sharing dialog so that long session titles, narrow phones and the on-screen keyboard all stay usable',
    notice: 'Share link copied.',
  },
};
/** Nothing to decide: no related conversations, so the switch is not rendered. */
export const NoSubConversations: Story = {
  args: {
    state: {
      ...state,
      root: { ...entry, sessionIds: ['main'], readableSessionIds: ['main'] },
      sources: [],
      candidates: [state.candidates[0]!],
    },
    candidates: [candidates[0]!],
    selected: ['main'],
  },
};
/** Every related conversation is still syncing, so the switch cannot be turned on. */
export const NoReadySubConversations: Story = {
  args: {
    state: {
      ...state,
      root: null,
      sources: [],
      candidates: state.candidates.map((candidate) => ({
        ...candidate,
        available: candidate.sessionId === 'main',
        validUntil: candidate.sessionId === 'main' ? now + 60_000 : null,
      })),
    },
    selected: ['main'],
  },
};
export const Failure: Story = {
  args: { error: 'Could not update sharing. Check the current settings and try again.' },
};
export const Loading: Story = { args: { state: undefined } };

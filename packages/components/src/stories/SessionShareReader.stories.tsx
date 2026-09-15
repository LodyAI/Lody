import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import type { SessionHistory } from '@lody/shared';
import type { SharePackageManifest } from '@lody/shared/session-sharing';
import { SessionShareSurface } from '@/components/sharing/session-share-page';

/**
 * The anonymous reader's shell, driven by props only — no share client, no
 * network and no workspace runtime. This is where the tree's selected row, the
 * sidebar toggle's slide and the pane's short action foot are reviewed; none of
 * them can be seen in jsdom.
 */
const conversation = (
  id: string,
  title: string,
  rest: Partial<SharePackageManifest['conversations'][number]> = {}
) => ({ id, title, historyObjectId: `o-${id}`, ...rest });

const manifest: SharePackageManifest = {
  formatVersion: 1,
  historyFormatVersion: 1,
  capturedAt: '2026-09-12T00:00:00.000Z',
  rootConversationId: 'c1',
  conversations: [
    conversation('c1', 'Designing static sharing'),
    conversation('c2', 'Deployment design', { parentConversationId: 'c1' }),
    conversation('c3', 'Reader layout notes', { parentConversationId: 'c1' }),
    conversation('c4', 'Garbage collection', { openedByConversationId: 'c2' }),
    conversation('c5', 'Quota accounting', { openedByConversationId: 'c2' }),
    conversation('c6', 'Rollout checklist'),
  ],
  attachments: [],
  objects: [],
};

const history: SessionHistory[] = [
  {
    id: 'u1',
    role: 'user',
    timestamp: '2026-09-12T00:00:00Z',
    finished: true,
    items: [{ type: 'text', text: 'How should the reader pin a deployment?' }],
    fileDiff: [],
  },
  {
    id: 'a1',
    role: 'assistant',
    timestamp: '2026-09-12T00:00:01Z',
    finished: true,
    items: [
      {
        type: 'text',
        text: 'Resolve the current deployment once, then read every object from it. A retired deployment keeps a bounded grace interval, so no read ever mixes versions.',
      },
    ],
    fileDiff: [],
  },
] as unknown as SessionHistory[];

const meta = {
  title: 'Sharing/SessionShareReader',
  component: SessionShareSurface,
  parameters: { layout: 'fullscreen' },
  render: function Story(args) {
    const [sessionId, setSessionId] = useState(args.sessionId);
    return <SessionShareSurface {...args} sessionId={sessionId} onSelect={setSessionId} />;
  },
  args: {
    manifest,
    sessionId: 'c1',
    status: 'ready',
    snapshot: { status: 'ready', history },
    onSelect: () => {},
    attachmentAccess: { read: async () => new Blob() },
    createAgentPrompt: async () => 'Read this shared conversation: https://example.test/agent',
  },
} satisfies Meta<typeof SessionShareSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Several independent conversations, so the tree and its selection are live. */
export const WithConversationTree: Story = {};

/** One conversation: no tree, no toggle, and the pane names itself with a solo tab. */
export const SingleConversation: Story = {
  args: {
    manifest: {
      ...manifest,
      conversations: [conversation('c1', 'Designing static sharing')],
    },
  },
};

/** A visitor the host could not identify still gets both export actions. */
export const WithoutAgentAccess: Story = {
  args: { createAgentPrompt: undefined },
};

/** The transcript has not arrived yet, so neither export is offered. */
export const Loading: Story = {
  args: { snapshot: { status: 'loading', history: [] } },
};

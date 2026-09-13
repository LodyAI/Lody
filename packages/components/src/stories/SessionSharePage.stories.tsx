import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Provider, createStore } from 'jotai';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type { SessionHistory } from '@lody/shared';
import { SessionShareSurface } from '@/components/sharing/session-share-page';
import { authTokenAtom } from '@/atoms/runtime';
import { SessionShareReadError } from '@/components/sharing/session-share-error-boundary';

const platform = createLocalPlatformProvider({
  session: createStaticStore({ status: 'unauthenticated' }),
  workspaces: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
});
const meta = {
  title: 'Pages/SessionSharePage',
  component: SessionShareSurface,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => {
      const [store] = useState(() => {
        const value = createStore();
        value.set(authTokenAtom, null);
        return value;
      });
      return (
        <Provider store={store}>
          <PlatformContext.Provider value={platform}>
            <Story />
          </PlatformContext.Provider>
        </Provider>
      );
    },
  ],
  args: {
    manifest: {
      formatVersion: 1,
      historyFormatVersion: 1,
      capturedAt: '2026-09-12T00:00:00.000Z',
      rootConversationId: 'main',
      conversations: [
        { id: 'main', title: 'Designing a shared conversation', historyObjectId: 'h1' },
        {
          id: 'notes',
          title: 'Implementation notes',
          historyObjectId: 'h2',
          parentConversationId: 'main',
        },
        {
          id: 'review',
          title: 'Independent review',
          historyObjectId: 'h3',
          openedByConversationId: 'notes',
        },
        {
          id: 'side',
          title: 'Side discussion',
          historyObjectId: 'h4',
          parentConversationId: 'main',
          childSessionPlacement: 'side-panel',
        },
      ],
      attachments: [],
      objects: ['h1', 'h2', 'h3', 'h4'].map((id) => ({
        id,
        mediaType: 'application/json',
        sizeBytes: 2,
        sha256: '0'.repeat(64),
      })),
    },
    sessionId: 'main',
    status: 'ready',
    onSelect: () => {},
    attachmentAccess: {
      read: async () => {
        throw new Error('Fixture attachment expired');
      },
    },
    snapshot: {
      status: 'ready',
      history: [
        {
          id: 'question',
          role: 'user',
          timestamp: '2026-09-07T08:00:00Z',
          finished: true,
          fileDiff: [],
          items: [{ type: 'text', text: 'How should we share a conversation with the team?' }],
        },
        {
          id: 'answer',
          role: 'assistant',
          timestamp: '2026-09-07T08:00:05Z',
          finished: true,
          fileDiff: [],
          items: [
            {
              type: 'text',
              text: 'Choose the conversations you want to include. Anyone with the complete link can read this published copy. New source messages stay private until you publish an update.\n\nThe author can update the deployment or revoke the link from sharing management.\n\n```ts\nconst selected = [mainConversation, implementationNotes];\n```',
            },
          ],
        },
      ] satisfies SessionHistory[],
    },
  },
} satisfies Meta<typeof SessionShareSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Published: Story = {};
export const SignedInViewer: Story = {
  args: { viewer: { status: 'signed-in', name: 'Ada Lovelace' } },
};
/** A side-panel child is an ordinary Tab here: the reader has no right pane. */
export const SidePanelChildAsTab: Story = { args: { sessionId: 'side' } };
export const Loading: Story = {
  args: {
    manifest: null,
    sessionId: null,
    status: 'loading',
    snapshot: { status: 'loading', history: [] },
  },
};
export const Unavailable: Story = { args: { manifest: null, status: 'unavailable' } };
export const Empty: Story = { args: { snapshot: { status: 'ready', history: [] } } };
export const UnsupportedContent: Story = { render: () => <SessionShareReadError /> };
export const AttachmentStates: Story = {
  args: {
    snapshot: {
      status: 'ready',
      history: [
        {
          id: 'attachments',
          role: 'assistant',
          timestamp: '2026-09-07T08:00:05Z',
          finished: true,
          fileDiff: [],
          items: [
            {
              type: 'file',
              fileId: 'expired',
              fileName: 'expired-notes.txt',
              mimeType: 'text/plain',
              sizeBytes: 1024,
              sha256: '0'.repeat(64),
              textPreview: true,
              transport: 'r2',
              uploadedAt: 0,
            },
            {
              type: 'file',
              fileId: 'local',
              fileName: 'local-notes.txt',
              mimeType: 'text/plain',
              sizeBytes: 1024,
              sha256: '0'.repeat(64),
              textPreview: true,
              transport: 'local',
              machineId: 'story-machine',
              uploadedAt: 0,
            },
          ],
        },
      ] satisfies SessionHistory[],
    },
  },
};

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
      shareId: 'story',
      rootSessionId: 'main',
      workspaceName: 'Lody · Product',
      scopeVersion: 1,
      credentialVersion: 1,
      validUntil: 2_000_000_000_000,
      targets: [
        { sessionId: 'main', title: 'Designing a shared conversation' },
        { sessionId: 'notes', title: 'Implementation notes' },
      ],
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
      status: 'live',
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
              text: 'Choose the conversations you want to include. Anyone with the complete link can read their history and follow new messages.\n\nThe author can update the selection or revoke the link from the conversation menu.\n\n```ts\nconst selected = [mainConversation, implementationNotes];\n```',
            },
          ],
        },
      ] satisfies SessionHistory[],
    },
  },
} satisfies Meta<typeof SessionShareSurface>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Live: Story = {};
export const Loading: Story = {
  args: {
    manifest: null,
    sessionId: null,
    status: 'loading',
    snapshot: { status: 'loading', history: [] },
  },
};
export const Paused: Story = { args: { status: 'paused' } };
export const Unavailable: Story = { args: { manifest: null, status: 'unavailable' } };
export const Empty: Story = { args: { snapshot: { status: 'live', history: [] } } };
export const UnsupportedContent: Story = { render: () => <SessionShareReadError /> };
export const AttachmentStates: Story = {
  args: {
    snapshot: {
      status: 'live',
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

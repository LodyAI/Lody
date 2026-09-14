import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import type { SessionHistory, SessionId, WorkspaceId } from '@lody/shared';

import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { runtimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { SessionPendingMessages } from '@/components/chat/session-pending-messages';
import type { SessionSendRecord } from '@/lib/session-send-journal';

const sessionId = 'attachment-draft-story' as SessionId;
const workspaceId = 'attachment-draft-workspace' as WorkspaceId;

const textEntry = (id: string, text: string): SessionHistory =>
  ({
    id,
    role: 'user',
    userId: 'storybook-user',
    timestamp: '2026-09-15T00:00:00.000Z',
    status: 'pending',
    read: false,
    finished: true,
    items: [{ type: 'text', text }],
    fileDiff: [],
    inputConfig: { inputBlocks: [{ type: 'text', text }], cliType: 'builtin', agentType: 'codex' },
  }) as SessionHistory;

const record = (overrides: Partial<SessionSendRecord>): SessionSendRecord => ({
  version: 2,
  id: 'pending-turn',
  sessionId,
  accountId: 'storybook-user',
  workspaceId,
  sourceReplica: 'storybook-replica',
  sequence: 1,
  entry: textEntry('pending-turn', 'Review these attachments before committing the recovery flow.'),
  delivery: { kind: 'dispatch' },
  stage: 'saved',
  ...overrides,
});

function StoryShell({ records }: { records: readonly SessionSendRecord[] }) {
  const store = createStore();
  const journal = {
    subscribe: () => () => {},
    getSnapshot: () => records,
    retry: async () => {},
    cancel: async () => {},
  };
  store.set(currentWorkspaceIdAtom, workspaceId);
  store.set(currentWorkspaceSlugAtom, 'attachment-draft-story');
  store.set(runtimeAtom, {
    workspaceId,
    workspaceSlug: 'attachment-draft-story',
    sendJournal: journal,
  } as unknown as WorkspaceRuntime);
  return (
    <Provider store={store}>
      <div className="w-[480px] max-w-full rounded-xl border bg-background shadow-xs">
        <SessionPendingMessages sessionId={sessionId} />
        <div className="border-t px-4 py-3 text-sm text-muted-foreground">
          Composer stays available here.
        </div>
      </div>
    </Provider>
  );
}

const meta = {
  title: 'Chat/SessionPendingMessages',
  component: StoryShell,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Preparing: Story = {
  args: {
    records: [
      record({
        attachments: [
          {
            id: 'design-image',
            kind: 'image',
            source: new Blob(['image']),
            name: 'design.png',
            mimeType: 'image/png',
            lastModified: 0,
            progress: 64,
          },
          {
            id: 'diagnostic-log',
            kind: 'file',
            source: new Blob(['log']),
            name: 'diagnostic.log',
            mimeType: 'text/plain',
            lastModified: 0,
            progress: 0,
          },
        ],
      }),
    ],
  },
};

export const RetryOnlyTheFailedAttachment: Story = {
  args: {
    records: [
      record({
        error: 'Attachment preparation failed',
        attachments: [
          {
            id: 'design-image',
            kind: 'image',
            source: new Blob(['image']),
            name: 'design.png',
            mimeType: 'image/png',
            lastModified: 0,
            ready: {
              type: 'image',
              imageId: 'uploaded-image',
              mimeType: 'image/png',
              sizeBytes: 2_048,
            },
            progress: 100,
          },
          {
            id: 'archive',
            kind: 'file',
            source: new Blob(['archive']),
            name: 'evidence.zip',
            mimeType: 'application/zip',
            lastModified: 0,
            error: 'Network error while preparing the file',
            progress: 0,
          },
        ],
      }),
    ],
  },
};

export const ConfirmingTheOriginalSend: Story = {
  args: {
    records: [
      record({
        stage: 'prepared',
        attachments: [
          {
            id: 'design-image',
            kind: 'image',
            source: new Blob(['image']),
            name: 'design.png',
            mimeType: 'image/png',
            lastModified: 0,
            ready: {
              type: 'image',
              imageId: 'uploaded-image',
              mimeType: 'image/png',
              sizeBytes: 2_048,
            },
            progress: 100,
          },
        ],
      }),
    ],
  },
};

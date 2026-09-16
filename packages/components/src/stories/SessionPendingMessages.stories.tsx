import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import type { SessionHistory, SessionId, WorkspaceId } from '@lody/shared';

import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { runtimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { SessionPendingMessages } from '@/components/chat/session-pending-messages';
import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import type { SessionSendRecord } from '@/lib/session-send-journal';

const sessionId = 'attachment-draft-story' as SessionId;
const workspaceId = 'attachment-draft-workspace' as WorkspaceId;
const imageSource = new Blob(
  [
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">',
      '<rect width="100%" height="100%" fill="#cbd5e1"/>',
      '<path d="M0 230 90 140l60 50 55-70 115 110v90H0Z" fill="#64748b"/>',
      '</svg>',
    ].join(''),
  ],
  { type: 'image/svg+xml' }
);

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

const readyImage: SessionAttachmentDraft = {
  id: 'design-image',
  kind: 'image',
  source: imageSource,
  name: 'design.png',
  mimeType: 'image/png',
  lastModified: 0,
  ready: { type: 'image', imageId: 'uploaded-image', mimeType: 'image/png', sizeBytes: 2_048 },
  progress: 100,
};

function StoryShell({
  records,
  width = 720,
}: {
  records: readonly SessionSendRecord[];
  width?: number;
}) {
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
      <div className="max-w-full rounded-xl border bg-background pt-4 shadow-xs" style={{ width }}>
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

/** Attachments still transferring: every card shows its own progress. */
export const Uploading: Story = {
  args: {
    records: [
      record({
        attachments: [
          {
            id: 'design-image',
            kind: 'image',
            source: imageSource,
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
            progress: 12,
          },
        ],
      }),
    ],
  },
};

/**
 * One attachment failed and the finished one is retained. The message level
 * says only "Not sent"; the reason lives on the failed card alone.
 */
export const FailedRetry: Story = {
  args: {
    records: [
      record({
        error: 'Attachment preparation failed',
        attachments: [
          readyImage,
          {
            id: 'archive',
            kind: 'file',
            source: new Blob(['archive']),
            name: 'incident-2026-09-15-capture-evidence-bundle-final.zip',
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

/** The same failure on a phone-width column: cards and actions still fit. */
export const FailedRetryNarrow: Story = {
  args: { ...FailedRetry.args, width: 380 } as Story['args'],
};

/** A whole-message failure with no per-attachment reason keeps one line of detail. */
export const FailedWithoutAttachmentReason: Story = {
  args: {
    records: [
      record({
        error: 'The workspace stopped responding before the message was submitted',
        attachments: [readyImage],
      }),
    ],
  },
};

export const ConfirmingTheOriginalSend: Story = {
  args: {
    records: [record({ stage: 'prepared', attachments: [readyImage] })],
  },
};

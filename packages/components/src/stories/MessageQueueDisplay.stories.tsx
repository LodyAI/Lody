import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import type { MessageQueueItem, SessionHistory, SessionId, WorkspaceId } from '@lody/shared';
import { runtimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { MessageQueueDisplay } from '@/components/sessions/message-queue';
import type { PendingSessionSend } from '@/lib/session-pending-sends';

const TASKS = [
  'Refactor the message queue to support priority ordering and cancellation tokens',
  'Add tests for the Loro mirror schema migrations around session history',
  'Investigate why the ACP transport occasionally drops the final chunk',
  'Wire up the new agent config options into the session chat input area',
  'Polish the chat landing page empty state for mobile',
  'Fix race condition when interrupting a running agent and re-sending',
  'Add i18n keys for queued message tooltips',
  'Document the backward-compatibility shim for legacy queue items',
  'Teach the CLI to resume interrupted runs via replay prompt builder',
  'Reduce re-renders in the session sidebar when queue length changes',
];

function makeItems(count: number): MessageQueueItem[] {
  return Array.from({ length: count }, (_, i) => ({
    $cid: `cid-${i}`,
    task: TASKS[i % TASKS.length] ?? `Task #${i + 1}`,
    project: undefined,
    userId: 'user-1',
    userTurnId: `turn-${i}`,
    timestamp: new Date(Date.now() - i * 1000).toISOString(),
    acpSessionConfig: {
      prompt: TASKS[i % TASKS.length] ?? `Task #${i + 1}`,
      cliType: 'claude-code',
      agentType: 'claude-code',
    },
  })) as unknown as MessageQueueItem[];
}

const meta = {
  title: 'Sessions/MessageQueueDisplay',
  component: MessageQueueDisplay,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story, ctx) => {
      const width = (ctx.parameters as { containerWidth?: string }).containerWidth ?? 'w-[420px]';
      // Mirror production: the sheet is inset over a faux composer and sits on it.
      return (
        <div className="bg-background p-6">
          <div className={`${width}`}>
            <div className="mx-3">
              <Story />
            </div>
            <div className="rounded-xl border border-foreground/[0.10] bg-[hsl(var(--composer))] px-3 py-3 text-xs text-muted-foreground/60">
              Composer placeholder
            </div>
          </div>
        </div>
      );
    },
  ],
} satisfies Meta<typeof MessageQueueDisplay>;

export default meta;
type Story = StoryObj<typeof meta>;

const commonArgs = {
  sessionId: 'session-story' as SessionId,
  onRemove: () => {},
  onReorder: () => {},
  onEditStart: () => {},
  onEditCancel: () => {},
  onEditSave: () => {},
  onSteer: () => {},
  showSteerAction: true,
};

export const FewItems: Story = {
  args: {
    ...commonArgs,
    items: makeItems(2),
  },
};

export const ManyItems: Story = {
  args: {
    ...commonArgs,
    items: makeItems(10),
  },
};

export const OverflowScroll: Story = {
  args: {
    ...commonArgs,
    items: makeItems(20),
  },
};

export const MobileWidth: Story = {
  args: {
    ...commonArgs,
    items: makeItems(3),
  },
  parameters: {
    containerWidth: 'w-[320px]',
  },
};

export const EditingFirstItem: Story = {
  args: {
    ...commonArgs,
    items: makeItems(3).map((item, index) => ({
      ...item,
      isEditing: index === 0,
    })),
  },
};

export const NativeSteerAllRows: Story = {
  args: {
    ...commonArgs,
    items: makeItems(3),
    nativeSteerAvailable: true,
  },
};

export const SingleItem: Story = {
  args: {
    ...commonArgs,
    items: makeItems(1),
  },
};

const localImage = new Blob(
  [
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="100%" height="100%" fill="#cbd5e1"/><path d="M0 46 18 28l12 10 11-14 23 22v18H0Z" fill="#64748b"/></svg>',
  ],
  { type: 'image/svg+xml' }
);

function localRecord(
  id: string,
  task: string,
  overrides: Partial<PendingSessionSend>
): PendingSessionSend {
  return {
    id,
    sessionId: commonArgs.sessionId,
    workspaceId: 'workspace-story',
    sequence: 1,
    entry: { id, role: 'user', items: [{ type: 'text', text: task }] } as SessionHistory,
    delivery: { kind: 'queue' },
    queue: { task },
    attachments: [],
    ...overrides,
  };
}

function withLocalQueueRows(records: readonly PendingSessionSend[]) {
  const store = createStore();
  store.set(currentWorkspaceIdAtom, 'workspace-story' as WorkspaceId);
  store.set(currentWorkspaceSlugAtom, 'workspace-story');
  store.set(runtimeAtom, {
    workspaceId: 'workspace-story',
    workspaceSlug: 'workspace-story',
    pendingSends: {
      subscribe: () => () => {},
      getSnapshot: () => records,
      retry: () => {},
      cancel: async () => {},
    },
  } as unknown as WorkspaceRuntime);
  return (Story: () => ReactNode) => (
    <Provider store={store}>
      <Story />
    </Provider>
  );
}

/**
 * Sent to a working conversation while its attachments upload: the messages sit
 * below the real queue as local rows, muted and without drag, edit or steer,
 * until their queue items sync in and take the same position.
 */
export const LocalUploadRows: Story = {
  args: {
    ...commonArgs,
    items: makeItems(1),
  },
  decorators: [
    withLocalQueueRows([
      localRecord('local-uploading', 'Compare this screenshot with the new layout', {
        attachments: [
          {
            id: 'shot',
            kind: 'image',
            source: localImage,
            name: 'layout.svg',
            mimeType: 'image/svg+xml',
            lastModified: 0,
            progress: 42,
          },
        ],
      }),
      localRecord('local-failed', 'Summarize the attached crash log', {
        error: 'offline',
        attachments: [
          {
            id: 'log',
            kind: 'file',
            source: new Blob(['log']),
            name: 'crash.log',
            mimeType: 'text/plain',
            lastModified: 0,
            error: 'offline',
          },
        ],
      }),
    ]),
  ],
};

/** A local row alone: the sheet appears for it before any queue item exists. */
export const LocalUploadOnly: Story = {
  args: {
    ...commonArgs,
    items: [],
  },
  decorators: [
    withLocalQueueRows([
      localRecord('local-only', 'Use these two mockups for the settings page', {
        attachments: [
          {
            id: 'a',
            kind: 'image',
            source: localImage,
            name: 'a.svg',
            mimeType: 'image/svg+xml',
            lastModified: 0,
            progress: 70,
          },
          {
            id: 'b',
            kind: 'image',
            source: localImage,
            name: 'b.svg',
            mimeType: 'image/svg+xml',
            lastModified: 0,
            progress: 10,
          },
        ],
      }),
    ]),
  ],
};

export const InactiveSession: Story = {
  args: {
    ...commonArgs,
    items: makeItems(3),
    showSteerAction: false,
  },
};

import { useLayoutEffect, useState, type CSSProperties, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, within } from 'storybook/test';
import { Provider, createStore } from 'jotai';
import type { MessageQueueItem, SessionHistory, SessionId, WorkspaceId } from '@lody/shared';
import { runtimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import {
  MessageQueueDisplay,
  type QueuedRunConfigSummary,
} from '@/components/sessions/message-queue';
import { ForceMobileLayoutProvider } from '@/hooks/use-mobile';
import { UserAvatar } from '@/components/user-avatar';
import type { PendingSessionSend } from '@/lib/session-pending-sends';
const storyCallerStyles = stylex.create({
  sheetOverride: {
    overflow: 'visible',
    borderTopLeftRadius: 'var(--radius-xl)',
    borderTopRightRadius: 'var(--radius-xl)',
    borderBottomRightRadius: 'var(--radius-md)',
    borderBottomLeftRadius: 'var(--radius-md)',
    borderStyle: 'solid',
    borderWidth: '2px',
    borderColor: 'var(--color-red-500)',
    backgroundColor: 'var(--color-blue-100)',
    boxShadow:
      '0 0 #0000, 0 0 #0000, 0 0 #0000,  0 0 0 calc(2px + 0px) var(--color-green-600), 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  },
});

const storyLayoutStyles = stylex.create({
  canvas: {
    'border-radius': 'var(--radius-xl)',
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: 'color-mix(in oklab, hsl(var(--foreground) / 1) 10%, transparent)',
    backgroundColor: 'hsl(var(--composer))',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 3)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 60%, transparent)',
  },
});

const storyLayout = stylex.create({
  canvas: {
    backgroundColor: 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 6)',
  },
  section: {
    'margin-inline': 'calc(var(--spacing) * 3)',
  },
});

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
      const width = (ctx.parameters as { containerWidth?: string | number }).containerWidth ?? 420;
      // Mirror production: the sheet is inset over a faux composer and sits on it.
      return (
        <div {...stylex.props(storyLayout.canvas)}>
          <div style={{ width }}>
            <div {...stylex.props(storyLayout.section)}>
              <Story />
            </div>
            <div {...stylex.props(storyLayoutStyles.canvas)}>Composer placeholder</div>
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
  onSteer: () => {},
  showSteerAction: true,
};

export const FewItems: Story = {
  args: {
    ...commonArgs,
    items: makeItems(2),
  },
};

export const StoppedQueue: Story = {
  args: {
    ...commonArgs,
    items: makeItems(5).map((item) => ({ ...item, paused: true })),
    sendWhileIdle: true,
  },
  parameters: { containerWidth: 'w-[600px]' },
};

export const StoppedQueueMobileWidth: Story = {
  args: {
    ...StoppedQueue.args,
    roomy: true,
  },
  parameters: { containerWidth: 'w-[320px]' },
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
    containerWidth: 320,
  },
};

/** A local wall-clock time `days` from today, so the labels read the same on any day. */
function at(days: number, hour: number): number {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const scheduledItems = [
  {
    scheduleId: 'scheduled-tomorrow',
    content: 'Review these files tomorrow morning',
    at: at(1, 9),
    timeZone,
    state: 'pending' as const,
  },
  {
    scheduleId: 'scheduled-week',
    content: 'Send the weekly summary to the team channel with the release notes',
    at: at(3, 17),
    timeZone,
    state: 'pending' as const,
  },
  {
    scheduleId: 'scheduled-failed',
    content: 'Re-run the nightly benchmark',
    at: at(0, 23),
    timeZone,
    state: 'failed' as const,
  },
];

const scheduledArgs = {
  onOpenScheduled: () => {},
  onEditScheduledTime: () => {},
  onCancelScheduled: () => {},
};

/** Production mobile: the touch layout, roomy rows and inline footers. */
const mobileDecorator: NonNullable<Story['decorators']> = [
  (Story) => (
    <ForceMobileLayoutProvider force>
      <Story />
    </ForceMobileLayoutProvider>
  ),
];

export const ScheduledSection: Story = {
  args: {
    ...commonArgs,
    ...scheduledArgs,
    items: makeItems(2),
    scheduledItems,
  },
};

/** A full conversation column: actions fit inline at the row's end. */
export const ScheduledSectionWide: Story = {
  args: {
    ...commonArgs,
    ...scheduledArgs,
    items: makeItems(2),
    scheduledItems,
  },
  parameters: { containerWidth: 720 },
};

export const ScheduledOnly: Story = {
  args: {
    ...commonArgs,
    ...scheduledArgs,
    items: [],
    scheduledItems: scheduledItems.slice(0, 1),
  },
};

export const ScheduledSectionMobile: Story = {
  args: {
    ...commonArgs,
    ...scheduledArgs,
    items: makeItems(2),
    scheduledItems,
    roomy: true,
    footerPosition: 'inline',
  },
  decorators: mobileDecorator,
  parameters: { containerWidth: 'calc(100vw - 48px)' },
};

export const ScheduledOnlyMobile: Story = {
  args: {
    ...commonArgs,
    ...scheduledArgs,
    items: [],
    scheduledItems: scheduledItems.slice(0, 1),
    roomy: true,
    footerPosition: 'inline',
  },
  decorators: mobileDecorator,
  parameters: { containerWidth: 'calc(100vw - 48px)' },
};

/** The first row is being edited in the composer: it keeps its place, dimmed and labelled. */
export const EditingFirstItem: Story = {
  args: {
    ...commonArgs,
    items: makeItems(3).map((item, index) => ({ ...item, isEditing: index === 0 })),
    editingCid: 'cid-0',
  },
};

export const EditingFirstItemMobile: Story = {
  args: { ...EditingFirstItem.args, roomy: true, footerPosition: 'inline' },
  decorators: mobileDecorator,
  parameters: { containerWidth: 'calc(100vw - 48px)' },
};

const PEOPLE: Record<string, { name: string }> = {
  'user-1': { name: 'Mia Chen' },
  'user-2': { name: 'Leo Park' },
  'user-3': { name: 'Sam Rivera' },
};

/** The production avatar with a synthetic member (initials, no photo). */
function StoryAvatar({ userId }: { userId?: string }) {
  return <UserAvatar size="small" user={{ id: userId, name: PEOPLE[userId ?? '']?.name ?? '' }} />;
}

function makeTeamItems(): MessageQueueItem[] {
  const senders = ['user-1', 'user-2', 'user-1', 'user-3'];
  return makeItems(4).map((item, index) => {
    const userId = senders[index]!;
    return { ...item, userId, userName: PEOPLE[userId]!.name };
  });
}

const teamArgs = {
  ...commonArgs,
  items: makeTeamItems(),
  renderSenderAvatar: (item: MessageQueueItem) => <StoryAvatar userId={item.userId} />,
};

/** Several people queued here: every row carries its sender's face. */
export const MultipleSenders: Story = { args: teamArgs };

export const MultipleSendersMobile: Story = {
  args: { ...teamArgs, roomy: true, footerPosition: 'inline' },
  decorators: mobileDecorator,
  parameters: { containerWidth: 'calc(100vw - 48px)' },
};

const runConfigs: Record<string, QueuedRunConfigSummary> = {
  'cid-0': { agentLabel: 'Claude Code', modelLabel: 'Sonnet 4.5', reasoningLabel: 'Medium' },
  'cid-1': {
    agentLabel: 'Claude Code',
    modelLabel: 'Opus 4.5',
    reasoningLabel: 'High',
    modeLabel: 'Ask before edits',
    planOn: true,
    differenceTag: 'Opus 4.5 · Plan',
  },
  'cid-2': {
    agentLabel: 'Claude Code',
    roleName: 'Reviewer',
    modelLabel: 'Sonnet 4.5',
    reasoningLabel: 'High',
    differenceTag: 'Reviewer',
  },
  'cid-3': { agentLabel: 'Claude Code', modelLabel: 'Sonnet 4.5', reasoningLabel: 'Medium' },
};
const describeRunConfig = (item: MessageQueueItem) => runConfigs[item.$cid];

/** Rows whose frozen run config differs from the composer's carry a short tag. */
export const RunConfigDifferences: Story = {
  args: { ...teamArgs, describeRunConfig },
  parameters: { containerWidth: 620 },
};

/** Narrower than 520 px the tag is left out; the details still show it. */
export const RunConfigDifferencesNarrow: Story = {
  args: { ...teamArgs, describeRunConfig },
  parameters: { containerWidth: 420 },
};

const openDetails = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  const rows = canvasElement.querySelectorAll<HTMLElement>('[data-message-queue-row]');
  const row = rows[1]!;
  const direct = row.querySelector<HTMLButtonElement>('[aria-label="Message details"]');
  if (direct) {
    await userEvent.click(direct);
    return;
  }
  await userEvent.click(row.querySelector<HTMLButtonElement>('[aria-label="More"]')!);
  const item = await within(document.body).findByRole('menuitem', { name: 'Message details' });
  await userEvent.click(item);
};

const LONG_MESSAGE =
  'Refactor the message queue to support priority ordering and cancellation tokens.\n\nKeep the existing drag order as the tie-breaker, and add tests for a cancelled head item while the agent is still running. Do not change the stored queue format.';

/** The details popover: the full message, its sender and how it will run. */
export const DetailsOpen: Story = {
  args: {
    ...teamArgs,
    describeRunConfig,
    items: teamArgs.items.map((item, index) =>
      index === 1
        ? {
            ...item,
            task: LONG_MESSAGE,
            acpSessionConfig: { ...item.acpSessionConfig!, prompt: LONG_MESSAGE },
          }
        : item
    ),
  },
  parameters: { containerWidth: 620 },
  play: openDetails,
};

export const DetailsOpenMobile: Story = {
  args: { ...DetailsOpen.args, roomy: true, footerPosition: 'inline' },
  decorators: mobileDecorator,
  parameters: { containerWidth: 'calc(100vw - 48px)' },
  play: openDetails,
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
const LOCAL_PREPARE_FAILED =
  "Lody on this computer couldn't prepare this attachment (request_timeout). Make sure the local agent is running and up to date, then continue sending.";

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
        error: LOCAL_PREPARE_FAILED,
        attachments: [
          {
            id: 'log',
            kind: 'file',
            source: new Blob(['log']),
            name: 'crash.log',
            mimeType: 'text/plain',
            lastModified: 0,
            error: LOCAL_PREPARE_FAILED,
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

function editRecord(error?: string): PendingSessionSend {
  return localRecord('turn-1', TASKS[1]!, {
    queueReplace: { cid: 'cid-1' },
    ...(error ? { error } : {}),
    attachments: [
      {
        id: 'mock',
        kind: 'image',
        source: localImage,
        name: 'mock.svg',
        mimeType: 'image/svg+xml',
        lastModified: 0,
        progress: error ? 0 : 64,
      },
    ],
  });
}

/** A saved edit with a new image: the row holds its place while the image uploads. */
export const SavingEditWithAttachment: Story = {
  args: { ...commonArgs, items: makeItems(3).map((item, i) => ({ ...item, isEditing: i === 1 })) },
  decorators: [withLocalQueueRows([editRecord()])],
  parameters: { containerWidth: 560 },
};

/** The new image failed: the row says why and offers retry or discarding the edit. */
export const SavingEditFailed: Story = {
  args: SavingEditWithAttachment.args,
  decorators: [
    withLocalQueueRows([editRecord("The image couldn't be uploaded (network_error). Try again.")]),
  ],
  parameters: { containerWidth: 560 },
};

/** The real disclosure keeps both recovery state and the total count visible. */
export const CollapsedWithUploads: Story = {
  ...LocalUploadRows,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Up next/ }));
  },
};

const ownedScopeVariables = {
  '--composer': '210 35% 88%',
  '--foreground': '270 55% 31%',
  '--input': '32 58% 72%',
  '--input-border': '315 60% 38%',
  '--border': '155 56% 33%',
  '--radius-lg': '17px',
} as const;

const callerStyles = stylex.create({
  sheet: {
    backgroundColor: 'rgb(230, 205, 180)',
    borderColor: 'rgb(115, 45, 85)',
    borderWidth: '3px',
    borderRadius: '21px',
    overflow: 'visible',
  },
});

function OwnedQueueFixture({
  scope = 'default',
  caller = 'none',
  count = 10,
  rowFooter = false,
}: {
  scope?: 'default' | 'root' | 'subtree';
  caller?: 'none' | 'utilities' | 'opaque';
  count?: number;
  rowFooter?: boolean;
}) {
  const [items, setItems] = useState(() => makeItems(count));
  const [editingCid, setEditingCid] = useState<string | null>(null);
  const [result, setResult] = useState('Ready');
  useLayoutEffect(() => {
    if (scope !== 'root') return undefined;
    const previous = Object.keys(ownedScopeVariables).map((key) => [
      key,
      document.documentElement.style.getPropertyValue(key),
      document.documentElement.style.getPropertyPriority(key),
    ]);
    for (const [key, value] of Object.entries(ownedScopeVariables)) {
      document.documentElement.style.setProperty(key, value);
    }
    return () => {
      for (const [key, value, priority] of previous) {
        if (key && value) document.documentElement.style.setProperty(key, value, priority);
        else if (key) document.documentElement.style.removeProperty(key);
      }
    };
  }, [scope]);
  return (
    <div
      data-owned-queue-fixture=""
      style={scope === 'subtree' ? (ownedScopeVariables as CSSProperties) : undefined}
    >
      <MessageQueueDisplay
        {...commonArgs}
        items={items}
        renderItemFooter={
          rowFooter
            ? (item) => (
                <span data-owned-queue-row-footer="" tabIndex={0}>
                  Synthetic metadata for {item.$cid}
                </span>
              )
            : undefined
        }
        xstyle={
          caller === 'utilities'
            ? storyCallerStyles.sheetOverride
            : caller === 'opaque'
              ? callerStyles.sheet
              : undefined
        }
        onRemove={(cid) => {
          setItems((rows) => rows.filter((row) => row.$cid !== cid));
          setResult(`Removed ${cid}`);
        }}
        editingCid={editingCid}
        onEditStart={(item) => {
          setEditingCid(item.$cid);
          setResult(`Editing ${item.$cid}`);
        }}
        onReorder={(activeCid, overCid) => setResult(`Reordered ${activeCid} ${overCid}`)}
        onSteer={(item) => setResult(`Steered ${item.$cid}`)}
      />
      <output data-owned-queue-result="">{result}</output>
    </div>
  );
}

type OwnedQueueStory = StoryObj<typeof OwnedQueueFixture>;

const ownedParameters = { containerWidth: 'min(420px,calc(100vw - 48px))' };
export const OwnedDefault: OwnedQueueStory = {
  parameters: ownedParameters,
  render: () => <OwnedQueueFixture />,
};
export const OwnedRootVariables: OwnedQueueStory = {
  parameters: ownedParameters,
  render: () => <OwnedQueueFixture scope="root" />,
};
export const OwnedSubtreeVariables: OwnedQueueStory = {
  parameters: ownedParameters,
  render: () => <OwnedQueueFixture scope="subtree" />,
};
export const OwnedUtilityCaller: OwnedQueueStory = {
  parameters: ownedParameters,
  render: () => <OwnedQueueFixture caller="utilities" />,
};
export const OwnedOpaqueCaller: OwnedQueueStory = {
  parameters: ownedParameters,
  render: () => <OwnedQueueFixture caller="opaque" />,
};

export const OwnedRowFooter: OwnedQueueStory = {
  parameters: ownedParameters,
  render: () => (
    <div {...stylex.props(stylex.defaultMarker())} data-unrelated-queue-marker="">
      <button type="button" data-unrelated-queue-control="">
        Unrelated outer marker target
      </button>
      <OwnedQueueFixture count={3} rowFooter />
    </div>
  ),
};

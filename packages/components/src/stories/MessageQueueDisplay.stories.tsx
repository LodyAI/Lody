import type { Meta, StoryObj } from '@storybook/react';
import type { MessageQueueItem, SessionId } from '@lody/shared';
import { MessageQueueDisplay } from '@/components/sessions/message-queue';

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
      // Mirror the real chat-input shell so the queue sits attached to a faux composer.
      return (
        <div className="bg-background p-6">
          <div className={`${width}`}>
            <Story />
            <div className="rounded-md rounded-t-none border border-border/50 bg-muted/40 px-3 py-3 text-xs text-muted-foreground/60">
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

export const InactiveSession: Story = {
  args: {
    ...commonArgs,
    items: makeItems(3),
    showSteerAction: false,
  },
};

import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';

import {
  MobileSessionTabButton,
  MobileSessionTabSheet,
  hasBackgroundUnread,
  hasBackgroundWorking,
  type ArchivedConversationEntry,
  type ConversationTabEntry,
  type ViewerTabEntry,
} from '@/components/mobile/mobile-session-tab-sheet';

const now = Date.now();
const conversations: ConversationTabEntry[] = [
  {
    id: 'c1',
    title: 'Solve merge conflicts',
    active: true,
    main: true,
    running: false,
    unread: false,
    lastActivityAt: now - 30_000,
  },
  {
    id: 'c2',
    title: 'Review mobile layout',
    active: false,
    running: true,
    unread: false,
    lastActivityAt: now - 4 * 60_000,
  },
  {
    id: 'c3',
    title: 'Fix flaky presence test',
    active: false,
    running: false,
    unread: true,
    lastActivityAt: now - 2 * 3_600_000,
  },
  {
    id: 'c4',
    title: 'A very long thread title that should truncate cleanly on a phone',
    active: false,
    running: true,
    unread: true,
    lastActivityAt: now - 3 * 86_400_000,
  },
  /* The case the hand exists for: a subagent tab the user is not looking at is
     blocked on an approval. Without it this row is a spinner, indistinguishable
     from `c2` above, and nothing on screen says the run is stalled on you. */
  {
    id: 'c5',
    title: 'Subagent · migrate the presence fixtures',
    active: false,
    running: true,
    waitingPermission: true,
    unread: false,
    lastActivityAt: now - 20_000,
  },
];

/* Crowded case: many threads + archived — exercises scroll, the Main chip on a
   non-active parent, and the collapsed Archived disclosure. */
const manyConversations: ConversationTabEntry[] = [
  {
    id: 'm0',
    title: 'Ship the mobile session header redesign',
    active: false,
    main: true,
    running: false,
    unread: false,
    lastActivityAt: now - 2 * 60_000,
  },
  {
    id: 'm1',
    title: 'Investigate flaky presence heartbeat',
    active: false,
    running: true,
    waitingPermission: true,
    unread: false,
    lastActivityAt: now - 40_000,
  },
  {
    id: 'm2',
    title: 'Refactor the diff viewer virtualization',
    active: true,
    running: false,
    unread: false,
    lastActivityAt: now - 8 * 60_000,
  },
  {
    id: 'm3',
    title: 'Write E2EE key rotation spec',
    active: false,
    running: false,
    unread: true,
    lastActivityAt: now - 25 * 60_000,
  },
  {
    id: 'm4',
    title: 'Fix Electron auto-update rollback',
    active: false,
    running: true,
    unread: true,
    lastActivityAt: now - 3 * 3_600_000,
  },
  {
    id: 'm5',
    title: 'Benchmark Loro snapshot load times',
    active: false,
    running: false,
    unread: false,
    lastActivityAt: now - 9 * 3_600_000,
  },
  {
    id: 'm6',
    title: 'Add worktree cleanup command',
    active: false,
    running: false,
    unread: false,
    lastActivityAt: now - 26 * 3_600_000,
  },
  {
    id: 'm7',
    title: 'Untangle the sidebar rollup mapping',
    active: false,
    running: false,
    unread: false,
    lastActivityAt: now - 3 * 86_400_000,
  },
];

const archivedConversations: ArchivedConversationEntry[] = [
  { id: 'a1', title: 'Spike: canvas glass buttons', lastActivityAt: now - 2 * 86_400_000 },
  { id: 'a2', title: 'Old approach: CSS filter glass', lastActivityAt: now - 4 * 86_400_000 },
  { id: 'a3', title: 'Prototype frosted header', lastActivityAt: now - 6 * 86_400_000 },
];

const viewers: ViewerTabEntry[] = [
  // Production always leads the group with Files (the session file browser).
  { id: 'mobile-viewer:files', label: 'Files', kind: 'files', active: false },
  { id: 'v1', label: '#482 Refactor sync loop', kind: 'pr', active: false },
  { id: 'v2', label: 'Browser', kind: 'browser', active: false },
  { id: 'v3', label: 'session-detail.tsx', kind: 'file', active: false },
  { id: 'v4', label: 'All changes', kind: 'diff', active: true },
];

function Harness({ withViewers, crowded }: { withViewers: boolean; crowded?: boolean }) {
  const [open, setOpen] = useState(true);
  const shownViewers = withViewers ? viewers : [];
  const shownConversations = crowded ? manyConversations : conversations;
  return (
    <div className="flex min-h-dvh flex-col items-center gap-4 bg-stone-950 p-6">
      <div className="flex items-center gap-3 rounded-full bg-background px-3 py-1.5">
        <span className="text-sm text-muted-foreground">Header trigger:</span>
        <MobileSessionTabButton
          hasUnread={hasBackgroundUnread(shownConversations)}
          hasWorking={hasBackgroundWorking(shownConversations)}
          onOpen={() => setOpen(true)}
        />
      </div>
      <MobileSessionTabSheet
        open={open}
        onOpenChange={setOpen}
        conversations={shownConversations}
        archivedConversations={crowded ? archivedConversations : []}
        viewers={shownViewers}
        onSelectConversation={fn()}
        onNewConversation={fn()}
        onSelectViewer={fn()}
        onRestoreConversation={fn()}
      />
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileSessionTabSheet',
  component: Harness,
  parameters: { layout: 'fullscreen' },
  globals: { theme: 'dark' },
  tags: ['autodocs'],
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithViewers: Story = { args: { withViewers: true } };
export const ConversationsOnly: Story = { args: { withViewers: false } };
export const ManyWithArchived: Story = { args: { withViewers: true, crowded: true } };

/* Isolates the header-button badge so the two background signals can be compared
   directly: solid dot = unread (finished, look at it), pulsing gradient dot in a
   fixed dark frame = working (agent still running). Unread wins when both true. */
function BadgeCell({
  caption,
  hasUnread,
  hasWorking,
}: {
  caption: string;
  hasUnread: boolean;
  hasWorking: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      {/* Frosted plate mimicking the floating session header the button sits on. */}
      <div className="rounded-2xl bg-background/55 p-3 backdrop-blur-xl">
        <MobileSessionTabButton hasUnread={hasUnread} hasWorking={hasWorking} onOpen={fn()} />
      </div>
      <span className="max-w-[8rem] text-center text-xs text-muted-foreground">{caption}</span>
    </div>
  );
}

export const BadgeStates: StoryObj = {
  render: () => (
    <div className="flex min-h-dvh items-center justify-center bg-stone-950 p-6">
      <div
        className="grid grid-cols-2 gap-8 rounded-3xl p-10"
        style={{
          backgroundImage: 'linear-gradient(135deg, oklch(0.55 0.15 260), oklch(0.6 0.14 20))',
        }}
      >
        <BadgeCell caption="Idle — no badge" hasUnread={false} hasWorking={false} />
        <BadgeCell caption="Working — pulsing gradient dot" hasUnread={false} hasWorking={true} />
        <BadgeCell caption="Unread — solid dot" hasUnread={true} hasWorking={false} />
        <BadgeCell caption="Both — unread wins" hasUnread={true} hasWorking={true} />
      </div>
    </div>
  ),
  parameters: { layout: 'fullscreen' },
  globals: { theme: 'dark' },
};

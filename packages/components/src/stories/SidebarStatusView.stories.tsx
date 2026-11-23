import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import type { PinSection } from '@lody/shared';
import { LoroSidebar } from '@/components/loro-sidebar';
import { isSidebarBucketCollapsed } from '@/lib/sidebar-status-group';
import type {
  SidebarUpdatedBucketKey,
  SidebarUpdatedItem,
} from '@/components/sidebar-updated-session-list';
import { useStatusViewStoryState } from './status-view-story-state';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.now();

type DemoSession = {
  id: string;
  title: string;
  subtitle: string;
  latestMessageAt: number;
  isPinned: boolean;
  pinSectionId?: string;
  orderKey?: string;
  isWorking?: boolean;
  isWaitingPermission?: boolean;
  hasUnreadMessages?: boolean;
  snoozedUntil?: number;
  settledAt?: number;
  focusRestoredAt?: number;
  prStatus?: 'open' | 'draft' | 'merged' | 'closed';
  prCiState?: 's' | 'f' | 'p';
  prUrl?: string;
};

const INITIAL_PIN_SECTIONS: PinSection[] = [
  { id: 'maintenance', name: 'Maintenance', orderKey: '80' },
];

const INITIAL_SESSIONS: DemoSession[] = [
  {
    id: 'pin-1',
    title: 'Weekly mirror update check',
    subtitle: 'lodyai/lody',
    latestMessageAt: NOW - 3 * HOUR,
    isPinned: true,
    pinSectionId: 'maintenance',
    orderKey: '80',
  },
  {
    id: 'pin-2',
    title: 'Release 0.106 checklist',
    subtitle: 'lodyai/lody',
    latestMessageAt: NOW - 45 * MINUTE,
    isPinned: true,
    orderKey: '80',
    hasUnreadMessages: true,
  },
  {
    id: 'focus-1',
    title: 'Refactor sidebar Status view',
    subtitle: 'lodyai/lody',
    latestMessageAt: NOW - 8 * MINUTE,
    isPinned: false,
    orderKey: '80',
    isWorking: true,
  },
  {
    id: 'focus-2',
    title: 'Approve prod DB migration plan',
    subtitle: 'lodyai/cloud',
    latestMessageAt: NOW - 25 * MINUTE,
    isPinned: false,
    orderKey: '81',
    isWaitingPermission: true,
  },
  {
    id: 'focus-3',
    title: 'Fix OAuth refresh race condition',
    subtitle: 'lodyai/lody',
    latestMessageAt: NOW - 2 * HOUR,
    isPinned: false,
    orderKey: '82',
    hasUnreadMessages: true,
    prStatus: 'open',
    prCiState: 's',
    prUrl: 'https://github.com/lodyai/lody/pull/412',
  },
  {
    id: 'focus-4',
    title: 'Nightly benchmark sweep',
    subtitle: 'lodyai/lody',
    latestMessageAt: NOW - 15 * MINUTE,
    isPinned: false,
    orderKey: '83',
    hasUnreadMessages: true,
  },
  {
    id: 'focus-5',
    title: 'Audit E2EE recovery key backup flow',
    subtitle: 'lodyai/lody',
    latestMessageAt: NOW - 6 * HOUR,
    isPinned: false,
    orderKey: '84',
  },
  {
    id: 'later-1',
    title: 'Re-run flaky Safari Playwright suite',
    subtitle: 'lodyai/lody',
    latestMessageAt: NOW - 3 * HOUR,
    isPinned: false,
    snoozedUntil: NOW + 2 * HOUR,
  },
  {
    id: 'later-2',
    title: 'Follow up with design on mobile drawer',
    subtitle: 'lodyai/lody',
    latestMessageAt: NOW - 5 * HOUR,
    isPinned: false,
    snoozedUntil: NOW + 18 * HOUR,
  },
  {
    id: 'later-3',
    title: 'Upgrade Electron to v36 beta',
    subtitle: 'lodyai/lody',
    latestMessageAt: NOW - 2 * DAY,
    isPinned: false,
    snoozedUntil: NOW + 3 * DAY,
  },
  {
    id: 'settled-1',
    title: 'Ship fractional-index pin sections',
    subtitle: 'lodyai/lody',
    latestMessageAt: NOW - 12 * HOUR,
    isPinned: false,
    settledAt: NOW - 10 * HOUR,
  },
  {
    id: 'settled-2',
    title: 'Investigate macOS notarization timeout',
    subtitle: 'lodyai/lody',
    latestMessageAt: NOW - 9 * DAY,
    isPinned: false,
  },
  {
    id: 'settled-3',
    title: 'Clean up deprecated CLI flags',
    subtitle: 'lodyai/lody',
    latestMessageAt: NOW - 14 * DAY,
    isPinned: false,
  },
];

const toItem = (session: DemoSession): SidebarUpdatedItem => ({
  id: session.id,
  kind: 'github',
  title: session.title,
  sectionLabel: session.subtitle,
  subtitle: session.subtitle,
  repoFullName: session.subtitle,
  latestMessageAt: session.latestMessageAt,
  isPinned: session.isPinned,
  orderKey: session.orderKey ?? null,
  isWorking: session.isWorking,
  isWaitingPermission: session.isWaitingPermission,
  hasUnreadMessages: session.hasUnreadMessages,
  snoozedUntil: session.snoozedUntil ?? null,
  settledAt: session.settledAt ?? null,
  focusRestoredAt: session.focusRestoredAt ?? null,
  prStatus: session.prStatus,
  prCiState: session.prCiState,
  prUrl: session.prUrl,
});

function StatusViewPlayground({
  initialCollapsedBuckets = {},
}: {
  initialCollapsedBuckets?: Partial<Record<SidebarUpdatedBucketKey, boolean>>;
}) {
  const state = useStatusViewStoryState(INITIAL_SESSIONS, INITIAL_PIN_SECTIONS, toItem);
  const { conversations: sessions, setConversations: setSessions } = state;
  const [selectedId, setSelectedId] = useState<string>('focus-1');
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [collapsedPinSectionIds, setCollapsedPinSectionIds] = useState<Record<string, boolean>>({});
  const [collapsedBuckets, setCollapsedBuckets] =
    useState<Partial<Record<SidebarUpdatedBucketKey, boolean>>>(initialCollapsedBuckets);

  const selected = sessions.find((s) => s.id === selectedId);

  return (
    <div className="flex h-[720px] w-full bg-background text-foreground">
      <LoroSidebar
        workspaceName="Lody"
        userEmail="alex@lody.ai"
        workspaces={[{ id: 'ws-1', name: 'Lody' }]}
        currentWorkspaceId="ws-1"
        organizeMode="status"
        showUpdatedProjectNames
        pinnedSections={state.pinnedSections}
        pinnedSectionCollapsed={pinnedCollapsed}
        onTogglePinnedSection={() => setPinnedCollapsed((prev) => !prev)}
        collapsedPinSectionIds={collapsedPinSectionIds}
        onTogglePinSection={(id) =>
          setCollapsedPinSectionIds((prev) => ({ ...prev, [id]: !prev[id] }))
        }
        pinSectionActions={state.pinSectionActions}
        updatedItems={state.updatedItems}
        updatedSelectedItemId={selectedId}
        updatedBucketsCollapsed={collapsedBuckets}
        onToggleUpdatedBucket={(key) =>
          setCollapsedBuckets((prev) => ({
            ...prev,
            [key]: !isSidebarBucketCollapsed(key, prev),
          }))
        }
        onSelectUpdatedItem={(id) => setSelectedId(id)}
        onToggleUpdatedItemPinned={state.togglePin}
        onSnoozeUpdatedItem={state.snooze}
        onSettleUpdatedItem={state.settle}
        onMoveUpdatedItemToFocus={state.moveToFocus}
        onDropFocusItem={state.onDropFocusItem}
        onRenameUpdatedItem={(id, nextTitle) =>
          setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: nextTitle } : s)))
        }
        onArchiveUpdatedItem={(id) => setSessions((prev) => prev.filter((s) => s.id !== id))}
        onMarkUpdatedItemUnread={(id) =>
          setSessions((prev) =>
            prev.map((s) => (s.id === id ? { ...s, hasUnreadMessages: true } : s))
          )
        }
      />

      <div className="flex flex-1 flex-col gap-3 border-l border-border/60 p-6">
        <div className="text-sm font-medium text-foreground">
          {selected ? selected.title : 'Select a session'}
        </div>
        <div className="max-w-lg space-y-2 text-xs text-muted-foreground">
          <p>
            <strong>Focus (进行中)</strong>: drag rows to reorder with fractional index (reuses
            Pinned&apos;s pointer drag + 100ms settle animation).
          </p>
          <p>
            <strong>Later (稍后)</strong>: collapsed by default; expand to see snoozed rows sorted
            by wake-up time with compact countdown pills (<code>2h</code>, <code>1d</code>,{' '}
            <code>3d</code>). Drag a row into Focus or use the context menu to restore.
          </p>
          <p>
            <strong>Settled (已完成)</strong>: collapsed by default; includes manually settled and
            7+ day inactive sessions. Right-click any row to test <strong>Later</strong>,{' '}
            <strong>Settle</strong>, and <strong>Move to Focus</strong>.
          </p>
        </div>
      </div>
    </div>
  );
}

const meta: Meta<typeof StatusViewPlayground> = {
  title: 'Sidebar/Status View',
  component: StatusViewPlayground,
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj<typeof StatusViewPlayground>;

/** Default Status view: Focus expanded, Later and Settled collapsed with counts. */
export const Default: Story = {};

/** All three Status tiers expanded so snooze countdown pills and settled rows are immediately visible. */
export const ExpandedLaterAndSettled: Story = {
  args: {
    initialCollapsedBuckets: {
      later: false,
      settled: false,
    },
  },
};

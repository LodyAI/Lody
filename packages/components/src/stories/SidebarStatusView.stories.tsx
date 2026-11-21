import type { Meta, StoryObj } from '@storybook/react';
import { useCallback, useMemo, useState } from 'react';
import {
  buildPinnedSectionLayout,
  planManualOrderMove,
  planNewPinPlacement,
  planNewPinSectionOrderKey,
  planPinSectionMove,
  planPinnedSessionMove,
  sortByManualOrder,
  type PinPlacementWrite,
  type PinSection,
  type PinnedSessionPlacement,
} from '@lody/shared';
import { LoroSidebar } from '@/components/loro-sidebar';
import { isSidebarBucketCollapsed, sidebarStatusGroup } from '@/lib/sidebar-status-group';
import type { SidebarPinSectionActions } from '@/components/sidebar-pinned-sections';
import type {
  SidebarUpdatedBucketKey,
  SidebarUpdatedItem,
} from '@/components/sidebar-updated-session-list';

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
  const [sessions, setSessions] = useState<DemoSession[]>(INITIAL_SESSIONS);
  const [pinSections, setPinSections] = useState<PinSection[]>(INITIAL_PIN_SECTIONS);
  const [selectedId, setSelectedId] = useState<string>('focus-1');
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [collapsedPinSectionIds, setCollapsedPinSectionIds] = useState<Record<string, boolean>>({});
  const [collapsedBuckets, setCollapsedBuckets] =
    useState<Partial<Record<SidebarUpdatedBucketKey, boolean>>>(initialCollapsedBuckets);

  const pinnedLayout = useMemo(() => {
    const pinned = sessions.filter((s) => s.isPinned).map(toItem);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return buildPinnedSectionLayout(pinned, pinSections, (item): PinnedSessionPlacement => {
      const meta = byId.get(item.id);
      return {
        id: item.id,
        pinSectionId: meta?.pinSectionId ?? null,
        orderKey: meta?.orderKey ?? null,
        recency: meta?.latestMessageAt ?? 0,
      };
    });
  }, [sessions, pinSections]);

  const pinnedSections = useMemo(
    () =>
      pinnedLayout.map((entry) => ({
        id: entry.sectionId,
        name: entry.section?.name ?? '',
        items: entry.items,
      })),
    [pinnedLayout]
  );

  const updatedItems = useMemo(() => sessions.filter((s) => !s.isPinned).map(toItem), [sessions]);

  const applyPinWrites = useCallback((writes: readonly PinPlacementWrite[]) => {
    const byId = new Map(writes.map((w) => [w.sessionId, w]));
    setSessions((prev) =>
      prev.map((session) => {
        const write = byId.get(session.id);
        return write
          ? {
              ...session,
              isPinned: true,
              pinSectionId: write.pinSectionId,
              orderKey: write.orderKey,
            }
          : session;
      })
    );
  }, []);

  const pinSectionActions = useMemo<SidebarPinSectionActions>(
    () => ({
      onDropItem: (itemId, sectionId, toIndex) => {
        const placements = buildPinnedSectionLayout(
          sessions
            .filter((s) => s.isPinned)
            .map((s) => ({
              id: s.id,
              pinSectionId: s.pinSectionId ?? null,
              orderKey: s.orderKey ?? null,
              recency: s.latestMessageAt,
            })),
          pinSections,
          (p) => p
        );
        applyPinWrites(
          planPinnedSessionMove(placements, { sessionId: itemId, toSectionId: sectionId, toIndex })
        );
      },
      onMoveSection: (sectionId, toIndex) => {
        const nextOrderKey = planPinSectionMove(pinSections, sectionId, toIndex);
        setPinSections((prev) =>
          prev.map((s) => (s.id === sectionId ? { ...s, orderKey: nextOrderKey } : s))
        );
      },
      onCreateSection: (name, moveItemId) => {
        const id = `sec-${Date.now()}`;
        const orderKey = planNewPinSectionOrderKey(pinSections);
        setPinSections((prev) => [...prev, { id, name, orderKey }]);
        if (moveItemId) {
          applyPinWrites([{ sessionId: moveItemId, pinSectionId: id, orderKey: '80' }]);
        }
      },
      onRenameSection: (sectionId, name) => {
        setPinSections((prev) => prev.map((s) => (s.id === sectionId ? { ...s, name } : s)));
      },
      onDeleteSection: (sectionId) => {
        setPinSections((prev) => prev.filter((s) => s.id !== sectionId));
      },
    }),
    [applyPinWrites, pinSections, sessions]
  );

  const handleDropFocusItem = useCallback(
    (sessionId: string, toIndex: number) => {
      const nowMs = Date.now();
      const focusSessions = sortByManualOrder(
        sessions.filter(
          (s) =>
            !s.isPinned &&
            sidebarStatusGroup(
              {
                latestMessageAt: s.latestMessageAt,
                isWorking: s.isWorking,
                isWaitingPermission: s.isWaitingPermission,
                snoozedUntil: s.snoozedUntil,
                settledAt: s.settledAt,
                focusRestoredAt: s.focusRestoredAt,
              },
              nowMs
            ) === 'focus'
        ),
        (s) => ({ id: s.id, orderKey: s.orderKey ?? null, recency: s.latestMessageAt })
      );
      const writes = planManualOrderMove(
        focusSessions.map((s) => ({
          id: s.id,
          orderKey: s.orderKey ?? null,
          recency: s.latestMessageAt,
        })),
        { sessionId, toIndex }
      );
      const byId = new Map(writes.map((w) => [w.sessionId, w.orderKey]));
      setSessions((prev) =>
        prev.map((s) => {
          const nextKey = byId.get(s.id);
          if (!nextKey) return s;
          return {
            ...s,
            orderKey: nextKey,
            ...(s.id === sessionId
              ? {
                  isPinned: false,
                  pinSectionId: undefined,
                  snoozedUntil: undefined,
                  settledAt: undefined,
                  focusRestoredAt: nowMs,
                }
              : {}),
          };
        })
      );
    },
    [sessions]
  );

  const handleTogglePin = useCallback((sessionId: string, nextPinned: boolean) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        if (!nextPinned) {
          return { ...s, isPinned: false, pinSectionId: undefined };
        }
        const { orderKey } = planNewPinPlacement(
          buildPinnedSectionLayout(
            prev
              .filter((entry) => entry.isPinned && !entry.pinSectionId && entry.id !== sessionId)
              .map((entry) => ({
                id: entry.id,
                pinSectionId: null,
                orderKey: entry.orderKey ?? null,
                recency: entry.latestMessageAt,
              })),
            [],
            (p) => p
          )
        );
        return { ...s, isPinned: true, pinSectionId: undefined, orderKey };
      })
    );
  }, []);

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
        pinnedSections={pinnedSections}
        pinnedSectionCollapsed={pinnedCollapsed}
        onTogglePinnedSection={() => setPinnedCollapsed((prev) => !prev)}
        collapsedPinSectionIds={collapsedPinSectionIds}
        onTogglePinSection={(id) =>
          setCollapsedPinSectionIds((prev) => ({ ...prev, [id]: !prev[id] }))
        }
        pinSectionActions={pinSectionActions}
        updatedItems={updatedItems}
        updatedSelectedItemId={selectedId}
        updatedBucketsCollapsed={collapsedBuckets}
        onToggleUpdatedBucket={(key) =>
          setCollapsedBuckets((prev) => ({
            ...prev,
            [key]: !isSidebarBucketCollapsed(key, prev),
          }))
        }
        onSelectUpdatedItem={(id) => setSelectedId(id)}
        onToggleUpdatedItemPinned={handleTogglePin}
        onSnoozeUpdatedItem={(id, snoozedUntil) =>
          setSessions((prev) =>
            prev.map((s) => (s.id === id ? { ...s, snoozedUntil, settledAt: undefined } : s))
          )
        }
        onSettleUpdatedItem={(id) =>
          setSessions((prev) =>
            prev.map((s) =>
              s.id === id ? { ...s, settledAt: Date.now(), snoozedUntil: undefined } : s
            )
          )
        }
        onMoveUpdatedItemToFocus={(id) =>
          setSessions((prev) =>
            prev.map((s) =>
              s.id === id
                ? {
                    ...s,
                    snoozedUntil: undefined,
                    settledAt: undefined,
                    focusRestoredAt: Date.now(),
                  }
                : s
            )
          )
        }
        onDropFocusItem={handleDropFocusItem}
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

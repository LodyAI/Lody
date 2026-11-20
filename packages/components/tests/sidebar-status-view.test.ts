import { describe, expect, it } from 'vitest';
import {
  buildSnoozePresets,
  formatSnoozeCountdown,
  isSidebarBucketCollapsed,
  SIDEBAR_SETTLED_INACTIVITY_MS,
  sidebarStatusGroup,
} from '@/lib/sidebar-status-group';
import {
  buildSidebarUpdatedBuckets,
  SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS,
  type SidebarUpdatedItem,
} from '@/components/sidebar-updated-session-list';
import { buildOpenedBySessionTree } from '@/lib/session-opened-by-tree';
import { sessionHasUnreadMessages } from '@/lib/session-read-receipt';
import { planManualOrderMove, sortByManualOrder } from '@lody/shared';

const NOW = Date.parse('2026-11-20T10:00:00.000Z');

describe('sidebarStatusGroup', () => {
  it('classifies snoozed sessions into later until snoozedUntil elapses', () => {
    expect(
      sidebarStatusGroup({ latestMessageAt: NOW - 1_000, snoozedUntil: NOW + 60_000 }, NOW)
    ).toBe('later');
    expect(
      sidebarStatusGroup({ latestMessageAt: NOW - 1_000, snoozedUntil: NOW }, NOW)
    ).toBe('focus');
  });

  it('classifies manually settled sessions into settled until a newer message arrives', () => {
    expect(
      sidebarStatusGroup({ latestMessageAt: NOW - 5_000, settledAt: NOW - 1_000 }, NOW)
    ).toBe('settled');
    expect(
      sidebarStatusGroup({ latestMessageAt: NOW, settledAt: NOW - 1_000 }, NOW)
    ).toBe('focus');
  });

  it('auto-settles quiet sessions after 7 days unless working, waiting, or restored to Focus', () => {
    const eightDaysAgo = NOW - SIDEBAR_SETTLED_INACTIVITY_MS - 86_400_000;
    expect(sidebarStatusGroup({ latestMessageAt: eightDaysAgo }, NOW)).toBe('settled');
    expect(sidebarStatusGroup({ latestMessageAt: eightDaysAgo, isWorking: true }, NOW)).toBe(
      'focus'
    );
    expect(
      sidebarStatusGroup({ latestMessageAt: eightDaysAgo, isWaitingPermission: true }, NOW)
    ).toBe('focus');
    expect(
      sidebarStatusGroup({ latestMessageAt: eightDaysAgo, focusRestoredAt: NOW - 3_600_000 }, NOW)
    ).toBe('focus');
  });

  it('always surfaces waiting-for-permission sessions in Focus even when snoozed or settled', () => {
    expect(
      sidebarStatusGroup(
        { latestMessageAt: NOW - 5_000, snoozedUntil: NOW + 3_600_000, isWaitingPermission: true },
        NOW
      )
    ).toBe('focus');
    expect(
      sidebarStatusGroup(
        { latestMessageAt: NOW - 5_000, settledAt: NOW - 1_000, isWaitingPermission: true },
        NOW
      )
    ).toBe('focus');
  });

  it('classifies opened-by child sessions independently, nests them when in the same group, and indexes Focus moves over roots only', () => {
    const mk = (id: string, extra: Partial<SidebarUpdatedItem> = {}): SidebarUpdatedItem => ({
      id,
      kind: 'chat',
      title: id,
      sectionLabel: 'Chats',
      latestMessageAt: NOW - 60_000,
      ...extra,
    });
    const items: SidebarUpdatedItem[] = [
      mk('root-a', { orderKey: '80' }),
      mk('child-a1', { openedBySessionId: 'root-a', openedByRowSessionId: 'root-a' }),
      mk('child-a2-snoozed', {
        openedBySessionId: 'root-a',
        openedByRowSessionId: 'root-a',
        snoozedUntil: NOW + 7_200_000,
      }),
      mk('root-b', { orderKey: '82' }),
    ];

    const buckets = buildSidebarUpdatedBuckets(items, 'status', NOW);
    const focus = buckets.find((b) => b.key === 'focus')!;
    const later = buckets.find((b) => b.key === 'later')!;

    // Snoozed child moves to Later on its own as a top-level row while its parent stays in Focus.
    const laterTree = buildOpenedBySessionTree(later.items, SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS);
    expect(laterTree.map((n) => ({ id: n.item.id, depth: n.depth }))).toEqual([
      { id: 'child-a2-snoozed', depth: 0 },
    ]);

    // Child in the same group stays indented under root-a; Focus DnD indexes over roots only.
    const focusTree = buildOpenedBySessionTree(focus.items, SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS);
    expect(focusTree.map((n) => ({ id: n.item.id, depth: n.depth }))).toEqual([
      { id: 'root-a', depth: 0 },
      { id: 'child-a1', depth: 1 },
      { id: 'root-b', depth: 0 },
    ]);

    // When child-a2 returns to Focus, indentation under root-a is restored automatically.
    const restoredBuckets = buildSidebarUpdatedBuckets(
      items.map((item) =>
        item.id === 'child-a2-snoozed' ? { ...item, snoozedUntil: null } : item
      ),
      'status',
      NOW
    );
    const restoredFocusTree = buildOpenedBySessionTree(
      restoredBuckets.find((b) => b.key === 'focus')!.items,
      SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS
    );
    expect(
      restoredFocusTree.find((n) => n.item.id === 'child-a2-snoozed')?.depth
    ).toBe(1);

    const focusRoots = focusTree.filter((node) => node.depth === 0).map((node) => node.item);
    expect(focusRoots.map((r) => r.id)).toEqual(['root-a', 'root-b']);
    const writes = planManualOrderMove(
      focusRoots.map((r) => ({ id: r.id, orderKey: r.orderKey ?? null, recency: NOW })),
      { sessionId: 'root-b', toIndex: 0 }
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sessionId).toBe('root-b');
    const reordered = sortByManualOrder(
      focusRoots.map((r) => (r.id === 'root-b' ? { ...r, orderKey: writes[0]!.orderKey } : r)),
      (r) => ({ id: r.id, orderKey: r.orderKey ?? null, recency: NOW })
    );
    expect(reordered.map((r) => r.id)).toEqual(['root-b', 'root-a']);
  });

  it('defaults later and settled to collapsed while focus starts expanded', () => {
    expect(isSidebarBucketCollapsed('focus', {})).toBe(false);
    expect(isSidebarBucketCollapsed('later', {})).toBe(true);
    expect(isSidebarBucketCollapsed('settled', {})).toBe(true);
    expect(isSidebarBucketCollapsed('later', { later: false })).toBe(false);
    expect(isSidebarBucketCollapsed('focus', { focus: true })).toBe(true);
  });
});

describe('formatSnoozeCountdown & buildSnoozePresets', () => {
  it('formats compact countdown units cleanly', () => {
    expect(formatSnoozeCountdown(NOW - 1, NOW)).toBeNull();
    expect(formatSnoozeCountdown(NOW + 20_000, NOW)).toBe('<1m');
    expect(formatSnoozeCountdown(NOW + 45 * 60_000, NOW)).toBe('45m');
    expect(formatSnoozeCountdown(NOW + 2 * 3_600_000, NOW)).toBe('2h');
    expect(formatSnoozeCountdown(NOW + 3 * 86_400_000, NOW)).toBe('3d');
  });

  it('produces three future quick snooze presets', () => {
    const presets = buildSnoozePresets(new Date(NOW));
    expect(presets.map((p) => p.id)).toEqual(['laterToday', 'tomorrowMorning', 'nextWeek']);
    for (const preset of presets) {
      expect(preset.timestamp).toBeGreaterThan(NOW);
      expect(preset.countdown.length).toBeGreaterThan(0);
    }
  });
});

describe('Focus manual fractional-index ordering', () => {
  it('sorts keyed items first and unkeyed items by stable ascending id (never recency)', () => {
    const items = [
      { id: 'z', orderKey: null, recency: 999 },
      { id: 'c', orderKey: null, recency: 300 },
      { id: 'b', orderKey: '82', recency: 100 },
      { id: 'a', orderKey: '80', recency: 200 },
    ];
    const sorted = sortByManualOrder(items, (item) => item);
    expect(sorted.map((item) => item.id)).toEqual(['a', 'b', 'c', 'z']);

    const writes = planManualOrderMove(sorted, { sessionId: 'c', toIndex: 1 });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sessionId).toBe('c');

    const updated = sorted.map((item) =>
      item.id === 'c' ? { ...item, orderKey: writes[0]!.orderKey } : item
    );
    expect(sortByManualOrder(updated, (item) => item).map((item) => item.id)).toEqual([
      'a',
      'c',
      'b',
      'z',
    ]);
  });

  it('derives snooze wake-up unread state and Focus top placement without mutating lastMessageAt or orderKey', () => {
    const tenDaysAgo = NOW - 10 * 86_400_000;
    const snoozeTarget = NOW - 5_000; // already elapsed

    // Older >7d session surfaces in Focus once its snooze elapses, and sorts to the top of Focus.
    expect(sidebarStatusGroup({ latestMessageAt: tenDaysAgo, snoozedUntil: snoozeTarget }, NOW)).toBe(
      'focus'
    );
    const items: SidebarUpdatedItem[] = [
      { id: 'focus-a', kind: 'chat', title: 'A', sectionLabel: 'Chats', latestMessageAt: NOW, orderKey: '80' },
      { id: 'focus-b', kind: 'chat', title: 'B', sectionLabel: 'Chats', latestMessageAt: NOW, orderKey: '82' },
      {
        id: 'woken-old',
        kind: 'chat',
        title: 'Woken',
        sectionLabel: 'Chats',
        latestMessageAt: tenDaysAgo,
        orderKey: '99',
        snoozedUntil: snoozeTarget,
      },
    ];
    const focus = buildSidebarUpdatedBuckets(items, 'status', NOW).find((b) => b.key === 'focus')!;
    expect(focus.items.map((i) => i.id)).toEqual(['woken-old', 'focus-a', 'focus-b']);

    // Unread derives from max(lastMessageAt, expiredSnoozeAt) > lastReadAt.
    expect(
      sessionHasUnreadMessages(
        { lastMessageAt: tenDaysAgo, lastReadAt: tenDaysAgo, snoozedUntil: snoozeTarget },
        NOW
      )
    ).toBe(true);
    // Reading after snoozeTarget clears unread and stays read.
    expect(
      sessionHasUnreadMessages(
        { lastMessageAt: tenDaysAgo, lastReadAt: snoozeTarget + 10_000, snoozedUntil: snoozeTarget },
        NOW
      )
    ).toBe(false);
    // A newer real reply after reading marks unread again.
    expect(
      sessionHasUnreadMessages(
        {
          lastMessageAt: snoozeTarget + 30_000,
          lastReadAt: snoozeTarget + 10_000,
          snoozedUntil: snoozeTarget,
        },
        NOW + 60_000
      )
    ).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildSnoozePresets,
  formatSnoozeCountdown,
  isSidebarBucketCollapsed,
  SIDEBAR_SETTLED_INACTIVITY_MS,
  sidebarStatusGroup,
} from '@/lib/sidebar-status-group';
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

describe('agentManaged unread suppression', () => {
  it('suppresses unread indicators when agentManaged is true without altering read receipts', () => {
    expect(
      sessionHasUnreadMessages({
        lastMessageAt: NOW,
        lastReadAt: NOW - 10_000,
        agentManaged: false,
      })
    ).toBe(true);
    expect(
      sessionHasUnreadMessages({
        lastMessageAt: NOW,
        lastReadAt: NOW - 10_000,
        agentManaged: true,
      })
    ).toBe(false);
  });
});

describe('Focus manual fractional-index ordering', () => {
  it('sorts keyed items first and plans single-write reorders cleanly', () => {
    const items = [
      { id: 'c', orderKey: null, recency: 300 },
      { id: 'b', orderKey: '82', recency: 100 },
      { id: 'a', orderKey: '80', recency: 200 },
    ];
    const sorted = sortByManualOrder(items, (item) => item);
    expect(sorted.map((item) => item.id)).toEqual(['a', 'b', 'c']);

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
    ]);
  });
});

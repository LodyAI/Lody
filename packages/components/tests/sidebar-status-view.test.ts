// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { isSidebarBucketCollapsed } from '@/lib/sidebar-status-group';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { runtimeAtom } from '@/atoms/runtime';
import { useStatusViewWritable } from '@/hooks/use-status-view-writable';
import { TestCloudPlatformProvider } from './test-platform';
import {
  buildSidebarUpdatedBuckets,
  SidebarUpdatedSessionList,
  SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS,
  type SidebarUpdatedItem,
} from '@/components/sidebar-updated-session-list';
import { buildOpenedBySessionTree } from '@/lib/session-opened-by-tree';
import { sessionHasUnreadMessages } from '@/lib/session-read-receipt';
import { initI18n } from '@/i18n';
import { planManualOrderMove, sortByManualOrder } from '@lody/shared';

const NOW = Date.parse('2026-11-20T10:00:00.000Z');

// Tier rules and their order are the shared golden vectors
// (packages/shared/src/status-view/vectors); these cover the sidebar adapter.
describe('sidebar Status buckets', () => {
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
    const laterTree = buildOpenedBySessionTree(
      later.items,
      SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS
    );
    expect(laterTree.map((n) => ({ id: n.item.id, depth: n.depth }))).toEqual([
      { id: 'child-a2-snoozed', depth: 0 },
    ]);

    // Child in the same group stays indented under root-a; Focus DnD indexes over roots only.
    const focusTree = buildOpenedBySessionTree(
      focus.items,
      SIDEBAR_UPDATED_OPENED_BY_TREE_ACCESSORS
    );
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
    expect(restoredFocusTree.find((n) => n.item.id === 'child-a2-snoozed')?.depth).toBe(1);

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

describe('Focus wake-up', () => {
  it('derives snooze wake-up unread state and Focus top placement without mutating lastMessageAt or orderKey', () => {
    const tenDaysAgo = NOW - 10 * 86_400_000;
    const snoozeTarget = NOW - 5_000; // already elapsed

    // Older >7d session surfaces in Focus once its snooze elapses, and sorts to the top of Focus.
    const items: SidebarUpdatedItem[] = [
      {
        id: 'focus-a',
        kind: 'chat',
        title: 'A',
        sectionLabel: 'Chats',
        latestMessageAt: NOW,
        orderKey: '80',
      },
      {
        id: 'focus-b',
        kind: 'chat',
        title: 'B',
        sectionLabel: 'Chats',
        latestMessageAt: NOW,
        orderKey: '82',
      },
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
        {
          lastMessageAt: tenDaysAgo,
          lastReadAt: snoozeTarget + 10_000,
          snoozedUntil: snoozeTarget,
        },
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

  it('keeps a woken row placed by a Focus reorder at its key and still unread', () => {
    const tenDaysAgo = NOW - 10 * 86_400_000;
    const wokeAt = NOW - 5_000;
    const items: SidebarUpdatedItem[] = [
      {
        id: 'focus-a',
        kind: 'chat',
        title: 'A',
        sectionLabel: 'Chats',
        latestMessageAt: NOW,
        orderKey: '80',
      },
      {
        id: 'placed-woken',
        kind: 'chat',
        title: 'Placed',
        sectionLabel: 'Chats',
        latestMessageAt: tenDaysAgo,
        orderKey: '82',
        snoozedUntil: wokeAt,
        focusRestoredAt: wokeAt,
      },
    ];
    const focus = buildSidebarUpdatedBuckets(items, 'status', NOW).find((b) => b.key === 'focus')!;
    expect(focus.items.map((i) => i.id)).toEqual(['focus-a', 'placed-woken']);
    expect(
      sessionHasUnreadMessages(
        { lastMessageAt: tenDaysAgo, lastReadAt: tenDaysAgo, snoozedUntil: wokeAt },
        NOW
      )
    ).toBe(true);
  });
});

describe('Status view row actions', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const statusItems: SidebarUpdatedItem[] = [
    {
      id: 'focus-row',
      kind: 'chat',
      title: 'Focus conversation',
      sectionLabel: 'Chats',
      latestMessageAt: NOW,
      orderKey: '80',
    },
    {
      id: 'later-row',
      kind: 'github',
      title: 'Snoozed conversation',
      sectionLabel: 'loro-dev/lody',
      latestMessageAt: NOW,
      snoozedUntil: NOW + 3 * 86_400_000,
      prUrl: 'https://github.com/loro-dev/lody/pull/42',
      prStatus: 'open',
    },
    {
      id: 'settled-row',
      kind: 'chat',
      title: 'Settled conversation',
      sectionLabel: 'Chats',
      latestMessageAt: NOW - 2_000,
      settledAt: NOW - 1_000,
    },
  ];

  function renderList(extraProps: Record<string, unknown> = {}) {
    flushSync(() => {
      root?.render(
        React.createElement(SidebarUpdatedSessionList, {
          items: statusItems,
          now: new Date(NOW),
          grouping: 'status',
          collapsedBuckets: { later: false, settled: false },
          onArchiveItem: vi.fn(),
          onSettleItem: vi.fn(),
          ...extraProps,
        })
      );
    });
  }

  function rowOf(id: string): HTMLElement {
    const row = container?.querySelector<HTMLElement>(`[data-sidebar-updated-id="${id}"]`);
    expect(row).not.toBeNull();
    return row!;
  }

  it('dismisses the session info card while the row menu is open', () => {
    vi.useFakeTimers();
    renderList({ onSnoozeItem: vi.fn() });
    const row = rowOf('focus-row');
    const infoCardTitle = () => document.body.querySelector('span[title="Focus conversation"]');
    const hoverRow = () =>
      row.dispatchEvent(
        new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body })
      );

    flushSync(hoverRow);
    flushSync(() => vi.advanceTimersByTime(700));
    expect(infoCardTitle()).not.toBeNull();

    flushSync(() => {
      row.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
      );
    });
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('Later');
    expect(infoCardTitle()).toBeNull();

    flushSync(hoverRow);
    flushSync(() => vi.advanceTimersByTime(700));
    expect(infoCardTitle()).toBeNull();
  });

  it('shows a one-click settle button on Focus and Later rows and keeps Archive on Settled rows', () => {
    const onSettleItem = vi.fn();
    const onArchiveItem = vi.fn();
    renderList({ onSettleItem, onArchiveItem });

    for (const id of ['focus-row', 'later-row']) {
      const row = rowOf(id);
      expect(row.querySelector('button[aria-label="Settle"]')).not.toBeNull();
      expect(row.querySelector('button[aria-label="Archive session"]')).toBeNull();
    }

    const settledRow = rowOf('settled-row');
    expect(settledRow.querySelector('button[aria-label="Archive session"]')).not.toBeNull();
    expect(settledRow.querySelector('button[aria-label="Settle"]')).toBeNull();

    flushSync(() => {
      rowOf('focus-row')
        .querySelector('button[aria-label="Settle"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(onSettleItem).toHaveBeenCalledTimes(1);
    expect(onSettleItem).toHaveBeenCalledWith('focus-row');
    expect(onArchiveItem).not.toHaveBeenCalled();
  });

  it('keeps the Archive hover button outside the Status view', () => {
    renderList({ grouping: 'recency', collapsedBuckets: undefined });

    const row = rowOf('focus-row');
    expect(row.querySelector('button[aria-label="Archive session"]')).not.toBeNull();
    expect(row.querySelector('button[aria-label="Settle"]')).toBeNull();
  });

  it('parks the snooze countdown last in the row trailing cluster', () => {
    renderList();

    const countdown = rowOf('later-row').querySelector('[data-snooze-countdown]');
    expect(countdown).not.toBeNull();
    // The PR icon must sit left of the countdown — the wake-up time owns the
    // row's right edge.
    expect(countdown?.parentElement?.lastElementChild).toBe(countdown);
  });
});

describe('Status view write gate', () => {
  let gateRoot: Root | undefined;
  let gateContainer: HTMLDivElement | undefined;

  afterEach(() => {
    flushSync(() => gateRoot?.unmount());
    gateRoot = undefined;
    gateContainer?.remove();
    gateContainer = undefined;
  });

  function writableFor(runtime: unknown, workspaceRole?: string): () => boolean {
    const store = createStore();
    store.set(runtimeAtom, runtime as never);
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useStatusViewWritable(workspaceRole));
      return null;
    }
    gateContainer = document.createElement('div');
    document.body.append(gateContainer);
    gateRoot = createRoot(gateContainer);
    flushSync(() =>
      gateRoot!.render(
        React.createElement(
          TestCloudPlatformProvider,
          null,
          React.createElement(JotaiProvider, { store }, React.createElement(Probe))
        )
      )
    );
    return () => seen.at(-1)!;
  }

  it('withholds status and section actions from an encrypted Guest until the ledger grants write', () => {
    let role: 'read' | 'write' = 'read';
    const listeners = new Set<() => void>();
    const latest = writableFor({
      workspaceId: 'ws-e2ee',
      contentMode: 'e2ee',
      protectedCodeCollabRole: {
        get: () => role,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });
    expect(latest()).toBe(false);

    role = 'write';
    flushSync(() => {
      for (const listener of listeners) listener();
    });
    expect(latest()).toBe(true);
  });

  it('withholds them from a known read-only membership of an ordinary workspace only', () => {
    const ordinary = { workspaceId: 'ws-plain', contentMode: 'plaintext' };
    expect(writableFor(ordinary, 'guest')()).toBe(false);
  });

  it('keeps them for members and while the membership is still unknown', () => {
    const ordinary = { workspaceId: 'ws-plain', contentMode: 'plaintext' };
    expect(writableFor(ordinary, 'member')()).toBe(true);
    flushSync(() => gateRoot?.unmount());
    gateContainer?.remove();
    expect(writableFor(ordinary)()).toBe(true);
  });
});

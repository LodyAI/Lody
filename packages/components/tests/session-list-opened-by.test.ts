// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import {
  buildGroups,
  getSessionGroupActivityStatus,
  getVisibleSessionGroupRows,
  getVisibleSessionGroupTree,
  MAX_VISIBLE_SESSIONS,
  SessionList,
  sessionGroupOverflowsPreview,
  type SessionListRow,
} from '../src/components/session-list';
import { sidebarCollapsedOpenedBySessionsAtom } from '../src/atoms/focus-layer';
import { initI18n } from '../src/i18n';

const REPO = 'loro-dev/lody';

function makeRow(overrides: Partial<SessionListRow> & { sessionId: string }): SessionListRow {
  return {
    title: `Session ${overrides.sessionId}`,
    repoFullName: REPO,
    branchName: '',
    latestMessageAt: '2026-04-22T00:00:00.000Z',
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
    ...overrides,
  };
}

/** Opener + three MCP-opened independent sessions, plus an unrelated session. */
function makeOpenerGroupRows(): SessionListRow[] {
  return [
    makeRow({ sessionId: 'opener', latestMessageAt: '2026-04-22T10:00:00.000Z' }),
    makeRow({
      sessionId: 'opened-1',
      openedBySessionId: 'opener',
      latestMessageAt: '2026-04-22T09:30:00.000Z',
    }),
    makeRow({
      sessionId: 'opened-2',
      openedBySessionId: 'opener',
      isWorking: true,
      latestMessageAt: '2026-04-22T09:20:00.000Z',
    }),
    makeRow({
      sessionId: 'opened-3',
      openedBySessionId: 'opener',
      hasUnreadMessages: true,
      latestMessageAt: '2026-04-22T09:10:00.000Z',
    }),
    makeRow({ sessionId: 'unrelated', latestMessageAt: '2026-04-22T08:00:00.000Z' }),
  ];
}

function buildRepoGroup(sessions: SessionListRow[]) {
  const groups = buildGroups(sessions, [{ repoFullName: REPO, collapsed: false }], false);
  const group = groups.find((candidate) => candidate.repoFullName === REPO);
  if (!group) throw new Error('expected a repo group');
  return group;
}

describe('repository group activity', () => {
  it('preserves initialization and prioritizes permission over running', () => {
    expect(
      getSessionGroupActivityStatus([
        makeRow({ sessionId: 'initializing', isWorking: true, activityStatus: 'initializing' }),
      ])
    ).toBe('initializing');

    expect(
      getSessionGroupActivityStatus([
        makeRow({ sessionId: 'running', isWorking: true, activityStatus: 'running' }),
        makeRow({
          sessionId: 'permission',
          isWorking: true,
          isWaitingPermission: true,
          activityStatus: 'requestPermission',
        }),
      ])
    ).toBe('requestPermission');
  });
});

describe('session group opened-by tree', () => {
  it('renders opened sessions indented under their opener', () => {
    const group = buildRepoGroup(makeOpenerGroupRows());
    expect(
      getVisibleSessionGroupTree(group, true).map((node) => [node.item.sessionId, node.depth])
    ).toEqual([
      ['opener', 0],
      ['opened-1', 1],
      ['opened-2', 1],
      ['opened-3', 1],
      ['unrelated', 0],
    ]);
  });

  it('hides opened sessions while their opener is collapsed', () => {
    const group = buildRepoGroup(makeOpenerGroupRows());
    expect(
      getVisibleSessionGroupRows(group, true, { opener: true }).map((row) => row.sessionId)
    ).toEqual(['opener', 'unrelated']);
  });

  it('keeps an opened session top-level when its opener is not in the group (orphan)', () => {
    const group = buildRepoGroup([
      makeRow({ sessionId: 'visible' }),
      makeRow({ sessionId: 'orphan', openedBySessionId: 'opener-in-another-repo' }),
    ]);
    expect(getVisibleSessionGroupTree(group, true).map((node) => node.depth)).toEqual([0, 0]);
  });

  it('counts only top-level rows when deciding whether a group overflows the preview', () => {
    const openerRows = [
      makeRow({ sessionId: 'opener' }),
      ...Array.from({ length: MAX_VISIBLE_SESSIONS }, (_unused, index) =>
        makeRow({ sessionId: `opened-${index}`, openedBySessionId: 'opener' })
      ),
    ];
    expect(sessionGroupOverflowsPreview(buildRepoGroup(openerRows))).toBe(false);

    const flatRows = Array.from({ length: MAX_VISIBLE_SESSIONS + 1 }, (_unused, index) =>
      makeRow({ sessionId: `flat-${index}` })
    );
    expect(sessionGroupOverflowsPreview(buildRepoGroup(flatRows))).toBe(true);
  });

  it('keeps an opener and its opened sessions together inside the compact preview', () => {
    const rows = [
      ...Array.from({ length: MAX_VISIBLE_SESSIONS }, (_unused, index) =>
        makeRow({ sessionId: `flat-${index}` })
      ),
      makeRow({ sessionId: 'opener' }),
      makeRow({ sessionId: 'opened', openedBySessionId: 'opener' }),
    ];
    const visible = getVisibleSessionGroupRows(buildRepoGroup(rows), false).map(
      (row) => row.sessionId
    );
    expect(visible).toHaveLength(MAX_VISIBLE_SESSIONS);
    expect(visible).not.toContain('opened');
  });
});

describe('SessionList opened-by rendering', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    Object.defineProperty(window, 'matchMedia', {
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
    vi.restoreAllMocks();
  });

  function renderList(
    sessions: SessionListRow[],
    collapsed: Record<string, boolean> = {},
    repoCollapsed = false
  ) {
    const store = createStore();
    store.set(sidebarCollapsedOpenedBySessionsAtom, collapsed);
    const onSelectSession = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(SessionList, {
            sessions,
            repos: [{ repoFullName: REPO, collapsed: repoCollapsed }],
            onSelectSession,
          })
        )
      );
    });

    return { onSelectSession, store };
  }

  it('combines live work and an unread result only on a collapsed repository', () => {
    renderList(
      [
        makeRow({ sessionId: 'running', isWorking: true, activityStatus: 'running' }),
        makeRow({ sessionId: 'unread', hasUnreadMessages: true }),
      ],
      {},
      true
    );

    const indicator = container?.querySelector('[data-sidebar-repo-activity="running"]');
    expect(indicator?.getAttribute('aria-label')).toBe('Running · Unread messages');
    expect(indicator?.querySelector('[data-session-working-spinner]')).not.toBeNull();
    expect(indicator?.querySelector('[data-session-unread-overlay]')).not.toBeNull();
    expect(container?.querySelector('[data-sidebar-session-id]')).toBeNull();
  });

  it('shows only the unread dot when a collapsed repository has no live work', () => {
    renderList([makeRow({ sessionId: 'unread', hasUnreadMessages: true })], {}, true);

    const indicator = container?.querySelector('[data-sidebar-repo-activity="unread"]');
    expect(indicator?.getAttribute('aria-label')).toBe('Unread messages');
    expect(indicator?.querySelector('[data-session-working-spinner]')).toBeNull();
    expect(indicator?.querySelector('[data-session-row-indicator]')?.children).toHaveLength(1);
  });

  it('lets permission override unread on a collapsed repository', () => {
    const sessions = [
      makeRow({
        sessionId: 'permission',
        isWorking: true,
        isWaitingPermission: true,
        activityStatus: 'requestPermission',
      }),
      makeRow({ sessionId: 'unread', hasUnreadMessages: true }),
    ];
    renderList(sessions, {}, true);

    const indicator = container?.querySelector('[data-sidebar-repo-activity="requestPermission"]');
    expect(indicator?.getAttribute('aria-label')).toBe('Request Permission');
    expect(indicator?.querySelector('[data-session-working-spinner]')).toBeNull();
    expect(indicator?.querySelector('[data-session-unread-overlay]')).toBeNull();
  });

  it('hides repository aggregation while the individual Session rows are expanded', () => {
    renderList([
      makeRow({ sessionId: 'running', isWorking: true, activityStatus: 'running' }),
      makeRow({ sessionId: 'unread', hasUnreadMessages: true }),
    ]);

    expect(container?.querySelector('[data-sidebar-repo-activity]')).toBeNull();
    expect(container?.querySelector('[data-sidebar-session-id="running"]')).not.toBeNull();
    expect(container?.querySelector('[data-sidebar-session-id="unread"]')).not.toBeNull();
  });

  function depthOf(sessionId: string): string | null | undefined {
    const row = container?.querySelector(`[data-sidebar-session-id="${sessionId}"]`);
    return row?.closest('[data-session-tree-depth]')?.getAttribute('data-session-tree-depth');
  }

  function indentOf(sessionId: string): string | null | undefined {
    const row = container?.querySelector(`[data-sidebar-session-id="${sessionId}"]`);
    return row?.closest('[data-session-tree-depth]')?.getAttribute('data-session-tree-indent');
  }

  it('marks opened sessions at depth 1 and their opener at depth 0', () => {
    renderList(makeOpenerGroupRows());
    expect(depthOf('opener')).toBe('0');
    expect(depthOf('opened-1')).toBe('1');
    expect(depthOf('opened-3')).toBe('1');
    expect(depthOf('unrelated')).toBe('0');
  });

  it('keeps every top-level row aligned and indents only children with tree connectors', () => {
    renderList(makeOpenerGroupRows());
    expect(indentOf('opener')).toBeNull();
    expect(indentOf('opened-1')).toBe('child');
    expect(indentOf('unrelated')).toBeNull();

    const openerRow = container
      ?.querySelector('[data-sidebar-session-id="opener"]')
      ?.closest('[data-session-tree-depth]');
    expect(openerRow?.getAttribute('data-session-tree-indent')).toBeNull();

    const childRow = container
      ?.querySelector('[data-sidebar-session-id="opened-1"]')
      ?.closest('[data-session-tree-depth]');
    const childSlot = childRow?.querySelector('[data-session-row-leading-slot]');
    expect(childRow?.getAttribute('data-session-tree-indent')).toBe('child');
    expect(childSlot?.className).toContain('w-[26px]');
    expect(childSlot?.querySelectorAll('[data-session-tree-connector]')).toHaveLength(2);
    expect(childSlot?.querySelector('[data-session-tree-connector="trunk"]')).not.toBeNull();
    expect(childSlot?.querySelector('[data-session-tree-connector="elbow"]')).not.toBeNull();
    expect(childSlot?.querySelector('button[aria-label="More actions"]')).not.toBeNull();

    const openerSlot = openerRow?.querySelector('[data-session-row-leading-slot]');
    expect(openerSlot?.querySelector('[data-session-opened-by-toggle]')).not.toBeNull();
    expect(openerSlot?.querySelector('button[aria-label="More actions"]')).not.toBeNull();
  });

  it('renders no tree gutter for a list without any opened session', () => {
    renderList([makeRow({ sessionId: 'a' }), makeRow({ sessionId: 'b' })]);
    expect(container?.querySelector('[data-session-tree-depth]')).toBeNull();
  });

  it('renders exactly one disclosure toggle, on the opener row', () => {
    renderList(makeOpenerGroupRows());
    const toggles = container?.querySelectorAll('[data-session-opened-by-toggle]') ?? [];
    expect(toggles).toHaveLength(1);
    expect(toggles[0]?.getAttribute('aria-expanded')).toBe('true');
  });

  it('collapsing the opener hides its opened rows and keeps the opener visible', () => {
    renderList(makeOpenerGroupRows());
    const toggle = container?.querySelector<HTMLButtonElement>('[data-session-opened-by-toggle]');
    expect(toggle).not.toBeNull();

    flushSync(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(container?.querySelector('[data-sidebar-session-id="opener"]')).not.toBeNull();
    expect(container?.querySelector('[data-sidebar-session-id="opened-1"]')).toBeNull();
    expect(
      container?.querySelector('[data-session-opened-by-toggle]')?.getAttribute('aria-expanded')
    ).toBe('false');
  });

  it('does not navigate when the disclosure toggle is clicked', () => {
    const { onSelectSession } = renderList(makeOpenerGroupRows());
    const toggle = container?.querySelector<HTMLButtonElement>('[data-session-opened-by-toggle]');
    flushSync(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('offers the same collapse action from the opener context menu', () => {
    renderList(makeOpenerGroupRows());
    const opener = container?.querySelector('[data-sidebar-session-id="opener"]');

    flushSync(() => {
      opener?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });

    const collapseItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
      item.textContent?.includes('Hide opened sessions')
    );
    expect(collapseItem).toBeDefined();

    flushSync(() => {
      collapseItem?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(container?.querySelector('[data-sidebar-session-id="opened-1"]')).toBeNull();
    expect(
      container?.querySelector('[data-session-opened-by-toggle]')?.getAttribute('aria-expanded')
    ).toBe('false');
  });

  it('shows the working spinner instead of the disclosure on a working opener', () => {
    renderList([
      makeRow({ sessionId: 'opener', isWorking: true }),
      makeRow({ sessionId: 'opened-1', openedBySessionId: 'opener' }),
    ]);

    const openerSlot = container
      ?.querySelector('[data-sidebar-session-id="opener"]')
      ?.querySelector('[data-session-row-leading-slot]');
    expect(openerSlot?.querySelector('[data-session-working-spinner]')).not.toBeNull();
    expect(openerSlot?.querySelector('[data-session-opened-by-toggle]')).toBeNull();
  });

  it('keeps collapse reachable from the context menu while the opener is working', () => {
    renderList([
      makeRow({ sessionId: 'opener', isWorking: true }),
      makeRow({ sessionId: 'opened-1', openedBySessionId: 'opener' }),
    ]);
    const opener = container?.querySelector('[data-sidebar-session-id="opener"]');

    flushSync(() => {
      opener?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });

    const collapseItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
      item.textContent?.includes('Hide opened sessions')
    );
    expect(collapseItem).toBeDefined();

    flushSync(() => {
      collapseItem?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(container?.querySelector('[data-sidebar-session-id="opened-1"]')).toBeNull();
  });

  it('hides tree connectors on an active child and keeps them on an idle child', () => {
    renderList(makeOpenerGroupRows());

    const slotOf = (sessionId: string) =>
      container
        ?.querySelector(`[data-sidebar-session-id="${sessionId}"]`)
        ?.querySelector('[data-session-row-leading-slot]');

    const idleSlot = slotOf('opened-1');
    expect(idleSlot?.querySelector('[data-session-row-indicator]')).toBeNull();
    expect(idleSlot?.querySelectorAll('[data-session-tree-connector]')).toHaveLength(2);

    const workingSlot = slotOf('opened-2');
    expect(workingSlot?.querySelector('[data-session-tree-connector]')).toBeNull();
    expect(workingSlot?.querySelector('[data-session-working-spinner]')).not.toBeNull();

    const unreadSlot = slotOf('opened-3');
    expect(unreadSlot?.querySelector('[data-session-tree-connector]')).toBeNull();
    expect(unreadSlot?.querySelector('[data-session-row-indicator] span')).not.toBeNull();
  });

  it('hides the opener disclosure for an unread or waiting opener, not just a working one', () => {
    // The disclosure branch REPLACES the indicator, so gating only on
    // `isWorking` makes an unread opener render a chevron and silently lose its
    // unread dot. Every status that would draw a mark has to take the node.
    for (const status of [{ hasUnreadMessages: true }, { isWaitingPermission: true }] as const) {
      renderList([
        makeRow({ sessionId: 'opener', ...status }),
        makeRow({ sessionId: 'opened-1', openedBySessionId: 'opener' }),
      ]);

      const openerSlot = container
        ?.querySelector('[data-sidebar-session-id="opener"]')
        ?.querySelector('[data-session-row-leading-slot]');
      expect(openerSlot?.querySelector('[data-session-opened-by-toggle]')).toBeNull();
      // The status mark it would otherwise have lost.
      expect(openerSlot?.querySelector('[data-session-row-indicator]')?.children.length).toBe(1);

      // The tree itself is untouched — only the affordance yields.
      expect(
        container
          ?.querySelector('[data-sidebar-session-id="opened-1"]')
          ?.querySelectorAll('[data-session-tree-connector]')
      ).toHaveLength(2);
    }
  });

  it('renders an active opened session as the selected row', () => {
    const store = createStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(SessionList, {
            sessions: makeOpenerGroupRows(),
            repos: [{ repoFullName: REPO, collapsed: false }],
            selectedSessionId: 'opened-2',
            onSelectSession: vi.fn(),
          })
        )
      );
    });

    const row = container?.querySelector('[data-sidebar-session-id="opened-2"]');
    expect(row?.className).toContain('bg-sidebar-foreground/10');
    expect(row?.querySelector('[data-session-working-spinner]')).not.toBeNull();
  });
});

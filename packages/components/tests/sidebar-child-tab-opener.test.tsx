// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import type { MachineId, SessionId, SessionMeta } from '@lody/shared';

import {
  buildSessionListRows,
  buildSessionMetaById,
  resolveSidebarOpenerRowId,
} from '../src/components/sessions/session-list-rows';
import {
  buildGroups,
  getVisibleSessionGroupRows,
  getVisibleSessionGroupTree,
  SessionList,
  type SessionListRow,
} from '../src/components/session-list';
import {
  getVisibleUpdatedItems,
  sortUpdatedItems,
  type SidebarUpdatedItem,
} from '../src/components/sidebar-updated-session-list';
import { buildSidebarNavigationItems } from '../src/components/sidebar-navigation-model';
import type { SidebarNavItem } from '../src/atoms/focus-layer';
import { initI18n } from '../src/i18n';

const machineId = 'machine-1' as MachineId;
const REPO = 'loro-dev/lody';

function makeSession(overrides: Partial<SessionMeta> & { id: string }): SessionMeta {
  return {
    machineId,
    createdAt: '2026-05-09T10:00:00.000Z',
    userId: 'user-1',
    cliType: 'builtin',
    agentType: 'codex',
    ...overrides,
    id: overrides.id as SessionId,
  } as SessionMeta;
}

/**
 * The production shape this feature exists for: a root Session, one of its child
 * Tabs (never a sidebar row), and an independent Session the agent created from
 * INSIDE that Tab via `lody_session_create`.
 */
const ROOT = makeSession({ id: 'root', lastMessageAt: 3_000 });
const CHILD_TAB = makeSession({
  id: 'child-tab',
  parentSessionId: 'root' as SessionId,
  lastMessageAt: 4_000,
});
const OPENED_FROM_TAB = makeSession({
  id: 'opened-from-tab',
  openedBySessionId: 'child-tab' as SessionId,
  lastMessageAt: 2_000,
});
const ALL_SESSIONS = [ROOT, CHILD_TAB, OPENED_FROM_TAB];

describe('resolveSidebarOpenerRowId', () => {
  const byId = buildSessionMetaById(ALL_SESSIONS);

  it('maps a child-tab opener to the root Session that owns a sidebar row', () => {
    expect(resolveSidebarOpenerRowId('child-tab', byId)).toBe('root');
  });

  it('returns a root opener unchanged', () => {
    expect(resolveSidebarOpenerRowId('root', byId)).toBe('root');
  });

  it('returns an unknown opener unchanged, leaving the orphan fallback to decide', () => {
    expect(resolveSidebarOpenerRowId('never-synced', byId)).toBe('never-synced');
  });

  it('treats an empty opener as absent', () => {
    expect(resolveSidebarOpenerRowId('   ', byId)).toBeNull();
    expect(resolveSidebarOpenerRowId(undefined, byId)).toBeNull();
  });

  it('walks more than one level, in case nesting ever deepens', () => {
    const deep = buildSessionMetaById([
      makeSession({ id: 'a' }),
      makeSession({ id: 'b', parentSessionId: 'a' as SessionId }),
      makeSession({ id: 'c', parentSessionId: 'b' as SessionId }),
    ]);
    expect(resolveSidebarOpenerRowId('c', deep)).toBe('a');
  });

  it('terminates on a parentSessionId cycle instead of hanging', () => {
    const cyclic = buildSessionMetaById([
      makeSession({ id: 'x', parentSessionId: 'y' as SessionId }),
      makeSession({ id: 'y', parentSessionId: 'x' as SessionId }),
    ]);
    expect(['x', 'y']).toContain(resolveSidebarOpenerRowId('x', cyclic));
  });

  it('never rewrites the precise opener on the session itself', () => {
    // Guard against "just set openedBySessionId to the root": provenance must
    // stay exact so navigation lands on the Tab that actually created it.
    expect(OPENED_FROM_TAB.openedBySessionId).toBe('child-tab');
  });
});

describe('buildSessionListRows child-tab provenance', () => {
  const rows = buildSessionListRows(
    // Sidebar rows exclude child Tabs, exactly like `sessionListAtom`.
    [ROOT, OPENED_FROM_TAB],
    { scope: 'my', currentUserId: 'user-1', defaultTitle: 'Untitled' },
    ALL_SESSIONS
  );
  const opened = rows.find((row) => row.sessionId === 'opened-from-tab');

  it('keeps the precise child-tab opener for navigation', () => {
    expect(opened?.openedBySessionId).toBe('child-tab');
  });

  it('resolves the nesting row to the root Session', () => {
    expect(opened?.openedByRowSessionId).toBe('root');
  });

  it('uses the persisted root when the opener Tab metadata has not synced', () => {
    const persisted = buildSessionListRows(
      [
        ROOT,
        makeSession({
          id: 'persisted-relation',
          openedBySessionId: 'not-synced-child-tab' as SessionId,
          openedByRootSessionId: 'root' as SessionId,
        }),
      ],
      { scope: 'my', currentUserId: 'user-1', defaultTitle: 'Untitled' },
      [ROOT]
    ).find((row) => row.sessionId === 'persisted-relation');
    expect(persisted?.openedBySessionId).toBe('not-synced-child-tab');
    expect(persisted?.openedByRowSessionId).toBe('root');
  });

  it('leaves a root-opened Session pointing at the same id in both fields', () => {
    const direct = buildSessionListRows(
      [ROOT, makeSession({ id: 'direct', openedBySessionId: 'root' as SessionId })],
      { scope: 'my', currentUserId: 'user-1', defaultTitle: 'Untitled' },
      [ROOT, makeSession({ id: 'direct', openedBySessionId: 'root' as SessionId })]
    ).find((row) => row.sessionId === 'direct');
    expect(direct?.openedBySessionId).toBe('root');
    expect(direct?.openedByRowSessionId).toBe('root');
  });

  it('does not turn the child Tab into a sidebar row', () => {
    expect(rows.map((row) => row.sessionId)).toEqual(['root', 'opened-from-tab']);
  });
});

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

const CHILD_TAB_GROUP_ROWS: SessionListRow[] = [
  makeRow({ sessionId: 'root', latestMessageAt: '2026-04-22T10:00:00.000Z' }),
  makeRow({
    sessionId: 'opened-from-tab',
    openedBySessionId: 'child-tab',
    openedByRowSessionId: 'root',
    latestMessageAt: '2026-04-22T09:00:00.000Z',
  }),
  makeRow({ sessionId: 'unrelated', latestMessageAt: '2026-04-22T08:00:00.000Z' }),
];

function buildRepoGroup(sessions: SessionListRow[]) {
  const group = buildGroups(sessions, [{ repoFullName: REPO, collapsed: false }], false).find(
    (candidate) => candidate.repoFullName === REPO
  );
  if (!group) throw new Error('expected a repo group');
  return group;
}

describe('Workspace group nesting for a child-tab opener', () => {
  it('indents the Session under the root row, not as an orphan', () => {
    expect(
      getVisibleSessionGroupTree(buildRepoGroup(CHILD_TAB_GROUP_ROWS), true).map((node) => [
        node.item.sessionId,
        node.depth,
      ])
    ).toEqual([
      ['root', 0],
      ['opened-from-tab', 1],
      ['unrelated', 0],
    ]);
  });

  it('collapsing the root hides the Session its child Tab opened', () => {
    expect(
      getVisibleSessionGroupRows(buildRepoGroup(CHILD_TAB_GROUP_ROWS), true, {
        root: true,
      }).map((row) => row.sessionId)
    ).toEqual(['root', 'unrelated']);
  });

  it('falls back to top-level when the root is not in this group either', () => {
    const group = buildRepoGroup([
      makeRow({ sessionId: 'elsewhere' }),
      makeRow({
        sessionId: 'opened-from-tab',
        openedBySessionId: 'child-tab',
        openedByRowSessionId: 'root-in-another-repo',
      }),
    ]);
    expect(getVisibleSessionGroupTree(group, true).map((node) => node.depth)).toEqual([0, 0]);
  });
});

describe('Updated list nesting for a child-tab opener', () => {
  function makeItem(overrides: Partial<SidebarUpdatedItem> & { id: string }): SidebarUpdatedItem {
    return {
      kind: 'chat',
      title: `Session ${overrides.id}`,
      sectionLabel: 'Chats',
      latestMessageAt: '2026-04-22T00:00:00.000Z',
      ...overrides,
    };
  }

  const items = sortUpdatedItems([
    makeItem({ id: 'root', latestMessageAt: '2026-04-22T10:00:00.000Z' }),
    makeItem({
      id: 'opened-from-tab',
      openedBySessionId: 'child-tab',
      openedByRowSessionId: 'root',
      latestMessageAt: '2026-04-22T09:00:00.000Z',
    }),
    makeItem({ id: 'unrelated', latestMessageAt: '2026-04-22T08:00:00.000Z' }),
  ]);

  it('nests under the root row', () => {
    expect(getVisibleUpdatedItems(items, true, false).map((item) => item.id)).toEqual([
      'root',
      'opened-from-tab',
      'unrelated',
    ]);
  });

  it('hides it behind a collapsed root', () => {
    expect(
      getVisibleUpdatedItems(items, true, false, { root: true }).map((item) => item.id)
    ).toEqual(['root', 'unrelated']);
  });

  it('does not nest across the Pinned/Updated boundary', () => {
    // Root pinned into the other section: the opened row stays top-level.
    const updatedOnly = sortUpdatedItems([
      makeItem({
        id: 'opened-from-tab',
        openedBySessionId: 'child-tab',
        openedByRowSessionId: 'root',
      }),
      makeItem({ id: 'unrelated' }),
    ]);
    expect(getVisibleUpdatedItems(updatedOnly, true, false).map((item) => item.id)).toEqual([
      'opened-from-tab',
      'unrelated',
    ]);
  });
});

function sessionIds(items: SidebarNavItem[]): string[] {
  return items.flatMap((item) => (item.kind === 'session' ? [item.sessionId] : []));
}

const navBase = {
  organizeMode: 'workspace' as const,
  showFullSessionGroups: {},
  pinnedItems: [] as SidebarUpdatedItem[],
  pinnedSectionCollapsed: false,
  workspace: {
    localSections: [],
    githubSectionCollapsed: false,
    repoSessions: [] as SessionListRow[],
    repos: [] as { repoFullName: string; collapsed: boolean }[],
    chatSessions: [] as SessionListRow[],
    chatsCollapsed: false,
  },
  updated: { items: [] as SidebarUpdatedItem[], collapsed: false, showFull: false },
};

describe('keyboard navigation for a child-tab opener', () => {
  it('visits the opened Session right after the root row in a Workspace group', () => {
    const items = buildSidebarNavigationItems({
      ...navBase,
      workspace: {
        ...navBase.workspace,
        repoSessions: CHILD_TAB_GROUP_ROWS,
        repos: [{ repoFullName: REPO, collapsed: false }],
      },
    });
    expect(sessionIds(items)).toEqual(['root', 'opened-from-tab', 'unrelated']);
  });

  it('skips it while the root is collapsed', () => {
    const items = buildSidebarNavigationItems({
      ...navBase,
      collapsedOpenedBySessions: { root: true },
      workspace: {
        ...navBase.workspace,
        repoSessions: CHILD_TAB_GROUP_ROWS,
        repos: [{ repoFullName: REPO, collapsed: false }],
      },
    });
    expect(sessionIds(items)).toEqual(['root', 'unrelated']);
  });

  it('matches the local-project section render order', () => {
    const items = buildSidebarNavigationItems({
      ...navBase,
      workspace: {
        ...navBase.workspace,
        localSections: [
          {
            collapsed: false,
            projects: [
              {
                machineId: 'machine-1',
                localProjectId: 'proj-1',
                collapsed: false,
                showFull: false,
                sessions: [
                  { id: 'root', rootRankMs: 3_000 },
                  { id: 'unrelated', rootRankMs: 2_500 },
                  { id: 'opened-from-tab', openedByRowSessionId: 'root', rootRankMs: 2_000 },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(sessionIds(items)).toEqual(['root', 'opened-from-tab', 'unrelated']);
  });
});

describe('SessionList child-tab opener rendering', () => {
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

  function renderList() {
    const store = createStore();
    const onSelectSession = vi.fn();
    const onNavigateSessionTab = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(SessionList, {
            sessions: CHILD_TAB_GROUP_ROWS,
            repos: [{ repoFullName: REPO, collapsed: false }],
            onSelectSession,
            onNavigateSessionTab,
          })
        )
      );
    });
    return { onNavigateSessionTab, onSelectSession };
  }

  it('renders the Session at depth 1 under the root row', () => {
    renderList();
    const row = container?.querySelector('[data-sidebar-session-id="opened-from-tab"]');
    expect(row?.closest('[data-session-tree-depth]')?.getAttribute('data-session-tree-depth')).toBe(
      '1'
    );
  });

  it('"Go to Opener Session" routes through the root and restores the exact child Tab', () => {
    const { onNavigateSessionTab, onSelectSession } = renderList();
    const row = container?.querySelector('[data-sidebar-session-id="opened-from-tab"]');
    expect(row).not.toBeNull();

    flushSync(() => {
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });

    const openerItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
      item.textContent?.includes('Go to Opener Session')
    );
    expect(openerItem).toBeDefined();

    flushSync(() => {
      openerItem?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(onNavigateSessionTab).toHaveBeenCalledWith('root', 'child-tab');
    expect(onSelectSession).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { buildOpenedBySessionTree } from '../src/lib/session-opened-by-tree';
import {
  buildGroups,
  getVisibleSessionGroupRows,
  getVisibleSessionGroupTree,
  MAX_VISIBLE_SESSIONS,
  SessionList,
  sessionGroupOverflowsPreview,
  type SessionListRow,
} from '../src/components/session-list';
import type { LocalProjectId, MachineId, SessionId, SessionMeta } from '@lody/shared';
import {
  buildSessionListRows,
  placeWorkspaceSessionsWithOpeners,
  type WorkspaceSidebarGroups,
} from '../src/components/sessions/session-list-rows';
import { sidebarCollapsedOpenedBySessionsAtom } from '../src/atoms/focus-layer';
import { sidebarShowBranchNamesAtom } from '../src/atoms/sidebar-state';
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

describe('session group opened-by tree', () => {
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
    showBranchNames = false
  ) {
    const store = createStore();
    store.set(sidebarCollapsedOpenedBySessionsAtom, collapsed);
    store.set(sidebarShowBranchNamesAtom, showBranchNames);
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
            repos: [{ repoFullName: REPO, collapsed: false }],
            onSelectSession,
          })
        )
      );
    });

    return { onSelectSession, store };
  }

  function indentOf(sessionId: string): string | null | undefined {
    const row = container?.querySelector(`[data-sidebar-session-id="${sessionId}"]`);
    return row?.closest('[data-session-tree-depth]')?.getAttribute('data-session-tree-indent');
  }

  it('keeps all descendants at one visual indentation regardless of conversation depth', () => {
    renderList([
      makeRow({ sessionId: 'opener' }),
      makeRow({ sessionId: 'child', openedBySessionId: 'opener' }),
      makeRow({ sessionId: 'grandchild', openedBySessionId: 'child' }),
      makeRow({ sessionId: 'great-grandchild', openedBySessionId: 'grandchild' }),
      makeRow({ sessionId: 'unrelated' }),
    ]);
    expect(indentOf('opener')).toBeNull();
    expect(indentOf('unrelated')).toBeNull();
    for (const id of ['child', 'grandchild', 'great-grandchild']) {
      expect(indentOf(id)).toBe('child');
    }
  });

  it('lets the disclosure toggle own keyboard activation without navigating', () => {
    const { onSelectSession } = renderList(makeOpenerGroupRows());
    const toggle = container?.querySelector<HTMLButtonElement>('[data-session-opened-by-toggle]');
    expect(toggle).not.toBeNull();

    const keydown = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    flushSync(() => {
      toggle?.dispatchEvent(keydown);
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(keydown.defaultPrevented).toBe(false);
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(container?.querySelector('[data-sidebar-session-id="opened-1"]')).toBeNull();
  });

  it('gives a top-level row a branch and time line and keeps nested children to one line', () => {
    renderList(
      [
        makeRow({ sessionId: 'opener', branchName: 'feat/two-line' }),
        makeRow({ sessionId: 'opened-1', openedBySessionId: 'opener', branchName: 'feat/child' }),
      ],
      {},
      true
    );

    const opener = container?.querySelector('[data-sidebar-session-id="opener"]');
    const child = container?.querySelector('[data-sidebar-session-id="opened-1"]');
    expect(opener?.querySelector('[data-sidebar-session-meta]')?.textContent).toContain(
      'feat/two-line'
    );
    expect(child?.querySelector('[data-sidebar-session-meta]')).toBeNull();
  });

  it('collapses repo rows to one line when the branch detail preference is off', () => {
    const { store } = renderList(
      [
        makeRow({ sessionId: 'opener', branchName: 'feat/two-line' }),
        makeRow({ sessionId: 'opened-1', openedBySessionId: 'opener', branchName: 'feat/child' }),
      ],
      {},
      true
    );
    flushSync(() => {
      store.set(sidebarShowBranchNamesAtom, false);
    });

    expect(container?.querySelector('[data-sidebar-session-meta]')).toBeNull();
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
});

describe('Workspace placement under openers across groups', () => {
  const PROJECT_KEY = 'machine-local:project-1';
  const meta = (overrides: Partial<SessionMeta> & { id: string }): SessionMeta =>
    ({
      machineId: 'machine-local' as MachineId,
      createdAt: '2026-05-09T10:00:00.000Z',
      userId: 'user-1',
      cliType: 'builtin',
      agentType: 'codex',
      ...overrides,
      id: overrides.id as SessionId,
    }) as SessionMeta;
  const localProject = {
    kind: 'local',
    localProjectId: 'project-1' as LocalProjectId,
  } as const;
  const toTaskRows = (sessions: SessionMeta[]) =>
    buildSessionListRows(sessions, {
      scope: 'my',
      currentUserId: 'user-1',
      defaultTitle: 'Untitled',
    });
  const place = (
    natural: WorkspaceSidebarGroups,
    sessions: SessionMeta[],
    rendered: (key: string) => boolean = (key) => key === PROJECT_KEY
  ) =>
    placeWorkspaceSessionsWithOpeners(natural, {
      sessions,
      isRenderedLocalProject: rendered,
      resolveOpenerRowId: (id) => id ?? null,
      toTaskRows,
      latestMessageAt: (session) => session.lastMessageAt ?? 0,
    });

  it('nests a remote plain chat opened from a Local Project under its opener there', () => {
    const opener = meta({ id: 'opener', project: localProject, lastMessageAt: 1_000 });
    const remoteChat = meta({
      id: 'remote-chat',
      machineId: 'machine-remote' as MachineId,
      openedBySessionId: 'opener' as SessionId,
      lastMessageAt: 2_000,
    });
    const placed = place(
      {
        chatSessions: toTaskRows([remoteChat]),
        repoSessions: [],
        projectGroupSessions: [],
        localProjectSessionsByKey: new Map([[PROJECT_KEY, [opener]]]),
      },
      [opener, remoteChat]
    );

    expect(placed.chatSessions).toEqual([]);
    expect(placed.localProjectSessionsByKey.get(PROJECT_KEY)?.map((s) => s.id)).toEqual([
      'remote-chat',
      'opener',
    ]);
    const tree = buildOpenedBySessionTree(placed.localProjectSessionsByKey.get(PROJECT_KEY) ?? [], {
      getId: (session) => session.id,
      getOpenedBySessionId: (session) => session.openedBySessionId ?? null,
    });
    expect(tree.map((node) => `${node.id}@${node.depth}`)).toEqual(['opener@0', 'remote-chat@1']);
  });

  it('renders a Local Project Session opened from a GitHub Session as a row of that repo group', () => {
    const opener = makeRow({ sessionId: 'repo-opener' });
    const localChild = meta({
      id: 'local-child',
      project: localProject,
      openedBySessionId: 'repo-opener' as SessionId,
    });
    const placed = place(
      {
        chatSessions: [],
        repoSessions: [opener],
        projectGroupSessions: [],
        localProjectSessionsByKey: new Map([[PROJECT_KEY, [localChild]]]),
      },
      [localChild]
    );

    expect(placed.localProjectSessionsByKey.get(PROJECT_KEY)).toEqual([]);
    const [group] = buildGroups(placed.repoSessions, [], false);
    expect(group?.repoFullName).toBe(REPO);
    expect(
      getVisibleSessionGroupTree(group!, true).map((node) => `${node.id}@${node.depth}`)
    ).toEqual(['repo-opener@0', 'local-child@1']);
  });

  it('leaves a row in its own group when the opener is not rendered there', () => {
    const opener = meta({ id: 'opener', project: localProject });
    const chat = toTaskRows([meta({ id: 'chat', openedBySessionId: 'opener' as SessionId })]);
    const natural: WorkspaceSidebarGroups = {
      chatSessions: chat,
      repoSessions: [],
      projectGroupSessions: [],
      localProjectSessionsByKey: new Map([[PROJECT_KEY, [opener]]]),
    };
    // A hidden project (or a pinned opener, absent from every Workspace group)
    // cannot host the row, so it stays where it was.
    expect(place(natural, [opener], () => false)).toBe(natural);
  });
});

// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import type {
  LocalProjectId,
  MachineId,
  SessionId,
  SessionMeta,
  SessionStatus,
} from '@lody/shared';
import { LocalProjectItem } from '../src/components/loro-app-sidebar';
import { SessionList } from '../src/components/session-list';
import {
  getProjectActivityItems,
  type ProjectActivityCounts,
} from '../src/components/project-activity';
import {
  buildChildSessionsByParent,
  buildSessionListRows,
} from '../src/components/sessions/session-list-rows';
import { TooltipProvider } from '../src/ui/tooltip';
import { initI18n } from '../src/i18n';

const machineId = 'machine-test' as MachineId;
const projectId = 'project-test' as LocalProjectId;
// Counts are permission / unread / active; expected items retain the raw single count.
const cases: [string, [number, number, number], string][] = [
  ['idle', [0, 0, 0], ''],
  ['permission', [1, 0, 0], 'permission:1'],
  ['permissions', [2, 0, 0], 'permission:2'],
  ['unread', [0, 1, 0], 'unread:1'],
  ['unreads', [0, 3, 0], 'unread:3'],
  ['active', [0, 0, 1], 'active:1'],
  ['actives', [0, 0, 3], 'active:3'],
  ['permission + unread', [1, 1, 0], 'permission:1 unread:1'],
  ['permissions + unreads', [2, 3, 0], 'permission:2 unread:3'],
  ['permission + active', [1, 0, 1], 'permission:1 active:1'],
  ['permissions + actives', [2, 0, 2], 'permission:2 active:2'],
  ['unread + active', [0, 1, 1], 'unread:1 active:1'],
  ['unreads + actives', [0, 3, 2], 'unread:3 active:2'],
  ['three single states', [1, 1, 1], 'permission:1 more:2'],
  ['merged remainder', [2, 3, 2], 'permission:2 more:5'],
];
function countsFrom([permission, unread, active]: [number, number, number]): ProjectActivityCounts {
  return { permission, unread, active };
}
function expectedItems(value: string): [string, number][] {
  return value
    ? value.split(' ').map((item) => {
        const [status, count] = item.split(':');
        return [status!, Number(count)];
      })
    : [];
}

describe('collapsed project activity', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function renderProject(
    kind: 'project' | 'repo',
    counts: ProjectActivityCounts,
    options: {
      collapsed?: boolean;
      childTabs?: boolean;
      pinned?: boolean;
      removalState?: 'removing' | 'waiting_for_device';
    } = {}
  ) {
    const sessions: SessionMeta[] = [];
    const liveSessionStatuses = new Map<string, SessionStatus>();
    for (const [status, count] of Object.entries(counts)) {
      for (let i = 0; i < count; i++) {
        const id = `${status}-${i}` as SessionId;
        sessions.push({
          id,
          machineId,
          userId: 'user-test',
          cliType: 'builtin',
          agentType: 'codex',
          title: id,
          createdAt: '2026-09-09T00:00:00Z',
          lastMessageAt: 2_000,
          lastReadAt: status === 'unread' ? 1_000 : 2_000,
          project:
            kind === 'repo'
              ? { kind: 'github', repoFullName: 'test/repo', branch: 'test' }
              : { kind: 'local', localProjectId: projectId },
          isPinned: options.pinned && i === 0,
          parentSessionId: options.childTabs && sessions.length ? sessions[0]!.id : undefined,
        });
        if (status !== 'unread')
          liveSessionStatuses.set(id, {
            type:
              status === 'permission' ? 'requestPermission' : i % 2 ? 'initializing' : 'running',
          });
      }
    }
    const parents = sessions.filter((s) => !s.parentSessionId);
    const rows = buildSessionListRows(
      parents,
      { scope: 'my', currentUserId: 'user-test', defaultTitle: '', liveSessionStatuses },
      sessions
    );
    const collapsed = options.collapsed ?? true;
    const view =
      kind === 'repo' ? (
        <SessionList
          sessions={rows.filter((row) => !row.isPinned)}
          activitySessions={rows}
          repos={[{ repoFullName: 'test/repo', collapsed }]}
          onNew={() => {}}
          onToggleRepoCollapsed={() => {}}
        />
      ) : (
        <LocalProjectItem
          machineId={machineId}
          project={{ id: projectId, name: 'test-project', rootPath: '/test', createdAtMs: 0 }}
          collapsed={collapsed}
          isSelected={false}
          canNavigateProject
          canRemoveProject
          sessionsForProject={parents.filter((s) => !s.isPinned)}
          activitySessionsForProject={parents}
          childSessionsByParent={buildChildSessionsByParent(sessions)}
          liveSessionStatuses={liveSessionStatuses}
          formattedPath="/test"
          defaultSessionTitle="Untitled"
          selectedSessionId={null}
          removeProjectLabel="Remove folder"
          archiveTooltipLabel="Archive"
          archiveActionLabel="Archive"
          archiveConfirmLabel="Confirm"
          isMobile={false}
          toggleLabel="Toggle"
          newChatLabel="New session"
          removalState={options.removalState}
          onNavigateProject={() => {}}
          onNavigateSession={() => {}}
          onArchive={() => {}}
          onToggleCollapsed={() => {}}
          onRequestRemoval={() => {}}
          onNewChatInProject={() => {}}
          onOpenProjectSettings={() => {}}
        />
      );
    flushSync(() =>
      root.render(
        <Provider store={createStore()}>
          <TooltipProvider>{view}</TooltipProvider>
        </Provider>
      )
    );
    return container.querySelector(`[data-sidebar-${kind}-activity]`);
  }

  it.each(cases)('selects at most two items: %s', (_name, counts, expected) => {
    const items = expectedItems(expected);
    expect(getProjectActivityItems(countsFrom(counts))).toEqual(
      items.map(([status, count]) => ({ status, count }))
    );
  });

  describe.each(['project', 'repo'] as const)('%s row', (kind) => {
    it.each(cases)('renders %s with counts and accessible detail', (_name, counts, expected) => {
      const items = expectedItems(expected);
      const label = counts
        .map((count, index) =>
          count ? `${count} ${['Request Permission', 'Unread messages', 'Running'][index]}` : ''
        )
        .filter(Boolean)
        .join(' · ');
      const indicator = renderProject(kind, countsFrom(counts));
      if (!items.length) {
        expect(indicator).toBeNull();
        return;
      }
      expect(indicator).not.toBeNull();
      const marks = [...indicator!.querySelectorAll('[data-project-activity-status]')];
      expect(
        marks.map((mark) => [mark.getAttribute('data-project-activity-status'), mark.textContent])
      ).toEqual(
        items.map(([status, count], index) => [
          status,
          status === 'more'
            ? `+${count}`
            : count > 1 || (index === 0 && items[1]?.[0] === 'more')
              ? String(count)
              : '',
        ])
      );
      const labelled = kind === 'repo' ? indicator : indicator!.closest('[aria-label]');
      expect(labelled?.getAttribute('aria-label')).toContain(label);
      for (const mark of marks) {
        const status = mark.getAttribute('data-project-activity-status');
        expect(Boolean(mark.querySelector('.lucide-hand'))).toBe(status === 'permission');
        expect(Boolean(mark.querySelector('[data-session-working-spinner]'))).toBe(
          status === 'active'
        );
      }
      expect(container.querySelector('button[aria-label="New session"]')).not.toBeNull();
      expect(container.querySelector('.lucide-chevron-down')).not.toBeNull();
    });

    it('hides the aggregate when expanded and preserves Session end status', () => {
      expect(
        renderProject(kind, { permission: 1, unread: 1, active: 1 }, { collapsed: false })
      ).toBeNull();
      expect(container.querySelectorAll('[data-sidebar-session-id]')).toHaveLength(3);
      expect(container.querySelectorAll('[data-session-row-indicator]')).toHaveLength(3);
    });

    it('preserves individual child-Tab counts even when the parent row shows permission', () => {
      const indicator = renderProject(
        kind,
        { permission: 2, unread: 3, active: 2 },
        { childTabs: true }
      );
      expect(indicator?.textContent).toBe('2+5');
    });

    it('includes pinned activity without adding pinned Sessions to the expanded group', () => {
      expect(
        renderProject(kind, { permission: 2, unread: 0, active: 0 }, { pinned: true })?.textContent
      ).toBe('2');
      renderProject(
        kind,
        { permission: 2, unread: 0, active: 0 },
        { pinned: true, collapsed: false }
      );
      expect(container.querySelectorAll('[data-sidebar-session-id]')).toHaveLength(1);
    });
  });

  it.each(['removing', 'waiting_for_device'] as const)(
    'gives %s its own local-project slot',
    (removalState) => {
      expect(
        renderProject('project', { permission: 2, unread: 3, active: 2 }, { removalState })
      ).toBeNull();
      expect(container.querySelector('[aria-label*="Request Permission"]')).toBeNull();
      expect(container.querySelector('button[aria-label="New session"]')).toBeNull();
      expect(container.textContent).toContain(
        removalState === 'removing' ? 'Removing…' : 'Waiting for device…'
      );
    }
  );
});

import { describe, expect, it } from 'vitest';

import { ONLY_CHATS_KEY, type SidebarNavItem } from '../src/atoms/focus-layer';
import { buildSidebarNavigationItems } from '../src/components/sidebar-navigation-model';
import type { SidebarUpdatedItem } from '../src/components/sidebar-updated-task-list';
import type { SessionListRow } from '../src/components/session-list';
import { placeProjectGroups } from '../src/lib/project-group-placement';
import type { LocalProjectId, MachineId, ProjectMemberId, WorkspaceProject } from '@lody/shared';

function sessionRow(
  sessionId: string,
  latestMessageAt: string,
  repoFullName?: string
): SessionListRow {
  return {
    sessionId,
    title: sessionId,
    repoFullName,
    branchName: '',
    latestMessageAt,
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
  };
}

function updatedItem(id: string, latestMessageAt: string): SidebarUpdatedItem {
  return {
    id,
    kind: 'chat',
    title: id,
    sectionLabel: 'Chats',
    latestMessageAt,
  };
}

function sessionIds(items: SidebarNavItem[]): string[] {
  return items.flatMap((item) => (item.kind === 'session' ? [item.sessionId] : []));
}

const baseOptions = {
  organizeMode: 'workspace' as const,
  showFullSessionGroups: {},
  pinnedItems: [] as SidebarUpdatedItem[],
  pinnedSectionCollapsed: false,
  workspace: {
    localSections: [],
    githubSectionCollapsed: false,
    repoSessions: [] as SessionListRow[],
    repos: [],
    chatSessions: [] as SessionListRow[],
    chatsCollapsed: false,
  },
  updated: {
    items: [] as SidebarUpdatedItem[],
    collapsed: false,
    showFull: false,
  },
};

describe('sidebar navigation model', () => {
  it('follows the rendered Workspace order with Chats last', () => {
    const items = buildSidebarNavigationItems({
      ...baseOptions,
      pinnedItems: [updatedItem('pinned', '2026-07-16T12:00:00Z')],
      workspace: {
        localSections: [
          {
            collapsed: false,
            projects: [
              {
                machineId: 'machine',
                localProjectId: 'project',
                collapsed: false,
                showFull: false,
                sessions: [{ id: 'local-new' }, { id: 'local-old' }],
              },
            ],
          },
        ],
        githubSectionCollapsed: false,
        repoSessions: [
          sessionRow('repo-old', '2026-07-16T08:00:00Z', 'loro-dev/lody'),
          sessionRow('repo-new', '2026-07-16T11:00:00Z', 'loro-dev/lody'),
        ],
        repos: [{ repoFullName: 'loro-dev/lody', collapsed: false }],
        chatSessions: [
          sessionRow('chat-old', '2026-07-16T07:00:00Z'),
          sessionRow('chat-new', '2026-07-16T10:00:00Z'),
        ],
        chatsCollapsed: false,
      },
    });

    expect(sessionIds(items)).toEqual([
      'pinned',
      'local-new',
      'local-old',
      'repo-new',
      'repo-old',
      'chat-new',
      'chat-old',
    ]);
    expect(items.at(-3)).toEqual({
      kind: 'group-header',
      groupKey: ONLY_CHATS_KEY,
      collapsed: false,
    });
  });

  it('uses the Updated projection instead of stale Workspace grouping', () => {
    const items = buildSidebarNavigationItems({
      ...baseOptions,
      organizeMode: 'updated',
      pinnedItems: [updatedItem('pinned', '2026-07-16T09:00:00Z')],
      workspace: {
        ...baseOptions.workspace,
        chatSessions: [sessionRow('workspace-only', '2026-07-16T12:00:00Z')],
      },
      updated: {
        items: [
          updatedItem('updated-old', '2026-07-16T08:00:00Z'),
          updatedItem('updated-new', '2026-07-16T11:00:00Z'),
        ],
        collapsed: false,
        showFull: false,
      },
    });

    expect(sessionIds(items)).toEqual(['pinned', 'updated-new', 'updated-old']);
  });

  it('matches collapsed sections and each list preview limit', () => {
    const repoSessions = Array.from({ length: 6 }, (_, index) =>
      sessionRow(`repo-${index}`, `2026-07-16T${String(index).padStart(2, '0')}:00:00Z`, 'repo')
    );
    const updatedItems = Array.from({ length: 21 }, (_, index) =>
      updatedItem(`updated-${index}`, `2026-07-16T${String(index).padStart(2, '0')}:00:00Z`)
    );

    const workspaceItems = buildSidebarNavigationItems({
      ...baseOptions,
      workspace: {
        localSections: [
          {
            collapsed: true,
            projects: [
              {
                machineId: 'machine',
                localProjectId: 'hidden-project',
                collapsed: false,
                showFull: false,
                sessions: [{ id: 'hidden-local' }],
              },
            ],
          },
        ],
        githubSectionCollapsed: false,
        repoSessions,
        repos: [{ repoFullName: 'repo', collapsed: false }],
        chatSessions: [sessionRow('hidden-chat', '2026-07-16T12:00:00Z')],
        chatsCollapsed: true,
      },
    });
    expect(sessionIds(workspaceItems)).toEqual(['repo-5', 'repo-4', 'repo-3', 'repo-2', 'repo-1']);

    const updatedPreview = buildSidebarNavigationItems({
      ...baseOptions,
      organizeMode: 'updated',
      updated: { items: updatedItems, collapsed: false, showFull: false },
    });
    expect(sessionIds(updatedPreview)).toHaveLength(20);

    const updatedCollapsed = buildSidebarNavigationItems({
      ...baseOptions,
      organizeMode: 'updated',
      pinnedItems: [updatedItem('pinned', '2026-07-16T12:00:00Z')],
      updated: { items: updatedItems, collapsed: true, showFull: true },
    });
    expect(sessionIds(updatedCollapsed)).toEqual(['pinned']);
  });

  it('matches the local-project preview and expanded list', () => {
    const localSessions = Array.from({ length: 7 }, (_, index) => ({
      id: `local-${index}`,
      rootRankMs: 7 - index,
    }));
    const localProject = {
      machineId: 'machine',
      localProjectId: 'project',
      collapsed: false,
      showFull: false,
      sessions: localSessions,
    };

    const preview = buildSidebarNavigationItems({
      ...baseOptions,
      workspace: {
        ...baseOptions.workspace,
        localSections: [{ collapsed: false, projects: [localProject] }],
      },
    });
    expect(sessionIds(preview)).toEqual(['local-0', 'local-1', 'local-2', 'local-3', 'local-4']);
    expect(preview.at(-1)).toEqual({
      kind: 'show-more',
      groupKey: 'local-project:machine:project',
      expanded: false,
    });

    const expanded = buildSidebarNavigationItems({
      ...baseOptions,
      workspace: {
        ...baseOptions.workspace,
        localSections: [{ collapsed: false, projects: [{ ...localProject, showFull: true }] }],
      },
    });
    expect(sessionIds(expanded)).toEqual(localSessions.map((session) => session.id));
    expect(expanded.at(-1)).toEqual({
      kind: 'show-more',
      groupKey: 'local-project:machine:project',
      expanded: true,
    });
  });
});

describe('sidebar navigation model opened-by tree', () => {
  it('visits opened sessions right after their opener in Updated mode', () => {
    const items = buildSidebarNavigationItems({
      ...baseOptions,
      organizeMode: 'updated',
      updated: {
        items: [
          updatedItem('opener', '2026-04-22T10:00:00.000Z'),
          { ...updatedItem('other', '2026-04-22T09:00:00.000Z') },
          { ...updatedItem('opened', '2026-04-22T08:00:00.000Z'), openedBySessionId: 'opener' },
        ],
        collapsed: false,
        showFull: false,
      },
    });

    expect(sessionIds(items)).toEqual(['opener', 'opened', 'other']);
  });

  it('skips opened sessions hidden behind a collapsed opener', () => {
    const items = buildSidebarNavigationItems({
      ...baseOptions,
      organizeMode: 'updated',
      collapsedOpenedBySessions: { opener: true },
      updated: {
        items: [
          updatedItem('opener', '2026-04-22T10:00:00.000Z'),
          { ...updatedItem('opened', '2026-04-22T08:00:00.000Z'), openedBySessionId: 'opener' },
          updatedItem('other', '2026-04-22T07:00:00.000Z'),
        ],
        collapsed: false,
        showFull: false,
      },
    });

    expect(sessionIds(items)).toEqual(['opener', 'other']);
  });

  it('does not nest across the Pinned/Updated section boundary', () => {
    // Opener is pinned (its own section); the Session it opened is not. Neither
    // list contains both, so both rows stay top-level in their own section.
    const items = buildSidebarNavigationItems({
      ...baseOptions,
      organizeMode: 'updated',
      pinnedItems: [{ ...updatedItem('opener', '2026-04-22T10:00:00.000Z'), isPinned: true }],
      updated: {
        items: [
          { ...updatedItem('opened', '2026-04-22T08:00:00.000Z'), openedBySessionId: 'opener' },
          updatedItem('other', '2026-04-22T07:00:00.000Z'),
        ],
        collapsed: false,
        showFull: false,
      },
    });

    expect(items.filter((item) => item.kind === 'session').map((item) => item.groupKey)).toEqual([
      '__pinned__',
      '__updated__',
      '__updated__',
    ]);
    expect(sessionIds(items)).toEqual(['opener', 'opened', 'other']);
  });

  it('nests inside the Pinned section when both rows are pinned', () => {
    const items = buildSidebarNavigationItems({
      ...baseOptions,
      pinnedItems: [
        { ...updatedItem('opener', '2026-04-22T10:00:00.000Z'), isPinned: true },
        { ...updatedItem('unrelated', '2026-04-22T09:00:00.000Z'), isPinned: true },
        {
          ...updatedItem('opened', '2026-04-22T08:00:00.000Z'),
          isPinned: true,
          openedBySessionId: 'opener',
        },
      ],
    });

    expect(sessionIds(items)).toEqual(['opener', 'opened', 'unrelated']);
  });

  it('lists a machine-bound project after the folders of its machine and the rest with GitHub', () => {
    const groupRow = (id: string, at: string, group: { id: string; name: string }) => ({
      ...sessionRow(id, at, 'acme/web'),
      projectGroup: group,
    });
    const shop = { id: 'shop', name: 'Shop' };
    const items = buildSidebarNavigationItems({
      ...baseOptions,
      workspace: {
        ...baseOptions.workspace,
        localSections: [
          {
            collapsed: false,
            projects: [
              {
                machineId: 'machine-1',
                localProjectId: 'notes',
                collapsed: true,
                showFull: false,
                sessions: [],
              },
            ],
            // Shop holds a folder without a remote, so it needs this machine.
            projectGroups: [{ projectId: 'shop', name: 'Shop', collapsed: false }],
            projectGroupSessions: [
              groupRow('group-old', '2026-04-22T08:00:00.000Z', shop),
              groupRow('group-new', '2026-04-22T09:00:00.000Z', shop),
            ],
          },
        ],
        // Repository-only projects run anywhere and sit with GitHub; a
        // deleted project's conversations keep their snapshot name there.
        projectGroups: [{ projectId: 'empty', name: 'Empty', collapsed: false }],
        repoSessions: [
          groupRow('orphan', '2026-04-22T07:00:00.000Z', { id: 'gone', name: 'Gone' }),
        ],
        chatSessions: [sessionRow('chat', '2026-04-22T10:00:00.000Z')],
      },
    });

    expect(
      items.flatMap((item) =>
        item.kind === 'group-header'
          ? [item.groupKey]
          : item.kind === 'local-project'
            ? [`local:${item.localProjectId}`]
            : []
      )
    ).toEqual([
      'local:notes',
      'projectGroup:shop',
      'projectGroup:empty',
      'projectGroup:gone',
      ONLY_CHATS_KEY,
    ]);
    expect(sessionIds(items)).toEqual(['group-new', 'group-old', 'orphan', 'chat']);
  });

  it('skips a machine-bound project while its machine is folded', () => {
    const items = buildSidebarNavigationItems({
      ...baseOptions,
      workspace: {
        ...baseOptions.workspace,
        localSections: [
          {
            collapsed: true,
            projects: [],
            projectGroups: [{ projectId: 'shop', name: 'Shop', collapsed: false }],
            projectGroupSessions: [
              {
                ...sessionRow('group-row', '2026-04-22T08:00:00.000Z'),
                projectGroup: { id: 'shop', name: 'Shop' },
              },
            ],
          },
        ],
      },
    });
    expect(items).toEqual([]);
  });

  it('lists GitHub-side projects only while they have conversations, like repositories', () => {
    const row = (id: string, group: { id: string; name: string }) => ({
      ...sessionRow(id, '2026-04-22T08:00:00.000Z', 'acme/web'),
      projectGroup: group,
    });
    const folder = (machineId: string): WorkspaceProject['members'] => [
      {
        id: 'm1' as ProjectMemberId,
        source: {
          kind: 'local',
          machineId: machineId as MachineId,
          localProjectId: 'notes' as LocalProjectId,
        },
        placement: { kind: 'root', dir: 'notes' },
      },
    ];
    const placed = placeProjectGroups({
      projects: [
        { id: 'local', members: folder('machine-1') },
        { id: 'idle', members: [] },
        { id: 'busy', members: [] },
      ],
      states: [
        { projectId: 'local', name: 'Local', collapsed: false },
        { projectId: 'idle', name: 'Idle', collapsed: false },
        { projectId: 'busy', name: 'Busy', collapsed: false },
        // Deleted, its restored conversation still names it; folded by the user.
        { projectId: 'gone', name: 'Gone', collapsed: true, removed: true },
      ],
      sessions: [
        row('busy-row', { id: 'busy', name: 'Busy' }),
        row('gone-row', { id: 'gone', name: 'Gone' }),
      ],
      listedMachineIds: new Set(['machine-1' as MachineId]),
    });
    const local = placed.byMachine.get('machine-1' as MachineId);
    const items = buildSidebarNavigationItems({
      ...baseOptions,
      workspace: {
        ...baseOptions.workspace,
        localSections: [
          {
            collapsed: false,
            projects: [],
            projectGroups: local?.states,
            projectGroupSessions: local?.sessions,
          },
        ],
        projectGroups: placed.anywhere.states,
        repoSessions: placed.anywhere.sessions,
      },
    });

    // A machine's project stays like its folders; an idle GitHub-side one does not.
    expect(items.flatMap((item) => (item.kind === 'group-header' ? [item.groupKey] : []))).toEqual([
      'projectGroup:local',
      'projectGroup:busy',
      'projectGroup:gone',
    ]);
    // The deleted project's group honours its fold.
    expect(sessionIds(items)).toEqual(['busy-row']);
  });
});

import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider } from 'jotai';
import { useMemo, useState } from 'react';
import type {
  LocalProjectId,
  LocalProjectMeta,
  MachineId,
  SessionId,
  SessionMeta,
  SessionStatus,
} from '@lody/shared';
import { Tooltip } from '@lody/ui/tooltip';
import { LocalProjectItem } from '@/components/loro-app-sidebar';
import { SessionList, type SessionListRow } from '@/components/session-list';
import {
  EMPTY_SIDEBAR_GROUP_ACTIVITY,
  SidebarSectionHeader,
} from '@/components/sidebar-row-shared';
const migrationStyles = stylex.create({
  group: {
    marginBottom: 'calc(var(--spacing) * 3)',
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 0.5)',
    },
  },
  rows: {
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 0.5)',
    },
  },
  collapsedGroup: { marginBottom: 'calc(var(--spacing) * 1)' },
  expandedGroup: { marginBottom: 'calc(var(--spacing) * 3)' },
});

const storyLayoutStyles = stylex.create({
  canvas: {
    paddingInline: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  canvas2: {
    borderRadius: 'var(--radius-xl)',
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: 'color-mix(in oklab, hsl(var(--sidebar-border) / 1) 80%, transparent)',
    backgroundColor: 'hsl(var(--sidebar-background) / 1)',
    padding: 'calc(var(--spacing) * 2)',
    fontSize: '14px',
    color: 'hsl(var(--sidebar-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  stack: {
    display: 'flex',
    width: '280px',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 2)',
  },
  frame: {
    'min-height': '100vh',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 6)',
  },
  row: {
    display: 'flex',
    'min-height': '100vh',
    'align-items': 'flex-start',
    gap: 'calc(var(--spacing) * 6)',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 6)',
  },
});

/**
 * What a folded sidebar group says about the Sessions it hides: one mark in the
 * rows' own status column, chosen by the rows' own priority (waiting > working
 * > unread), with the counts on hover. The Side by side story renders the same
 * data folded and expanded so each folded mark can be traced to its rows.
 */
const meta = {
  title: 'Components/Sidebar/Folded Group Status',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const machineId = 'machine-studio' as MachineId;

function makeProject(id: string, name: string): LocalProjectMeta {
  return {
    id: id as LocalProjectId,
    name,
    rootPath: `/Users/demo/code/${name}`,
  } as LocalProjectMeta;
}

function localSession(id: string, title: string, fields: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: id as SessionId,
    machineId,
    createdAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(),
    lastMessageAt: NOW - 60 * 60 * 1000,
    lastReadAt: NOW - 60 * 60 * 1000,
    userId: 'user-demo',
    cliType: 'builtin',
    agentType: 'claude',
    title,
    ...fields,
  } as SessionMeta;
}

const unread = { lastMessageAt: NOW - 5 * 60 * 1000, lastReadAt: NOW - 60 * 60 * 1000 };

const PROJECTS: Array<{ project: LocalProjectMeta; sessions: SessionMeta[] }> = [
  {
    project: makeProject('proj-lody', 'lody'),
    sessions: [
      localSession('lody-migrate', 'Migrate settings to StyleX'),
      localSession('lody-sidebar', 'Fold status on sidebar groups'),
      localSession('lody-review', 'Review the Dock badge fix', unread),
      localSession('lody-docs', 'Update the onboarding docs'),
    ],
  },
  {
    project: makeProject('proj-loro', 'loro'),
    sessions: [
      localSession('loro-bench', 'Benchmark the new movable list'),
      localSession('loro-release', 'Draft the 1.6 release notes'),
    ],
  },
  {
    project: makeProject('proj-notes', 'notes'),
    sessions: [localSession('notes-weekly', 'Summarize this week', unread)],
  },
  {
    project: makeProject('proj-dotfiles', 'dotfiles'),
    sessions: [localSession('dotfiles-zsh', 'Speed up zsh startup')],
  },
];

const LIVE_STATUSES: ReadonlyMap<string, SessionStatus> = new Map<string, SessionStatus>([
  ['lody-migrate', { type: 'requestPermission' }],
  ['lody-sidebar', { type: 'running' }],
  ['loro-bench', { type: 'running' }],
]);

function row(
  sessionId: string,
  title: string,
  repoFullName: string | null,
  status: Partial<Pick<SessionListRow, 'isWorking' | 'isWaitingPermission' | 'hasUnreadMessages'>>
): SessionListRow {
  return {
    sessionId,
    title,
    repoFullName,
    branchName: repoFullName ? `lody/${sessionId}` : '',
    latestMessageAt: NOW - 10 * 60 * 1000,
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
    ...status,
  };
}

const REPO_SESSIONS: SessionListRow[] = [
  row('gh-ci', 'Fix flaky CI on Windows', 'loro-dev/loro', { isWorking: true }),
  row('gh-perf', 'Profile the diff viewer', 'loro-dev/loro', {}),
  row('gh-auth', 'Rotate the OAuth callback', 'LodyAI/Lody', { isWaitingPermission: true }),
  row('gh-copy', 'Polish settings copy', 'LodyAI/Lody', { hasUnreadMessages: true }),
];

// A multi-repository project's conversations, listed under the project rather
// than the repository of its first member.
const GROUP_SESSIONS: SessionListRow[] = [
  {
    ...row('group-export', 'Export report across web and api', 'acme/web', { isWorking: true }),
    projectGroup: { id: 'shop', name: 'Shop' },
  },
];

const CHAT_SESSIONS: SessionListRow[] = [
  row('chat-plan', 'Plan the Q4 roadmap', null, { hasUnreadMessages: true }),
  row('chat-idea', 'Naming ideas', null, {}),
];

/** A teammate's machine that starts folded, with one Session running on it. */
const TEAMMATE_ACTIVITY = { ...EMPTY_SIDEBAR_GROUP_ACTIVITY, working: 1 };

function FoldedGroupsSidebar({ folded, heading }: { folded: boolean; heading?: string }) {
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(PROJECTS.map(({ project }) => [project.id, folded]))
  );
  // Teammates' machines start folded in production; this one has no fixture rows.
  const [teammateCollapsed, setTeammateCollapsed] = useState(true);
  const [repos, setRepos] = useState(() => [
    { repoFullName: 'loro-dev/loro', collapsed: folded },
    { repoFullName: 'LodyAI/Lody', collapsed: folded },
  ]);
  const [chatsCollapsed, setChatsCollapsed] = useState(folded);
  const [groupsFolded, setGroupsFolded] = useState<Record<string, boolean>>({
    'projectGroup:shop': folded,
  });
  const store = useMemo(() => createStore(), []);
  const emptyChildren = useMemo(() => new Map<string, SessionMeta[]>(), []);

  return (
    <div {...stylex.props(storyLayout.stack)}>
      {heading ? <div {...stylex.props(storyLayoutStyles.canvas)}>{heading}</div> : null}
      <Provider store={store}>
        <div
          data-folded-groups-sidebar={folded ? 'folded' : 'expanded'}
          {...stylex.props(storyLayoutStyles.canvas2)}
        >
          <div {...stylex.props(migrationStyles.group)}>
            <SidebarSectionHeader
              label="Mac Studio"
              collapsed={false}
              toggleLabel="Toggle"
              onToggleCollapsed={() => undefined}
            />
            <div {...stylex.props(migrationStyles.rows)}>
              {PROJECTS.map(({ project, sessions }) => (
                <LocalProjectItem
                  key={project.id}
                  machineId={machineId}
                  machineName="Mac Studio"
                  project={project}
                  canRemoveProject
                  collapsed={collapsedProjects[project.id] ?? false}
                  whetherShowFullList={false}
                  isSelected={false}
                  sessionsForProject={sessions}
                  childSessionsByParent={emptyChildren}
                  liveSessionStatuses={LIVE_STATUSES}
                  formattedPath={project.rootPath}
                  defaultSessionTitle="Untitled"
                  selectedSessionId={null}
                  removeProjectLabel="Remove folder"
                  newChatLabel="New chat"
                  archiveTooltipLabel="Archive"
                  archiveActionLabel="Archive"
                  archiveConfirmLabel="Confirm"
                  isMobile={false}
                  toggleLabel="Toggle"
                  onNavigateProject={() => undefined}
                  onNewChatInProject={() => undefined}
                  onEditProject={() => undefined}
                  onNavigateSession={() => undefined}
                  onArchive={() => undefined}
                  collapsedOpenedBySessionIds={{}}
                  onToggleOpenedBySessions={() => undefined}
                  onToggleCollapsed={(_machine, projectId) =>
                    setCollapsedProjects((prev) => ({ ...prev, [projectId]: !prev[projectId] }))
                  }
                  onToggleFullList={() => undefined}
                  onRequestRemoval={() => undefined}
                />
              ))}
            </div>
            {/* A project holding a folder of this machine sits with its folders. */}
            <SessionList
              sessions={GROUP_SESSIONS}
              repos={[]}
              projectGroups={[
                {
                  projectId: 'shop',
                  name: 'Shop',
                  collapsed: groupsFolded['projectGroup:shop'] ?? false,
                  // Created by this user; Docs site was created by a teammate.
                  canDelete: true,
                },
                { projectId: 'docs', name: 'Docs site', collapsed: false },
              ]}
              onToggleProjectGroupCollapsed={(key) =>
                setGroupsFolded((prev) => ({ ...prev, [key]: !prev[key] }))
              }
              onNewInProjectGroup={() => undefined}
              onOpenProjectGroupSettings={() => undefined}
              onDeleteProjectGroup={() => undefined}
              onArchiveProjectGroupChats={() => undefined}
              onMoveProjectGroup={() => undefined}
            />
          </div>

          <div
            {...stylex.props(
              teammateCollapsed ? migrationStyles.collapsedGroup : migrationStyles.expandedGroup
            )}
          >
            <SidebarSectionHeader
              label="Lampese's MacBook"
              collapsed={teammateCollapsed}
              activity={TEAMMATE_ACTIVITY}
              toggleLabel="Toggle"
              onToggleCollapsed={() => setTeammateCollapsed((value) => !value)}
            />
          </div>

          <div {...stylex.props(migrationStyles.group)}>
            <SidebarSectionHeader
              label="GitHub Worktrees"
              collapsed={false}
              toggleLabel="Toggle"
              onToggleCollapsed={() => undefined}
            />
            <SessionList
              sessions={REPO_SESSIONS}
              repos={repos}
              onEditRepoProject={() => undefined}
              onArchiveRepoChats={() => undefined}
              onToggleRepoCollapsed={(repoFullName) =>
                setRepos((prev) =>
                  prev.map((repo) =>
                    repo.repoFullName === repoFullName
                      ? { ...repo, collapsed: !repo.collapsed }
                      : repo
                  )
                )
              }
            />
          </div>

          <SessionList
            sessions={CHAT_SESSIONS}
            repos={[]}
            chatsCollapsed={chatsCollapsed}
            onToggleChatsCollapsed={() => setChatsCollapsed((value) => !value)}
          />
        </div>
      </Provider>
    </div>
  );
}

/** Every group folded: the sidebar still answers "does anything need me?". */
export const Folded: Story = {
  render: () => (
    <Tooltip.Provider>
      <div {...stylex.props(storyLayout.frame)}>
        <FoldedGroupsSidebar folded />
      </div>
    </Tooltip.Provider>
  ),
};

/** The same data folded and expanded, to trace each folded mark to its rows. */
export const SideBySide: Story = {
  render: () => (
    <Tooltip.Provider>
      <div {...stylex.props(storyLayout.row)}>
        <FoldedGroupsSidebar folded heading="Folded" />
        <FoldedGroupsSidebar folded={false} heading="Expanded" />
      </div>
    </Tooltip.Provider>
  ),
};

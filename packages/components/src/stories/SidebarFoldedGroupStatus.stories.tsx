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
import { SidebarSectionHeader } from '@/components/sidebar-row-shared';

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

const CHAT_SESSIONS: SessionListRow[] = [
  row('chat-plan', 'Plan the Q4 roadmap', null, { hasUnreadMessages: true }),
  row('chat-idea', 'Naming ideas', null, {}),
];

/** A teammate's machine that starts folded, with one Session running on it. */
const TEAMMATE_ACTIVITY = { waiting: 0, working: 1, unread: 0 };

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
  const store = useMemo(() => createStore(), []);
  const emptyChildren = useMemo(() => new Map<string, SessionMeta[]>(), []);

  return (
    <div className="flex w-[280px] flex-col gap-2">
      {heading ? (
        <div className="px-1 text-xs font-medium text-muted-foreground">{heading}</div>
      ) : null}
      <Provider store={store}>
        <div
          data-folded-groups-sidebar={folded ? 'folded' : 'expanded'}
          className="rounded-xl border border-sidebar-border/80 bg-sidebar p-2 text-sidebar-foreground text-[14px]"
        >
          <div className="mb-3 space-y-0.5">
            <SidebarSectionHeader
              label="Mac Studio"
              collapsed={false}
              toggleLabel="Toggle"
              onToggleCollapsed={() => undefined}
            />
            <div className="space-y-0.5">
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
          </div>

          <div className={teammateCollapsed ? 'mb-1' : 'mb-3'}>
            <SidebarSectionHeader
              label="Lampese's MacBook"
              collapsed={teammateCollapsed}
              activity={TEAMMATE_ACTIVITY}
              toggleLabel="Toggle"
              onToggleCollapsed={() => setTeammateCollapsed((value) => !value)}
            />
          </div>

          <div className="mb-3 space-y-0.5">
            <SidebarSectionHeader
              label="GitHub Worktrees"
              collapsed={false}
              toggleLabel="Toggle"
              onToggleCollapsed={() => undefined}
            />
            <SessionList
              sessions={REPO_SESSIONS}
              repos={repos}
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
      <div className="min-h-screen bg-background p-6">
        <FoldedGroupsSidebar folded />
      </div>
    </Tooltip.Provider>
  ),
};

/** The same data folded and expanded, to trace each folded mark to its rows. */
export const SideBySide: Story = {
  render: () => (
    <Tooltip.Provider>
      <div className="flex min-h-screen items-start gap-6 bg-background p-6">
        <FoldedGroupsSidebar folded heading="Folded" />
        <FoldedGroupsSidebar folded={false} heading="Expanded" />
      </div>
    </Tooltip.Provider>
  ),
};

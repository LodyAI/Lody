import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  LoroSidebarChatScope,
  LoroSidebarNavKey,
  LoroSidebarOrganizeMode,
} from '@/components/loro-sidebar';
import { LoroSidebar } from '@/components/loro-sidebar';
import { LocalProjectItem } from '@/components/loro-app-sidebar';
import { SidebarSectionHeader } from '@/components/sidebar-row-shared';
import {
  buildChildSessionsByParent,
  buildSidebarOpenerRowResolver,
} from '@/components/sessions/session-list-rows';
import { SessionList } from '@/components/session-list';
import type { SessionListProps } from '@/components/session-list';
import type {
  SessionListRepoMove,
  SessionListRepoState,
  SessionListRow,
} from '@/components/session-list';
import type {
  SidebarUpdatedBucketKey,
  SidebarUpdatedItem,
} from '@/components/sidebar-updated-session-list';
import { useIsMobile } from '@/hooks/use-mobile';
import type {
  LocalProjectHistoryProvider,
  LocalProjectId,
  LocalProjectMeta,
  MachineId,
  SessionId,
  SessionMeta,
  SessionStatus,
} from '@lody/shared';

const NOW = Date.now();
const EMPTY_LIVE_SESSION_STATUSES = new Map<string, SessionStatus>();
const DEMO_LIVE_SESSION_STATUSES = new Map<string, SessionStatus>([
  ['local-sess-worktree', { type: 'running' }],
]);
const DEMO_PERMISSION_SESSION_STATUSES = new Map<string, SessionStatus>([
  ['local-sess-worktree', { type: 'requestPermission' }],
]);
const DEMO_INITIALIZING_SESSION_STATUSES = new Map<string, SessionStatus>([
  ['local-sess-worktree', { type: 'initializing', stage: 'managed-runtime' }],
]);
const DEMO_MIXED_SESSION_STATUSES = new Map<string, SessionStatus>([
  ['local-sess-worktree', { type: 'running' }],
  ['local-sess-plain', { type: 'requestPermission' }],
]);
const DEMO_CHILD_PERMISSION_SESSION_STATUSES = new Map<string, SessionStatus>([
  ['local-sess-child-tab', { type: 'requestPermission' }],
]);
const DEMO_REMOTE_SESSION_STATUSES = new Map<string, SessionStatus>([
  ['remote-sess-running', { type: 'running' }],
]);
const DEMO_REMOTE_PROJECT_KEY = 'machine-remote:proj-lody';

const codexHistoryProvider = {
  cliType: 'builtin',
  agentType: 'codex',
} satisfies LocalProjectHistoryProvider;

const claudeHistoryProvider = {
  cliType: 'builtin',
  agentType: 'claude',
} satisfies LocalProjectHistoryProvider;

const demoTaskListProps: SessionListProps = {
  selectedSessionId: 'task-4',
  repos: [
    { repoFullName: 'loro-dev/loro', collapsed: false },
    { repoFullName: 'loro-dev/lody', collapsed: false },
  ],
  sessions: [
    {
      sessionId: 'task-1',
      title: 'Open PR · CI passed',
      repoFullName: 'loro-dev/loro',
      branchName: 'feat/browser-notifications',
      prUrl: 'https://github.com/loro-dev/loro/pull/123',
      prStatus: 'open',
      prCiState: 's',
      latestMessageAt: NOW - 24 * 60 * 60 * 1000,
      addedLines: 123,
      deletedLines: 912,
      isWorking: true,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
      isPinned: true,
    },
    {
      sessionId: 'task-open-failed',
      title: 'Open PR · CI failed',
      repoFullName: 'loro-dev/loro',
      branchName: 'fix/open-failed',
      prUrl: 'https://github.com/loro-dev/loro/pull/124',
      prStatus: 'open',
      prCiState: 'f',
      latestMessageAt: NOW - 25 * 60 * 60 * 1000,
      addedLines: 64,
      deletedLines: 8,
      isWorking: false,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-2',
      title: 'Merged PR · CI passed',
      repoFullName: 'loro-dev/loro',
      branchName: 'feat/meta-persistence',
      prUrl: 'https://github.com/loro-dev/loro/pull/456',
      prStatus: 'merged',
      prCiState: 's',
      latestMessageAt: NOW - 2 * 24 * 60 * 60 * 1000,
      addedLines: 456,
      deletedLines: 12,
      isWorking: false,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-merged-failed',
      title: 'Merged PR · CI failed',
      repoFullName: 'loro-dev/loro',
      branchName: 'fix/merged-failed',
      prUrl: 'https://github.com/loro-dev/loro/pull/457',
      prStatus: 'merged',
      prCiState: 'f',
      latestMessageAt: NOW - 3 * 24 * 60 * 60 * 1000,
      addedLines: 21,
      deletedLines: 5,
      isWorking: false,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-3',
      title: 'Why frontend crash',
      repoFullName: 'loro-dev/loro',
      branchName: 'fix/frontend-crash',
      prUrl: 'https://github.com/loro-dev/loro/pull/789',
      prStatus: 'closed',
      latestMessageAt: NOW - 7 * 24 * 60 * 60 * 1000,
      addedLines: 0,
      deletedLines: 0,
      isWorking: false,
      hasUnreadMessages: false,
      isOffline: true,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-4',
      title: 'Draft PR · CI passed',
      repoFullName: 'loro-dev/lody',
      branchName: 'fix/data-persistence',
      prUrl: 'https://github.com/loro-dev/lody/pull/78',
      prStatus: 'draft',
      prCiState: 's',
      latestMessageAt: NOW - 10 * 60 * 1000,
      addedLines: 456,
      deletedLines: 12,
      isWorking: false,
      hasUnreadMessages: true,
      isOffline: false,
      isWaitingPermission: false,
      isPinned: true,
    },
    {
      sessionId: 'task-draft-failed',
      title: 'Draft PR · CI failed',
      repoFullName: 'loro-dev/lody',
      branchName: 'fix/draft-failed',
      prUrl: 'https://github.com/loro-dev/lody/pull/79',
      prStatus: 'draft',
      prCiState: 'f',
      latestMessageAt: NOW - 11 * 60 * 1000,
      addedLines: 84,
      deletedLines: 7,
      isWorking: false,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-draft-running',
      title: 'Draft PR · CI running',
      repoFullName: 'loro-dev/lody',
      branchName: 'fix/draft-running',
      prUrl: 'https://github.com/loro-dev/lody/pull/80',
      prStatus: 'draft',
      prCiState: 'p',
      latestMessageAt: NOW - 12 * 60 * 1000,
      addedLines: 32,
      deletedLines: 4,
      isWorking: false,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-draft-expected',
      title: 'Draft PR · CI expected',
      repoFullName: 'loro-dev/lody',
      branchName: 'fix/draft-expected',
      prUrl: 'https://github.com/loro-dev/lody/pull/81',
      prStatus: 'draft',
      prCiState: 'x',
      latestMessageAt: NOW - 13 * 60 * 1000,
      addedLines: 18,
      deletedLines: 2,
      isWorking: false,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-5',
      title: 'Delete outdated comments',
      repoFullName: 'loro-dev/lody',
      branchName: 'chore/delete-comments',
      latestMessageAt: NOW - 14 * 60 * 1000,
      addedLines: 0,
      deletedLines: 172,
      isWorking: false,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-6',
      title: 'Temperature of the sun',
      repoFullName: null,
      branchName: '',
      latestMessageAt: NOW - 60 * 60 * 1000,
      addedLines: 0,
      deletedLines: 0,
      isWorking: false,
      hasUnreadMessages: true,
      isOffline: false,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-7',
      title: 'How to design workflow',
      repoFullName: '',
      branchName: '',
      latestMessageAt: NOW - 2 * 60 * 60 * 1000,
      addedLines: 0,
      deletedLines: 0,
      isWorking: false,
      hasUnreadMessages: true,
      isOffline: false,
      isWaitingPermission: false,
    },
  ],
};

function withCollapsedGitHubRepositoryActivity(
  status: NonNullable<SessionListRow['activityStatus']>
): SessionListProps {
  return {
    ...demoTaskListProps,
    repos: demoTaskListProps.repos.map((repo) =>
      repo.repoFullName === 'loro-dev/lody' ? { ...repo, collapsed: true } : repo
    ),
    sessions: demoTaskListProps.sessions.map((session) => ({
      ...session,
      activityStatus: session.sessionId === 'task-4' ? status : null,
      isWorking: session.sessionId === 'task-4',
      isWaitingPermission: session.sessionId === 'task-4' && status === 'requestPermission',
    })),
  };
}

const collapsedGitHubRepositoryRunning = withCollapsedGitHubRepositoryActivity('running');
const collapsedGitHubRepositoryInitializing = withCollapsedGitHubRepositoryActivity('initializing');
const collapsedGitHubRepositoryPermissionRequired =
  withCollapsedGitHubRepositoryActivity('requestPermission');

const externalHistoryTaskListProps: SessionListProps = {
  ...demoTaskListProps,
  selectedSessionId: 'task-6',
  sessions: demoTaskListProps.sessions.map((task) => {
    if (task.sessionId === 'task-6') {
      return {
        ...task,
        title: 'Codex imported ACP conversation',
        latestMessageAt: NOW - 35 * 60 * 1000,
        externalHistoryProvider: codexHistoryProvider,
      };
    }
    if (task.sessionId === 'task-7') {
      return {
        ...task,
        title: 'Claude imported ACP conversation',
        latestMessageAt: NOW - 2 * 60 * 60 * 1000,
        externalHistoryProvider: claudeHistoryProvider,
      };
    }
    return task;
  }),
};

const meta = {
  title: 'Components/LodySidebar',
  component: LoroSidebar,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof LoroSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

function StoryLayout(args: Parameters<typeof LoroSidebar>[0]) {
  const [activeNav, setActiveNav] = useState<LoroSidebarNavKey>(args.activeNav ?? 'home');
  const [workspaceId, setWorkspaceId] = useState(args.currentWorkspaceId);
  const baseSessionListProps = args.sessionListProps ?? demoTaskListProps;
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    baseSessionListProps.selectedSessionId ?? null
  );
  const [repos, setRepos] = useState<SessionListRepoState[]>(baseSessionListProps.repos);
  const [chatsCollapsed, setChatsCollapsed] = useState(false);
  const [pinnedSectionCollapsed, setPinnedSectionCollapsed] = useState(false);
  const [sessions, setTasks] = useState<SessionListRow[]>(baseSessionListProps.sessions);
  const [organizeMode, setOrganizeMode] = useState<LoroSidebarOrganizeMode>(
    args.organizeMode ?? 'workspace'
  );
  const [chatScope, setChatScope] = useState<LoroSidebarChatScope>(args.chatScope ?? 'my');
  const [updatedBucketsCollapsed, setUpdatedBucketsCollapsed] = useState<
    Partial<Record<SidebarUpdatedBucketKey, boolean>>
  >({});
  const handleToggleUpdatedBucket = (key: SidebarUpdatedBucketKey) => {
    setUpdatedBucketsCollapsed((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }));
  };
  const nextSessionIdRef = useRef(1);

  useEffect(() => {
    if (args.organizeMode) setOrganizeMode(args.organizeMode);
  }, [args.organizeMode]);
  useEffect(() => {
    if (args.chatScope) setChatScope(args.chatScope);
  }, [args.chatScope]);

  useEffect(() => {
    setSelectedSessionId(baseSessionListProps.selectedSessionId ?? null);
  }, [baseSessionListProps.selectedSessionId]);

  useEffect(() => {
    setRepos(baseSessionListProps.repos);
  }, [baseSessionListProps.repos]);

  useEffect(() => {
    setTasks(baseSessionListProps.sessions);
  }, [baseSessionListProps.sessions]);

  const toggleRepoCollapsed = (repoFullName: string) => {
    setRepos((prev) =>
      prev.map((repo) =>
        repo.repoFullName === repoFullName ? { ...repo, collapsed: !repo.collapsed } : repo
      )
    );
  };

  const archiveTask = (sessionId: string) => {
    setTasks((prev) => prev.filter((task) => task.sessionId !== sessionId));
    setSelectedSessionId((prev) => (prev === sessionId ? null : prev));
  };

  const togglePinned = (sessionId: string, nextPinned: boolean) => {
    setTasks((prev) =>
      prev.map((task) => (task.sessionId === sessionId ? { ...task, isPinned: nextPinned } : task))
    );
  };

  const createTask = (repoFullName?: string) => {
    const nextId = nextSessionIdRef.current++;
    const normalizedRepoFullName =
      typeof repoFullName === 'string' ? repoFullName.trim() || undefined : undefined;
    const sessionId = `new-task-${nextId}`;

    setTasks((prev) => [
      {
        sessionId,
        title: normalizedRepoFullName ? `New task in ${normalizedRepoFullName}` : 'New chat task',
        repoFullName: normalizedRepoFullName ?? null,
        branchName: normalizedRepoFullName ? `feat/new-task-${nextId}` : '',
        latestMessageAt: Date.now(),
        addedLines: 0,
        deletedLines: 0,
        isWorking: false,
        hasUnreadMessages: true,
        isOffline: false,
        isWaitingPermission: false,
      },
      ...prev,
    ]);
    setSelectedSessionId(sessionId);
  };

  const allSidebarItems = useMemo<SidebarUpdatedItem[]>(
    () => buildDemoUpdatedItems(sessions, chatScope),
    [sessions, chatScope]
  );
  const pinnedItems = useMemo(
    () => allSidebarItems.filter((item) => item.isPinned),
    [allSidebarItems]
  );
  const updatedItems = useMemo(
    () => allSidebarItems.filter((item) => !item.isPinned),
    [allSidebarItems]
  );
  const workspaceTasks = useMemo(() => sessions.filter((task) => !task.isPinned), [sessions]);
  const isMobile = useIsMobile();

  const sidebar = (
    <LoroSidebar
      {...args}
      activeNav={activeNav}
      currentWorkspaceId={workspaceId}
      organizeMode={organizeMode}
      chatScope={chatScope}
      pinnedItems={pinnedItems}
      pinnedSectionCollapsed={pinnedSectionCollapsed}
      updatedItems={updatedItems}
      updatedSelectedItemId={selectedSessionId}
      updatedBucketsCollapsed={updatedBucketsCollapsed}
      onOrganizeModeChange={setOrganizeMode}
      onChatScopeChange={setChatScope}
      onSelectUpdatedItem={setSelectedSessionId}
      onTogglePinnedSection={() => setPinnedSectionCollapsed((prev) => !prev)}
      onToggleUpdatedBucket={handleToggleUpdatedBucket}
      onArchiveUpdatedItem={archiveTask}
      onToggleUpdatedItemPinned={togglePinned}
      sessionListProps={{
        sessions: workspaceTasks,
        repos,
        chatsCollapsed,
        selectedSessionId,
        onSelect: setSelectedSessionId,
        onToggleRepoCollapsed: toggleRepoCollapsed,
        onToggleChatsCollapsed: () => setChatsCollapsed((prev) => !prev),
        onArchiveSession: archiveTask,
        onTogglePinSession: togglePinned,
        onNew: createTask,
        onMoveRepo: (move: SessionListRepoMove) => setRepos(move.nextRepos),
      }}
      onWorkspaceSelected={setWorkspaceId}
      onHomeClicked={() => setActiveNav('home')}
      onArchiveClicked={() => setActiveNav('archive')}
    />
  );

  // Mobile preview: the production sidebar fills the MobileSidebarDrawer panel
  // (full width, no shoulder padding, no adjacent content card). We mirror that
  // here so the screenshots reflect production layout instead of a squeezed
  // desktop column with truncated labels.
  if (isMobile) {
    return (
      <div className="min-h-screen w-full bg-background text-foreground">
        <div className="h-screen w-full">{sidebar}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-background p-10 text-foreground">
      <div className="flex h-[calc(100vh-5rem)] items-start gap-8">
        {sidebar}
        <div className="flex-1">
          <div className="rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xs">
            <div className="text-lg font-semibold">Content</div>
            <div className="mt-2 text-sm text-muted-foreground">
              Use the filter button at the bottom-right of the sidebar to switch between Workspace
              and Updated organize modes, and to toggle My Tasks vs All Tasks.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const DEMO_LOCAL_KIND_TASK_IDS = new Set<string>(['task-5']);
const DEMO_OWNER_BY_TASK_ID: Record<string, string> = {
  'task-1': 'zxch3n',
  'task-2': 'zxch3n',
  'task-3': 'someone-else',
  'task-4': 'zxch3n',
  'task-5': 'zxch3n',
  'task-6': 'zxch3n',
  'task-7': 'someone-else',
};

function buildDemoUpdatedItems(
  source: SessionListRow[],
  scope: LoroSidebarChatScope
): SidebarUpdatedItem[] {
  // Storybook: "All Tasks" includes everyone; "My Tasks" hides items assigned to others.
  // We use a static owner-by-id map (above) so the toggle has a visible effect in the demo.
  const filtered = source.filter((task) => {
    if (scope === 'team') return true;
    const owner = DEMO_OWNER_BY_TASK_ID[task.sessionId] ?? 'zxch3n';
    return owner === 'zxch3n';
  });

  return filtered.map((task) => {
    if (DEMO_LOCAL_KIND_TASK_IDS.has(task.sessionId)) {
      return {
        id: task.sessionId,
        kind: 'local',
        title: task.title,
        sectionLabel: 'Local Projects · lody',
        subtitle: 'lody',
        latestMessageAt: task.latestMessageAt,
        isPinned: task.isPinned,
        isWorking: task.isWorking,
        isWorktree: task.isWorktree,
        hasUnreadMessages: task.hasUnreadMessages,
        isOffline: task.isOffline,
        isWaitingPermission: task.isWaitingPermission,
        openedBySessionId: task.openedBySessionId ?? null,
        openedByRowSessionId: task.openedByRowSessionId ?? null,
      };
    }
    if (task.repoFullName) {
      return {
        id: task.sessionId,
        kind: 'github',
        title: task.title,
        sectionLabel: task.repoFullName,
        subtitle: task.repoFullName,
        latestMessageAt: task.latestMessageAt,
        isPinned: task.isPinned,
        isWorking: task.isWorking,
        isWorktree: task.isWorktree,
        hasUnreadMessages: task.hasUnreadMessages,
        isOffline: task.isOffline,
        isWaitingPermission: task.isWaitingPermission,
        openedBySessionId: task.openedBySessionId ?? null,
        openedByRowSessionId: task.openedByRowSessionId ?? null,
        prStatus: task.prStatus,
        prCiState: task.prCiState,
        prNumber: task.prNumber,
        prUrl: task.prUrl ?? null,
        owner: task.owner ?? { name: DEMO_OWNER_BY_TASK_ID[task.sessionId] ?? 'zxch3n' },
        addedLines: task.addedLines,
        deletedLines: task.deletedLines,
      };
    }
    return {
      id: task.sessionId,
      kind: 'chat',
      title: task.title,
      sectionLabel: 'Chats',
      subtitle: null,
      latestMessageAt: task.latestMessageAt,
      isPinned: task.isPinned,
      isWorking: task.isWorking,
      hasUnreadMessages: task.hasUnreadMessages,
      isOffline: task.isOffline,
      isWaitingPermission: task.isWaitingPermission,
      openedBySessionId: task.openedBySessionId ?? null,
      openedByRowSessionId: task.openedByRowSessionId ?? null,
    };
  });
}

export const Default: Story = {
  render: (args) => <WithProjectsLayout {...args} />,
  args: {
    workspaceName: 'Loro',
    userEmail: 'zixuan@loro.dev',
    repoSections: [],
    chats: [],
    workspaces: [
      { id: 'ws-1', name: 'Loro', planTier: 'plus' },
      { id: 'ws-2', name: 'Lody' },
      { id: 'ws-3', name: 'Demo', planTier: 'enterprise' },
    ],
    currentWorkspaceId: 'ws-1',
    sessionListProps: demoTaskListProps,
    onInviteClicked: () => {},
    onLinkRepoClicked: () => {},
    onSettingsClicked: () => {},
    onRequestCollapse: () => {},
  },
};

export const ElectronAlwaysVisibleCollapseToggle: Story = {
  render: (args) => <WithProjectsLayout {...args} />,
  args: {
    ...Default.args!,
    isElectron: true,
  },
};

export const ElectronMacOSCollapseToggle: Story = {
  render: (args) => <WithProjectsLayout {...args} />,
  args: {
    ...Default.args!,
    isElectron: true,
    // Pins the collapse toggle to the macOS traffic-light centerline (y=23,
    // see `trafficLightPosition` in apps/electron/src/main/window.ts).
    isElectronMacOS: true,
  },
};

/** Compact builder for the opened-by demo rows below. */
function buildOpenedDemoRow(
  sessionId: string,
  title: string,
  openedBySessionId: string | undefined,
  minutesAgo: number,
  overrides: Partial<SessionListRow> = {}
): SessionListRow {
  return {
    sessionId,
    title,
    repoFullName: 'loro-dev/loro',
    branchName: `feat/${sessionId}`,
    latestMessageAt: NOW - minutesAgo * 60 * 1000,
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
    ...(openedBySessionId ? { openedBySessionId, openedByRowSessionId: openedBySessionId } : {}),
    ...overrides,
  };
}

const demoUpdatedTaskListProps: SessionListProps = {
  ...demoTaskListProps,
  sessions: [
    {
      sessionId: 'task-1',
      title: 'Browser notifications',
      repoFullName: 'loro-dev/loro',
      branchName: 'feat/browser-notifications',
      prUrl: 'https://github.com/loro-dev/loro/pull/123',
      prStatus: 'open',
      latestMessageAt: NOW - 30 * 60 * 1000, // 30m -> today
      addedLines: 123,
      deletedLines: 912,
      isWorking: true,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
      isPinned: true,
    },
    {
      sessionId: 'task-2',
      title: 'Flock meta persistence',
      repoFullName: 'loro-dev/loro',
      branchName: 'feat/meta-persistence',
      prUrl: 'https://github.com/loro-dev/loro/pull/456',
      prStatus: 'merged',
      latestMessageAt: NOW - 3 * 60 * 60 * 1000, // 3h -> today
      addedLines: 456,
      deletedLines: 12,
      isWorking: false,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-3',
      title: 'Why frontend crash',
      repoFullName: 'loro-dev/loro',
      branchName: 'fix/frontend-crash',
      prUrl: 'https://github.com/loro-dev/loro/pull/789',
      prStatus: 'closed',
      latestMessageAt: NOW - 2 * 24 * 60 * 60 * 1000, // 2d -> this week
      addedLines: 0,
      deletedLines: 0,
      isWorking: false,
      hasUnreadMessages: false,
      isOffline: true,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-4',
      title: 'Fix Data Persistence Issue',
      repoFullName: 'loro-dev/lody',
      branchName: 'fix/data-persistence',
      prUrl: 'https://github.com/loro-dev/lody/pull/78',
      prStatus: 'open',
      latestMessageAt: NOW - 4 * 24 * 60 * 60 * 1000, // 4d -> this week
      addedLines: 456,
      deletedLines: 12,
      isWorking: false,
      hasUnreadMessages: true,
      isOffline: false,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-5',
      title: 'Local — refactor outbox',
      repoFullName: null,
      branchName: '',
      latestMessageAt: NOW - 6 * 60 * 60 * 1000, // 6h -> today, kind: local
      addedLines: 0,
      deletedLines: 0,
      isWorking: false,
      isWorktree: true,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-6',
      title: 'Temperature of the sun',
      repoFullName: null,
      branchName: '',
      latestMessageAt: NOW - 90 * 60 * 1000, // 90m -> today, kind: chat
      addedLines: 0,
      deletedLines: 0,
      isWorking: false,
      hasUnreadMessages: true,
      isOffline: false,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-7',
      title: 'How to design workflow',
      repoFullName: '',
      branchName: '',
      latestMessageAt: NOW - 12 * 24 * 60 * 60 * 1000, // 12d -> older, kind: chat
      addedLines: 0,
      deletedLines: 0,
      isWorking: false,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
    },
  ],
};

/**
 * Demonstrates the "Updated" organize mode: a flat recency-sorted list. Each row
 * is a single line — leading status slot (PR status at rest), title, a trailing
 * mode icon (FolderTree/Folder for github/local worktrees), and diff — with a
 * desktop hover info card carrying the time / repo / branch / PR / diff.
 */
export const UpdatedMode: Story = {
  render: (args) => <StoryLayout {...args} />,
  args: {
    ...Default.args!,
    organizeMode: 'updated',
    chatScope: 'my',
    sessionListProps: demoUpdatedTaskListProps,
  },
};

/**
 * Updated mode with MCP-opened independent Sessions. `task-2` opened three of
 * them, so they indent beneath it with a disclosure chevron and tree connector
 * lines. `task-1` is PINNED, so it renders in the Pinned section while the
 * Session it opened stays a top-level row in Updated — nesting never crosses a
 * section boundary. `orphan-updated` was opened by a Session that is not in
 * this list at all and falls back to top-level too.
 *
 * `stale-opener` is the ordering case: it is the oldest row here, but the
 * Session it opened is the newest, so the whole group still sorts to the top —
 * Updated mode stays a recency list. It is also WORKING, so its leading slot
 * shows the status spinner instead of the disclosure chevron (loading
 * outranks folding; collapse stays in the row's context menu).
 */
export const UpdatedModeOpenedSessions: Story = {
  name: 'Updated Mode · Opened Sessions (MCP)',
  render: (args) => <StoryLayout {...args} />,
  args: {
    ...UpdatedMode.args!,
    sessionListProps: {
      ...demoUpdatedTaskListProps,
      sessions: [
        ...demoUpdatedTaskListProps.sessions,
        buildOpenedDemoRow('opened-tests', 'Write the migration tests', 'task-2', 45, {
          isWorking: true,
          addedLines: 38,
          deletedLines: 4,
        }),
        buildOpenedDemoRow('opened-docs', 'Update the persistence docs', 'task-2', 70, {
          hasUnreadMessages: true,
        }),
        buildOpenedDemoRow('opened-audit', 'Audit archive + scope behavior', 'task-2', 110, {
          addedLines: 12,
          deletedLines: 3,
        }),
        // Opener (`task-1`) is pinned into the other section — stays top-level.
        buildOpenedDemoRow('opened-across-section', 'Opened by a pinned session', 'task-1', 150),
        // Precise opener is a child Tab of `task-2`; the row nests under `task-2`.
        {
          ...buildOpenedDemoRow('opened-from-child-tab', 'Opened from a child tab', undefined, 130),
          openedBySessionId: 'task-2-child-tab',
          openedByRowSessionId: 'task-2',
        },
        buildOpenedDemoRow(
          'orphan-updated',
          'Opened by an archived session',
          'missing-opener',
          190
        ),
        buildOpenedDemoRow('stale-opener', 'Long-running orchestration', undefined, 6 * 24 * 60, {
          isWorking: true,
        }),
        buildOpenedDemoRow('stale-opened', 'Just finished a subtask', 'stale-opener', 2),
      ],
    },
  },
};

/**
 * Variant of UpdatedMode showing the team scope (All Tasks).
 */
export const UpdatedModeTeam: Story = {
  render: (args) => <StoryLayout {...args} />,
  args: {
    ...UpdatedMode.args!,
    chatScope: 'team',
  },
};

export const ExternalHistoryProviders: Story = {
  render: (args) => <StoryLayout {...args} />,
  args: {
    ...Default.args!,
    sessionListProps: externalHistoryTaskListProps,
  },
};

const demoMachineId = 'machine-demo' as MachineId;

const demoProjects: LocalProjectMeta[] = [
  {
    id: 'proj-lody' as LocalProjectId,
    name: 'lody',
    rootPath: '/Users/developer/Code/lody',
    createdAtMs: NOW - 30 * 24 * 60 * 60 * 1000,
  },
  {
    id: 'proj-loro' as LocalProjectId,
    name: 'loro',
    rootPath: '/Users/developer/Code/loro',
    createdAtMs: NOW - 60 * 24 * 60 * 60 * 1000,
  },
];

// A couple of local-project sessions so the single-line local row is exercised:
// one running inside a worktree (shows the FolderTree mode icon) and one plain
// local session (no mode icon). The first session stays live so the collapsed
// project row demonstrates its aggregate running indicator.
const demoLocalSessions: SessionMeta[] = [
  {
    id: 'local-sess-worktree' as SessionId,
    machineId: demoMachineId,
    createdAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(),
    userId: 'user-demo',
    cliType: 'builtin',
    agentType: 'claude',
    title: 'Refactor persistence layer',
    branchName: 'feat/persistence-refactor',
    isWorktree: true,
    lastMessageAt: NOW - 3 * 60 * 60 * 1000,
  },
  // Independent Session opened by an agent running inside a CHILD TAB of
  // `local-sess-worktree`. Its precise opener is the Tab (`demoChildTabSession`
  // below), which has no sidebar row of its own — so the sidebar nests it under
  // the Tab's ROOT Session while "Go to Opener Session" still targets the Tab.
  {
    id: 'local-sess-opened-from-tab' as SessionId,
    machineId: demoMachineId,
    createdAt: new Date(NOW - 25 * 60 * 1000).toISOString(),
    userId: 'user-demo',
    cliType: 'builtin',
    agentType: 'claude',
    title: 'Opened from a child tab',
    openedBySessionId: 'local-sess-child-tab' as SessionId,
    lastMessageAt: NOW - 25 * 60 * 1000,
  },
  // Independent Sessions the first one opened through the `lody_session_create`
  // MCP tool: they indent under it, but keep their own lifecycle and row.
  {
    id: 'local-sess-opened-tests' as SessionId,
    machineId: demoMachineId,
    createdAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    userId: 'user-demo',
    cliType: 'builtin',
    agentType: 'claude',
    title: 'Write the migration tests',
    openedBySessionId: 'local-sess-worktree' as SessionId,
    isWorktree: true,
    lastMessageAt: NOW - 2 * 60 * 60 * 1000,
  },
  {
    id: 'local-sess-opened-docs' as SessionId,
    machineId: demoMachineId,
    createdAt: new Date(NOW - 90 * 60 * 1000).toISOString(),
    userId: 'user-demo',
    cliType: 'builtin',
    agentType: 'claude',
    title: 'Update the persistence docs',
    openedBySessionId: 'local-sess-worktree' as SessionId,
    lastMessageAt: NOW - 90 * 60 * 1000,
  },
  {
    id: 'local-sess-plain' as SessionId,
    machineId: demoMachineId,
    createdAt: new Date(NOW - 26 * 60 * 60 * 1000).toISOString(),
    userId: 'user-demo',
    cliType: 'builtin',
    agentType: 'claude',
    title: 'Tidy up logging output',
    isWorktree: false,
    lastMessageAt: NOW - 26 * 60 * 60 * 1000,
  },
];

/**
 * A child Tab of `local-sess-worktree`. Child Tabs are deliberately absent from
 * every sidebar list, so this one is NOT in `demoLocalSessions` — it exists only
 * in the resolver's session view, exactly as in production where the sidebar
 * reads rows from `sessionListAtom` and the resolver from `allActiveSessions`.
 */
const demoChildTabSession: SessionMeta = {
  id: 'local-sess-child-tab' as SessionId,
  machineId: demoMachineId,
  createdAt: new Date(NOW - 90 * 60 * 1000).toISOString(),
  userId: 'user-demo',
  cliType: 'builtin',
  agentType: 'claude',
  title: 'Child tab: try the alternative fix',
  parentSessionId: 'local-sess-worktree' as SessionId,
  lastMessageAt: NOW - 40 * 60 * 1000,
};

const demoChildSessionsByParent = buildChildSessionsByParent([demoChildTabSession]);

const demoRemoteSessions: SessionMeta[] = [
  {
    id: 'remote-sess-running' as SessionId,
    machineId: 'machine-remote' as MachineId,
    createdAt: new Date(NOW - 20 * 60 * 1000).toISOString(),
    userId: 'user-demo',
    cliType: 'builtin',
    agentType: 'claude',
    title: 'Run checks on the remote machine',
    lastMessageAt: NOW - 20 * 60 * 1000,
  },
];

/** Mirrors `allActiveSessions`: sidebar rows PLUS the child Tabs they hide. */
const demoResolveOpenerRowId = buildSidebarOpenerRowResolver([
  ...demoLocalSessions,
  demoChildTabSession,
]);

function ProductionLikeTopContent({
  chatSessions,
  githubWorktreeCount,
  localProjectLiveSessionStatuses,
  localProjectChildSessionsByParent,
  remoteProjectSessions,
  initiallyCollapseRemoteProject,
  selectedSessionId,
  onSelectSession,
  onArchiveSession,
  onNew,
  chatsCollapsed,
  onToggleChatsCollapsed,
}: {
  chatSessions: SessionListRow[];
  githubWorktreeCount: number;
  localProjectLiveSessionStatuses: ReadonlyMap<string, SessionStatus>;
  localProjectChildSessionsByParent: Map<string, SessionMeta[]>;
  remoteProjectSessions: SessionMeta[];
  initiallyCollapseRemoteProject: boolean;
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  onArchiveSession: (id: string) => void;
  onNew: (repoFullName?: string) => void;
  chatsCollapsed: boolean;
  onToggleChatsCollapsed: () => void;
}) {
  const isMobile = useIsMobile();
  const [localProjectsCollapsed, setLocalProjectsCollapsed] = useState(false);
  const [githubCollapsed, setGithubCollapsed] = useState(false);
  const projectCollapseStates = useMemo(
    () =>
      Object.fromEntries([
        ...demoProjects.map((p) => [`${demoMachineId}:${p.id}`, true]),
        ...(initiallyCollapseRemoteProject ? [[DEMO_REMOTE_PROJECT_KEY, true]] : []),
      ]),
    [initiallyCollapseRemoteProject]
  );
  const [collapsedProjects, setCollapsedProjects] =
    useState<Record<string, boolean>>(projectCollapseStates);
  const [collapsedOpenedBySessionIds, setCollapsedOpenedBySessionIds] = useState<
    Record<string, boolean>
  >({});
  const toggleOpenedBySessions = (openerSessionId: string) =>
    setCollapsedOpenedBySessionIds((prev) => ({
      ...prev,
      [openerSessionId]: !prev[openerSessionId],
    }));

  return (
    // Mirrors LoroAppSidebar's sidebarTopContent: sections carry their own
    // bottom margin — 12px expanded, 4px collapsed.
    <div>
      {chatSessions.length > 0 ? (
        <SessionList
          className={chatsCollapsed ? 'mb-1' : 'mb-3'}
          sessions={chatSessions}
          repos={[]}
          chatsCollapsed={chatsCollapsed}
          selectedSessionId={selectedSessionId}
          onSelectSession={onSelectSession}
          onArchiveSession={onArchiveSession}
          onNew={onNew}
          onToggleChatsCollapsed={onToggleChatsCollapsed}
        />
      ) : null}

      <div>
        <div className={cn('space-y-0.5', localProjectsCollapsed ? 'mb-1' : 'mb-3')}>
          <SidebarSectionHeader
            label="Local Projects"
            collapsed={localProjectsCollapsed}
            count={demoProjects.length}
            isMobile={isMobile}
            toggleLabel="Toggle"
            onToggleCollapsed={() => setLocalProjectsCollapsed((v) => !v)}
            action={
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground/80 hover:bg-muted/30 hover:text-foreground"
                aria-label="Import local project folder"
              >
                <FolderPlus className="h-4 w-4" />
              </button>
            }
          />
          {localProjectsCollapsed ? null : (
            <div className="space-y-1">
              {demoProjects.map((project) => {
                const key = `${demoMachineId}:${project.id}`;
                const collapsed = collapsedProjects[key] ?? false;
                return (
                  <LocalProjectItem
                    key={project.id}
                    machineId={demoMachineId}
                    machineName="Mac Studio"
                    project={project}
                    canRemoveProject
                    canNavigateProject
                    collapsed={collapsed}
                    isSelected={false}
                    sessionsForProject={
                      project.id === ('proj-lody' as LocalProjectId) ? demoLocalSessions : []
                    }
                    childSessionsByParent={localProjectChildSessionsByParent}
                    liveSessionStatuses={localProjectLiveSessionStatuses}
                    formattedPath={project.rootPath}
                    defaultSessionTitle="Untitled"
                    selectedSessionId={null}
                    removeProjectLabel="Remove folder"
                    archiveTooltipLabel="Archive"
                    archiveActionLabel="Archive"
                    archiveConfirmLabel="Confirm"
                    isMobile={isMobile}
                    toggleLabel="Toggle"
                    onNavigateProject={() => {}}
                    onNavigateSession={() => {}}
                    onArchive={() => {}}
                    collapsedOpenedBySessionIds={collapsedOpenedBySessionIds}
                    onToggleOpenedBySessions={toggleOpenedBySessions}
                    resolveOpenerRowId={demoResolveOpenerRowId}
                    onToggleCollapsed={() =>
                      setCollapsedProjects((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }))
                    }
                    onRequestRemoval={() => {}}
                  />
                );
              })}
            </div>
          )}
        </div>

        <div className="mb-3 space-y-0.5">
          <SidebarSectionHeader
            label="MacBook Pro projects"
            collapsed={false}
            count={1}
            isMobile={isMobile}
            toggleLabel="Toggle"
            onToggleCollapsed={() => {}}
          />
          <div className="space-y-1">
            {demoProjects.slice(0, 1).map((project) => {
              const remoteMachineId = 'machine-remote' as MachineId;
              const key = `${remoteMachineId}:${project.id}`;
              const collapsed = collapsedProjects[key] ?? false;
              return (
                <LocalProjectItem
                  key={`remote-${project.id}`}
                  machineId={remoteMachineId}
                  machineName="MacBook Pro"
                  project={project}
                  canRemoveProject
                  canNavigateProject
                  collapsed={collapsed}
                  isSelected={false}
                  sessionsForProject={remoteProjectSessions}
                  childSessionsByParent={localProjectChildSessionsByParent}
                  liveSessionStatuses={localProjectLiveSessionStatuses}
                  formattedPath={project.rootPath}
                  defaultSessionTitle="Untitled"
                  selectedSessionId={null}
                  removeProjectLabel="Remove folder"
                  archiveTooltipLabel="Archive"
                  archiveActionLabel="Archive"
                  archiveConfirmLabel="Confirm"
                  isMobile={isMobile}
                  toggleLabel="Toggle"
                  onNavigateProject={() => {}}
                  onNavigateSession={() => {}}
                  onArchive={() => {}}
                  collapsedOpenedBySessionIds={collapsedOpenedBySessionIds}
                  onToggleOpenedBySessions={toggleOpenedBySessions}
                  resolveOpenerRowId={demoResolveOpenerRowId}
                  onToggleCollapsed={() =>
                    setCollapsedProjects((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }))
                  }
                  onRequestRemoval={() => {}}
                />
              );
            })}
          </div>
        </div>
      </div>

      <SidebarSectionHeader
        label="GitHub Worktrees"
        collapsed={githubCollapsed}
        count={githubWorktreeCount}
        isMobile={isMobile}
        toggleLabel="Toggle"
        onToggleCollapsed={() => setGithubCollapsed((v) => !v)}
      />
    </div>
  );
}

function WithProjectsLayout({
  localProjectLiveSessionStatuses = EMPTY_LIVE_SESSION_STATUSES,
  localProjectChildSessionsByParent = new Map(),
  remoteProjectSessions = [],
  initiallyCollapseRemoteProject = false,
  ...args
}: Parameters<typeof LoroSidebar>[0] & {
  localProjectLiveSessionStatuses?: ReadonlyMap<string, SessionStatus>;
  localProjectChildSessionsByParent?: Map<string, SessionMeta[]>;
  remoteProjectSessions?: SessionMeta[];
  initiallyCollapseRemoteProject?: boolean;
}) {
  const baseSessionListProps = args.sessionListProps ?? demoTaskListProps;
  const [activeNav, setActiveNav] = useState<LoroSidebarNavKey>(args.activeNav ?? 'home');
  const [workspaceId, setWorkspaceId] = useState(args.currentWorkspaceId);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    baseSessionListProps.selectedSessionId ?? null
  );
  const [chatsCollapsed, setChatsCollapsed] = useState(false);
  const [sessions, setTasks] = useState<SessionListRow[]>(baseSessionListProps.sessions);
  const [repos, setRepos] = useState<SessionListRepoState[]>(baseSessionListProps.repos);
  const nextSessionIdRef = useRef(1);

  const chatSessions = useMemo(() => sessions.filter((t) => !t.repoFullName), [sessions]);
  const repoSessions = useMemo(() => sessions.filter((t) => Boolean(t.repoFullName)), [sessions]);

  const archiveTask = (sessionId: string) => {
    setTasks((prev) => prev.filter((task) => task.sessionId !== sessionId));
    setSelectedSessionId((prev) => (prev === sessionId ? null : prev));
  };

  const createTask = (repoFullName?: string) => {
    const nextId = nextSessionIdRef.current++;
    const normalizedRepoFullName =
      typeof repoFullName === 'string' ? repoFullName.trim() || undefined : undefined;
    const sessionId = `new-task-${nextId}`;
    setTasks((prev) => [
      {
        sessionId,
        title: normalizedRepoFullName ? `New task in ${normalizedRepoFullName}` : 'New chat task',
        repoFullName: normalizedRepoFullName ?? null,
        branchName: normalizedRepoFullName ? `feat/new-task-${nextId}` : '',
        latestMessageAt: Date.now(),
        addedLines: 0,
        deletedLines: 0,
        isWorking: false,
        hasUnreadMessages: true,
        isOffline: false,
        isWaitingPermission: false,
      },
      ...prev,
    ]);
    setSelectedSessionId(sessionId);
  };

  const toggleRepoCollapsed = (repoFullName: string) => {
    setRepos((prev) =>
      prev.map((repo) =>
        repo.repoFullName === repoFullName ? { ...repo, collapsed: !repo.collapsed } : repo
      )
    );
  };

  const isMobile = useIsMobile();

  const sidebar = (
    <LoroSidebar
      {...args}
      activeNav={activeNav}
      currentWorkspaceId={workspaceId}
      topContent={
        <ProductionLikeTopContent
          chatSessions={chatSessions}
          githubWorktreeCount={repos.length}
          localProjectLiveSessionStatuses={localProjectLiveSessionStatuses}
          localProjectChildSessionsByParent={localProjectChildSessionsByParent}
          remoteProjectSessions={remoteProjectSessions}
          initiallyCollapseRemoteProject={initiallyCollapseRemoteProject}
          selectedSessionId={selectedSessionId}
          onSelectSession={setSelectedSessionId}
          onArchiveSession={archiveTask}
          onNew={createTask}
          chatsCollapsed={chatsCollapsed}
          onToggleChatsCollapsed={() => setChatsCollapsed((p) => !p)}
        />
      }
      sessionListProps={{
        sessions: repoSessions,
        repos,
        selectedSessionId,
        onSelectSession: setSelectedSessionId,
        onToggleRepoCollapsed: toggleRepoCollapsed,
        onArchiveSession: archiveTask,
        onNew: createTask,
        onMoveRepo: (move: SessionListRepoMove) => setRepos(move.nextRepos),
      }}
      onWorkspaceSelected={setWorkspaceId}
      onHomeClicked={() => setActiveNav('home')}
      onArchiveClicked={() => setActiveNav('archive')}
    />
  );

  if (isMobile) {
    return (
      <div className="min-h-screen w-full bg-background text-foreground">
        <div className="h-screen w-full">{sidebar}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-background p-10 text-foreground">
      <div className="flex h-[calc(100vh-5rem)] items-start gap-8">
        {sidebar}
        <div className="flex-1">
          <div className="rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xs">
            <div className="text-lg font-semibold">Content</div>
            <div className="mt-2 text-sm text-muted-foreground">
              This area is intentionally left minimal for the component preview.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const STRESS_REPOSITORIES = [
  'loro-dev/lody',
  'loro-dev/loro',
  'loro-dev/flock',
  'loro-dev/loro-streams',
  'loro-dev/loro-docs',
  'loro-dev/loro-site',
  'loro-dev/loro-sync',
  'loro-dev/loro-benchmarks',
];

const stressTaskListProps: SessionListProps = {
  selectedSessionId: 'stress-48',
  repos: STRESS_REPOSITORIES.map((repoFullName) => ({ repoFullName, collapsed: false })),
  sessions: Array.from({ length: 180 }, (_, index): SessionListRow => {
    const number = index + 1;
    const repoFullName =
      number <= 24 ? null : STRESS_REPOSITORIES[(number - 25) % STRESS_REPOSITORIES.length];
    const hasPullRequest = repoFullName !== null && number % 3 !== 0;

    return {
      sessionId: `stress-${number}`,
      title: repoFullName
        ? `Improve ${repoFullName.split('/')[1]} session workflow ${number}`
        : `Research conversation ${number}`,
      repoFullName,
      branchName: repoFullName ? `feat/sidebar-load-${number}` : '',
      ...(hasPullRequest
        ? {
            prUrl: `https://github.com/${repoFullName}/pull/${400 + number}`,
            prStatus: number % 11 === 0 ? 'merged' : 'open',
          }
        : {}),
      latestMessageAt: NOW - number * 17 * 60 * 1000,
      addedLines: number % 4 === 0 ? number * 3 : 0,
      deletedLines: number % 5 === 0 ? number * 2 : 0,
      isWorking: number % 29 === 0,
      isWorktree: repoFullName !== null && number % 4 !== 0,
      hasUnreadMessages: number % 13 === 0,
      isOffline: number % 37 === 0,
      isWaitingPermission: false,
      isPinned: number === 3 || number === 48 || number === 96,
    };
  }),
};

export const WithProjects: Story = {
  render: (args) => <WithProjectsLayout {...args} />,
  args: {
    ...Default.args!,
  },
};

export const CollapsedProjectRunning: Story = {
  name: 'Collapsed project · running',
  render: (args) => (
    <WithProjectsLayout {...args} localProjectLiveSessionStatuses={DEMO_LIVE_SESSION_STATUSES} />
  ),
  args: {
    ...Default.args!,
  },
};

export const CollapsedProjectPermissionRequired: Story = {
  name: 'Collapsed project · permission required',
  render: (args) => (
    <WithProjectsLayout
      {...args}
      localProjectLiveSessionStatuses={DEMO_PERMISSION_SESSION_STATUSES}
    />
  ),
  args: {
    ...Default.args!,
  },
};

export const CollapsedProjectInitializing: Story = {
  name: 'Collapsed project · initializing',
  render: (args) => (
    <WithProjectsLayout
      {...args}
      localProjectLiveSessionStatuses={DEMO_INITIALIZING_SESSION_STATUSES}
    />
  ),
  args: {
    ...Default.args!,
  },
};

export const CollapsedRemoteProjectRunning: Story = {
  name: 'Collapsed remote project · running',
  render: (args) => (
    <WithProjectsLayout
      {...args}
      localProjectLiveSessionStatuses={DEMO_REMOTE_SESSION_STATUSES}
      remoteProjectSessions={demoRemoteSessions}
      initiallyCollapseRemoteProject
    />
  ),
  args: {
    ...Default.args!,
  },
};

export const CollapsedProjectPermissionPrecedence: Story = {
  name: 'Collapsed project · permission wins over running',
  render: (args) => (
    <WithProjectsLayout {...args} localProjectLiveSessionStatuses={DEMO_MIXED_SESSION_STATUSES} />
  ),
  args: {
    ...Default.args!,
  },
};

export const CollapsedProjectChildPermissionRequired: Story = {
  name: 'Collapsed project · child tab permission required',
  render: (args) => (
    <WithProjectsLayout
      {...args}
      localProjectLiveSessionStatuses={DEMO_CHILD_PERMISSION_SESSION_STATUSES}
      localProjectChildSessionsByParent={demoChildSessionsByParent}
    />
  ),
  args: {
    ...Default.args!,
  },
};

export const CollapsedGitHubRepositoryRunning: Story = {
  name: 'Collapsed GitHub repository · running',
  render: (args) => <WithProjectsLayout {...args} />,
  args: {
    ...Default.args!,
    sessionListProps: collapsedGitHubRepositoryRunning,
  },
};

export const CollapsedGitHubRepositoryInitializing: Story = {
  name: 'Collapsed GitHub repository · initializing',
  render: (args) => <WithProjectsLayout {...args} />,
  args: {
    ...Default.args!,
    sessionListProps: collapsedGitHubRepositoryInitializing,
  },
};

export const CollapsedGitHubRepositoryPermissionRequired: Story = {
  name: 'Collapsed GitHub repository · permission required',
  render: (args) => <WithProjectsLayout {...args} />,
  args: {
    ...Default.args!,
    sessionListProps: collapsedGitHubRepositoryPermissionRequired,
  },
};

/** 180 conversations across chats and eight worktree repositories for scrolling and density checks. */
export const StressTest: Story = {
  name: 'Stress test (180 sessions)',
  render: (args) => <WithProjectsLayout {...args} />,
  args: {
    ...Default.args!,
    sessionListProps: stressTaskListProps,
  },
};

/**
 * The Tasks entry only exists while the Tasks beta is on (`showTasks`, driven by
 * `tasksFeatureEnabledAtom`). It sits with New Chat at the top of the sidebar,
 * not in the bottom utility rail, because it is a primary destination. Every
 * other story leaves it off, which is the default state for anyone who has not
 * enabled Developer mode plus the beta — so this is the one place the entry
 * stays reviewable. No open-task count on the row: the number was noise next
 * to New chat and is already available on the Tasks page itself.
 *
 * The trailing `+` is quick capture: it opens the global capture dialog without
 * navigating, so writing a task down stays cheaper than starting a chat. Its
 * tooltip carries the shortcut — in Storybook the command registry is empty, so
 * only the label shows.
 */
export const TasksBetaEnabled: Story = {
  name: 'Tasks beta enabled',
  render: (args) => <WithProjectsLayout {...args} />,
  args: {
    ...Default.args!,
    showTasks: true,
    onNewTaskClicked: () => {},
  },
};

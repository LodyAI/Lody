import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider } from 'jotai';
import { SessionList } from '@/components/session-list';
import type { SessionListProps } from '@/components/session-list';
import { sidebarCollapsedOpenedBySessionsAtom } from '@/atoms/focus-layer';
import { useEffect, useMemo, useRef, useState } from 'react';

const meta = {
  title: 'Components/SessionList',
  component: SessionList,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof SessionList>;

export default meta;
type Story = StoryObj<typeof meta>;

type TaskListDemoProps = SessionListProps & {
  containerClassName?: string;
  /** Seeds the shared sidebar collapse atom so a story can show a folded opener. */
  collapsedOpenedBySessionIds?: Record<string, boolean>;
};

function TaskListDemo({
  sessions,
  repos,
  isLoading,
  selectedSessionId,
  containerClassName,
  collapsedOpenedBySessionIds,
}: TaskListDemoProps) {
  const [selectedId, setSelectedId] = useState<string | null>(selectedSessionId ?? null);
  const [repoState, setRepoState] = useState(repos);
  const [chatsCollapsed, setChatsCollapsed] = useState(false);
  const [taskState, setTaskState] = useState(sessions);
  const nextTaskIdRef = useRef(1);

  useEffect(() => {
    setRepoState(repos);
  }, [repos]);

  useEffect(() => {
    setSelectedId(selectedSessionId ?? null);
  }, [selectedSessionId]);

  useEffect(() => {
    setTaskState(sessions);
  }, [sessions]);

  const toggleRepoCollapsed = (repoFullName: string) => {
    setRepoState((prev) =>
      prev.map((repo) =>
        repo.repoFullName === repoFullName ? { ...repo, collapsed: !repo.collapsed } : repo
      )
    );
  };

  const archiveTask = (sessionId: string) => {
    setTaskState((prev) => prev.filter((task) => task.sessionId !== sessionId));
    setSelectedId((prev) => (prev === sessionId ? null : prev));
  };

  const renameTask = (sessionId: string, nextTitle: string) => {
    setTaskState((prev) =>
      prev.map((task) => (task.sessionId === sessionId ? { ...task, title: nextTitle } : task))
    );
  };

  const createTask = (repoFullName?: string) => {
    const nextId = nextTaskIdRef.current++;
    const normalizedRepoFullName =
      typeof repoFullName === 'string' ? repoFullName.trim() || undefined : undefined;
    const sessionId = `new-task-${nextId}`;

    setTaskState((prev) => [
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
    setSelectedId(sessionId);
  };

  const frameClassName = useMemo(
    () =>
      [
        'w-[360px] rounded-xl p-3 shadow-lg',
        'bg-card text-card-foreground',
        'border border-border/60',
        containerClassName,
      ].join(' '),
    [containerClassName]
  );

  // A fresh store per mount keeps stories independent: the collapse state is a
  // shared jotai atom in production, so a leaked default would bleed across.
  const store = useMemo(() => {
    const next = createStore();
    if (collapsedOpenedBySessionIds) {
      next.set(sidebarCollapsedOpenedBySessionsAtom, collapsedOpenedBySessionIds);
    }
    return next;
  }, [collapsedOpenedBySessionIds]);

  return (
    <div className={frameClassName}>
      <Provider store={store}>
        <SessionList
          sessions={taskState}
          repos={repoState}
          isLoading={isLoading}
          chatsCollapsed={chatsCollapsed}
          selectedSessionId={selectedId}
          onSelect={setSelectedId}
          onToggleRepoCollapsed={toggleRepoCollapsed}
          onToggleChatsCollapsed={() => setChatsCollapsed((prev) => !prev)}
          onArchiveSession={archiveTask}
          onRenameSession={renameTask}
          onNew={createTask}
          onMoveRepo={(move) => setRepoState(move.nextRepos)}
          getSessionHref={(sessionId) => `/demo/sessions/${sessionId}`}
        />
      </Provider>
    </div>
  );
}

const NOW = Date.now();

const DEFAULT_ARGS: SessionListProps = {
  selectedSessionId: 'task-4',
  repos: [
    { repoFullName: 'loro-dev/loro', collapsed: false },
    { repoFullName: 'loro-dev/lody', collapsed: false },
  ],
  sessions: [
    {
      sessionId: 'task-1',
      title: 'Browser notifications',
      repoFullName: 'loro-dev/loro',
      branchName: 'feat/browser-notifications',
      prUrl: 'https://github.com/loro-dev/loro/pull/123',
      prStatus: 'open',
      latestMessageAt: NOW - 24 * 60 * 60 * 1000,
      addedLines: 123,
      deletedLines: 912,
      isWorking: true,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
      isWorktree: true,
    },
    {
      sessionId: 'task-2',
      title: 'Flock meta persistence',
      repoFullName: 'loro-dev/loro',
      branchName: 'feat/meta-persistence',
      prUrl: 'https://github.com/loro-dev/loro/pull/456',
      prStatus: 'merged',
      latestMessageAt: NOW - 2 * 24 * 60 * 60 * 1000,
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
      title: 'Fix Data Persistence Issue',
      repoFullName: 'loro-dev/lody',
      branchName: 'fix/data-persistence',
      prUrl: 'https://github.com/loro-dev/lody/pull/78',
      prStatus: 'open',
      latestMessageAt: NOW - 10 * 60 * 1000,
      addedLines: 456,
      deletedLines: 12,
      isWorking: false,
      hasUnreadMessages: true,
      isOffline: false,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-5',
      title: 'Delete outdated comments',
      repoFullName: 'loro-dev/lody',
      branchName: 'chore/delete-comments',
      latestMessageAt: NOW - 12 * 60 * 1000,
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

export const Default: Story = {
  args: DEFAULT_ARGS,
  render: (args) => <TaskListDemo {...args} />,
};

export const Loading: Story = {
  args: {
    ...DEFAULT_ARGS,
    sessions: [],
    repos: [],
    isLoading: true,
  },
  render: (args) => <TaskListDemo {...args} />,
};

export const Light: Story = {
  args: DEFAULT_ARGS,
  parameters: {
    globals: { theme: 'light' },
  },
  render: (args) => <TaskListDemo {...args} />,
};

export const Dark: Story = {
  args: DEFAULT_ARGS,
  parameters: {
    globals: { theme: 'dark' },
  },
  render: (args) => <TaskListDemo {...args} />,
};

// Team ("All Tasks") scope on a multi-member workspace: each row carries its
// author, so the session title shows the owner's avatar at its leading edge.
const TEAM_OWNERS = [
  { name: 'Ada Lovelace' },
  { name: 'Grace Hopper' },
  { name: 'Linus Torvalds' },
  { name: 'Margaret Hamilton' },
] as const;

export const TeamScopeAuthors: Story = {
  args: {
    ...DEFAULT_ARGS,
    sessions: DEFAULT_ARGS.sessions.map((task, index) => ({
      ...task,
      owner: TEAM_OWNERS[index % TEAM_OWNERS.length],
    })),
  },
  render: (args) => <TaskListDemo {...args} />,
};

export const RepoCollapsed: Story = {
  args: {
    ...DEFAULT_ARGS,
    repos: [
      { repoFullName: 'loro-dev/loro', collapsed: true },
      { repoFullName: 'loro-dev/lody', collapsed: false },
    ],
  },
  render: (args) => <TaskListDemo {...args} />,
};

export const EmptyRepo: Story = {
  args: {
    ...DEFAULT_ARGS,
    selectedSessionId: null,
    repos: [
      { repoFullName: 'loro-dev/loro', collapsed: false },
      { repoFullName: 'loro-dev/empty-repo', collapsed: false },
      { repoFullName: 'loro-dev/lody', collapsed: false },
    ],
    sessions: DEFAULT_ARGS.sessions.filter((task) => task.repoFullName !== 'loro-dev/empty-repo'),
  },
  render: (args) => <TaskListDemo {...args} />,
};

export const LongBranchName: Story = {
  args: {
    ...DEFAULT_ARGS,
    selectedSessionId: 'task-long-branch',
    repos: [{ repoFullName: 'loro-dev/loro', collapsed: false }],
    sessions: [
      {
        sessionId: 'task-long-branch',
        title: 'Long branch name truncation',
        repoFullName: 'loro-dev/loro',
        branchName:
          'feat/super-long-branch-name-that-should-be-truncated-in-the-ui-and-shown-in-a-tooltip-on-hover',
        prUrl: 'https://github.com/loro-dev/loro/pull/999',
        latestMessageAt: NOW - 2 * 60 * 1000,
        addedLines: 12,
        deletedLines: 3,
        isWorking: false,
        hasUnreadMessages: false,
        isOffline: false,
        isWaitingPermission: false,
      },
    ],
  },
  render: (args) => <TaskListDemo {...args} />,
};

function buildLongListTasks(): SessionListProps {
  const repoNames = ['loro-dev/loro', 'loro-dev/lody', 'loro-dev/boise', 'loro-dev/empty-repo'];
  const repos = repoNames.map((repoFullName) => ({ repoFullName, collapsed: false }));

  const sessions = Array.from({ length: 120 }, (_, index) => {
    const repoFullName = repoNames[index % (repoNames.length - 1)] ?? 'loro-dev/loro';
    const prNumber = 1_000 + index;
    return {
      sessionId: `task-long-${index}`,
      title: `Task ${index + 1}`,
      repoFullName,
      branchName: `feat/long-list-${index + 1}`,
      prUrl: index % 7 === 0 ? `https://github.com/${repoFullName}/pull/${prNumber}` : null,
      latestMessageAt: NOW - index * 60 * 1000,
      addedLines: index % 9 === 0 ? 0 : (index % 200) + 1,
      deletedLines: index % 11 === 0 ? 0 : (index % 120) + 1,
      isWorking: index % 17 === 0,
      hasUnreadMessages: index % 13 === 0,
      isOffline: index % 23 === 0,
      isWaitingPermission: false,
    } satisfies SessionListProps['sessions'][number];
  });

  const chats = Array.from({ length: 18 }, (_, index) => ({
    sessionId: `chat-long-${index}`,
    title: `Chat ${index + 1}`,
    repoFullName: null,
    branchName: '',
    latestMessageAt: NOW - (index + 3) * 60 * 1000,
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: index % 2 === 0,
    isOffline: false,
    isWaitingPermission: false,
  })) satisfies SessionListProps['sessions'];

  return {
    selectedSessionId: 'task-long-0',
    repos,
    sessions: [...sessions, ...chats],
  };
}

export const VeryLongList: Story = {
  args: buildLongListTasks(),
  render: (args) => (
    <TaskListDemo {...args} containerClassName="scrollbar-pro max-h-[520px] overflow-auto" />
  ),
};

const PR_STATUS_ARGS: SessionListProps = {
  selectedSessionId: 'task-open',
  repos: [{ repoFullName: 'loro-dev/lody', collapsed: false }],
  sessions: [
    {
      sessionId: 'task-open',
      title: 'Open PR - In Review',
      repoFullName: 'loro-dev/lody',
      branchName: 'feat/new-feature',
      prUrl: 'https://github.com/loro-dev/lody/pull/100',
      prStatus: 'open',
      latestMessageAt: NOW - 10 * 60 * 1000,
      addedLines: 150,
      deletedLines: 20,
      isWorking: true,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-merged',
      title: 'Merged PR - Completed',
      repoFullName: 'loro-dev/lody',
      branchName: 'feat/completed-feature',
      prUrl: 'https://github.com/loro-dev/lody/pull/99',
      prStatus: 'merged',
      latestMessageAt: NOW - 2 * 60 * 60 * 1000,
      addedLines: 300,
      deletedLines: 50,
      isWorking: false,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-closed',
      title: 'Closed PR - Rejected',
      repoFullName: 'loro-dev/lody',
      branchName: 'feat/rejected-feature',
      prUrl: 'https://github.com/loro-dev/lody/pull/98',
      prStatus: 'closed',
      latestMessageAt: NOW - 24 * 60 * 60 * 1000,
      addedLines: 80,
      deletedLines: 10,
      isWorking: false,
      hasUnreadMessages: false,
      isOffline: false,
      isWaitingPermission: false,
    },
    {
      sessionId: 'task-no-pr',
      title: 'No PR yet',
      repoFullName: 'loro-dev/lody',
      branchName: 'feat/wip-feature',
      latestMessageAt: NOW - 30 * 60 * 1000,
      addedLines: 50,
      deletedLines: 5,
      isWorking: false,
      hasUnreadMessages: true,
      isOffline: false,
      isWaitingPermission: false,
    },
  ],
};

export const PRStatusVariants: Story = {
  args: PR_STATUS_ARGS,
  render: (args) => <TaskListDemo {...args} />,
};

type StoryTask = SessionListProps['sessions'][number];

function buildStateTask(
  sessionId: string,
  title: string,
  repoFullName: string | null,
  minutesAgo: number,
  overrides: Partial<StoryTask> = {}
): StoryTask {
  return {
    sessionId,
    title,
    repoFullName,
    branchName: repoFullName ? `storybook/${sessionId}` : '',
    latestMessageAt: NOW - minutesAgo * 60 * 1000,
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
    ...overrides,
  };
}

function buildPrState(
  repoFullName: string,
  prNumber: number,
  prStatus: NonNullable<StoryTask['prStatus']>
) {
  return {
    prUrl: `https://github.com/${repoFullName}/pull/${prNumber}`,
    prNumber,
    prStatus,
  };
}

const ALL_DIFF_AND_PR_STATES_ARGS: SessionListProps = {
  selectedSessionId: 'state-open-mixed',
  repos: [
    { repoFullName: 'loro-dev/lody', collapsed: false },
    { repoFullName: 'loro-dev/loro', collapsed: false },
    { repoFullName: 'loro-dev/boise', collapsed: false },
    { repoFullName: 'loro-dev/fusio', collapsed: false },
  ],
  sessions: [
    // PR + diff combinations. The diff stays immediately left of the PR icon.
    buildStateTask('state-open-mixed', 'Open PR · mixed diff', 'loro-dev/lody', 1, {
      ...buildPrState('loro-dev/lody', 401, 'open'),
      addedLines: 182,
      deletedLines: 47,
    }),
    buildStateTask('state-draft-add', 'Draft PR · additions only', 'loro-dev/lody', 2, {
      ...buildPrState('loro-dev/lody', 402, 'draft'),
      addedLines: 96,
    }),
    buildStateTask('state-merged-delete', 'Merged PR · deletions only', 'loro-dev/lody', 3, {
      ...buildPrState('loro-dev/lody', 403, 'merged'),
      deletedLines: 312,
    }),
    buildStateTask('state-closed-clean', 'Closed PR · no diff', 'loro-dev/lody', 4, {
      ...buildPrState('loro-dev/lody', 404, 'closed'),
    }),
    buildStateTask('state-no-pr-mixed', 'No PR · mixed diff', 'loro-dev/lody', 5, {
      addedLines: 24,
      deletedLines: 9,
    }),

    // Every PR status both with and without line changes.
    buildStateTask('state-open-clean', 'Open PR · no diff', 'loro-dev/loro', 6, {
      ...buildPrState('loro-dev/loro', 501, 'open'),
    }),
    buildStateTask('state-draft-mixed', 'Draft PR · mixed diff', 'loro-dev/loro', 7, {
      ...buildPrState('loro-dev/loro', 502, 'draft'),
      addedLines: 64,
      deletedLines: 12,
    }),
    buildStateTask('state-merged-mixed', 'Merged PR · mixed diff', 'loro-dev/loro', 8, {
      ...buildPrState('loro-dev/loro', 503, 'merged'),
      addedLines: 420,
      deletedLines: 118,
    }),
    buildStateTask('state-closed-mixed', 'Closed PR · mixed diff', 'loro-dev/loro', 9, {
      ...buildPrState('loro-dev/loro', 504, 'closed'),
      addedLines: 7,
      deletedLines: 43,
    }),
    buildStateTask('state-no-pr-add-one', 'No PR · one line added', 'loro-dev/loro', 10, {
      addedLines: 1,
    }),

    // Diff-only fallbacks, including zero, balanced, and large values.
    buildStateTask('state-no-pr-delete-one', 'No PR · one line deleted', 'loro-dev/boise', 11, {
      deletedLines: 1,
    }),
    buildStateTask('state-balanced', 'No PR · balanced diff', 'loro-dev/boise', 12, {
      addedLines: 88,
      deletedLines: 88,
    }),
    buildStateTask('state-large-diff', 'No PR · large diff', 'loro-dev/boise', 13, {
      addedLines: 12_540,
      deletedLines: 9_876,
    }),
    buildStateTask('state-open-large', 'Open PR · large diff', 'loro-dev/boise', 14, {
      ...buildPrState('loro-dev/boise', 601, 'open'),
      addedLines: 8_912,
      deletedLines: 7_604,
    }),
    buildStateTask('state-draft-clean', 'Draft PR · no diff', 'loro-dev/boise', 15, {
      ...buildPrState('loro-dev/boise', 602, 'draft'),
    }),

    // Leading status variants combined with trailing PR / diff states.
    buildStateTask('state-working', 'Working · Open PR · mixed diff', 'loro-dev/fusio', 16, {
      ...buildPrState('loro-dev/fusio', 701, 'open'),
      addedLines: 33,
      deletedLines: 4,
      isWorking: true,
    }),
    buildStateTask(
      'state-permission',
      'Waiting permission · Draft PR · mixed diff',
      'loro-dev/fusio',
      17,
      {
        ...buildPrState('loro-dev/fusio', 702, 'draft'),
        addedLines: 12,
        deletedLines: 6,
        isWaitingPermission: true,
      }
    ),
    buildStateTask('state-unread', 'Unread · Merged PR · mixed diff', 'loro-dev/fusio', 18, {
      ...buildPrState('loro-dev/fusio', 703, 'merged'),
      addedLines: 51,
      deletedLines: 13,
      hasUnreadMessages: true,
    }),
    buildStateTask('state-pinned', 'Pinned · Closed PR · deletions only', 'loro-dev/fusio', 19, {
      ...buildPrState('loro-dev/fusio', 704, 'closed'),
      deletedLines: 20,
      isPinned: true,
    }),
    buildStateTask(
      'state-long-title',
      'No PR · very long session title that demonstrates truncation beside large diff stats',
      'loro-dev/fusio',
      20,
      {
        addedLines: 1_000,
        deletedLines: 999,
        isOffline: true,
      }
    ),

    // Non-repo rows complete the long mixed session list.
    buildStateTask('state-chat-plain', 'Chat · plain', null, 21),
    buildStateTask('state-chat-working', 'Chat · working', null, 22, { isWorking: true }),
    buildStateTask('state-chat-permission', 'Chat · waiting permission', null, 23, {
      isWaitingPermission: true,
    }),
    buildStateTask('state-chat-unread', 'Chat · unread', null, 24, {
      hasUnreadMessages: true,
    }),
    buildStateTask('state-chat-pinned', 'Chat · pinned', null, 25, { isPinned: true }),
  ],
};

/**
 * A long, scrollable session list containing every PR status and the important
 * diff combinations. No group has more than five rows, so Storybook renders all
 * cases immediately instead of hiding part of the matrix behind “Show all”.
 */
export const AllDiffAndPrStates: Story = {
  name: 'All Diff and PR States',
  args: ALL_DIFF_AND_PR_STATES_ARGS,
  render: (args) => (
    <TaskListDemo {...args} containerClassName="scrollbar-pro h-[760px] overflow-y-auto" />
  ),
};

// ---------------------------------------------------------------------------
// MCP-opened independent Sessions (`SessionMeta.openedBySessionId`)
// ---------------------------------------------------------------------------

/**
 * `lody_session_create` records the Session that opened each new one. The
 * sidebar indents those rows under their opener, but they stay INDEPENDENT
 * Sessions — own machine, own project, own lifecycle — not `parentSessionId`
 * child tabs. Covered here: an opener with several opened Sessions, a working
 * one, an unread one, the active one, and an orphan whose opener is not in this
 * list (archived / another scope) and therefore stays top-level.
 */
const OPENED_SESSIONS_ARGS: SessionListProps = {
  selectedSessionId: 'mcp-opened-2',
  repos: [{ repoFullName: 'loro-dev/lody', collapsed: false }],
  sessions: [
    buildStateTask('mcp-opener', 'Refactor the sidebar tree', 'loro-dev/lody', 2, {
      ...buildPrState('loro-dev/lody', 812, 'open'),
      addedLines: 214,
      deletedLines: 63,
    }),
    buildStateTask('mcp-opened-1', 'Audit archive + scope behavior', 'loro-dev/lody', 4, {
      openedBySessionId: 'mcp-opener',
      isWorking: true,
      addedLines: 38,
      deletedLines: 4,
    }),
    buildStateTask('mcp-opened-2', 'Write the tree unit tests', 'loro-dev/lody', 6, {
      openedBySessionId: 'mcp-opener',
      addedLines: 121,
      deletedLines: 0,
    }),
    buildStateTask('mcp-opened-3', 'Check mobile still reads correctly', 'loro-dev/lody', 9, {
      openedBySessionId: 'mcp-opener',
      hasUnreadMessages: true,
    }),
    buildStateTask('mcp-opened-4', 'Update the scoped AGENTS.md', 'loro-dev/lody', 14, {
      openedBySessionId: 'mcp-opener',
      ...buildPrState('loro-dev/lody', 813, 'draft'),
    }),
    // Opened by an agent running inside a CHILD TAB of `mcp-opener`. Child Tabs
    // have no sidebar row, so the row nests under the Tab's ROOT Session
    // (`openedByRowSessionId`) while the precise `openedBySessionId` still names
    // the Tab — that is what "Go to Opener Session" navigates to.
    buildStateTask('mcp-from-child-tab', 'Opened from a child tab', 'loro-dev/lody', 17, {
      openedBySessionId: 'mcp-opener-child-tab',
      openedByRowSessionId: 'mcp-opener',
      addedLines: 55,
      deletedLines: 9,
    }),
    buildStateTask('mcp-orphan', 'Opened by an archived session', 'loro-dev/lody', 21, {
      openedBySessionId: 'session-not-in-this-list',
      openedByRowSessionId: 'session-not-in-this-list',
      addedLines: 7,
      deletedLines: 7,
    }),
    buildStateTask('mcp-standalone', 'Unrelated conversation', 'loro-dev/lody', 40),
  ],
};

export const OpenedSessions: Story = {
  name: 'Opened Sessions (MCP)',
  args: OPENED_SESSIONS_ARGS,
  render: (args) => <TaskListDemo {...args} />,
};

export const OpenedSessionsLight: Story = {
  name: 'Opened Sessions (MCP) · Light',
  args: OPENED_SESSIONS_ARGS,
  parameters: { globals: { theme: 'light' } },
  render: (args) => <TaskListDemo {...args} />,
};

/**
 * The opener itself is WORKING. Status outranks the tree at that node, so the
 * opener shows its spinner instead of the disclosure — the same rule an active
 * opened Session follows when it drops its ├/└. Folding is still reachable
 * from the row's context menu, which carries the identical toggle.
 */
export const OpenedSessionsActiveOpener: Story = {
  name: 'Opened Sessions (MCP) · Active opener',
  args: {
    ...OPENED_SESSIONS_ARGS,
    selectedSessionId: 'mcp-opener',
    sessions: OPENED_SESSIONS_ARGS.sessions.map((session) =>
      session.sessionId === 'mcp-opener' ? { ...session, isWorking: true } : session
    ),
  },
  render: (args) => <TaskListDemo {...args} />,
};

/**
 * The opener folded: its opened Sessions are hidden, the opener keeps its own
 * row, and the disclosure chevron stays visible (this is the only state where
 * rows are hidden, so the affordance must not need a hover to be found).
 */
export const OpenedSessionsCollapsed: Story = {
  name: 'Opened Sessions (MCP) · Collapsed',
  args: {
    ...OPENED_SESSIONS_ARGS,
    selectedSessionId: 'mcp-opener',
  },
  render: (args) => <TaskListDemo {...args} collapsedOpenedBySessionIds={{ 'mcp-opener': true }} />,
};

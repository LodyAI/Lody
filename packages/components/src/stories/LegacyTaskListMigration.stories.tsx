import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider } from 'jotai';
import { useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { TaskList, type TaskListTask, type TaskListRepoState } from '@/components/task-list';
import { sidebarShowFullListAtom } from '@/atoms/focus-layer';
import { sessionSendStatusesAtom } from '@/atoms/session-send-status';
import { ForceDesktopLayoutProvider } from '@/hooks/use-mobile';

const meta = {
  title: 'Components/Legacy Task List Migration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const styles = stylex.create({
  canvas: {
    minHeight: '100vh',
    padding: 16,
    backgroundColor: 'hsl(var(--background) / 1)',
    color: 'hsl(var(--foreground) / 1)',
  },
  panel: {
    width: 320,
    maxWidth: '100%',
    padding: 8,
    backgroundColor: 'hsl(var(--sidebar) / 1)',
  },
  narrow: { width: 240 },
  section: { marginBottom: 24 },
  output: { display: 'block', marginTop: 16, fontSize: 12, overflowWrap: 'anywhere' },
});

const NOW = Date.UTC(2026, 9, 22, 9);
const ALPHA = 'migration-fixture/alpha-project';
const BETA = 'migration-fixture/beta-project';
const variables = {
  '--spacing': '0.375rem',
  '--text-xs': '0.875rem',
  '--text-xs--line-height': '1.75',
  '--text-sm': '1.0625rem',
  '--text-sm--line-height': '1.6',
  '--radius-sm': '0.625rem',
  '--sidebar-ring': '280 65% 45%',
  '--sidebar-foreground-muted': '185 65% 35%',
  '--muted-foreground': '185 65% 35%',
  '--font-weight-medium': '650',
} as CSSProperties;

function task(taskId: string, title: string, extra: Partial<TaskListTask> = {}): TaskListTask {
  return {
    taskId,
    title,
    repoFullName: null,
    branchName: '',
    latestMessageAt: NOW - 10 * 60_000,
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
    ...extra,
  };
}

const TASKS: TaskListTask[] = [
  task('chat-rest', 'A resting conversation with a long title that must remain clipped 会话标题'),
  task('chat-sending', 'An unsent first message'),
  task('chat-failed', 'A failed first message'),
  task('alpha-pinned', 'Pinned: preserve a very long clipped title during archive confirmation', {
    repoFullName: ALPHA,
    branchName: 'migration/long-branch-name-with-several-segments',
    isPinned: true,
    machineName: 'Synthetic workstation',
    prUrl: 'https://github.com/migration-fixture/alpha-project/pull/42',
    prStatus: 'open',
    prCiState: 's',
    prReadiness: 'y',
    addedLines: 1234,
    deletedLines: 56,
    sharing: {
      visibility: 'private',
      canManage: true,
      privateReason: 'machine',
      machineId: null,
      localProjectId: null,
      machineName: 'Synthetic workstation',
      projectName: null,
    },
  }),
  task('alpha-working', 'Agent working', { repoFullName: ALPHA, isWorking: true }),
  task('alpha-waiting', 'Waiting for permission', {
    repoFullName: ALPHA,
    isWaitingPermission: true,
  }),
  task('alpha-unread', 'Unread merged pull request', {
    repoFullName: ALPHA,
    hasUnreadMessages: true,
    prUrl: 'https://github.com/migration-fixture/alpha-project/pull/43',
    prStatus: 'merged',
  }),
  task('alpha-rest', 'Resting mergeable pull request', {
    repoFullName: ALPHA,
    prUrl: 'https://github.com/migration-fixture/alpha-project/pull/44',
    prStatus: 'open',
    prReadiness: 'y',
  }),
  task('beta-closed', 'Closed pull request on an offline machine', {
    repoFullName: BETA,
    isOffline: true,
    prUrl: 'https://github.com/migration-fixture/beta-project/pull/45',
    prStatus: 'closed',
  }),
];

function RootVariables({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = Object.keys(variables).map((key) => [
      key,
      root.style.getPropertyValue(key),
      root.style.getPropertyPriority(key),
    ]);
    for (const [key, value] of Object.entries(variables))
      root.style.setProperty(key, String(value));
    return () => {
      for (const [key, value, priority] of previous) {
        if (value) root.style.setProperty(key, value, priority);
        else root.style.removeProperty(key);
      }
    };
  }, []);
  return children;
}

function Demo({
  initialTasks = TASKS,
  anchors = false,
  readOnly = false,
  narrow = false,
  subtree = false,
  caller = false,
  naturalDevice = false,
  initialCollapsed = false,
  activeGroup = false,
  toggleOnly = false,
  stateCaller = false,
}: {
  initialTasks?: TaskListTask[];
  anchors?: boolean;
  readOnly?: boolean;
  narrow?: boolean;
  subtree?: boolean;
  caller?: boolean;
  naturalDevice?: boolean;
  initialCollapsed?: boolean;
  activeGroup?: boolean;
  toggleOnly?: boolean;
  stateCaller?: boolean;
}) {
  const store = useMemo(() => {
    const value = createStore();
    value.set(sidebarShowFullListAtom, {});
    value.set(sessionSendStatusesAtom, {
      'chat-sending': {
        state: 'sending',
        progress: 40,
        sentBytes: 400,
        totalBytes: 1000,
        unsentNewConversation: true,
      },
      'chat-failed': {
        state: 'failed',
        progress: 0,
        sentBytes: 0,
        totalBytes: 0,
        unsentNewConversation: true,
      },
    });
    return value;
  }, []);
  const [tasks, setTasks] = useState(initialTasks);
  const [repos, setRepos] = useState<TaskListRepoState[]>([
    { repoFullName: ALPHA, collapsed: initialCollapsed },
    { repoFullName: BETA, collapsed: initialCollapsed },
  ]);
  const [chatsCollapsed, setChatsCollapsed] = useState(initialCollapsed);
  const [selected, setSelected] = useState('alpha-pinned');
  const [event, setEvent] = useState('Ready');
  const contents = (
    <div
      {...stylex.props(styles.canvas)}
      data-legacy-task-fixture
      style={subtree ? variables : undefined}
    >
      <div {...stylex.props(styles.panel, narrow && styles.narrow)} data-legacy-task-panel>
        <TaskList
          tasks={tasks}
          repos={repos}
          chatsCollapsed={chatsCollapsed}
          selectedTaskId={selected}
          activeGroupKey={activeGroup ? ALPHA : undefined}
          className={
            stateCaller
              ? '[&_svg]:opacity-50 [&_button]:pointer-events-none'
              : caller
                ? 'gap-5 p-3 border border-sidebar-ring w-[280px] max-w-full'
                : undefined
          }
          headerAction={
            <Button size="small" variant="ghost" onClick={() => setEvent('Header action')}>
              Filter
            </Button>
          }
          onSelectTask={
            readOnly
              ? undefined
              : (id) => {
                  setSelected(id);
                  setEvent(`Selected ${id}`);
                }
          }
          onToggleRepoCollapsed={
            readOnly
              ? undefined
              : (name) =>
                  setRepos((current) =>
                    current.map((repo) =>
                      repo.repoFullName === name ? { ...repo, collapsed: !repo.collapsed } : repo
                    )
                  )
          }
          onToggleChatsCollapsed={readOnly ? undefined : () => setChatsCollapsed((value) => !value)}
          onArchiveTask={
            readOnly
              ? undefined
              : (id) => {
                  setTasks((current) => current.filter((item) => item.taskId !== id));
                  setEvent(`Archived ${id}`);
                }
          }
          onRenameTask={
            readOnly
              ? undefined
              : (id, title) => {
                  setTasks((current) =>
                    current.map((item) => (item.taskId === id ? { ...item, title } : item))
                  );
                  setEvent(`Renamed ${id}: ${title}`);
                }
          }
          onTogglePinTask={
            readOnly
              ? undefined
              : (id, isPinned) => {
                  setTasks((current) =>
                    current.map((item) => (item.taskId === id ? { ...item, isPinned } : item))
                  );
                  setEvent(`Pinned ${id}: ${isPinned}`);
                }
          }
          onCopySessionUrl={readOnly ? undefined : (id) => setEvent(`Copied ${id}`)}
          onShareSessionWithTeam={readOnly ? undefined : (id) => setEvent(`Shared ${id}`)}
          onNew={readOnly ? undefined : (name) => setEvent(`New ${name ?? 'chat'}`)}
          onMoveRepo={
            readOnly
              ? undefined
              : (move) => {
                  setRepos(move.nextRepos);
                  setEvent(`Moved ${move.activeRepoFullName} to ${move.toIndex}`);
                }
          }
          onOpenPullRequest={
            readOnly ? undefined : ({ taskId }) => setEvent(`Pull request ${taskId}`)
          }
          onNavigateToNewSession={
            readOnly || toggleOnly ? undefined : (name) => setEvent(`Navigate ${name ?? 'chat'}`)
          }
          getTaskHref={anchors ? (id) => `#synthetic-session-${id}` : undefined}
        />
      </div>
      <output {...stylex.props(styles.output)} data-legacy-task-event>
        {event}
      </output>
    </div>
  );
  return (
    <Provider store={store}>
      {naturalDevice ? (
        contents
      ) : (
        <ForceDesktopLayoutProvider>{contents}</ForceDesktopLayoutProvider>
      )}
    </Provider>
  );
}

export const Rows: Story = { render: () => <Demo activeGroup /> };
export const Anchors: Story = { render: () => <Demo anchors /> };
export const Narrow: Story = { render: () => <Demo narrow /> };
export const Overflow: Story = {
  render: () => (
    <Demo
      initialTasks={Array.from({ length: 7 }, (_, i) =>
        task(`overflow-${i}`, `Conversation ${i + 1}`, { latestMessageAt: NOW - i * 60_000 })
      )}
    />
  ),
};
export const ReadOnlyCollapsed: Story = { render: () => <Demo readOnly initialCollapsed /> };
export const CallerOverrides: Story = { render: () => <Demo caller /> };
export const SubtreeVariables: Story = { render: () => <Demo subtree /> };
export const RootVariableOverrides: Story = {
  render: () => (
    <RootVariables>
      <Demo />
    </RootVariables>
  ),
};
export const NaturalDevice: Story = { render: () => <Demo naturalDevice /> };
export const ToggleOnly: Story = { render: () => <Demo toggleOnly /> };
export const ExternalGenericGroup: Story = {
  render: () => (
    <div className="group" data-legacy-external-group style={{ padding: 48 }}>
      <Demo toggleOnly />
    </div>
  ),
};
export const StateCallerOverrides: Story = {
  render: () => (
    <div className="group" data-legacy-external-group style={{ padding: 48 }}>
      <Demo toggleOnly stateCaller />
    </div>
  ),
};

export const LoadingAndEmpty: Story = {
  render: () => (
    <div {...stylex.props(styles.canvas)} data-legacy-task-fixture>
      <div {...stylex.props(styles.panel)}>
        <section {...stylex.props(styles.section)} data-legacy-task-loading>
          <TaskList
            tasks={[]}
            repos={[]}
            isLoading
            headerAction={<Button size="small">Loading filter</Button>}
          />
        </section>
        <section {...stylex.props(styles.section)} data-legacy-task-empty>
          <TaskList
            tasks={[]}
            repos={[]}
            headerAction={<Button size="small">Empty filter</Button>}
          />
        </section>
        <section data-legacy-task-no-action>
          <TaskList tasks={[]} repos={[]} />
        </section>
      </div>
    </div>
  ),
};

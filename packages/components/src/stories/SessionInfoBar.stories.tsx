import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import {
  getServerNow,
  SESSION_GOAL_COMMANDS,
  type GitHubMergeMethod,
  type PendingScheduledTask,
  type SessionGoalCommand,
  type SessionGoalMessage,
  type SessionPullRequestMeta,
} from '@lody/shared';
import { SessionInfoBar } from '@/components/sessions/session-info-bar';
import type { ContextChipAction, PrCiRun } from '@/components/sessions/session-info-chips';
import type { SessionStatusStripState } from '@/components/sessions/session-status-strip';

const openPr: SessionPullRequestMeta = {
  url: 'https://github.com/loro-dev/lody/pull/2857',
  status: 'open',
} as SessionPullRequestMeta;

const draftPr: SessionPullRequestMeta = {
  url: 'https://github.com/loro-dev/lody/pull/2857',
  status: 'draft',
} as SessionPullRequestMeta;

const mergedPr: SessionPullRequestMeta = {
  url: 'https://github.com/loro-dev/lody/pull/12345',
  status: 'merged',
} as SessionPullRequestMeta;

const LONG_PROJECT =
  'some-organization-with-a-really-long-name/incredibly-long-repository-name-that-should-truncate-gracefully';
const LONG_BRANCH =
  'feat/extremely-long-branch-name-describing-the-whole-feature-in-detail-with-ticket-id-LODY-12345';

const makeGoal = (overrides: Partial<SessionGoalMessage> = {}): SessionGoalMessage => ({
  type: 'goal',
  threadId: 'thread-1',
  objective:
    'Ship the presence-based machine online status end to end: migrate every lastSeen call site, fix the CLI machine list, and land the session info bar.',
  status: 'active',
  ...overrides,
});

const LONG_OBJECTIVE = `Refactor the whole session info surface:
1. merge status, goal and scheduled tasks into one always-visible row above the composer;
2. keep the message queue as its own direct-manipulation surface;
3. make every chip peek on appearance so the user notices new ambient info without a modal;
4. cover the entire matrix in Storybook, including this absurdly long multi-line objective that must scroll inside the popover instead of blowing it up.`;

const makeWakeup = (inMs: number, summary?: string): PendingScheduledTask => ({
  id: `wakeup-${inMs}`,
  kind: 'wakeup',
  createdAtMs: getServerNow(),
  scheduledForMs: getServerNow() + inMs,
  summary: summary ?? 'Check whether the CI run finished and report back.',
});

const makeCron = (
  humanSchedule: string,
  recurring: boolean,
  summary?: string
): PendingScheduledTask => ({
  id: `cron-${humanSchedule}`,
  kind: 'cron',
  createdAtMs: getServerNow(),
  humanSchedule,
  recurring,
  summary: summary ?? 'Summarize new GitHub notifications every morning.',
  timeZone: 'Asia/Shanghai',
});

const CI_PASSING: PrCiRun[] = [
  { name: 'check', status: 'success', durationMs: 62_000, url: 'https://example.com' },
  { name: 'build', status: 'success', durationMs: 4 * 60_000, url: 'https://example.com' },
  { name: 'unit-tests', status: 'success', durationMs: 8 * 60_000, url: 'https://example.com' },
  { name: 'e2e', status: 'success', durationMs: 14 * 60_000, url: 'https://example.com' },
];

const CI_FAILING: PrCiRun[] = [
  { name: 'check', status: 'success', durationMs: 55_000, url: 'https://example.com' },
  { name: 'lint', status: 'failure', durationMs: 30_000, url: 'https://example.com' },
  { name: 'build', status: 'success', durationMs: 3 * 60_000, url: 'https://example.com' },
  { name: 'e2e', status: 'failure', durationMs: 11 * 60_000, url: 'https://example.com' },
  { name: 'deploy-preview', status: 'skipped' },
];

const CI_RUNNING: PrCiRun[] = [
  { name: 'check', status: 'success', durationMs: 58_000, url: 'https://example.com' },
  { name: 'build', status: 'success', durationMs: 3 * 60_000, url: 'https://example.com' },
  { name: 'unit-tests', status: 'running', url: 'https://example.com' },
  { name: 'e2e', status: 'queued' },
  { name: 'deploy-preview', status: 'queued' },
];

function StoryHarness({
  status = null,
  goal = null,
  goalPending = null,
  scheduledTasks,
  prCiRuns,
  projectName = 'loro-dev/lody',
  branch = 'feat/presence-machine-online-session-status',
  workspaceLocation = null,
  pr = openPr,
  diffStat = { add: 128, del: 42 },
  width = 760,
  initialStage,
  withPreview = false,
  actionLabels,
  mergeAction = false,
  syncing = false,
  task = null,
}: {
  status?: SessionStatusStripState | null;
  goal?: SessionGoalMessage | null;
  goalPending?: SessionGoalCommand | null;
  scheduledTasks?: PendingScheduledTask[];
  prCiRuns?: PrCiRun[];
  projectName?: string | null;
  branch?: string | null;
  workspaceLocation?: {
    kind: 'worktree' | 'folder' | 'github-worktree';
    path?: string | null;
  } | null;
  pr?: SessionPullRequestMeta | null;
  diffStat?: { add: number; del: number } | null;
  width?: number;
  initialStage?: 'status' | 'goal' | 'schedule' | 'task' | 'context';
  task?: { taskId: string; title: string } | null;
  withPreview?: boolean;
  actionLabels?: string[];
  mergeAction?: boolean;
  syncing?: boolean;
}) {
  const [currentGoal, setCurrentGoal] = useState(goal);
  const [mergeMethod, setMergeMethod] = useState<GitHubMergeMethod>('merge');
  const contextActions: ContextChipAction[] | undefined = mergeAction
    ? [
        {
          kind: 'merge',
          id: 'merge',
          method: mergeMethod,
          onMerge: fn(),
          onSelectMethod: setMergeMethod,
        },
      ]
    : actionLabels?.map((label) => ({
        id: label.toLowerCase().replaceAll(' ', '-'),
        label,
        onClick: fn(),
      }));
  return (
    <div className="flex max-w-full flex-col" style={{ width }}>
      {/* Room above the bar so chip popovers (side=top) stay visible. */}
      <div className="h-72" />
      <SessionInfoBar
        status={status}
        goal={currentGoal}
        goalCommands={SESSION_GOAL_COMMANDS}
        goalPendingCommand={goalPending}
        onGoalCommand={fn()}
        onGoalDismiss={() => setCurrentGoal(null)}
        scheduledTasks={scheduledTasks}
        prCiRuns={prCiRuns}
        onOpenPrCiRun={fn()}
        task={task}
        onOpenTask={fn()}
        initialStage={initialStage}
        projectName={projectName}
        branch={branch}
        workspaceLocation={workspaceLocation}
        pr={pr}
        onOpenPr={fn()}
        contextActions={contextActions}
        onOpenAllChanges={fn()}
        onOpenBrowser={withPreview ? fn() : undefined}
        diffStat={diffStat}
        syncing={syncing}
      />
      <div className="h-14 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        (composer placeholder)
      </div>
    </div>
  );
}

const meta = {
  title: 'Sessions/SessionInfoBar',
  component: StoryHarness,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

/* ── Context / status matrix ─────────────────────────────────────────── */

export const ContextOnly: Story = { args: {} };

export const ContextWithMachineOffline: Story = {
  args: { status: { kind: 'machine-offline', machineName: 'zx MacBook-Pro.local' } },
};

export const ContextWithMachineRemoved: Story = {
  args: { status: { kind: 'machine-removed' } },
};

export const NoPr: Story = { args: { pr: null } };

const worktreeLocation = {
  kind: 'worktree' as const,
  path: '/Users/zx/.lody/worktrees/loro-dev-lody/feat-presence',
};
const folderLocation = { kind: 'folder' as const, path: '/Users/zx/Code/lody' };
const githubWorktreeLocation = {
  kind: 'github-worktree' as const,
  path: '/Users/zx/.lody/worktrees/loro-dev-lody/feat-presence',
};

/** Worktree session without a PR: the leading glyph is the worktree copy control. */
export const WorktreeNoPr: Story = {
  name: 'Worktree (no PR)',
  args: { workspaceLocation: worktreeLocation, pr: null },
};

/** A changed local worktree without a PR collects its GitHub actions in the context stage. */
export const WorktreeChangedCreatePr: Story = {
  name: 'Worktree changed (Create PR)',
  args: {
    workspaceLocation: worktreeLocation,
    pr: null,
    actionLabels: ['Create PR', 'Commit & Push'],
  },
};

/** A changed worktree with only one available action renders Create PR without a dropdown. */
export const WorktreeChangedCreatePrOnly: Story = {
  name: 'Worktree changed (Create PR only)',
  args: {
    workspaceLocation: worktreeLocation,
    pr: null,
    actionLabels: ['Create PR'],
  },
};

/** A lone action stays directly visible and does not add an empty overflow trigger. */
export const SingleAction: Story = {
  args: { actionLabels: ['Merge PR'] },
};

/** Worktree session with a PR: the leading icon shows PR state, so the worktree
 *  copy control rides in the leading slot after the PR/CI. */
export const WorktreeWithPr: Story = {
  name: 'Worktree (with PR)',
  args: { workspaceLocation: worktreeLocation },
};

/** Local-folder session without a PR: the leading glyph is a folder copy control
 *  (symmetric with the worktree case). */
export const LocalFolderNoPr: Story = {
  name: 'Local folder (no PR)',
  args: { workspaceLocation: folderLocation, pr: null, projectName: 'lody' },
};

/** GitHub session without a PR: since a GitHub project is always a worktree, the
 *  leading glyph is the GitHub mark (still a copy-path control) rather than the
 *  redundant worktree mark. */
export const GitHubWorktreeNoPr: Story = {
  name: 'GitHub worktree (no PR)',
  args: { workspaceLocation: githubWorktreeLocation, pr: null, projectName: 'loro-dev/lody' },
};

/** GitHub session with a PR: the leading icon shows PR state, so the GitHub
 *  copy-path control rides in the leading slot after the PR/CI. */
export const GitHubWorktreeWithPr: Story = {
  name: 'GitHub worktree (with PR)',
  args: { workspaceLocation: githubWorktreeLocation, projectName: 'loro-dev/lody' },
};

/** Local-folder session with a PR: the folder copy control rides in the leading slot. */
export const LocalFolderWithPr: Story = {
  name: 'Local folder (with PR)',
  args: { workspaceLocation: folderLocation, projectName: 'lody' },
};

export const MergedPrLargeDiff: Story = {
  args: { pr: mergedPr, diffStat: { add: 12345, del: 6789 } },
};

export const StatusOnlyNoContext: Story = {
  args: {
    status: { kind: 'machine-offline', machineName: 'zx MacBook-Pro.local' },
    projectName: null,
    branch: null,
    pr: null,
    diffStat: null,
  },
};

/* ── Goal chip ───────────────────────────────────────────────────────── */

export const GoalActive: Story = { args: { goal: makeGoal() } };

export const GoalPaused: Story = { args: { goal: makeGoal({ status: 'paused' }) } };

export const GoalComplete: Story = { args: { goal: makeGoal({ status: 'complete' }) } };

export const GoalCleared: Story = { args: { goal: makeGoal({ status: 'cleared' }) } };

export const GoalBlocked: Story = { args: { goal: makeGoal({ status: 'blocked' }) } };

export const GoalWithMetrics: Story = {
  args: {
    goal: makeGoal({ tokensUsed: 184_000, tokenBudget: 500_000, timeUsedSeconds: 47 * 60 }),
  },
};

export const GoalPendingCommand: Story = {
  args: { goal: makeGoal(), goalPending: 'pause' },
};

export const GoalLongObjective: Story = {
  args: { goal: makeGoal({ objective: LONG_OBJECTIVE }) },
};

/* ── Schedule chip ───────────────────────────────────────────────────── */

export const ScheduleWakeupSoon: Story = {
  args: { scheduledTasks: [makeWakeup(45_000)] },
};

export const ScheduleCronRecurring: Story = {
  args: { scheduledTasks: [makeCron('0 9 * * *', true)] },
};

export const ScheduleMultiple: Story = {
  args: {
    scheduledTasks: [
      makeWakeup(4 * 60_000, 'Poll the deploy status and continue the release.'),
      makeCron('0 9 * * *', true),
      makeCron('30 18 * * 5', false, 'One-shot: prepare the weekly retro notes.'),
    ],
  },
};

/* ── PR CI chip ──────────────────────────────────────────────────────── */

export const CiPassing: Story = { args: { prCiRuns: CI_PASSING } };

export const Mergeable: Story = {
  args: { prCiRuns: CI_PASSING, mergeAction: true },
};

export const DraftReadyForReview: Story = {
  args: {
    pr: draftPr,
    prCiRuns: CI_PASSING,
    actionLabels: ['Ready for review'],
  },
};

export const CiFailing: Story = { args: { prCiRuns: CI_FAILING } };

export const CiFailingWithActions: Story = {
  args: {
    prCiRuns: CI_FAILING,
    actionLabels: ['Commit & Push', 'Fix CI Errors'],
  },
};

export const CiRunning: Story = { args: { prCiRuns: CI_RUNNING } };

/* ── Everything at once / squeeze ────────────────────────────────────── */

export const EverythingAtOnce: Story = {
  args: {
    status: { kind: 'machine-offline', machineName: 'zx MacBook-Pro.local' },
    goal: makeGoal(),
    scheduledTasks: [makeWakeup(12 * 60_000), makeCron('0 9 * * *', true)],
    prCiRuns: CI_FAILING,
    withPreview: true,
  },
};

/** Preview available: a plain emerald action chip at the end of the cluster. */
export const WithPreviewAction: Story = {
  args: { withPreview: true },
};

export const EverythingLongNamesNarrow: Story = {
  args: {
    width: 480,
    status: { kind: 'machine-offline', machineName: 'zx MacBook-Pro.local' },
    goal: makeGoal(),
    scheduledTasks: [makeWakeup(12 * 60_000)],
    projectName: LONG_PROJECT,
    branch: LONG_BRANCH,
  },
};

/** Phone-width squeeze: everything present at 360px. */
export const MobileNarrowEverything: Story = {
  args: {
    width: 360,
    status: { kind: 'machine-offline', machineName: 'zx MacBook-Pro.local' },
    goal: makeGoal(),
    scheduledTasks: [makeWakeup(12 * 60_000)],
    prCiRuns: CI_FAILING,
    actionLabels: ['Commit & Push', 'Fix CI Errors'],
    withPreview: true,
  },
};

export const GoalAndScheduleNoContext: Story = {
  args: {
    goal: makeGoal(),
    scheduledTasks: [makeWakeup(12 * 60_000)],
    projectName: null,
    branch: null,
    pr: null,
    diffStat: null,
  },
};

/* ── Syncing (desktop ambient catch-up) ──────────────────────────────── */

/** Desktop doc catch-up: a quiet spinner pinned to the bar's right edge. */
export const Syncing: Story = { args: { syncing: true } };

/** Syncing under pressure: the stage truncates, the spinner never does. */
export const SyncingEverythingNarrow: Story = {
  args: {
    width: 480,
    syncing: true,
    status: { kind: 'machine-offline', machineName: 'zx MacBook-Pro.local' },
    goal: makeGoal(),
    scheduledTasks: [makeWakeup(12 * 60_000)],
    prCiRuns: CI_FAILING,
    withPreview: true,
  },
};

/** Regression: on a context-less chat session syncing alone must still
 *  render the bar — no staged item, no divider, spinner pinned right. */
export const SyncOnly: Story = {
  args: {
    projectName: null,
    branch: null,
    pr: null,
    diffStat: null,
    syncing: true,
  },
};

/** With no items and no syncing the bar still hides entirely. */
export const EmptyNotSyncingHidden: Story = {
  args: {
    projectName: null,
    branch: null,
    pr: null,
    diffStat: null,
  },
};

/* ── Recency-driven focus ────────────────────────────────────────────── */

/**
 * Interactive: use the buttons to add the goal / schedule AFTER mount and
 * watch the expanded slot hand off to the newest event (and stay there).
 * Clicking a collapsed icon moves focus; clicking the expanded item opens
 * its popover / the PR tab.
 */
function PeekPlayground() {
  const [goal, setGoal] = useState<SessionGoalMessage | null>(null);
  const [tasks, setTasks] = useState<PendingScheduledTask[]>([]);
  return (
    <div className="flex w-[760px] max-w-full flex-col gap-3">
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 text-xs"
          onClick={() => setGoal(makeGoal())}
        >
          + goal appears
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 text-xs"
          onClick={() => setGoal((g) => (g ? makeGoal({ status: 'paused' }) : g))}
        >
          pause goal (re-focus)
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 text-xs"
          onClick={() => setTasks([makeWakeup(9 * 60_000)])}
        >
          + schedule appears
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 text-xs"
          onClick={() => {
            setGoal(null);
            setTasks([]);
          }}
        >
          reset
        </button>
      </div>
      <div className="h-56" />
      <SessionInfoBar
        status={null}
        goal={goal}
        goalCommands={SESSION_GOAL_COMMANDS}
        onGoalCommand={fn()}
        onGoalDismiss={() => setGoal(null)}
        scheduledTasks={tasks}
        projectName="loro-dev/lody"
        branch="feat/presence-machine-online-session-status"
        pr={openPr}
        onOpenPr={fn()}
        diffStat={{ add: 128, del: 42 }}
      />
      <div className="h-14 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        (composer placeholder)
      </div>
    </div>
  );
}

export const RecencyFocus: Story = {
  render: () => <PeekPlayground />,
};

/**
 * 会话属于某个任务时，簇里多一个 task chip——它是从工作现场回到任务的路。
 * 任务链接不是状态，所以保持中性色，不带语义色。
 */
export const WithTask: Story = {
  args: {
    status: null,
    task: { taskId: 't1', title: 'Refactor the auth flow' },
    projectName: 'loro-dev/lody',
    branch: 'feat/tasks',
  },
};

/** 任务标题还没同步过来时，chip 退化为"未命名任务"而不是空白。 */
export const WithUntitledTask: Story = {
  args: {
    status: null,
    task: { taskId: 't1', title: '' },
    projectName: 'loro-dev/lody',
  },
};

/** task chip 作为舞台项时给出打开任务的动作。 */
export const TaskStaged: Story = {
  args: {
    status: null,
    task: { taskId: 't1', title: 'Ship the PR poller fix' },
    projectName: 'loro-dev/lody',
    initialStage: 'task',
  },
};

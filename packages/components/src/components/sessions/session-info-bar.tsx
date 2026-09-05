import { useEffect, useRef, useState } from 'react';
import { LockKeyhole, MonitorPlay } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PendingScheduledTask, SessionGoalCommand, SessionGoalMessage } from '@lody/shared';
import type { SessionPullRequestMeta } from '@lody/shared';
import { sanitizeGoalObjective } from '@lody/shared';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { cn } from '@/lib/utils';
import { ActionChip } from './info-chip';
import {
  ContextChip,
  GoalChip,
  ScheduleChip,
  StatusChip,
  TaskChip,
  ScheduleSourceChip,
  useScheduledTaskSignature,
  type GoalChipCommandHandler,
  type ContextChipAction,
  type PrCiRun,
  type WorkspaceLocationKind,
} from './session-info-chips';
import type { SessionStatusStripState } from './session-status-strip';
import { SessionSyncingIndicator } from './session-syncing-indicator';

export type InfoBarItemKey = 'status' | 'goal' | 'schedule' | 'task' | 'scheduleSource' | 'context';

export type SessionInfoBarProps = {
  status: SessionStatusStripState | null;
  /** Task this session belongs to; the chip is the way back to it. */
  task?: { taskId: string; title: string } | null;
  onOpenTask?: (taskId: string) => void;
  scheduleSource?: { title: string; onOpen: () => void } | null;
  /** Active/paused/terminal goal snapshot; the chip replaces the old sticky top banner. */
  goal?: SessionGoalMessage | null;
  goalCommands?: readonly SessionGoalCommand[];
  goalPendingCommand?: SessionGoalCommand | null;
  onGoalCommand?: GoalChipCommandHandler;
  onGoalDismiss?: (goal: SessionGoalMessage) => void;
  /** Pending cron/wakeup tasks (derived from history); countdown chip. */
  scheduledTasks?: readonly PendingScheduledTask[];
  /** CI check runs for the session's PR; cluster-only verdict chip (click = popover). */
  prCiRuns?: readonly PrCiRun[];
  onOpenPrCiRun?: (run: PrCiRun) => void;
  projectName?: string | null;
  branch?: string | null;
  /** The session's on-disk location (worktree vs local folder) + its resolved
   *  path; drives the context chip's leading glyph and its click-to-copy. Omit
   *  for remote/repo-only sessions with no local path. */
  workspaceLocation?: { kind: WorkspaceLocationKind; path?: string | null } | null;
  pr?: SessionPullRequestMeta | null;
  onOpenPr?: () => void;
  /** Agent-driven PR/worktree actions shown inside the context stage. */
  contextActions?: readonly ContextChipAction[];
  /** Open the complete working-tree diff from the context diffstat. */
  onOpenAllChanges?: () => void;
  /** Open the session Browser panel. Renders a
   *  plain action chip in the cluster zone (no stage form). */
  onOpenBrowser?: () => void;
  /** Mobile team workspace: persistent effective privacy status. */
  privateAccessStatus?: { label: string; description: string; onAction?: () => void };
  diffStat?: { add: number; del: number } | null;
  /** Desktop-only ambient doc catch-up state: a quiet spinner pinned to the
   *  bar's right edge. Not a cluster/stage item — it must never steal focus
   *  or relayout the canonical order. */
  syncing?: boolean;
  /** Mobile native shell only: lift the bar above the session drawer's
   *  transparent z-30 left-edge swipe-back strip, which otherwise covers the
   *  leftmost ~48px of the row and swallows taps on the first chip. Same
   *  treatment (and same trade-off) as the composer's `protectFromEdgeBackZone`. */
  protectFromEdgeBackZone?: boolean;
  /** Storybook/testing aid: initial staged item. */
  initialStage?: InfoBarItemKey;
};

/**
 * Desktop-only info bar glued above the composer, following the
 * "canonical cluster + fixed stage" model:
 *
 *   [☁][⏰][◎]  │  ⑂#2857 loro-dev/lody · branch · ±diff [CI] ↗
 *    cluster (collapsed,   stage (THE active item: icon marker,
 *    fixed canonical order) summary = detail, CI pill when PR)
 *
 * - The cluster keeps a constant order (status > goal > schedule > context);
 *   items return to their own slot when they leave the stage — no MRU-style
 *   reshuffling, spatial memory stays intact. The CI verdict is NOT a cluster
 *   item: it rides inside the context item as a "CI" pill and is therefore
 *   only visible when the PR is expanded on the stage.
 * - Invariants: with no items the bar hides entirely; with items, exactly
 *   ONE is always expanded on the stage (the rightmost item IS the expanded
 *   one — there is no fully-collapsed state). Clicking a cluster chip
 *   promotes it; the STAGE ICON is an inert marker (clicking it must never
 *   relayout or collapse); clicking the stage SUMMARY (with its resting ↗)
 *   opens the item's detail surface — popover, or the PR tab for context.
 *   The CI chip opts out: always collapsed, one click toggles its check-run
 *   popover.
 * - Focus is recency-driven: when an item appears or meaningfully changes
 *   (goal created/paused, schedule added, PR created, offline began) it
 *   takes the stage. Stage content only leaves by promoting another item or
 *   by its own data disappearing.
 * - Stage selection is session-view local and intentionally not persisted.
 *
 * The message queue intentionally stays OUT of the bar — pending sends need
 * persistent visibility and direct manipulation next to the composer.
 */
export function SessionInfoBar({
  status,
  goal,
  goalCommands,
  goalPendingCommand,
  onGoalCommand,
  onGoalDismiss,
  task,
  onOpenTask,
  scheduleSource,
  scheduledTasks,
  prCiRuns,
  onOpenPrCiRun,
  projectName,
  branch,
  workspaceLocation,
  pr,
  onOpenPr,
  contextActions,
  onOpenAllChanges,
  onOpenBrowser,
  privateAccessStatus,
  diffStat,
  syncing = false,
  protectFromEdgeBackZone = false,
  initialStage,
}: SessionInfoBarProps) {
  const { t } = useTranslation();
  const hasDiff = diffStat != null && diffStat.add + diffStat.del > 0;
  const hasContext = !!pr || !!projectName || !!branch || hasDiff || !!contextActions?.length;
  const goalObjective = goal ? sanitizeGoalObjective(goal.objective) : '';
  const hasGoal = !!goal && !!goalObjective;
  const scheduleSignature = useScheduledTaskSignature(scheduledTasks);
  const hasSchedule = scheduleSignature !== null;
  const hasStatus = !!status;
  const hasTask = !!task;

  const present: Record<InfoBarItemKey, boolean> = {
    status: hasStatus,
    goal: hasGoal,
    schedule: hasSchedule,
    task: hasTask,
    scheduleSource: !!scheduleSource,
    context: hasContext,
  };
  const defaultKey =
    (['context', 'status', 'goal', 'schedule', 'task', 'scheduleSource'] as const).find(
      (key) => present[key]
    ) ?? null;

  const [stage, setStage] = useState<InfoBarItemKey | null>(initialStage ?? defaultKey);

  // ── Recency-driven focus ─────────────────────────────────────────────
  // Each item has a change signature; when it changes after mount, that item
  // takes the stage. Purely last-event-wins, no priority tiers.
  const statusSignature = status
    ? `${status.kind}:${'machineName' in status ? (status.machineName ?? '') : ''}`
    : null;
  const goalSignature = hasGoal && goal ? `${goal.status}:${goalObjective}` : null;
  const contextSignature = hasContext
    ? [
        pr?.url ?? '',
        projectName ?? '',
        branch ?? '',
        diffStat ? `${diffStat.add}:${diffStat.del}` : '',
        contextActions?.map((action) => action.id).join(',') ?? '',
      ].join('|')
    : null;

  const mountedRef = useRef(false);
  const taskSignature = task ? `${task.taskId}:${task.title}` : null;
  const prevRef = useRef({
    status: statusSignature,
    goal: goalSignature,
    schedule: scheduleSignature,
    task: taskSignature,
    context: contextSignature,
  });
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    const prev = prevRef.current;
    if (statusSignature !== prev.status && statusSignature !== null) {
      setStage('status');
    } else if (goalSignature !== prev.goal && goalSignature !== null) {
      setStage('goal');
    } else if (scheduleSignature !== prev.schedule && scheduleSignature !== null) {
      setStage('schedule');
    } else if (taskSignature !== prev.task && taskSignature !== null) {
      setStage('task');
    } else if (contextSignature !== prev.context && contextSignature !== null) {
      setStage('context');
    }
    prevRef.current = {
      status: statusSignature,
      goal: goalSignature,
      schedule: scheduleSignature,
      task: taskSignature,
      context: contextSignature,
    };
  }, [statusSignature, goalSignature, scheduleSignature, taskSignature, contextSignature]);

  // With no staged items the bar hides unless it still owns a standalone
  // action or ambient syncing state. A reported preview is often the only
  // context a chat-only Session has, so dropping the Browser action here would
  // leave no visible path from the report to the preview.
  if (!defaultKey && !onOpenBrowser && !syncing && !privateAccessStatus) return null;

  // Derived, never null while any item is present: if the staged item's data
  // disappeared (goal dismissed, machine back online), fall back to the
  // default item — the rightmost slot is always occupied.
  const stagedKey = stage !== null && present[stage] ? stage : defaultKey;

  const renderItem = (key: InfoBarItemKey, mode: 'cluster' | 'stage') => {
    const itemMode =
      mode === 'cluster'
        ? ({ mode: 'cluster', onPromote: () => setStage(key) } as const)
        : ({ mode: 'stage' } as const);
    switch (key) {
      case 'status':
        return status ? <StatusChip key={key} state={status} {...itemMode} /> : null;
      case 'goal':
        return hasGoal && goal ? (
          <GoalChip
            key={key}
            goal={goal}
            commands={goalCommands}
            pendingCommand={goalPendingCommand}
            onGoalCommand={onGoalCommand}
            onDismiss={onGoalDismiss}
            {...itemMode}
          />
        ) : null;
      case 'schedule':
        return hasSchedule && scheduledTasks ? (
          <ScheduleChip key={key} tasks={scheduledTasks} {...itemMode} />
        ) : null;
      case 'scheduleSource':
        return scheduleSource ? (
          <ScheduleSourceChip
            key={key}
            title={scheduleSource.title}
            onOpen={scheduleSource.onOpen}
            {...itemMode}
          />
        ) : null;
      case 'task':
        return task ? (
          <TaskChip
            key={key}
            title={task.title}
            onOpen={onOpenTask ? () => onOpenTask(task.taskId) : undefined}
            {...itemMode}
          />
        ) : null;
      case 'context':
        return hasContext ? (
          <ContextChip
            key={key}
            projectName={projectName}
            branch={branch}
            workspaceLocation={workspaceLocation}
            pr={pr}
            onOpenPr={onOpenPr}
            actions={contextActions}
            onOpenAllChanges={onOpenAllChanges}
            diffStat={diffStat}
            prCiRuns={prCiRuns}
            onOpenPrCiRun={onOpenPrCiRun}
            {...itemMode}
          />
        ) : null;
      default:
        return null;
    }
  };

  const clusterKeys = (
    ['status', 'goal', 'schedule', 'task', 'scheduleSource', 'context'] as const
  ).filter((key) => present[key] && key !== stagedKey);
  const clusterNonEmpty = clusterKeys.length > 0 || !!onOpenBrowser;

  return (
    // Keep the bar in the composer's input-surface family, with a lighter
    // opacity so it reads as the secondary tier of the same control stack.
    <div
      className={cn(
        'w-full shrink-0 bg-background pb-1.5',
        /* Gutter is on ConversationColumn (same as stream + composer).
           The native session drawer's transparent edge-back strip is z-30 and
           spans the body's left 48px. Elevating this band keeps the leading
           chip tappable; message body above still owns edge-back swipes. */
        protectFromEdgeBackZone && 'relative z-40'
      )}
    >
      {/* Same centered width as the composer content, so the bar and the
          input box share edges. */}
      <ConversationColumn>
        <div className="@container flex h-8 w-full min-w-0 select-none items-center gap-1.5 rounded-md border border-foreground/[0.10] bg-background px-2.5 text-xs shadow-[0_1px_2px_hsl(0_0%_0%/0.03)] dark:border-input-border/45 dark:bg-input/70 dark:shadow-none">
          {privateAccessStatus ? (
            <button
              type="button"
              className="inline-flex h-6 max-w-[11rem] shrink-0 items-center gap-1 rounded-md px-1 text-amber-700 transition-colors hover:bg-muted-foreground/10 dark:text-amber-300"
              title={privateAccessStatus.description}
              aria-label={privateAccessStatus.description}
              onClick={privateAccessStatus.onAction}
            >
              <LockKeyhole className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate font-medium">{privateAccessStatus.label}</span>
            </button>
          ) : null}
          {privateAccessStatus && (clusterKeys.length > 0 || onOpenBrowser || stagedKey) ? (
            <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-muted-foreground/25" />
          ) : null}
          {clusterKeys.map((key) => renderItem(key, 'cluster'))}
          {/* Browser is a plain action and has no stage form. */}
          {onOpenBrowser ? (
            <ActionChip
              icon={MonitorPlay}
              label={t('sessions.browser.openPreview', 'Open preview')}
              textClassName="text-emerald-600 dark:text-emerald-400"
              onAction={onOpenBrowser}
            />
          ) : null}
          {/* The divider is what marks the staged item as active (the stage
              icon has no highlight bg), so it must stay clearly visible —
              plain bg-border melts into the pill in light theme. */}
          {stagedKey && clusterNonEmpty ? (
            <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-muted-foreground/25" />
          ) : null}
          {/* key remounts the stage per item so any open popover state resets
              on hand-off. */}
          {stagedKey ? (
            <div key={stagedKey} className="flex min-w-0 flex-1 items-center">
              {renderItem(stagedKey, 'stage')}
            </div>
          ) : null}
          {/* Ambient sync state hugs the right edge, outside the
              cluster/stage model. Under squeeze the label yields first
              (spinner stays) so the stage's diffstat never clips. In
              sync-only mode nothing else consumes the row's free space, so
              ml-auto keeps the spinner pinned right; with a stage present
              its flex-1 has already eaten the space (no-op). */}
          {syncing ? (
            <span className="ml-auto inline-flex shrink-0 items-center">
              <SessionSyncingIndicator labelClassName="hidden @[560px]:inline" />
            </span>
          ) : null}
        </div>
      </ConversationColumn>
    </div>
  );
}

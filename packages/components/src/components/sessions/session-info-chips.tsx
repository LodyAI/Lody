import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlarmClock,
  ChevronDown,
  CircleCheck,
  CircleDot,
  CircleMinus,
  CircleX,
  Clock,
  Folder,
  GitBranch,
  Github,
  ListTodo,
  Pause,
  Play,
  Target,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  getSessionPullRequestLegacyFields,
  isSessionGoalCleared,
  parseGitHubPrNumber,
  sanitizeGoalObjective,
  type GitHubMergeMethod,
  type PendingScheduledTask,
  type PrStatus,
  type SessionGoalCommand,
  type SessionGoalMessage,
  type SessionPullRequestMeta,
} from '@lody/shared';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { writeTextToClipboard } from '@/lib/clipboard';
import { getGoalStatusPresentation } from '@/lib/session-goal-status';
import { formatDurationCompact, type DurationUnitLabels } from '@/lib/format-duration';
import { ClusterChip, StageChip } from './info-chip';
import { WorktreeIcon } from '@/components/icons/worktree-icon';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import { Popover, PopoverAnchor, PopoverContent } from '@/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { GoalActionButton, formatTokensCompact } from './session-goal-banner';
import { ScheduledTaskList, useResolvedScheduledTasks } from './scheduled-tasks-panel';
import { PR_STATUS_META } from './pull-request-badge';
import { useSessionStatusPresentation, type SessionStatusStripState } from './session-status-strip';
import { PrMergeButton } from './pr-merge-button';

/**
 * Shared contract: the bar renders each item either collapsed in the cluster
 * (`mode: 'cluster'`, click promotes) or as THE active item on the stage
 * (`mode: 'stage'`, icon is an inert marker / summary opens detail).
 */
export type InfoBarItemMode = { mode: 'cluster'; onPromote: () => void } | { mode: 'stage' };

/* ── Status (offline / removed) ──────────────────────────────────────── */

/**
 * The task this session belongs to.
 *
 * Ambient and neutral like the other context chips — a task link is not a status,
 * so it carries no semantic colour. Its one job is being the way back to the task
 * from inside the work.
 */
export function TaskChip({
  title,
  onOpen,
  ...itemMode
}: { title: string; onOpen?: (() => void) | undefined } & InfoBarItemMode) {
  const { t } = useTranslation();
  const label = title.trim() || t('tasks.untitled', 'Untitled task');

  if (itemMode.mode === 'cluster') {
    return (
      <ClusterChip
        icon={ListTodo}
        label={label}
        textClassName="text-muted-foreground"
        onPromote={itemMode.onPromote}
      />
    );
  }

  return (
    <StageChip
      icon={ListTodo}
      label={label}
      textClassName="text-muted-foreground"
      summary={label}
      {...(onOpen ? { detail: { kind: 'action', onAction: onOpen, ariaLabel: label } } : {})}
    />
  );
}

export function ScheduleSourceChip({
  title,
  onOpen,
  ...itemMode
}: { title: string; onOpen?: (() => void) | undefined } & InfoBarItemMode) {
  const { t } = useTranslation();
  const label = title.trim() || t('schedules.source', 'Scheduled task');

  if (itemMode.mode === 'cluster') {
    return (
      <ClusterChip
        icon={Clock}
        label={label}
        textClassName="text-muted-foreground"
        onPromote={itemMode.onPromote}
      />
    );
  }

  return (
    <StageChip
      icon={Clock}
      label={label}
      textClassName="text-muted-foreground"
      summary={label}
      {...(onOpen ? { detail: { kind: 'action', onAction: onOpen, ariaLabel: label } } : {})}
    />
  );
}

export function StatusChip({
  state,
  ...itemMode
}: { state: SessionStatusStripState } & InfoBarItemMode) {
  const presentation = useSessionStatusPresentation(state);
  if (!presentation) return null;
  const { Icon, text, warning } = presentation;
  const textClassName = warning ? 'text-status-warning' : 'text-muted-foreground';

  if (itemMode.mode === 'cluster') {
    return (
      <ClusterChip
        icon={Icon}
        label={text}
        textClassName={textClassName}
        onPromote={itemMode.onPromote}
      />
    );
  }
  return <StageChip icon={Icon} label={text} textClassName={textClassName} summary={text} />;
}

/* ── Goal ────────────────────────────────────────────────────────────── */

export type GoalChipCommandHandler = (
  command: SessionGoalCommand,
  goal: SessionGoalMessage
) => void;

/**
 * Goal item. Cluster = a Target icon tinted by goal status (pulsing while
 * active); stage = "status · objective" with the detail popover carrying the
 * full objective, usage metrics, and Pause / Resume / Clear / Dismiss (this
 * replaces the old sticky top banner). A terminal/cleared goal keeps its
 * chip until dismissed.
 */
export function GoalChip({
  goal,
  commands,
  pendingCommand,
  onGoalCommand,
  onDismiss,
  ...itemMode
}: {
  goal: SessionGoalMessage;
  /** Commands the current session transport can safely dispatch. */
  commands?: readonly SessionGoalCommand[];
  pendingCommand?: SessionGoalCommand | null;
  onGoalCommand?: GoalChipCommandHandler;
  onDismiss?: (goal: SessionGoalMessage) => void;
} & InfoBarItemMode) {
  const { t } = useTranslation();
  const objective = sanitizeGoalObjective(goal.objective);
  if (!objective) return null;

  const meta = getGoalStatusPresentation(goal.status);
  const statusLabel = t(meta.labelKey, meta.fallbackLabel);
  const label = `${t('sessions.goal.banner.label', 'Goal')} · ${statusLabel}`;

  if (itemMode.mode === 'cluster') {
    // Neutral inline chrome — color is reserved for genuine status (CI, diff);
    // goal state reads from the popover, not an ambient tint or motion.
    return <ClusterChip icon={Target} label={label} onPromote={itemMode.onPromote} />;
  }

  const isPending = pendingCommand != null;
  const isCleared = isSessionGoalCleared(goal);
  const showPause =
    goal.status === 'active' && commands?.includes('pause') === true && onGoalCommand != null;
  const showResume =
    goal.status === 'paused' && commands?.includes('resume') === true && onGoalCommand != null;
  const showClear = !isCleared && commands?.includes('clear') === true && onGoalCommand != null;
  const showDismiss = isCleared && onDismiss != null;

  const durationUnitLabels: DurationUnitLabels = {
    hour: t('time.unitShort.hour', 'h'),
    minute: t('time.unitShort.minute', 'm'),
    second: t('time.unitShort.second', 's'),
  };
  const timeUsedMs = Math.max(0, Math.floor((goal.timeUsedSeconds ?? 0) * 1000));
  const timeLabel = timeUsedMs > 0 ? formatDurationCompact(timeUsedMs, durationUnitLabels) : '';
  const tokensUsed = Math.max(0, Math.floor(goal.tokensUsed ?? 0));
  const tokenBudget =
    typeof goal.tokenBudget === 'number' && goal.tokenBudget > 0
      ? Math.floor(goal.tokenBudget)
      : null;
  const showTokens = tokensUsed > 0 || tokenBudget != null;
  const tokensLabel = showTokens
    ? tokenBudget != null
      ? t('sessions.goal.metrics.tokensValueWithBudget', 'tokens: {{used}} / {{budget}}', {
          used: formatTokensCompact(tokensUsed),
          budget: formatTokensCompact(tokenBudget),
        })
      : t('sessions.goal.metrics.tokensValue', 'tokens: {{used}}', {
          used: formatTokensCompact(tokensUsed),
        })
    : '';

  const triggerCommand = (command: SessionGoalCommand) => {
    if (isPending) return;
    onGoalCommand?.(command, goal);
  };

  return (
    <StageChip
      icon={Target}
      label={label}
      summary={`${statusLabel} · ${objective}`}
      detail={{
        kind: 'popover',
        ariaLabel: t('sessions.goal.banner.label', 'Goal'),
        content: (
          <div className="flex flex-col gap-2 p-3 text-xs">
            <div className="flex items-center gap-2">
              <Target className={cn('h-4 w-4 shrink-0', meta.textClassName)} aria-hidden="true" />
              <span
                className={cn(
                  'text-[11px] font-semibold uppercase tracking-wide',
                  meta.textClassName
                )}
              >
                {t('sessions.goal.banner.label', 'Goal')}
              </span>
              <span className={cn('font-medium', meta.textClassName)}>{statusLabel}</span>
              <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                {timeLabel ? (
                  <span
                    className="inline-flex items-center gap-1 tabular-nums leading-none"
                    title={t('sessions.goal.metrics.elapsed', 'Elapsed time')}
                  >
                    <Clock className="relative -top-px h-3 w-3" aria-hidden="true" />
                    <span>{timeLabel}</span>
                  </span>
                ) : null}
                {tokensLabel ? <span className="tabular-nums">{tokensLabel}</span> : null}
              </span>
            </div>
            <p className="scrollbar-pro max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-snug text-foreground">
              {objective}
            </p>
            {showPause || showResume || showClear || showDismiss ? (
              <div className="flex items-center justify-end gap-1.5">
                {showPause ? (
                  <GoalActionButton
                    icon={Pause}
                    label={t('sessions.goal.actions.pause', 'Pause')}
                    onClick={() => triggerCommand('pause')}
                    disabled={isPending}
                    loading={pendingCommand === 'pause'}
                  />
                ) : null}
                {showResume ? (
                  <GoalActionButton
                    icon={Play}
                    label={t('sessions.goal.actions.resume', 'Resume')}
                    onClick={() => triggerCommand('resume')}
                    disabled={isPending}
                    loading={pendingCommand === 'resume'}
                    tone="success"
                  />
                ) : null}
                {showClear ? (
                  <GoalActionButton
                    icon={X}
                    label={t('sessions.goal.actions.clear', 'Clear')}
                    onClick={() => triggerCommand('clear')}
                    disabled={isPending}
                    loading={pendingCommand === 'clear'}
                    tone="danger"
                  />
                ) : null}
                {showDismiss ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onDismiss?.(goal)}
                    aria-label={t('sessions.goal.actions.dismiss', 'Dismiss goal banner')}
                    title={t('sessions.goal.actions.dismiss', 'Dismiss goal banner')}
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ),
      }}
    />
  );
}

/* ── Scheduled tasks ─────────────────────────────────────────────────── */

/** "12m" / "45s" / "3h" / "2d" — the schedule chip's persistent glanceable value. */
function formatCompactCountdown(
  diffMs: number,
  t: (key: string, fallback: string) => string
): string {
  if (diffMs <= 5_000) return t('sessions.scheduledTasks.firingShort', 'now');
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return `${seconds}${t('time.unitShort.second', 's')}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}${t('time.unitShort.minute', 'm')}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}${t('time.unitShort.hour', 'h')}`;
  const days = Math.round(hours / 24);
  return `${days}${t('time.unitShort.day', 'd')}`;
}

/**
 * Scheduled-tasks item. Both modes keep the countdown to the soonest fire as
 * the icon's short value (its glanceable core); the stage adds the heading +
 * soonest summary, with the full task list in the detail popover.
 */
export function ScheduleChip({
  tasks,
  ...itemMode
}: { tasks: readonly PendingScheduledTask[] } & InfoBarItemMode) {
  const { t } = useTranslation();
  const { rows, nowMs } = useResolvedScheduledTasks(tasks);
  if (rows.length === 0) return null;

  const soonest = rows[0];
  const countdown =
    soonest?.fireMs !== undefined ? formatCompactCountdown(soonest.fireMs - nowMs, t) : undefined;
  const heading = t('sessions.scheduledTasks.heading');
  const summary = t('sessions.scheduledTasks.summary', { count: rows.length });
  const label = `${heading} · ${summary}`;

  if (itemMode.mode === 'cluster') {
    return (
      <ClusterChip
        icon={AlarmClock}
        label={label}
        value={countdown}
        onPromote={itemMode.onPromote}
      />
    );
  }

  return (
    <StageChip
      icon={AlarmClock}
      label={label}
      value={countdown}
      summary={`${heading} · ${soonest?.task.summary ?? summary}`}
      detail={{
        kind: 'popover',
        ariaLabel: heading,
        content: (
          <div className="flex flex-col gap-1.5 p-3">
            <div className="flex items-center gap-1.5 text-xs">
              <AlarmClock className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
              <span className="font-medium text-foreground">{heading}</span>
              <span className="text-muted-foreground">· {summary}</span>
            </div>
            <ScheduledTaskList rows={rows} nowMs={nowMs} />
          </div>
        ),
      }}
    />
  );
}

/* ── PR / repo context ───────────────────────────────────────────────── */

const PR_STATUS_TEXT: Record<PrStatus, string> = {
  open: 'text-github-open',
  merged: 'text-github-merged',
  closed: 'text-github-closed',
  draft: 'text-github-draft',
};

/**
 * The session's work context. Cluster = the PR status icon + "#1234" (the
 * icon alone conveys open/merged/closed — no state text); with no PR it
 * falls back to a branch icon. Stage adds project · branch · ±diff and the CI
 * verdict pill (only visible here, when the PR is expanded). Its controls are
 * intentionally separate: PR opens PR details, branch copies the branch name,
 * and ±diff opens All Changes.
 */
// 'worktree' / 'folder' are the on-disk layout of a LOCAL project. A GitHub
// project is always checked out as an isolated worktree, so its worktree-ness
// carries no information; 'github-worktree' surfaces the GitHub identity instead
// (a GitHub glyph rather than the redundant worktree mark), matching the sidebar
// where the worktree badge is suppressed for GitHub sessions.
export type WorkspaceLocationKind = 'worktree' | 'folder' | 'github-worktree';

export type ContextChipStandardAction = {
  kind?: 'action';
  id: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

export type ContextChipMergeAction = {
  kind: 'merge';
  id: 'merge';
  method: GitHubMergeMethod;
  isMerging?: boolean;
  disabled?: boolean;
  onMerge: (method: GitHubMergeMethod) => void | Promise<void>;
  onSelectMethod: (method: GitHubMergeMethod) => void;
};

export type ContextChipAction = ContextChipStandardAction | ContextChipMergeAction;

function ContextChipActions({ actions }: { actions: readonly ContextChipAction[] }) {
  const { t } = useTranslation();
  const [primaryAction, ...overflowActions] = actions;
  if (!primaryAction) return null;

  if (primaryAction.kind === 'merge') {
    return (
      <PrMergeButton
        compact
        method={primaryAction.method}
        isMerging={primaryAction.isMerging}
        disabled={primaryAction.disabled}
        onMerge={primaryAction.onMerge}
        onSelectMethod={primaryAction.onSelectMethod}
      />
    );
  }

  const standardOverflowActions = overflowActions.filter(
    (action): action is ContextChipStandardAction => action.kind !== 'merge'
  );

  return (
    <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-foreground/[0.08] bg-foreground/[0.03] dark:border-transparent dark:bg-muted-foreground/[0.08]">
      <button
        type="button"
        onClick={primaryAction.onClick}
        disabled={primaryAction.disabled}
        title={primaryAction.label}
        className="flex shrink-0 select-none items-center px-1.5 py-0.5 text-xs font-medium text-muted-foreground outline-none transition-colors enabled:hover:bg-foreground/[0.05] enabled:hover:text-foreground focus:outline-none focus:ring-0 focus:ring-offset-0 focus:shadow-none focus-visible:bg-foreground/[0.05] focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:opacity-50 dark:text-muted-foreground/80 dark:enabled:hover:bg-muted-foreground/[0.08] dark:focus-visible:bg-muted-foreground/[0.08]"
      >
        <span className="truncate">{primaryAction.label}</span>
      </button>
      {standardOverflowActions.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('sessions.moreActions', 'More actions')}
              title={t('sessions.moreActions', 'More actions')}
              className="relative flex w-5 shrink-0 self-stretch items-center justify-center text-muted-foreground/75 outline-none transition-colors before:absolute before:left-0 before:h-3 before:w-px before:bg-foreground/10 hover:bg-foreground/[0.05] hover:text-foreground focus:outline-none focus:ring-0 focus:ring-offset-0 focus:shadow-none focus-visible:bg-foreground/[0.05] focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 dark:before:bg-muted-foreground/15 dark:hover:bg-muted-foreground/[0.08] dark:focus-visible:bg-muted-foreground/[0.08]"
            >
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" sideOffset={6}>
            {standardOverflowActions.map((action) => (
              <DropdownMenuItem
                key={action.id}
                disabled={action.disabled}
                onSelect={action.onClick}
              >
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

/**
 * The workspace-location affordance inside the context chip: the worktree or
 * folder glyph rendered as a copy control. Hover shows a "Worktree"/"Folder"
 * tooltip that hints the click copies the path; clicking copies it and confirms
 * with a toast. With no resolvable path it degrades to a plain, non-interactive
 * glyph that still labels the mode on hover. Worktree and local-folder sessions
 * share this control so their leading icon behaves symmetrically.
 */
function LocationControl({
  kind,
  path,
  className,
}: {
  kind: WorkspaceLocationKind;
  path?: string | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const trimmedPath = path?.trim() || '';
  const canCopy = trimmedPath.length > 0;
  const isGitHub = kind === 'github-worktree';
  const isFolder = kind === 'folder';

  // A GitHub session is always a worktree, so it leads with the GitHub identity
  // instead of the redundant worktree mark; the underlying path is still a
  // worktree checkout, so it copies the worktree path.
  const label = isGitHub
    ? t('sessions.infoBar.github', 'GitHub')
    : isFolder
      ? t('sessions.infoCard.folder', 'Folder')
      : t('sessions.infoCard.worktree', 'Worktree');
  const copiedMessage = isFolder
    ? t('sessions.infoBar.folderPathCopied', 'Copied the path to the folder')
    : t('sessions.infoBar.worktreePathCopied', 'Copied the path to the worktree');

  const handleCopy = useCallback(() => {
    if (!trimmedPath) return;
    void writeTextToClipboard(trimmedPath).then((ok) => {
      if (ok) toast.success(copiedMessage);
    });
  }, [trimmedPath, copiedMessage]);

  const Icon = isGitHub ? Github : isFolder ? Folder : WorktreeIcon;
  const glyph = <Icon className={cn('h-3.5 w-3.5 shrink-0', className)} />;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          {canCopy ? (
            <button
              type="button"
              onClick={handleCopy}
              aria-label={label}
              // -mr-1 cancels the stage's icon→summary gap so the glyph sits
              // close to the repo/branch text (a lone icon otherwise floats).
              className="-mr-1 flex h-6 shrink-0 select-none items-center rounded-md px-1 text-muted-foreground transition-colors hover:bg-muted-foreground/10 hover:text-foreground"
            >
              {glyph}
            </button>
          ) : (
            <span className="flex h-6 shrink-0 select-none items-center px-1 text-muted-foreground">
              {glyph}
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent side="top">
          <span className="font-medium text-foreground">{label}</span>
          {canCopy ? (
            <span className="ml-1.5 text-muted-foreground">
              {t('sessions.infoBar.copyPathHint', 'click to copy path')}
            </span>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ContextChip({
  projectName,
  branch,
  workspaceLocation,
  pr,
  onOpenPr,
  actions,
  onOpenAllChanges,
  diffStat,
  prCiRuns,
  onOpenPrCiRun,
  ...itemMode
}: {
  projectName?: string | null;
  branch?: string | null;
  /** The session's on-disk location: a worktree or a local folder. Drives the
   *  leading glyph (worktree/folder mark vs the default branch icon) and makes
   *  it a click-to-copy control for `path`. Omit for remote/repo-only sessions
   *  that have no local path to surface (leading icon stays an inert branch). */
  workspaceLocation?: { kind: WorkspaceLocationKind; path?: string | null } | null;
  pr?: SessionPullRequestMeta | null;
  onOpenPr?: () => void;
  /** Agent-driven PR/worktree actions pinned after the context summary. */
  actions?: readonly ContextChipAction[];
  /** Open the complete working-tree diff. */
  onOpenAllChanges?: () => void;
  diffStat?: { add: number; del: number } | null;
  prCiRuns?: readonly PrCiRun[];
  onOpenPrCiRun?: (run: PrCiRun) => void;
} & InfoBarItemMode) {
  const { t } = useTranslation();
  const hasDiff = diffStat != null && diffStat.add + diffStat.del > 0;
  const trimmedBranch = branch?.trim() || '';
  if (!pr && !projectName && !trimmedBranch && !hasDiff && !actions?.length) return null;

  const status: PrStatus | null = pr ? (pr.status ?? 'open') : null;
  const statusMeta = status ? (PR_STATUS_META[status] ?? PR_STATUS_META.open) : null;
  // The neutral leading glyph reflects the session's location/identity: the
  // GitHub mark for a GitHub session (always a worktree, so its worktree-ness is
  // noise), a worktree mark for a local worktree, a folder for a local folder,
  // else a plain branch icon — matching the sidebar's GitHub-suppressed worktree
  // badge so the identity reads the same everywhere.
  const LocationIcon =
    workspaceLocation?.kind === 'github-worktree'
      ? Github
      : workspaceLocation?.kind === 'worktree'
        ? WorktreeIcon
        : workspaceLocation?.kind === 'folder'
          ? Folder
          : GitBranch;
  // Expanded icon reflects PR state (open/merged/closed) or the location when
  // there is no PR; the COLLAPSED chip is always a neutral location icon so the
  // cluster stays uniform-width (the "#1234" label lived only here and caused
  // the layout jump on hand-off).
  const StatusIcon = statusMeta?.icon ?? LocationIcon;
  const statusText = status ? PR_STATUS_TEXT[status] : '';
  const prNumber = pr
    ? (getSessionPullRequestLegacyFields(pr).number ?? parseGitHubPrNumber(pr.url))
    : null;
  const value = pr ? (prNumber ? `#${prNumber}` : 'PR') : undefined;
  const label = pr
    ? t('sessions.pr.openTab', 'Open pull request')
    : trimmedBranch || projectName || t('sessions.infoBar.context', 'Work context');

  if (itemMode.mode === 'cluster') {
    return <ClusterChip icon={LocationIcon} label={label} onPromote={itemMode.onPromote} />;
  }

  const copyBranchLabel = t('sessions.copyBranchName', 'Copy branch name');
  const handleCopyBranch = () => {
    if (!trimmedBranch) return;
    void writeTextToClipboard(trimmedBranch).then((ok) => {
      if (ok) {
        toast.success(t('sessions.currentBranchCopied', 'Current branch name copied to clipboard'));
      }
    });
  };

  const prControl = pr ? (
    onOpenPr ? (
      <button
        type="button"
        onClick={onOpenPr}
        aria-label={t('sessions.pr.openTab', 'Open pull request')}
        title={t('sessions.pr.openTab', 'Open pull request')}
        className={cn(
          'flex h-6 shrink-0 select-none items-center gap-1 rounded-md px-1 text-xs font-semibold transition-colors hover:bg-muted-foreground/10',
          statusText
        )}
      >
        <StatusIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {value ? (
          <span className="hidden shrink-0 tabular-nums @[420px]:inline">{value}</span>
        ) : null}
      </button>
    ) : (
      <span className={cn('flex h-6 shrink-0 items-center gap-1 px-1 font-semibold', statusText)}>
        <StatusIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {value ? (
          <span className="hidden shrink-0 tabular-nums @[420px]:inline">{value}</span>
        ) : null}
      </span>
    )
  ) : undefined;

  const summary = (
    <span className="flex min-w-0 items-center gap-2 font-normal">
      {projectName ? (
        <span className="min-w-0 shrink-[2] truncate text-muted-foreground">{projectName}</span>
      ) : null}
      {trimmedBranch ? (
        <button
          type="button"
          onClick={handleCopyBranch}
          aria-label={`${copyBranchLabel}: ${trimmedBranch}`}
          title={copyBranchLabel}
          className="-mx-1 flex h-6 min-w-0 shrink items-center rounded-md px-1 text-foreground/85 transition-colors hover:bg-muted-foreground/10 hover:text-foreground"
        >
          <span className="truncate">{trimmedBranch}</span>
        </button>
      ) : null}
      {hasDiff ? (
        <button
          type="button"
          onClick={onOpenAllChanges}
          disabled={!onOpenAllChanges}
          aria-label={t('sessions.detailTabs.allChanges', 'All Changes')}
          title={t('sessions.detailTabs.allChanges', 'All Changes')}
          className="-mx-1 flex h-6 shrink-0 items-center gap-1 rounded-md px-1 tabular-nums transition-colors enabled:hover:bg-muted-foreground/10 disabled:pointer-events-none"
        >
          <span className="text-code-added">+{diffStat.add}</span>
          <span className="text-code-removed">−{diffStat.del}</span>
        </button>
      ) : null}
    </span>
  );

  const locationControl = workspaceLocation ? (
    <LocationControl kind={workspaceLocation.kind} path={workspaceLocation.path} />
  ) : null;

  return (
    <StageChip
      icon={StatusIcon}
      // No PR: the leading icon IS the worktree/folder glyph, so make it the
      // interactive copy control. When a PR takes the leading (status) icon, the
      // control rides in the `leading` slot instead so both stay reachable.
      iconOverride={pr ? prControl : (locationControl ?? undefined)}
      label={label}
      textClassName="text-muted-foreground"
      summary={summary}
      leading={
        pr ? (
          <>
            {/* CI pill stays adjacent to the PR number; the location control
                trails it, sitting right before the repo/branch summary. */}
            <span className="hidden @[420px]:contents">
              <PrCiPill runs={prCiRuns} onOpenRun={onOpenPrCiRun} />
            </span>
            {locationControl}
          </>
        ) : undefined
      }
      trailing={actions?.length ? <ContextChipActions actions={actions} /> : undefined}
    />
  );
}

/* ── PR CI checks ────────────────────────────────────────────────────── */

export type PrCiRunStatus = 'success' | 'failure' | 'running' | 'queued' | 'skipped';

export type PrCiRun = {
  name: string;
  status: PrCiRunStatus;
  durationMs?: number;
  url?: string;
};

export type PrCiOverall = 'passing' | 'failing' | 'running';

/** Failure dominates; anything still in flight means running; else passing. */
export function summarizePrCiRuns(runs: readonly PrCiRun[]): PrCiOverall {
  if (runs.some((run) => run.status === 'failure')) return 'failing';
  if (runs.some((run) => run.status === 'running' || run.status === 'queued')) return 'running';
  return 'passing';
}

export const PR_CI_RUN_ICON: Record<
  PrCiRunStatus,
  { Icon: typeof CircleCheck; className: string }
> = {
  success: { Icon: CircleCheck, className: 'text-status-success' },
  failure: { Icon: CircleX, className: 'text-destructive' },
  running: { Icon: CircleDot, className: 'text-status-warning' },
  queued: { Icon: CircleDot, className: 'text-muted-foreground' },
  skipped: { Icon: CircleMinus, className: 'text-muted-foreground/70' },
};

export function usePrCiPresentation(runs: readonly PrCiRun[]) {
  const { t } = useTranslation();
  const overall = summarizePrCiRuns(runs);
  const settled = runs.filter((run) => run.status !== 'running' && run.status !== 'queued').length;
  const overallLabel =
    overall === 'passing'
      ? t('sessions.prCi.passing', 'CI passed')
      : overall === 'failing'
        ? t('sessions.prCi.failing', 'CI failed')
        : t('sessions.prCi.running', 'CI running');
  const toneClassName =
    overall === 'passing'
      ? 'text-status-success'
      : overall === 'failing'
        ? 'text-destructive'
        : 'text-status-warning';
  const tintClassName =
    overall === 'passing'
      ? 'bg-status-success/12'
      : overall === 'failing'
        ? 'bg-destructive/12'
        : 'bg-status-warning/12';
  const VerdictIcon =
    overall === 'passing' ? CircleCheck : overall === 'failing' ? CircleX : CircleDot;
  return { overall, settled, overallLabel, toneClassName, tintClassName, VerdictIcon };
}

function PrCiPopoverBody({
  runs,
  onOpenRun,
}: {
  runs: readonly PrCiRun[];
  onOpenRun?: (run: PrCiRun) => void;
}) {
  const { t } = useTranslation();
  const durationUnitLabels: DurationUnitLabels = {
    hour: t('time.unitShort.hour', 'h'),
    minute: t('time.unitShort.minute', 'm'),
    second: t('time.unitShort.second', 's'),
  };
  const { settled, overallLabel, toneClassName } = usePrCiPresentation(runs);
  return (
    <div className="flex flex-col gap-1.5 p-3">
      <div className="flex items-center gap-1.5 text-xs">
        <span className={cn('font-medium', toneClassName)}>{overallLabel}</span>
        <span className="text-muted-foreground">
          · {settled}/{runs.length}
        </span>
      </div>
      <ul className="scrollbar-pro flex max-h-56 flex-col overflow-y-auto text-xs">
        {runs.map((run) => {
          const { Icon: RunIcon, className: runClassName } = PR_CI_RUN_ICON[run.status];
          const duration =
            run.durationMs != null && run.durationMs > 0
              ? formatDurationCompact(run.durationMs, durationUnitLabels)
              : null;
          const row = (
            <>
              <RunIcon className={cn('h-3.5 w-3.5 shrink-0', runClassName)} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-foreground">{run.name}</span>
              {duration ? (
                <span className="shrink-0 tabular-nums text-muted-foreground">{duration}</span>
              ) : null}
            </>
          );
          return (
            <li key={run.name}>
              {run.url && onOpenRun ? (
                <button
                  type="button"
                  onClick={() => onOpenRun(run)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted-foreground/10"
                >
                  {row}
                </button>
              ) : (
                <span className="flex w-full items-center gap-2 px-1.5 py-1">{row}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * PR CI verdict as a compact "CI" text pill. It only appears INSIDE the PR
 * context when that item is expanded on the stage (never a standalone cluster
 * icon). The pill is tinted by verdict (green passing / red failing / amber
 * running, with "done/total" while running); a single click opens the
 * check-run list.
 */
export function PrCiPill({
  runs,
  onOpenRun,
}: {
  runs: readonly PrCiRun[] | undefined;
  /** Open a check run (e.g. its GitHub Actions page). */
  onOpenRun?: (run: PrCiRun) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const hasRuns = !!runs && runs.length > 0;
  const presentation = usePrCiPresentation(hasRuns ? runs! : []);
  if (!hasRuns) return null;

  const { overall, settled, overallLabel, toneClassName, tintClassName, VerdictIcon } =
    presentation;
  const label = `${t('sessions.prCi.label', 'CI checks')} · ${overallLabel}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          ref={anchorRef}
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={label}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            'flex h-5 shrink-0 select-none items-center gap-1 rounded px-1.5 text-[11px] font-semibold uppercase tracking-wide',
            tintClassName,
            toneClassName
          )}
        >
          <VerdictIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
          CI
          {overall === 'running' ? (
            <span className="tabular-nums">
              {settled}/{runs!.length}
            </span>
          ) : null}
          <ChevronDown
            className={cn('h-3 w-3 shrink-0 opacity-60 transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        aria-label={t('sessions.prCi.label', 'CI checks')}
        onPointerDownOutside={(event) => {
          const target = event.target as Node | null;
          if (target && anchorRef.current?.contains(target)) {
            event.preventDefault();
          }
        }}
        className="w-96 max-w-[min(24rem,90vw)] border-border/60 p-0 shadow-xl"
      >
        <PrCiPopoverBody runs={runs!} onOpenRun={onOpenRun} />
      </PopoverContent>
    </Popover>
  );
}

/** Stable identity signature for the schedule set (drives recency focus). */
export function useScheduledTaskSignature(
  tasks: readonly PendingScheduledTask[] | undefined
): string | null {
  return useMemo(() => {
    if (!tasks || tasks.length === 0) return null;
    return tasks
      .map((task) => task.id)
      .sort()
      .join(',');
  }, [tasks]);
}

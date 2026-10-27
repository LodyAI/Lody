import { useCallback, useMemo, useState } from 'react';
import { toast } from '@/lib/toast';
import {
  AlarmClock,
  ChevronDown,
  CircleCheck,
  CircleDot,
  CircleMinus,
  CircleSlash,
  CircleX,
  Clock,
  Folder,
  GitBranch,
  Github,
  Pause,
  Play,
  Target,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import {
  getSessionPullRequestLegacyFields,
  isSessionGoalCleared,
  isSessionGoalResumable,
  parseGitHubPrNumber,
  sanitizeGoalObjective,
  type GitHubCheckRun,
  type GitHubMergeMethod,
  type PendingScheduledTask,
  type PrStatus,
  type SessionGoalCommand,
  type SessionGoalMessage,
  type SessionPullRequestCiState,
  type SessionPullRequestMeta,
} from '@lody/shared';
import { Button } from '@lody/ui/button';
import { writeTextToClipboard } from '@/lib/clipboard';
import { getGoalStatusPresentation } from '@/lib/session-goal-status';
import { formatDurationCompact, getDurationUnitLabels } from '@/lib/format-duration';
import { INFO_BAR_PROSE_CLASS, INFO_BAR_TEXT_CLASS } from './info-bar-type';
import { ClusterChip, StageChip } from './info-chip';
import { WorktreeIcon } from '@/components/icons/worktree-icon';
import { Tooltip } from '@lody/ui/tooltip';
import { Popover } from '@lody/ui/popover';
import { Menu } from '@/ui/menu';
import { GoalActionButton, formatTokensCompact } from './session-goal-banner';
import { ScheduledTaskList, useResolvedScheduledTasks } from './scheduled-tasks-panel';
import { SessionPrIcon } from '@/components/sidebar-row-shared';
import { PR_STATUS_META } from './pull-request-badge';
import { useSessionStatusPresentation, type SessionStatusStripState } from './session-status-strip';
import { PrMergeButton, PrMergeMethodLabel } from './pr-merge-button';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontWeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const styles = stylex.create({
  textMuted: { color: 'hsl(var(--muted-foreground) / 1)' },
  textWarning: { color: 'hsl(var(--status-warning) / 1)' },
  ciPopover: {
    width: 'calc(var(--spacing) * 96)',
    borderColor: 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
  },
  /* ── Goal popover ─────────────────────────────────────────────────── */
  goalPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[2],
    padding: themeSpace[3],
  },
  goalHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
  },
  goalGlyph: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
  },
  goalLabel: { fontWeight: themeFontWeight.medium },
  goalMetrics: {
    marginLeft: 'auto',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[2],
    color: themeColors.mutedForeground,
  },
  goalMetric: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[1],
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1,
  },
  goalClock: {
    position: 'relative',
    top: '-1px',
    width: themeSpace[3],
    height: themeSpace[3],
  },
  goalMetricValue: { fontVariantNumeric: 'tabular-nums' },
  goalObjective: {
    maxHeight: '12rem',
    overflowY: 'auto',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    color: themeColors.foreground,
  },
  goalActions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: themeSpace[1.5],
  },
  dismissGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },

  /* ── Schedule popover ─────────────────────────────────────────────── */
  schedulePanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[1.5],
    padding: themeSpace[3],
  },
  scheduleHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
  },
  scheduleGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: themeColors.primary,
  },
  scheduleTitle: {
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  scheduleSummary: { color: themeColors.mutedForeground },

  /* ── Context chip actions ─────────────────────────────────────────── */
  actionsShell: {
    display: 'flex',
    minWidth: themeSpace[12],
    flexShrink: 8,
    alignItems: 'center',
    overflow: 'hidden',
    borderRadius: themeRadius.md,
    backgroundColor: {
      default: 'hsl(var(--foreground) / 0.05)',
      ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 8%, transparent)',
    },
  },
  actionButton: {
    display: 'flex',
    minWidth: 0,
    flexShrink: 0,
    userSelect: 'none',
    alignItems: 'center',
    paddingInline: themeSpace[1.5],
    paddingBlock: themeSpace[0.5],
    fontWeight: themeFontWeight.medium,
    color: {
      default: themeColors.mutedForeground,
      ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 80%, transparent)',
      ':focus-visible': themeColors.foreground,
      ':focus-visible:where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 80%, transparent)',
      '@media (hover: hover)': { ':enabled:hover': 'hsl(var(--foreground) / 1)' },
    },
    backgroundColor: {
      default: 'transparent',
      ':focus-visible': 'hsl(var(--foreground) / 0.05)',
      ':focus-visible:where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 8%, transparent)',
      '@media (hover: hover)': {
        ':enabled:hover': 'color-mix(in oklab, hsl(var(--foreground) / 1) 5%, transparent)',
        ':enabled:hover:where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
          'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 8%, transparent)',
      },
    },
    // The old Tailwind `focus:ring-*` (and its `focus-visible:` twin) painted
    // nothing — the app forces Tailwind's own ring transparent — but it still
    // declared a `box-shadow`, and a utility-layer shadow beats the base
    // layer's inset focus ring. So the chip showed NO focus indicator at all.
    // Keep it that way.
    boxShadow: { default: null, ':focus-visible': 'none' },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
    ':disabled': { opacity: 0.5 },
  },
  actionLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  overflowButton: {
    position: 'relative',
    display: 'flex',
    width: themeSpace[5],
    flexShrink: 0,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'hsl(var(--muted-foreground) / 0.75)',
    backgroundColor: {
      default: 'transparent',
      ':focus-visible': 'hsl(var(--foreground) / 0.05)',
      ':focus-visible:where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 8%, transparent)',
      '@media (hover: hover)': {
        ':hover': 'hsl(var(--foreground) / 0.05)',
        ':hover:where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
          'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 8%, transparent)',
      },
    },
    // Same as the action chip above: the old Tailwind `focus:ring-*` erased
    // the base layer's inset focus ring, so the button showed NO focus
    // indicator. Keep it that way.
    boxShadow: { default: null, ':focus-visible': 'none' },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
    '::before': {
      content: '""',
      position: 'absolute',
      left: 0,
      height: themeSpace[3],
      width: '1px',
      backgroundColor: {
        default: 'hsl(var(--foreground) / 0.1)',
        ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
          'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 15%, transparent)',
      },
    },
    '@media (hover: hover)': {
      ':hover': {
        color: themeColors.foreground,
      },
    },
    ':focus-visible': { color: themeColors.foreground },
  },
  overflowGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },

  /* ── Workspace-location control ───────────────────────────────────── */
  locationGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
  },
  locationButton: {
    // -mr-1 cancels the stage's icon→summary gap so the glyph sits close to
    // the repo/branch text (a lone icon otherwise floats).
    marginRight: `calc(-1 * ${themeSpace[1]})`,
    display: 'flex',
    height: themeSpace[6],
    flexShrink: 0,
    userSelect: 'none',
    alignItems: 'center',
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[1],
    color: themeColors.mutedForeground,
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': 'hsl(var(--muted-foreground) / 0.1)' },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
    '@media (hover: hover)': {
      ':hover': { color: themeColors.foreground },
    },
  },
  locationStatic: {
    display: 'flex',
    height: themeSpace[6],
    flexShrink: 0,
    userSelect: 'none',
    alignItems: 'center',
    paddingInline: themeSpace[1],
    color: themeColors.mutedForeground,
  },
  tooltipLabel: {
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  tooltipHint: {
    marginLeft: themeSpace[1.5],
    color: themeColors.mutedForeground,
  },

  /* ── Context chip summary ─────────────────────────────────────────── */
  prButton: {
    display: 'flex',
    height: themeSpace[6],
    flexShrink: 0,
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[1],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[1],
    fontWeight: themeFontWeight.medium,
    color: themeColors.mutedForeground,
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': 'hsl(var(--muted-foreground) / 0.1)' },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  prStatic: {
    display: 'flex',
    height: themeSpace[6],
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1],
    paddingInline: themeSpace[1],
    fontWeight: themeFontWeight.medium,
    color: themeColors.mutedForeground,
  },
  chipValue: {
    display: { default: 'none', '@container (min-width: 420px)': 'inline' },
    flexShrink: 0,
    fontVariantNumeric: 'tabular-nums',
  },
  summaryRow: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[2],
    fontWeight: themeFontWeight.normal,
  },
  projectName: {
    minWidth: 0,
    flexShrink: 2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: themeColors.mutedForeground,
  },
  branchButton: {
    marginInline: `calc(-1 * ${themeSpace[1]})`,
    display: 'flex',
    height: themeSpace[6],
    minWidth: 0,
    flexShrink: 0,
    alignItems: 'center',
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[1],
    color: themeColors.reading,
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': 'hsl(var(--muted-foreground) / 0.1)' },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  branchName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  diffChip: {
    display: 'flex',
    height: themeSpace[5],
    minWidth: 0,
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1.5],
    overflow: 'hidden',
    borderRadius: themeRadius.md,
    backgroundColor: {
      default: 'hsl(var(--foreground) / 0.06)',
      '@media (hover: hover)': {
        ':enabled:hover': 'color-mix(in oklab, hsl(var(--foreground) / 1) 10%, transparent)',
      },
    },
    paddingInline: themeSpace[1.5],
    fontWeight: themeFontWeight.medium,
    fontVariantNumeric: 'tabular-nums',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
    ':disabled': { pointerEvents: 'none' },
  },
  diffAdded: { color: themeColors.githubAddition },
  diffRemoved: { color: themeColors.githubDeletion },
  ciSlot: {
    display: { default: 'none', '@container (min-width: 420px)': 'contents' },
  },

  /* ── CI popover ───────────────────────────────────────────────────── */
  ciPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[1.5],
    padding: themeSpace[3],
  },
  ciHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
  },
  ciOverall: { fontWeight: themeFontWeight.medium },
  ciCount: { color: themeColors.mutedForeground },
  ciList: {
    display: 'flex',
    maxHeight: '14rem',
    flexDirection: 'column',
    overflowY: 'auto',
  },
  ciRunGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
  },
  ciRunName: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: themeColors.foreground,
  },
  ciRunDuration: {
    flexShrink: 0,
    fontVariantNumeric: 'tabular-nums',
    color: themeColors.mutedForeground,
  },
  ciRunRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[1.5],
    paddingBlock: themeSpace[1],
    textAlign: 'left',
  },
  ciRunButton: {
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': 'hsl(var(--muted-foreground) / 0.1)' },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  ciPillButton: {
    display: 'flex',
    height: themeSpace[6],
    flexShrink: 0,
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[1],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[1],
    color: themeColors.mutedForeground,
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': 'hsl(var(--muted-foreground) / 0.1)' },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  ciPillOpen: { backgroundColor: 'hsl(var(--muted-foreground) / 0.1)' },
  ciPillCount: { fontVariantNumeric: 'tabular-nums' },

  /* CI run tones. */
  ciSuccess: { color: themeColors.statusSuccess },
  ciFailure: { color: themeColors.destructive },
  ciRunning: { color: themeColors.statusWarning },
  ciQueued: { color: themeColors.mutedForeground },
  ciSkipped: { color: 'hsl(var(--muted-foreground) / 0.7)' },
});

/**
 * Shared contract: the bar renders each item either collapsed in the cluster
 * (`mode: 'cluster'`, click promotes) or as THE active item on the stage
 * (`mode: 'stage'`, icon is an inert marker / summary opens detail).
 */
export type InfoBarItemMode = { mode: 'cluster'; onPromote: () => void } | { mode: 'stage' };

/* ── Status (offline / removed) ──────────────────────────────────────── */

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
        textClassName={stylex.props(styles.textMuted).className}
        onPromote={itemMode.onPromote}
      />
    );
  }

  return (
    <StageChip
      icon={Clock}
      label={label}
      textClassName={stylex.props(styles.textMuted).className}
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
  const textClassName = stylex.props(warning ? styles.textWarning : styles.textMuted).className;

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
    isSessionGoalResumable(goal) && commands?.includes('resume') === true && onGoalCommand != null;
  const showClear = !isCleared && commands?.includes('clear') === true && onGoalCommand != null;
  const showDismiss = isCleared && onDismiss != null;

  const durationUnitLabels = getDurationUnitLabels(t);
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
          <div
            {...stylex.props(styles.goalPanel)}
            className={clsx(stylex.props(styles.goalPanel).className, INFO_BAR_TEXT_CLASS)}
          >
            <div {...stylex.props(styles.goalHeaderRow)}>
              <Target
                {...stylex.props(styles.goalGlyph)}
                className={clsx(stylex.props(styles.goalGlyph).className, meta.textClassName)}
                aria-hidden="true"
              />
              <span
                {...stylex.props(styles.goalLabel)}
                className={clsx(stylex.props(styles.goalLabel).className, meta.textClassName)}
              >
                {t('sessions.goal.banner.label', 'Goal')}
              </span>
              <span
                {...stylex.props(styles.goalLabel)}
                className={clsx(stylex.props(styles.goalLabel).className, meta.textClassName)}
              >
                {statusLabel}
              </span>
              <span {...stylex.props(styles.goalMetrics)}>
                {timeLabel ? (
                  <span
                    {...stylex.props(styles.goalMetric)}
                    title={t('sessions.goal.metrics.elapsed', 'Elapsed time')}
                  >
                    <Clock {...stylex.props(styles.goalClock)} aria-hidden="true" />
                    <span>{timeLabel}</span>
                  </span>
                ) : null}
                {tokensLabel ? (
                  <span {...stylex.props(styles.goalMetricValue)}>{tokensLabel}</span>
                ) : null}
              </span>
            </div>
            <p
              {...stylex.props(styles.goalObjective)}
              className={clsx(
                stylex.props(styles.goalObjective).className,
                'scrollbar-pro',
                INFO_BAR_PROSE_CLASS
              )}
            >
              {objective}
            </p>
            {showPause || showResume || showClear || showDismiss ? (
              <div {...stylex.props(styles.goalActions)}>
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
                    size="small"
                    icon
                    onClick={() => onDismiss?.(goal)}
                    aria-label={t('sessions.goal.actions.dismiss', 'Dismiss goal banner')}
                    title={t('sessions.goal.actions.dismiss', 'Dismiss goal banner')}
                  >
                    <X {...stylex.props(styles.dismissGlyph)} aria-hidden="true" />
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
          <div {...stylex.props(styles.schedulePanel)}>
            <div
              {...stylex.props(styles.scheduleHeaderRow)}
              className={clsx(
                stylex.props(styles.scheduleHeaderRow).className,
                INFO_BAR_TEXT_CLASS
              )}
            >
              <AlarmClock {...stylex.props(styles.scheduleGlyph)} aria-hidden="true" />
              <span {...stylex.props(styles.scheduleTitle)}>{heading}</span>
              <span {...stylex.props(styles.scheduleSummary)}>· {summary}</span>
            </div>
            <ScheduledTaskList rows={rows} nowMs={nowMs} />
          </div>
        ),
      }}
    />
  );
}

/* ── PR / repo context ───────────────────────────────────────────────── */

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

  return (
    <div {...stylex.props(styles.actionsShell)}>
      <button
        type="button"
        onClick={primaryAction.onClick}
        disabled={primaryAction.disabled}
        title={primaryAction.label}
        {...stylex.props(styles.actionButton)}
        className={clsx(stylex.props(styles.actionButton).className, INFO_BAR_TEXT_CLASS)}
      >
        <span {...stylex.props(styles.actionLabel)}>{primaryAction.label}</span>
      </button>
      {overflowActions.length > 0 ? (
        <Menu.Root>
          <Menu.Trigger
            render={
              <button
                type="button"
                aria-label={t('sessions.moreActions', 'More actions')}
                title={t('sessions.moreActions', 'More actions')}
                {...stylex.props(styles.overflowButton)}
              >
                <ChevronDown {...stylex.props(styles.overflowGlyph)} aria-hidden="true" />
              </button>
            }
          >
            <button
              type="button"
              aria-label={t('sessions.moreActions', 'More actions')}
              title={t('sessions.moreActions', 'More actions')}
              {...stylex.props(styles.overflowButton)}
            >
              <ChevronDown {...stylex.props(styles.overflowGlyph)} aria-hidden="true" />
            </button>
          </Menu.Trigger>
          <Menu.Content side="top" align="end" sideOffset={6}>
            {overflowActions.map((action) =>
              // Merge can be demoted out of the primary slot (unpublished work
              // outranks it) and must stay reachable rather than silently vanish.
              // Here it collapses to one item performing the already-selected
              // method; picking a different method remains the split button's
              // job, which is back as soon as merge leads again.
              action.kind === 'merge' ? (
                <Menu.Item
                  key={action.id}
                  disabled={action.disabled || action.isMerging}
                  onClick={() => void action.onMerge(action.method)}
                >
                  {action.isMerging ? (
                    t('sessions.prTab.merging', 'Merging…')
                  ) : (
                    <PrMergeMethodLabel method={action.method} />
                  )}
                </Menu.Item>
              ) : (
                <Menu.Item key={action.id} disabled={action.disabled} onClick={action.onClick}>
                  {action.label}
                </Menu.Item>
              )
            )}
          </Menu.Content>
        </Menu.Root>
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
  const glyphProps = stylex.props(styles.locationGlyph);
  const glyph = <Icon {...glyphProps} className={clsx(glyphProps.className, className)} />;

  return (
    <Tooltip.Provider delay={300}>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            canCopy ? (
              <button
                type="button"
                onClick={handleCopy}
                aria-label={label}
                {...stylex.props(styles.locationButton)}
              >
                {glyph}
              </button>
            ) : (
              <span {...stylex.props(styles.locationStatic)}>{glyph}</span>
            )
          }
        />
        <Tooltip.Content side="top">
          <span {...stylex.props(styles.tooltipLabel)}>{label}</span>
          {canCopy ? (
            <span {...stylex.props(styles.tooltipHint)}>
              {t('sessions.infoBar.copyPathHint', 'click to copy path')}
            </span>
          ) : null}
        </Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
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
  prCiState,
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
  /** Compact CI state from the session row; live runs override it when present. */
  prCiState?: SessionPullRequestCiState | null;
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
  const liveCiOverall = prCiRuns?.length ? summarizePrCiRuns(prCiRuns) : null;
  const compactCiState: SessionPullRequestCiState | null | undefined =
    liveCiOverall === 'failing'
      ? 'f'
      : liveCiOverall === 'running'
        ? 'p'
        : liveCiOverall === 'passing'
          ? 's'
          : prCiState;
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
        {...stylex.props(styles.prButton)}
        className={clsx(stylex.props(styles.prButton).className, INFO_BAR_TEXT_CLASS)}
      >
        <SessionPrIcon prStatus={status ?? 'open'} prCiState={compactCiState} />
        {value ? <span {...stylex.props(styles.chipValue)}>{value}</span> : null}
      </button>
    ) : (
      <span {...stylex.props(styles.prStatic)}>
        <SessionPrIcon prStatus={status ?? 'open'} prCiState={compactCiState} />
        {value ? <span {...stylex.props(styles.chipValue)}>{value}</span> : null}
      </span>
    )
  ) : undefined;

  const summary = (
    <span {...stylex.props(styles.summaryRow)}>
      {projectName ? <span {...stylex.props(styles.projectName)}>{projectName}</span> : null}
      {trimmedBranch ? (
        <button
          type="button"
          onClick={handleCopyBranch}
          aria-label={`${copyBranchLabel}: ${trimmedBranch}`}
          title={copyBranchLabel}
          {...stylex.props(styles.branchButton)}
        >
          <span {...stylex.props(styles.branchName)}>{trimmedBranch}</span>
        </button>
      ) : null}
    </span>
  );

  // The line totals sit on the right edge in their own tinted chip, colored
  // like GitHub's (the PR's green and red), apart from the repo/branch text.
  // Under squeeze the action label truncates first; the totals clip last,
  // inside their own chip rather than past the bar.
  const diffChip = hasDiff ? (
    <button
      type="button"
      onClick={onOpenAllChanges}
      disabled={!onOpenAllChanges}
      aria-label={t('sessions.detailTabs.allChanges', 'All Changes')}
      title={t('sessions.detailTabs.allChanges', 'All Changes')}
      {...stylex.props(styles.diffChip)}
      className={clsx(stylex.props(styles.diffChip).className, INFO_BAR_TEXT_CLASS)}
    >
      <span {...stylex.props(styles.diffAdded)}>+{diffStat.add}</span>
      <span {...stylex.props(styles.diffRemoved)}>−{diffStat.del}</span>
    </button>
  ) : null;
  const trailing =
    diffChip || actions?.length ? (
      <>
        {diffChip}
        {actions?.length ? <ContextChipActions actions={actions} /> : null}
      </>
    ) : undefined;

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
      textClassName={stylex.props(styles.textMuted).className}
      summary={summary}
      leading={
        pr ? (
          <>
            {/* CI pill stays adjacent to the PR number; the location control
                trails it, sitting right before the repo/branch summary. */}
            <span {...stylex.props(styles.ciSlot)}>
              <PrCiPill runs={prCiRuns} onOpenRun={onOpenPrCiRun} />
            </span>
            {locationControl}
          </>
        ) : undefined
      }
      trailing={trailing}
    />
  );
}

/* ── PR CI checks ────────────────────────────────────────────────────── */

export type PrCiRunStatus =
  | 'success'
  | 'failure'
  | 'running'
  | 'queued'
  | 'skipped'
  /** Cancelled/stale: aborted rather than failed, so it never turns CI red. */
  | 'cancelled';

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

export function mapGitHubCheckRunToPrCiRun(run: GitHubCheckRun): PrCiRun {
  const status: PrCiRun['status'] =
    run.status === 'queued'
      ? 'queued'
      : run.status === 'in_progress'
        ? 'running'
        : run.conclusion === 'success'
          ? 'success'
          : run.conclusion === 'neutral' || run.conclusion === 'skipped'
            ? 'skipped'
            : run.conclusion === 'cancelled' || run.conclusion === 'stale'
              ? 'cancelled'
              : 'failure';
  const startedAtMs = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  const completedAtMs = run.completedAt ? Date.parse(run.completedAt) : Number.NaN;
  const durationMs =
    Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
      ? Math.max(0, completedAtMs - startedAtMs)
      : undefined;
  return {
    name: run.name,
    status,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(run.htmlUrl ? { url: run.htmlUrl } : {}),
  };
}

export const PR_CI_RUN_ICON: Record<
  PrCiRunStatus,
  { Icon: typeof CircleCheck; className: string }
> = {
  success: { Icon: CircleCheck, className: stylex.props(styles.ciSuccess).className ?? '' },
  failure: { Icon: CircleX, className: stylex.props(styles.ciFailure).className ?? '' },
  running: { Icon: CircleDot, className: stylex.props(styles.ciRunning).className ?? '' },
  queued: { Icon: CircleDot, className: stylex.props(styles.ciQueued).className ?? '' },
  skipped: { Icon: CircleMinus, className: stylex.props(styles.ciSkipped).className ?? '' },
  cancelled: { Icon: CircleSlash, className: stylex.props(styles.ciSkipped).className ?? '' },
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
      ? stylex.props(styles.ciSuccess).className
      : overall === 'failing'
        ? stylex.props(styles.ciFailure).className
        : stylex.props(styles.ciRunning).className;
  const VerdictIcon =
    overall === 'passing' ? CircleCheck : overall === 'failing' ? CircleX : CircleDot;
  return { overall, settled, overallLabel, toneClassName, VerdictIcon };
}

function PrCiPopoverBody({
  runs,
  onOpenRun,
}: {
  runs: readonly PrCiRun[];
  onOpenRun?: (run: PrCiRun) => void;
}) {
  const { t } = useTranslation();
  const durationUnitLabels = getDurationUnitLabels(t);
  const { settled, overallLabel, toneClassName } = usePrCiPresentation(runs);
  const ciOverallProps = stylex.props(styles.ciOverall);
  const ciListProps = stylex.props(styles.ciList);
  const ciRunGlyphProps = stylex.props(styles.ciRunGlyph);
  return (
    <div {...stylex.props(styles.ciPanel)}>
      <div
        {...stylex.props(styles.ciHeaderRow)}
        className={clsx(stylex.props(styles.ciHeaderRow).className, INFO_BAR_TEXT_CLASS)}
      >
        <span {...ciOverallProps} className={clsx(ciOverallProps.className, toneClassName)}>
          {overallLabel}
        </span>
        <span {...stylex.props(styles.ciCount)}>
          · {settled}/{runs.length}
        </span>
      </div>
      <ul
        {...ciListProps}
        className={clsx(ciListProps.className, 'scrollbar-pro', INFO_BAR_TEXT_CLASS)}
      >
        {runs.map((run) => {
          const { Icon: RunIcon, className: runClassName } = PR_CI_RUN_ICON[run.status];
          const duration =
            run.durationMs != null && run.durationMs > 0
              ? formatDurationCompact(run.durationMs, durationUnitLabels)
              : null;
          const row = (
            <>
              <RunIcon
                {...ciRunGlyphProps}
                className={clsx(ciRunGlyphProps.className, runClassName)}
                aria-hidden="true"
              />
              <span {...stylex.props(styles.ciRunName)}>{run.name}</span>
              {duration ? <span {...stylex.props(styles.ciRunDuration)}>{duration}</span> : null}
            </>
          );
          return (
            <li key={run.name}>
              {run.url && onOpenRun ? (
                <button
                  type="button"
                  onClick={() => onOpenRun(run)}
                  {...stylex.props(styles.ciRunRow, styles.ciRunButton)}
                >
                  {row}
                </button>
              ) : (
                <span {...stylex.props(styles.ciRunRow)}>{row}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * PR CI verdict as a compact icon button. It only appears INSIDE the PR
 * context when that item is expanded on the stage (never a standalone cluster
 * icon). The verdict icon carries the color (green passing / red failing /
 * amber running, with a muted "done/total" while running); there is no tinted
 * fill, so the bar stays quiet. A single click opens the check-run list.
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
  const hasRuns = !!runs && runs.length > 0;
  const presentation = usePrCiPresentation(hasRuns ? runs! : []);
  if (!hasRuns) return null;

  const { overall, settled, overallLabel, toneClassName, VerdictIcon } = presentation;
  const label = `${t('sessions.prCi.label', 'CI checks')} · ${overallLabel}`;
  const pillProps = stylex.props(styles.ciPillButton, open && styles.ciPillOpen);
  const ciRunGlyphProps = stylex.props(styles.ciRunGlyph);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label={label}
            title={label}
            {...pillProps}
            className={clsx(pillProps.className, INFO_BAR_TEXT_CLASS)}
          >
            <VerdictIcon
              {...ciRunGlyphProps}
              className={clsx(ciRunGlyphProps.className, toneClassName)}
              aria-hidden="true"
            />
            {overall === 'running' ? (
              <span {...stylex.props(styles.ciPillCount)}>
                {settled}/{runs!.length}
              </span>
            ) : null}
          </button>
        }
      />
      <Popover.Content
        side="top"
        align="start"
        sideOffset={8}
        aria-label={t('sessions.prCi.label', 'CI checks')}
        className={clsx(
          stylex.props(styles.ciPopover).className,
          'max-w-[min(24rem,90vw)] p-0 shadow-xl'
        )}
      >
        <PrCiPopoverBody runs={runs!} onOpenRun={onOpenRun} />
      </Popover.Content>
    </Popover.Root>
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

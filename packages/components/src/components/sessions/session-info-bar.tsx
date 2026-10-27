import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { clsx } from 'clsx';
import { LockKeyhole, MonitorPlay, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  PendingScheduledTask,
  SessionGoalCommand,
  SessionGoalMessage,
  SessionPullRequestCiState,
  SessionPullRequestMeta,
} from '@lody/shared';
import { sanitizeGoalObjective } from '@lody/shared';
import { INFO_BAR_ELEVATION_CLASS } from '@/components/chat/composer-surface';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { INFO_BAR_TEXT_CLASS } from './info-bar-type';
import { ActionChip } from './info-chip';
import {
  ContextChip,
  GoalChip,
  ScheduleChip,
  StatusChip,
  ScheduleSourceChip,
  useScheduledTaskSignature,
  type GoalChipCommandHandler,
  type ContextChipAction,
  type PrCiRun,
  type WorkspaceLocationKind,
} from './session-info-chips';
import type { SessionStatusStripState } from './session-status-strip';
import {
  SessionSyncingIndicator,
  type SessionSyncIndicatorVariant,
} from './session-syncing-indicator';
import { SessionMachineInfo } from './session-machine-info';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontWeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

export type InfoBarItemKey = 'status' | 'goal' | 'schedule' | 'scheduleSource' | 'context';

export type SessionInfoBarProps = {
  status: SessionStatusStripState | null;
  /** Persistent execution target, outside the cluster/stage selection. */
  machine?: SessionMachineInfo | null;
  /** Mobile keeps the target as an icon; its full name remains in the card. */
  compactMachineInfo?: boolean;
  /** The schedule that started this session; the chip is the way back to it. */
  scheduleSource?: { title: string; onOpen: () => void } | null;
  /**
   * The queued-turn sheet. Not a bar item: it sits on the bar's top edge, or,
   * when the bar has nothing to show, directly on the composer below.
   */
  queue?: ReactNode;
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
  /** Compact CI state from the session row; live runs override it when present. */
  prCiState?: SessionPullRequestCiState | null;
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
  /** Related-Sessions chip (opener + Sessions/Tabs created here). A plain
   *  cluster action with its own popover; never staged. Pass it only when a
   *  relation exists, so an otherwise empty bar still hides. */
  relations?: ReactNode;
  /** Scheduled composer draft: icon-only action, never staged. */
  scheduledMessage?: ReactNode;
  /** Repositories of a multi-repository conversation: a plain cluster action
   *  with its own popover, placed before Related sessions; never staged. */
  projectMembers?: ReactNode;
  /** Open the session Browser panel. Renders a
   *  plain action chip in the cluster zone (no stage form). */
  onOpenBrowser?: () => void;
  onOpenIosSimulator?: () => void;
  /** Mobile team workspace: persistent effective privacy status. */
  privateAccessStatus?: { label: string; description: string; onAction?: () => void };
  diffStat?: { add: number; del: number } | null;
  /** Desktop-only ambient doc catch-up state: a quiet spinner pinned to the
   *  bar's right edge. Not a cluster/stage item — it must never steal focus
   *  or relayout the canonical order. */
  syncing?: boolean;
  /** Overrides `syncing` with a specific conversation content-sync state. */
  syncStatus?: SessionSyncIndicatorVariant | null;
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

const DARK =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';

const styles = stylex.create({
  machineOnly: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    height: space[8],
    paddingInline: space[1.5],
    containerType: 'inline-size',
  },
  compactPrivateLabel: {
    display: {
      default: 'inline',
      '@container (max-width: 420px)': 'none',
    },
  },
  /** The queue sheet is inset past the rounded corners of the surface it sits
   *  on (the bar pill or the composer), so its square bottom meets a straight
   *  edge. */
  queueSheet: { marginInline: themeSpace[3] },
  bar: {
    width: '100%',
    flexShrink: 0,
    backgroundColor: themeColors.background,
    paddingBottom: themeSpace[2],
  },
  /** The native session drawer's transparent edge-back strip is z-30 and spans
   *  the body's left 48px. Elevating this band keeps the leading chip
   *  tappable; message body above still owns edge-back swipes. */
  barEdgeGuard: { position: 'relative', zIndex: 40 },
  barSpacer: {
    height: themeSpace[1],
    width: '100%',
    flexShrink: 0,
  },
  surface: {
    containerType: 'inline-size',
    display: 'flex',
    height: themeSpace[8],
    width: '100%',
    minWidth: 0,
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[1.5],
    borderWidth: '0.5px',
    borderStyle: 'solid',
    borderColor: {
      default: 'hsl(var(--foreground) / 0.1)',
      [DARK]: 'color-mix(in oklab, hsl(var(--input-border) / 1) 45%, transparent)',
    },
    borderRadius: themeRadius.lg,
    backgroundColor: {
      default: 'hsl(var(--composer))',
      [DARK]: 'color-mix(in oklab, hsl(var(--input) / 1) 70%, transparent)',
    },
    paddingInline: themeSpace[2],
  },
  /** The machine button carries its own 8px padding (chips carry 4px): trim
   *  the leading inset so the first glyph sits where a chip's would. */
  surfaceWithMachine: { paddingLeft: themeSpace[1] },
  /** Keep the queue sheet's top seam free of upward shadow bleed. */
  surfaceWithQueue: { clipPath: 'inset(0 -6px -6px -6px)' },
  privateAccessButton: {
    display: 'inline-flex',
    height: themeSpace[6],
    maxWidth: '11rem',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[1],
    color: {
      default: 'oklch(55.5% 0.163 48.998)',
      [DARK]: 'var(--color-amber-300, oklch(87.9% 0.169 91.605))',
    },
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': 'hsl(var(--muted-foreground) / 0.1)' },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  previewActionInk: {
    color: {
      default: 'var(--color-emerald-600, oklch(59.6% 0.145 163.225))',
      [DARK]: 'var(--color-emerald-400, oklch(76.5% 0.177 163.223))',
    },
  },
  privateAccessGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
  },
  privateAccessLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: themeFontWeight.medium,
  },
  divider: {
    height: themeSpace[3.5],
    width: '1px',
    flexShrink: 0,
    backgroundColor: 'hsl(var(--muted-foreground) / 0.25)',
  },
  stage: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
  },
  ambientSync: {
    marginLeft: 'auto',
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
  },
  ambientSyncLabel: {
    display: { default: 'none', '@container (min-width: 560px)': 'inline' },
  },
});

export function SessionInfoBar({
  status,
  machine,
  compactMachineInfo = false,
  goal,
  goalCommands,
  goalPendingCommand,
  onGoalCommand,
  onGoalDismiss,
  scheduleSource,
  scheduledTasks,
  prCiRuns,
  onOpenPrCiRun,
  prCiState,
  projectName,
  branch,
  workspaceLocation,
  pr,
  onOpenPr,
  contextActions,
  onOpenAllChanges,
  relations,
  scheduledMessage,
  projectMembers,
  onOpenBrowser,
  onOpenIosSimulator,
  privateAccessStatus,
  diffStat,
  syncing = false,
  syncStatus,
  protectFromEdgeBackZone = false,
  initialStage,
  queue,
}: SessionInfoBarProps) {
  const { t } = useTranslation();
  const hasDiff = diffStat != null && diffStat.add + diffStat.del > 0;
  const hasContext = !!pr || !!projectName || !!branch || hasDiff || !!contextActions?.length;
  const goalObjective = goal ? sanitizeGoalObjective(goal.objective) : '';
  const hasGoal = !!goal && !!goalObjective;
  const scheduleSignature = useScheduledTaskSignature(scheduledTasks);
  const hasSchedule = scheduleSignature !== null;
  const hasStatus = !!status;

  const present: Record<InfoBarItemKey, boolean> = {
    status: hasStatus,
    goal: hasGoal,
    schedule: hasSchedule,
    scheduleSource: !!scheduleSource,
    context: hasContext,
  };
  const defaultKey =
    (['context', 'status', 'goal', 'schedule', 'scheduleSource'] as const).find(
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
  const prevRef = useRef({
    status: statusSignature,
    goal: goalSignature,
    schedule: scheduleSignature,
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
    } else if (contextSignature !== prev.context && contextSignature !== null) {
      setStage('context');
    }
    prevRef.current = {
      status: statusSignature,
      goal: goalSignature,
      schedule: scheduleSignature,
      context: contextSignature,
    };
  }, [statusSignature, goalSignature, scheduleSignature, contextSignature]);

  // With no staged items the bar hides unless it still owns a standalone
  // action, execution target or ambient syncing state. A reported preview is often the only
  // context a chat-only Session has, so dropping the Browser action here would
  // leave no visible path from the report to the preview.
  // The bar owns the gap above the composer (the session composer skips its own
  // spacer): 8px under the pill, none under a queue sheet (it sits on the
  // composer), and the plain 4px when there is nothing to show.
  const ambientSync = syncStatus !== undefined ? syncStatus : syncing ? 'syncing' : null;
  const hasMachine = !!machine?.name.trim();
  const hasSurfaceContent = !!(
    defaultKey ||
    scheduledMessage ||
    projectMembers ||
    relations ||
    onOpenBrowser ||
    onOpenIosSimulator ||
    ambientSync ||
    privateAccessStatus
  );
  if (!hasSurfaceContent && !hasMachine) {
    return queue ? (
      <div {...stylex.props(styles.bar)}>
        <ConversationColumn>
          <div {...stylex.props(styles.queueSheet)}>{queue}</div>
        </ConversationColumn>
      </div>
    ) : (
      <div aria-hidden="true" {...stylex.props(styles.barSpacer)} />
    );
  }

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
            prCiState={prCiState}
            {...itemMode}
          />
        ) : null;
      default:
        return null;
    }
  };

  const clusterKeys = (['status', 'goal', 'schedule', 'scheduleSource', 'context'] as const).filter(
    (key) => present[key] && key !== stagedKey
  );
  const clusterNonEmpty =
    hasMachine ||
    clusterKeys.length > 0 ||
    !!scheduledMessage ||
    !!projectMembers ||
    !!relations ||
    !!onOpenBrowser ||
    !!onOpenIosSimulator;

  const surfaceStyleProps = stylex.props(
    styles.surface,
    hasMachine && styles.surfaceWithMachine,
    Boolean(queue) && styles.surfaceWithQueue
  );
  const surfaceProps = hasSurfaceContent
    ? {
        ...surfaceStyleProps,
        className: clsx(surfaceStyleProps.className, INFO_BAR_TEXT_CLASS, INFO_BAR_ELEVATION_CLASS),
      }
    : stylex.props(styles.machineOnly);

  const barProps = stylex.props(styles.bar, protectFromEdgeBackZone && styles.barEdgeGuard);
  const privateAccessButtonProps = stylex.props(styles.privateAccessButton);
  const privateAccessLabelProps = stylex.props(styles.privateAccessLabel);

  return (
    // Light: same fill and lift as the session composer. Dark: recessed input.
    <div {...barProps}>
      {/* Same centered width as the composer content, so the bar and the
          input box share edges. */}
      <ConversationColumn>
        {queue ? <div {...stylex.props(styles.queueSheet)}>{queue}</div> : null}
        <div data-info-bar-surface="" {...surfaceProps}>
          {hasMachine && machine ? (
            <SessionMachineInfo
              key={machine.machineId}
              machine={machine}
              compact={compactMachineInfo}
            />
          ) : null}
          {privateAccessStatus ? (
            <button
              type="button"
              {...privateAccessButtonProps}
              title={privateAccessStatus.description}
              aria-label={privateAccessStatus.description}
              onClick={privateAccessStatus.onAction}
            >
              <LockKeyhole {...stylex.props(styles.privateAccessGlyph)} aria-hidden="true" />
              <span
                {...privateAccessLabelProps}
                className={clsx(
                  privateAccessLabelProps.className,
                  compactMachineInfo && stylex.props(styles.compactPrivateLabel).className
                )}
              >
                {privateAccessStatus.label}
              </span>
            </button>
          ) : null}
          {privateAccessStatus &&
          (clusterKeys.length > 0 ||
            scheduledMessage ||
            projectMembers ||
            relations ||
            onOpenBrowser ||
            onOpenIosSimulator ||
            stagedKey) ? (
            <span aria-hidden="true" {...stylex.props(styles.divider)} />
          ) : null}
          {clusterKeys.map((key) => renderItem(key, 'cluster'))}
          {/* Repositories, Relations and Browser are plain actions with no stage form. */}
          {scheduledMessage}
          {projectMembers}
          {relations}
          {onOpenBrowser ? (
            <ActionChip
              icon={MonitorPlay}
              label={t('sessions.browser.openPreview', 'Open preview')}
              textClassName={stylex.props(styles.previewActionInk).className}
              onAction={onOpenBrowser}
            />
          ) : null}
          {onOpenIosSimulator ? (
            <ActionChip
              icon={Smartphone}
              label={t('sessions.detailTabs.iosSimulator', 'iOS Simulator')}
              textClassName={stylex.props(styles.previewActionInk).className}
              onAction={onOpenIosSimulator}
            />
          ) : null}
          {/* The divider is what marks the staged item as active (the stage
              icon has no highlight bg), so it must stay clearly visible —
              plain bg-border melts into the pill in light theme. */}
          {stagedKey && clusterNonEmpty ? (
            <span aria-hidden="true" {...stylex.props(styles.divider)} />
          ) : null}
          {/* key remounts the stage per item so any open popover state resets
              on hand-off. */}
          {stagedKey ? (
            <div key={stagedKey} {...stylex.props(styles.stage)}>
              {renderItem(stagedKey, 'stage')}
            </div>
          ) : null}
          {/* Ambient sync state hugs the right edge, outside the
              cluster/stage model. Under squeeze the label yields first
              (spinner stays) so the stage's diffstat never clips. In
              sync-only mode nothing else consumes the row's free space, so
              ml-auto keeps the spinner pinned right; with a stage present
              its flex-1 has already eaten the space (no-op). */}
          {ambientSync ? (
            <span {...stylex.props(styles.ambientSync)}>
              <SessionSyncingIndicator
                variant={ambientSync}
                labelClassName={stylex.props(styles.ambientSyncLabel).className}
              />
            </span>
          ) : null}
        </div>
      </ConversationColumn>
    </div>
  );
}

import * as stylex from '@stylexjs/stylex';
import {
  COORDINATOR_CLIENT_COMMANDS,
  hasWorkspaceChanges,
  type CoordinatorActionSpec,
  type CoordinatorCardKind,
  type SessionPullRequestView,
} from '@lody/shared';
import { Spinner } from '@lody/ui/spinner';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  Play,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ResolvedCoordinatorAction,
  ResolvedCoordinatorProactiveCard,
} from './coordinator-action-engine';
import { formatTaskNumber } from './project-board';
import {
  hasMultiplePullRequestRepos,
  resolveOwnerSessionForPullRequest,
} from './project-board-model';

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';
const COLLAPSE_EASE = 'cubic-bezier(0.2, 0, 0, 1)';
const REGION_SUBTLE = `color-mix(in oklab, transparent, ${colors.label} 3.5%)`;
const REGION_HOVER = `color-mix(in oklab, transparent, ${colors.label} 7%)`;
const ACCENT_TINT = `color-mix(in oklab, transparent, ${colors.accent} 8%)`;
const ACCENT_TINT_HOVER = `color-mix(in oklab, transparent, ${colors.accent} 13%)`;
const ACCENT_BORDER = `color-mix(in oklab, transparent, ${colors.accent} 32%)`;
const ACCENT_BADGE_BG = `color-mix(in oklab, transparent, ${colors.accent} 14%)`;
const WARNING_BADGE_BG = `color-mix(in oklab, transparent, ${colors.warning} 15%)`;
const SUCCESS_BADGE_BG = `color-mix(in oklab, transparent, ${colors.success} 14%)`;

const styles = stylex.create({
  outerPresenceGrid: {
    display: 'grid',
    gridTemplateRows: '1fr',
    opacity: 1,
    width: '100%',
    maxWidth: 640,
    minWidth: 0,
    transitionProperty: 'grid-template-rows, opacity',
    transitionDuration: { default: '220ms', [REDUCED_MOTION]: '0ms' },
    transitionTimingFunction: COLLAPSE_EASE,
  },
  outerPresenceHidden: {
    gridTemplateRows: '0fr',
    opacity: 0,
    pointerEvents: 'none',
  },
  card: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    maxWidth: 640,
    minWidth: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    color: colors.label,
    overflow: 'hidden',
    transitionProperty: 'background-color, border-color, box-shadow',
    transitionDuration: { default: '240ms', [REDUCED_MOTION]: '0ms' },
    transitionTimingFunction: COLLAPSE_EASE,
  },
  cardCollapsed: {
    backgroundColor: colors.wellBackground,
    boxShadow: 'none',
  },
  cardSuperseded: {
    borderColor: 'transparent',
    boxShadow: 'none',
  },

  collapseGrid: {
    display: 'grid',
    gridTemplateRows: '0fr',
    opacity: 0,
    transitionProperty: 'grid-template-rows, opacity',
    transitionDuration: { default: '240ms', [REDUCED_MOTION]: '0ms' },
    transitionTimingFunction: COLLAPSE_EASE,
  },
  collapseGridOpen: {
    gridTemplateRows: '1fr',
    opacity: 1,
  },
  collapseInner: {
    minHeight: 0,
    minWidth: 0,
    overflow: 'hidden',
  },

  collapsedBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    minWidth: 0,
    paddingBlock: space[2],
    paddingInline: space[3],
  },
  collapsedMain: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    flex: 1,
    minWidth: 0,
  },
  collapsedStatusPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: 22,
    paddingInline: space[2],
    borderRadius: radius.full,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 600,
    flexShrink: 0,
  },
  collapsedStatusRunning: {
    backgroundColor: ACCENT_BADGE_BG,
    color: colors.accent,
  },
  collapsedStatusCompleted: {
    backgroundColor: SUCCESS_BADGE_BG,
    color: colors.success,
  },
  collapsedTextGroup: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    minWidth: 0,
    flex: 1,
    overflow: 'hidden',
  },
  collapsedActionTitle: {
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 600,
    color: colors.label,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    flexShrink: 0,
    maxWidth: '68%',
  },
  collapsedDot: {
    color: colors.tertiaryLabel,
    fontSize: text.footnoteSize,
    flexShrink: 0,
  },
  collapsedCardTitle: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
  },
  collapsedRight: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    flexShrink: 0,
  },
  compactTaskPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 22,
    paddingInline: space[1.5],
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: colors.elevatedBackground, ':hover': colors.hoverFill },
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontVariantNumeric: 'tabular-nums',
    cursor: 'pointer',
    flexShrink: 0,
  },
  expandToggleBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.tertiaryLabel,
    cursor: 'pointer',
    flexShrink: 0,
  },

  expandedContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    padding: space[3],
    minWidth: 0,
  },
  metaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[1.5],
    minWidth: 0,
  },
  metaLeft: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
  },
  kindBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 22,
    paddingInline: space[2],
    borderRadius: radius.full,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 600,
    flexShrink: 0,
  },
  kindNextStep: {
    backgroundColor: ACCENT_BADGE_BG,
    color: colors.accent,
  },
  kindReviewReady: {
    backgroundColor: SUCCESS_BADGE_BG,
    color: colors.success,
  },
  kindDecision: {
    backgroundColor: WARNING_BADGE_BG,
    color: colors.warning,
  },
  kindHandoff: {
    backgroundColor: ACCENT_BADGE_BG,
    color: colors.accent,
  },
  directModePill: {
    display: 'inline-flex',
    alignItems: 'center',
    height: 16,
    paddingInline: 5,
    borderRadius: radius.full,
    backgroundColor: ACCENT_BADGE_BG,
    color: colors.accent,
    fontSize: 10,
    fontWeight: 600,
    flexShrink: 0,
  },
  taskChipGroup: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    minWidth: 0,
    maxWidth: 320,
  },
  taskChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: 22,
    maxWidth: 260,
    minWidth: 0,
    paddingInline: space[2],
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: colors.wellBackground, ':hover': colors.hoverFill },
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    cursor: 'pointer',
    transitionProperty: 'background-color, color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  taskNumber: {
    flexShrink: 0,
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    color: colors.label,
  },
  taskTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  diffAdd: {
    flexShrink: 0,
    fontVariantNumeric: 'tabular-nums',
    fontWeight: 500,
    color: colors.success,
  },
  diffDel: {
    flexShrink: 0,
    fontVariantNumeric: 'tabular-nums',
    fontWeight: 500,
    color: colors.destructive,
  },
  prChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    height: 22,
    paddingInline: space[1.5],
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: colors.wellBackground, ':hover': colors.hoverFill },
    color: colors.accent,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
    cursor: 'pointer',
    flexShrink: 0,
  },

  headerText: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 600,
    color: colors.label,
  },
  summary: {
    margin: 0,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    color: colors.secondaryLabel,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },

  optionsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
    paddingTop: 2,
    minWidth: 0,
  },
  optionCard: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    width: '100%',
    minWidth: 0,
    paddingBlock: space[2],
    paddingInline: space[3],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: { default: REGION_SUBTLE, ':hover': REGION_HOVER },
    color: colors.label,
    textAlign: 'left',
    cursor: 'pointer',
    transitionProperty: 'background-color, border-color, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  optionCardPrimary: {
    backgroundColor: { default: ACCENT_TINT, ':hover': ACCENT_TINT_HOVER },
    borderColor: ACCENT_BORDER,
  },
  optionCardDanger: {
    color: colors.destructive,
  },
  optionCardCompleted: {
    backgroundColor: REGION_SUBTLE,
    borderColor: 'transparent',
    cursor: 'default',
  },
  optionCardRunning: {
    backgroundColor: REGION_SUBTLE,
    borderColor: colors.separator,
    cursor: 'default',
  },
  optionCardDisabled: {
    backgroundColor: REGION_SUBTLE,
    borderColor: 'transparent',
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  optionLead: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: 22,
    height: 22,
    marginTop: 1,
    borderRadius: radius.small,
    backgroundColor: colors.wellBackground,
    color: colors.secondaryLabel,
  },
  optionLeadPrimary: {
    backgroundColor: ACCENT_BADGE_BG,
    color: colors.accent,
  },
  optionLeadCompleted: {
    backgroundColor: SUCCESS_BADGE_BG,
    color: colors.success,
  },
  optionBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    flex: 1,
    minWidth: 0,
  },
  optionTitleRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
  },
  optionLabel: {
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 500,
    overflowWrap: 'anywhere',
  },
  recommendedBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    height: 18,
    paddingInline: 6,
    borderRadius: radius.full,
    backgroundColor: ACCENT_BADGE_BG,
    color: colors.accent,
    fontSize: '11px',
    lineHeight: '16px',
    fontWeight: 600,
    flexShrink: 0,
  },
  optionStatePill: {
    display: 'inline-flex',
    alignItems: 'center',
    height: 18,
    paddingInline: 6,
    borderRadius: radius.full,
    backgroundColor: colors.wellBackground,
    color: colors.secondaryLabel,
    fontSize: '11px',
    lineHeight: '16px',
    fontWeight: 500,
    flexShrink: 0,
  },
  optionDescription: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
    overflowWrap: 'anywhere',
  },
  optionTrail: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    marginTop: 3,
    color: colors.tertiaryLabel,
  },
  optionTrailPrimary: {
    color: colors.accent,
  },

  legacyRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
    paddingTop: space[1],
    minWidth: 0,
  },
  legacyButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    minHeight: 28,
    maxWidth: '100%',
    paddingBlock: 4,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    borderRadius: radius.medium,
    backgroundColor: { default: colors.background, ':hover': colors.hoverFill },
    color: colors.label,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    cursor: 'pointer',
  },
  iconCompleted: {
    flexShrink: 0,
    color: colors.success,
  },
  iconSlot: {
    flexShrink: 0,
  },
  labelTruncate: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  spinner: {
    width: 12,
    height: 12,
    flexShrink: 0,
  },
});

type OptimisticCardChoice = {
  kind: 'action';
  spec: CoordinatorActionSpec;
  phase: 'sending' | 'settled';
};

function shouldActionCollapseCard(
  spec: CoordinatorActionSpec,
  cardKind: CoordinatorCardKind
): boolean {
  if (spec.intent.kind === 'client_command') {
    if (spec.intent.command === COORDINATOR_CLIENT_COMMANDS.panelOpen) {
      return Boolean(spec.intent.params?.handoff === true || cardKind === 'handoff');
    }
    return true;
  }
  return spec.intent.mode !== 'prefill';
}

function ActionIcon({ icon, defaultKind }: { icon?: string; defaultKind?: string }) {
  switch (icon ?? defaultKind) {
    case 'check':
      return <Check size={13} {...stylex.props(styles.iconSlot)} aria-hidden="true" />;
    case 'git-merge':
      return <GitMerge size={13} {...stylex.props(styles.iconSlot)} aria-hidden="true" />;
    case 'git-pull-request':
      return <GitPullRequest size={13} {...stylex.props(styles.iconSlot)} aria-hidden="true" />;
    case 'message-square':
      return <MessageSquare size={13} {...stylex.props(styles.iconSlot)} aria-hidden="true" />;
    case 'external-link':
      return <ExternalLink size={13} {...stylex.props(styles.iconSlot)} aria-hidden="true" />;
    case 'play':
      return <Play size={12} {...stylex.props(styles.iconSlot)} aria-hidden="true" />;
    default:
      return <Sparkles size={13} {...stylex.props(styles.iconSlot)} aria-hidden="true" />;
  }
}

function CardKindBadge({ kind }: { kind: CoordinatorCardKind }) {
  const { t } = useTranslation();
  if (kind === 'handoff') {
    return (
      <span {...stylex.props(styles.kindBadge, styles.kindHandoff)}>
        <ArrowRight size={12} aria-hidden="true" />
        <span>{t('projectMode.card.kindHandoff', 'Direct co-work')}</span>
      </span>
    );
  }
  if (kind === 'review_ready') {
    return (
      <span {...stylex.props(styles.kindBadge, styles.kindReviewReady)}>
        <GitPullRequest size={12} aria-hidden="true" />
        <span>{t('projectMode.card.kindReviewReady', 'Ready for review')}</span>
      </span>
    );
  }
  if (kind === 'decision') {
    return (
      <span {...stylex.props(styles.kindBadge, styles.kindDecision)}>
        <MessageSquare size={12} aria-hidden="true" />
        <span>{t('projectMode.card.kindDecision', 'Decision needed')}</span>
      </span>
    );
  }
  return (
    <span {...stylex.props(styles.kindBadge, styles.kindNextStep)}>
      <Sparkles size={12} aria-hidden="true" />
      <span>{t('projectMode.card.kindNextStep', 'Suggested next step')}</span>
    </span>
  );
}

/**
 * Standalone, context-rich coordinator card displaying predicted next-step or
 * decision options and live child-task/diff/PR pills. Animates into a compact
 * single-row receipt when an option is chosen, and smoothly auto-hides when an
 * unchosen card is superseded by a new user instruction in the chat composer.
 */
export function CoordinatorProactiveCard({
  card,
  superseded = false,
  onExecuteAction,
  onDismiss,
  onOpenTask,
  onOpenPr,
}: {
  card: ResolvedCoordinatorProactiveCard;
  superseded?: boolean;
  onExecuteAction?: (action: CoordinatorActionSpec) => Promise<void> | void;
  onDismiss?: () => Promise<void> | void;
  onOpenTask?: (sessionId: string) => void;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
}) {
  const { t } = useTranslation();
  const [inFlightId, setInFlightId] = useState<string | null>(null);
  const [optimisticChoice, setOptimisticChoice] = useState<OptimisticCardChoice | null>(null);
  const [optimisticDismissed, setOptimisticDismissed] = useState(false);
  const [manualExpanded, setManualExpanded] = useState(false);

  const activeSummary = (() => {
    if (optimisticChoice?.kind === 'action') {
      const matched = card.actions.find((item) => item.spec.id === optimisticChoice.spec.id);
      const isSending = optimisticChoice.phase === 'sending';
      const isRunning = !isSending && matched?.liveState === 'running';
      return {
        isBusy: isSending || isRunning,
        statusLabel: isSending
          ? t('projectMode.card.statusSending', 'Sending…')
          : isRunning
            ? t('projectMode.board.working', 'In progress')
            : (matched?.statusBadgeLabel ?? t('projectMode.card.statusSelected', 'Selected')),
        actionTitle: optimisticChoice.spec.label,
      };
    }
    if (card.chosenAction) {
      const isRunning = card.chosenAction.liveState === 'running';
      return {
        isBusy: isRunning,
        statusLabel: isRunning
          ? t('projectMode.board.working', 'In progress')
          : (card.chosenAction.statusBadgeLabel ??
            t('projectMode.card.statusSelected', 'Selected')),
        actionTitle: card.chosenAction.spec.label,
      };
    }
    if (card.customFeedbackSummary) {
      return {
        isBusy: false,
        statusLabel: t('projectMode.card.statusFeedbackSent', 'Feedback sent'),
        actionTitle: card.customFeedbackSummary,
      };
    }
    return null;
  })();

  const isCardDismissed = Boolean(card.isDismissed || optimisticDismissed);
  const shouldHideCard = isCardDismissed || (superseded && activeSummary === null);
  const [mountedVisible, setMountedVisible] = useState(() => !shouldHideCard);

  useEffect(() => {
    if (!shouldHideCard) {
      setMountedVisible(true);
    }
  }, [shouldHideCard]);

  useEffect(() => {
    if (
      optimisticChoice?.kind === 'action' &&
      optimisticChoice.phase === 'settled' &&
      card.chosenAction?.spec.id === optimisticChoice.spec.id
    ) {
      setOptimisticChoice(null);
    }
  }, [card.chosenAction, optimisticChoice]);

  if (shouldHideCard && !mountedVisible) {
    return null;
  }

  const isCollapsed = activeSummary !== null && !manualExpanded;

  const handleActionClick = (spec: CoordinatorActionSpec) => {
    if (!onExecuteAction) return;
    setInFlightId(spec.id);
    const collapses = shouldActionCollapseCard(spec, card.kind);
    if (collapses) {
      setManualExpanded(false);
      setOptimisticChoice({ kind: 'action', spec, phase: 'sending' });
    }
    Promise.resolve(onExecuteAction(spec))
      .then(() => {
        if (collapses) {
          setOptimisticChoice((prev) =>
            prev?.kind === 'action' && prev.spec.id === spec.id
              ? { ...prev, phase: 'settled' }
              : prev
          );
        }
      })
      .catch(() => {
        if (collapses) {
          setOptimisticChoice((prev) =>
            prev?.kind === 'action' && prev.spec.id === spec.id ? null : prev
          );
        }
      })
      .finally(() => {
        setInFlightId((prev) => (prev === spec.id ? null : prev));
      });
  };

  const handleDismissClick = () => {
    setOptimisticDismissed(true);
    void onDismiss?.();
  };

  return (
    <div
      aria-hidden={shouldHideCard}
      inert={shouldHideCard}
      onTransitionEnd={(event) => {
        if (shouldHideCard && event.target === event.currentTarget) {
          setMountedVisible(false);
        }
      }}
      {...stylex.props(styles.outerPresenceGrid, shouldHideCard && styles.outerPresenceHidden)}
    >
      <div {...stylex.props(styles.collapseInner)}>
        <div
          {...stylex.props(
            styles.card,
            isCollapsed && styles.cardCollapsed,
            shouldHideCard && styles.cardSuperseded
          )}
          data-coordinator-proactive-card=""
          data-coordinator-card-collapsed={isCollapsed ? '' : undefined}
          data-coordinator-card-superseded={shouldHideCard ? '' : undefined}
          data-coordinator-card-dismissed={isCardDismissed ? '' : undefined}
        >
          <div
            aria-hidden={!isCollapsed}
            inert={!isCollapsed}
            {...stylex.props(styles.collapseGrid, isCollapsed && styles.collapseGridOpen)}
          >
            <div {...stylex.props(styles.collapseInner)}>
              {activeSummary ? (
                <div {...stylex.props(styles.collapsedBar)} data-coordinator-card-summary-bar="">
                  <div {...stylex.props(styles.collapsedMain)}>
                    <span
                      {...stylex.props(
                        styles.collapsedStatusPill,
                        activeSummary.isBusy
                          ? styles.collapsedStatusRunning
                          : styles.collapsedStatusCompleted
                      )}
                    >
                      {activeSummary.isBusy ? (
                        <Spinner {...stylex.props(styles.spinner)} />
                      ) : (
                        <Check size={12} {...stylex.props(styles.iconSlot)} aria-hidden="true" />
                      )}
                      <span>{activeSummary.statusLabel}</span>
                    </span>
                    <div {...stylex.props(styles.collapsedTextGroup)}>
                      <span
                        title={activeSummary.actionTitle}
                        {...stylex.props(styles.collapsedActionTitle)}
                      >
                        {activeSummary.actionTitle}
                      </span>
                      <span {...stylex.props(styles.collapsedDot)} aria-hidden="true">
                        ·
                      </span>
                      <span title={card.title} {...stylex.props(styles.collapsedCardTitle)}>
                        {card.title}
                      </span>
                    </div>
                  </div>
                  <div {...stylex.props(styles.collapsedRight)}>
                    {card.linkedTasks.slice(0, 2).map((task) => {
                      const num = formatTaskNumber(task.taskNumber);
                      const diff = task.session?.diffStats?.allChange;
                      const showDiff = hasWorkspaceChanges(diff);
                      const prs =
                        task.pullRequests && task.pullRequests.length > 0
                          ? task.pullRequests
                          : task.pullRequest
                            ? [task.pullRequest]
                            : [];
                      const showRepo = hasMultiplePullRequestRepos(prs);
                      const title = task.workItemTitle?.trim() || task.session?.title || '';
                      return (
                        <span
                          key={task.workItemId || task.session?.id || title}
                          {...stylex.props(styles.collapsedRight)}
                        >
                          <button
                            type="button"
                            title={title}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (task.session) onOpenTask?.(task.session.id);
                            }}
                            {...stylex.props(styles.compactTaskPill)}
                          >
                            <span {...stylex.props(styles.taskNumber)}>
                              {num ?? t('sessions.untitled', 'Task')}
                            </span>
                            {showDiff && diff && prs.length === 0 ? (
                              <>
                                {diff.add > 0 ? (
                                  <span {...stylex.props(styles.diffAdd)}>+{diff.add}</span>
                                ) : null}
                                {diff.del > 0 ? (
                                  <span {...stylex.props(styles.diffDel)}>-{diff.del}</span>
                                ) : null}
                              </>
                            ) : null}
                          </button>
                          {prs.map((pr) => {
                            const shortRepo = pr.repoFullName?.split('/')[1] || pr.repoFullName;
                            const numLabel = pr.number !== null ? `#${pr.number}` : 'PR';
                            return (
                              <button
                                key={pr.url}
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  const ownerSid = resolveOwnerSessionForPullRequest(task, pr.url);
                                  if (onOpenPr) {
                                    onOpenPr(ownerSid, pr);
                                  } else {
                                    onOpenTask?.(ownerSid);
                                  }
                                }}
                                {...stylex.props(styles.prChip)}
                              >
                                <GitPullRequest size={11} aria-hidden="true" />
                                <span>
                                  {showRepo && shortRepo ? `${shortRepo} ${numLabel}` : numLabel}
                                </span>
                              </button>
                            );
                          })}
                        </span>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => setManualExpanded(true)}
                      title={t('projectMode.card.expandDetails', 'Show card details')}
                      aria-label={t('projectMode.card.expandDetails', 'Show card details')}
                      data-coordinator-card-expand=""
                      {...stylex.props(styles.expandToggleBtn)}
                    >
                      <ChevronDown size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div
            aria-hidden={isCollapsed}
            inert={isCollapsed}
            {...stylex.props(styles.collapseGrid, !isCollapsed && styles.collapseGridOpen)}
          >
            <div {...stylex.props(styles.collapseInner)}>
              <div {...stylex.props(styles.expandedContent)}>
                <div {...stylex.props(styles.metaRow)}>
                  <div {...stylex.props(styles.metaLeft)}>
                    <CardKindBadge kind={card.kind} />
                    {card.linkedTasks.map((task) => {
                      const num = formatTaskNumber(task.taskNumber);
                      const title =
                        task.workItemTitle?.trim() ||
                        task.session?.title?.trim() ||
                        t('sessions.untitled', 'Untitled session');
                      const diff = task.session?.diffStats?.allChange;
                      const showDiff = hasWorkspaceChanges(diff);
                      const prs =
                        task.pullRequests && task.pullRequests.length > 0
                          ? task.pullRequests
                          : task.pullRequest
                            ? [task.pullRequest]
                            : [];
                      const showRepo = hasMultiplePullRequestRepos(prs);
                      return (
                        <span
                          key={task.workItemId || task.session?.id || title}
                          {...stylex.props(styles.taskChipGroup)}
                        >
                          <button
                            type="button"
                            title={title}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (task.session) onOpenTask?.(task.session.id);
                            }}
                            {...stylex.props(styles.taskChip)}
                          >
                            {num ? <span {...stylex.props(styles.taskNumber)}>{num}</span> : null}
                            <span {...stylex.props(styles.taskTitle)}>{title}</span>
                            {task.collaborationMode === 'direct' ? (
                              <span {...stylex.props(styles.directModePill)}>
                                {t('projectMode.board.directMode', 'Direct')}
                              </span>
                            ) : null}
                            {showDiff && diff ? (
                              <>
                                {diff.add > 0 ? (
                                  <span {...stylex.props(styles.diffAdd)}>+{diff.add}</span>
                                ) : null}
                                {diff.del > 0 ? (
                                  <span {...stylex.props(styles.diffDel)}>-{diff.del}</span>
                                ) : null}
                              </>
                            ) : null}
                          </button>
                          {prs.map((pr) => {
                            const shortRepo = pr.repoFullName?.split('/')[1] || pr.repoFullName;
                            const numLabel = pr.number !== null ? `#${pr.number}` : 'PR';
                            return (
                              <button
                                key={pr.url}
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  const ownerSid = resolveOwnerSessionForPullRequest(task, pr.url);
                                  if (onOpenPr) {
                                    onOpenPr(ownerSid, pr);
                                  } else {
                                    onOpenTask?.(ownerSid);
                                  }
                                }}
                                {...stylex.props(styles.prChip)}
                              >
                                <GitPullRequest size={11} aria-hidden="true" />
                                <span>
                                  {showRepo && shortRepo ? `${shortRepo} ${numLabel}` : numLabel}
                                </span>
                              </button>
                            );
                          })}
                        </span>
                      );
                    })}
                  </div>
                  {activeSummary ? (
                    <button
                      type="button"
                      onClick={() => setManualExpanded(false)}
                      title={t('projectMode.card.collapseDetails', 'Collapse card')}
                      aria-label={t('projectMode.card.collapseDetails', 'Collapse card')}
                      data-coordinator-card-collapse=""
                      {...stylex.props(styles.expandToggleBtn)}
                    >
                      <ChevronUp size={14} aria-hidden="true" />
                    </button>
                  ) : onDismiss ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleDismissClick();
                      }}
                      title={t('projectMode.card.dismiss', 'Dismiss')}
                      aria-label={t('projectMode.card.dismiss', 'Dismiss')}
                      data-coordinator-card-dismiss=""
                      {...stylex.props(styles.expandToggleBtn)}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>

                <div {...stylex.props(styles.headerText)}>
                  <h4 {...stylex.props(styles.title)}>{card.title}</h4>
                  {card.summary ? <p {...stylex.props(styles.summary)}>{card.summary}</p> : null}
                </div>

                {card.actions.length > 0 ? (
                  <div {...stylex.props(styles.optionsList)} data-coordinator-action-bar="">
                    {card.actions.map((resolved) => {
                      const { spec, liveState, statusBadgeLabel } = resolved;
                      const isBusy = inFlightId === spec.id || liveState === 'running';
                      const isCompleted = liveState === 'completed';
                      const isDisabled = liveState === 'disabled' || !onExecuteAction;
                      const interactive =
                        !isBusy && !isCompleted && !isDisabled && inFlightId === null;
                      const isPrimary = spec.tone === 'primary' && interactive;
                      const defaultIcon =
                        spec.intent.kind === 'session_dispatch'
                          ? 'play'
                          : spec.intent.kind === 'client_command'
                            ? 'check'
                            : 'sparkles';

                      return (
                        <button
                          key={spec.id}
                          type="button"
                          disabled={!interactive}
                          data-coordinator-action-id={spec.id}
                          data-coordinator-action-state={isBusy ? 'running' : liveState}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!interactive) return;
                            handleActionClick(spec);
                          }}
                          {...stylex.props(
                            styles.optionCard,
                            isPrimary && styles.optionCardPrimary,
                            interactive && spec.tone === 'danger' && styles.optionCardDanger,
                            isCompleted && styles.optionCardCompleted,
                            isBusy && styles.optionCardRunning,
                            liveState === 'disabled' && styles.optionCardDisabled
                          )}
                        >
                          <span
                            {...stylex.props(
                              styles.optionLead,
                              isPrimary && styles.optionLeadPrimary,
                              isCompleted && styles.optionLeadCompleted
                            )}
                          >
                            {isBusy ? (
                              <Spinner {...stylex.props(styles.spinner)} />
                            ) : isCompleted ? (
                              <Check
                                size={13}
                                {...stylex.props(styles.iconCompleted)}
                                aria-hidden="true"
                              />
                            ) : (
                              <ActionIcon icon={spec.icon} defaultKind={defaultIcon} />
                            )}
                          </span>
                          <span {...stylex.props(styles.optionBody)}>
                            <span {...stylex.props(styles.optionTitleRow)}>
                              <span {...stylex.props(styles.optionLabel)}>{spec.label}</span>
                              {spec.tone === 'primary' && liveState === 'ready' ? (
                                <span {...stylex.props(styles.recommendedBadge)}>
                                  {t('projectMode.card.recommended', 'Recommended')}
                                </span>
                              ) : null}
                              {statusBadgeLabel ? (
                                <span {...stylex.props(styles.optionStatePill)}>
                                  {statusBadgeLabel}
                                </span>
                              ) : null}
                            </span>
                            {spec.description ? (
                              <span {...stylex.props(styles.optionDescription)}>
                                {spec.description}
                              </span>
                            ) : null}
                          </span>
                          {interactive ? (
                            <span
                              {...stylex.props(
                                styles.optionTrail,
                                isPrimary && styles.optionTrailPrimary
                              )}
                              aria-hidden="true"
                            >
                              <ArrowRight size={14} />
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CoordinatorBubbleActionBar({
  actions,
  onExecuteAction,
}: {
  actions: readonly ResolvedCoordinatorAction[];
  onExecuteAction?: (action: CoordinatorActionSpec) => Promise<void> | void;
}) {
  if (actions.length === 0) return null;
  return (
    <div {...stylex.props(styles.legacyRow)} data-coordinator-action-bar="">
      {actions.map(({ spec, displayLabel }) => (
        <button
          key={spec.id}
          type="button"
          onClick={() => {
            void onExecuteAction?.(spec);
          }}
          {...stylex.props(styles.legacyButton)}
        >
          <span {...stylex.props(styles.labelTruncate)}>{displayLabel}</span>
        </button>
      ))}
    </div>
  );
}

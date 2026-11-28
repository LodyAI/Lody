import * as stylex from '@stylexjs/stylex';
import {
  COORDINATOR_CLIENT_COMMANDS,
  type CoordinatorActionSpec,
  type CoordinatorCardKind,
  type SessionPullRequestView,
} from '@lody/shared';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { conversation } from '@/components/ai-gui/conversation.tokens.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  Play,
  Sparkles,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ResolvedCoordinatorAction,
  ResolvedCoordinatorProactiveCard,
} from './coordinator-action-engine';

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';
const COLLAPSE_EASE = 'cubic-bezier(0.2, 0, 0, 1)';
const REGION_SUBTLE = `color-mix(in oklab, transparent, ${colors.label} 3.5%)`;
const REGION_HOVER = `color-mix(in oklab, transparent, ${colors.label} 7.5%)`;
const ACCENT_TINT = `color-mix(in oklab, transparent, ${colors.accent} 7.5%)`;
const ACCENT_TINT_HOVER = `color-mix(in oklab, transparent, ${colors.accent} 12.5%)`;
const ACCENT_BORDER = `color-mix(in oklab, transparent, ${colors.accent} 32%)`;
const ACCENT_BADGE_BG = `color-mix(in oklab, transparent, ${colors.accent} 14%)`;
const SUCCESS_BADGE_BG = `color-mix(in oklab, transparent, ${colors.success} 14%)`;

const styles = stylex.create({
  outerPresenceGrid: {
    display: 'grid',
    gridTemplateRows: '1fr',
    opacity: 1,
    width: '100%',
    minWidth: 0,
    transitionProperty: 'grid-template-rows, opacity',
    transitionDuration: { default: '200ms', [REDUCED_MOTION]: '0ms' },
    transitionTimingFunction: COLLAPSE_EASE,
  },
  outerPresenceHidden: {
    gridTemplateRows: '0fr',
    opacity: 0,
    pointerEvents: 'none',
  },
  collapseGrid: {
    display: 'grid',
    gridTemplateRows: '0fr',
    opacity: 0,
    transitionProperty: 'grid-template-rows, opacity',
    transitionDuration: { default: '200ms', [REDUCED_MOTION]: '0ms' },
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

  fallbackBubble: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    width: '100%',
    minWidth: 0,
    marginBottom: space[1.5],
    borderRadius: conversation.bubbleRadius,
    backgroundColor: conversation.bubbleFill,
    paddingInline: conversation.bubblePaddingInline,
    paddingBlock: conversation.bubblePaddingBlock,
    color: conversation.reading,
  },
  fallbackTitle: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 600,
    color: colors.label,
  },
  fallbackSummary: {
    margin: 0,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    color: colors.secondaryLabel,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },

  collapsedBar: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    maxWidth: '100%',
    minWidth: 0,
    paddingBlock: 5,
    paddingInline: 10,
    borderRadius: radius.large,
    backgroundColor: REGION_SUBTLE,
  },
  collapsedMain: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
    overflow: 'hidden',
  },
  collapsedStatusIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: colors.success,
  },
  collapsedStatusIconMuted: {
    color: colors.tertiaryLabel,
  },
  collapsedStatusLabel: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    color: colors.secondaryLabel,
    flexShrink: 0,
  },
  collapsedActionTitle: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 600,
    color: colors.label,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
  },
  collapsedActionTitleMuted: {
    fontWeight: 500,
    color: colors.secondaryLabel,
  },
  expandToggleBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 20,
    height: 20,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.tertiaryLabel,
    cursor: 'pointer',
    flexShrink: 0,
  },

  optionsStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    width: '100%',
    minWidth: 0,
  },
  optionsHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    minWidth: 0,
  },
  optionRow: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    width: '100%',
    minWidth: 0,
    paddingBlock: 8,
    paddingInline: 12,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: { default: colors.elevatedBackground, ':hover': REGION_HOVER },
    color: colors.label,
    textAlign: 'left',
    cursor: 'pointer',
    transitionProperty: 'background-color, border-color, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  optionRowPrimary: {
    backgroundColor: { default: ACCENT_TINT, ':hover': ACCENT_TINT_HOVER },
    borderColor: ACCENT_BORDER,
  },
  optionRowDanger: {
    color: colors.destructive,
  },
  optionRowPassive: {
    backgroundColor: { default: REGION_SUBTLE, ':hover': REGION_HOVER },
    borderColor: colors.separator,
    color: colors.secondaryLabel,
  },
  optionRowCompleted: {
    backgroundColor: REGION_SUBTLE,
    borderColor: colors.separator,
    cursor: 'default',
  },
  optionRowRunning: {
    backgroundColor: REGION_SUBTLE,
    borderColor: colors.separator,
    cursor: 'default',
  },
  optionRowDisabled: {
    backgroundColor: REGION_SUBTLE,
    borderColor: 'transparent',
    opacity: 0.58,
    cursor: 'not-allowed',
  },
  optionLead: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: 22,
    height: 22,
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
  optionLeadPassive: {
    backgroundColor: 'transparent',
    color: colors.tertiaryLabel,
  },
  optionBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
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
  optionLabelPassive: {
    color: colors.secondaryLabel,
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

export function shouldCoordinatorActionCollapseCard(
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

/**
 * Equal-hierarchy option list shared by inline coordinator bubbles and the
 * Header "Needs Your Input" Dynamic Island. Positive and negative/defer choices
 * sit on the exact same visual level instead of hiding dismissal behind a tiny ×.
 */
export function CoordinatorDecisionOptionsList({
  actions,
  inFlightId,
  onSelectAction,
  onSkipForNow,
}: {
  actions: readonly ResolvedCoordinatorAction[];
  inFlightId?: string | null;
  onSelectAction?: (action: CoordinatorActionSpec) => void;
  onSkipForNow?: () => void;
}) {
  const { t } = useTranslation();
  const busyAny = Boolean(inFlightId);

  return (
    <div {...stylex.props(styles.optionsStack)} data-coordinator-action-bar="">
      {actions.map((resolved) => {
        const { spec, liveState, statusBadgeLabel } = resolved;
        const isBusy = inFlightId === spec.id || liveState === 'running';
        const isCompleted = liveState === 'completed';
        const isDisabled = liveState === 'disabled' || !onSelectAction;
        const interactive = !isBusy && !isCompleted && !isDisabled && !busyAny;
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
              onSelectAction(spec);
            }}
            {...stylex.props(
              styles.optionRow,
              isPrimary && styles.optionRowPrimary,
              interactive && spec.tone === 'danger' && styles.optionRowDanger,
              isCompleted && styles.optionRowCompleted,
              isBusy && styles.optionRowRunning,
              liveState === 'disabled' && styles.optionRowDisabled
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
                <Check size={13} {...stylex.props(styles.iconCompleted)} aria-hidden="true" />
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
                  <span {...stylex.props(styles.optionStatePill)}>{statusBadgeLabel}</span>
                ) : null}
              </span>
              {spec.description ? (
                <span {...stylex.props(styles.optionDescription)}>{spec.description}</span>
              ) : null}
            </span>
            {interactive ? (
              <span
                {...stylex.props(styles.optionTrail, isPrimary && styles.optionTrailPrimary)}
                aria-hidden="true"
              >
                <ArrowRight size={14} />
              </span>
            ) : null}
          </button>
        );
      })}
      {onSkipForNow ? (
        <button
          type="button"
          disabled={busyAny}
          data-coordinator-card-dismiss=""
          onClick={(event) => {
            event.stopPropagation();
            if (busyAny) return;
            onSkipForNow();
          }}
          {...stylex.props(styles.optionRow, styles.optionRowPassive)}
        >
          <span {...stylex.props(styles.optionLead, styles.optionLeadPassive)}>
            <Clock size={13} {...stylex.props(styles.iconSlot)} aria-hidden="true" />
          </span>
          <span {...stylex.props(styles.optionBody)}>
            <span {...stylex.props(styles.optionTitleRow)}>
              <span {...stylex.props(styles.optionLabel, styles.optionLabelPassive)}>
                {t('projectMode.card.skipForNow', 'Not now')}
              </span>
            </span>
          </span>
        </button>
      ) : null}
    </div>
  );
}

/**
 * Bubble-aligned equal-hierarchy decision options beneath a coordinator bubble.
 * Never repeats the bubble's title, summary, or task/PR chips when attached to a
 * bubble (`hasBubbleBody`), and collapses into a compact 1-line receipt once settled.
 */
export function CoordinatorProactiveCard({
  card,
  hasBubbleBody = true,
  superseded = false,
  onExecuteAction,
  onDismiss,
}: {
  card: ResolvedCoordinatorProactiveCard;
  hasBubbleBody?: boolean;
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

  const isCardDismissed = Boolean(card.isDismissed || optimisticDismissed);

  const activeSummary = (() => {
    if (optimisticChoice?.kind === 'action') {
      const matched = card.actions.find((item) => item.spec.id === optimisticChoice.spec.id);
      const isSending = optimisticChoice.phase === 'sending';
      const isRunning = !isSending && matched?.liveState === 'running';
      return {
        isBusy: isSending || isRunning,
        isMuted: false,
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
        isMuted: false,
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
        isMuted: false,
        statusLabel: t('projectMode.card.statusFeedbackSent', 'Replied'),
        actionTitle: card.customFeedbackSummary,
      };
    }
    if (isCardDismissed) {
      return {
        isBusy: false,
        isMuted: true,
        statusLabel: t('projectMode.card.statusSkipped', 'Skipped'),
        actionTitle: t('projectMode.card.skipForNow', 'Not now'),
      };
    }
    return null;
  })();

  const shouldHideCard = superseded && activeSummary === null;
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
    const collapses = shouldCoordinatorActionCollapseCard(spec, card.kind);
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
    setManualExpanded(false);
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
        {!hasBubbleBody ? (
          <div {...stylex.props(styles.fallbackBubble)}>
            <h4 {...stylex.props(styles.fallbackTitle)}>{card.title}</h4>
            {card.summary ? <p {...stylex.props(styles.fallbackSummary)}>{card.summary}</p> : null}
          </div>
        ) : null}

        <div
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
                        styles.collapsedStatusIcon,
                        activeSummary.isMuted && styles.collapsedStatusIconMuted
                      )}
                    >
                      {activeSummary.isBusy ? (
                        <Spinner {...stylex.props(styles.spinner)} />
                      ) : activeSummary.isMuted ? (
                        <Clock size={12} {...stylex.props(styles.iconSlot)} aria-hidden="true" />
                      ) : (
                        <Check size={12} {...stylex.props(styles.iconSlot)} aria-hidden="true" />
                      )}
                    </span>
                    <span {...stylex.props(styles.collapsedStatusLabel)}>
                      {activeSummary.statusLabel}
                    </span>
                    {!activeSummary.isMuted ? (
                      <span
                        title={activeSummary.actionTitle}
                        {...stylex.props(
                          styles.collapsedActionTitle,
                          activeSummary.isMuted && styles.collapsedActionTitleMuted
                        )}
                      >
                        {activeSummary.actionTitle}
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setManualExpanded(true)}
                    title={t('projectMode.card.expandDetails', 'Show options')}
                    aria-label={t('projectMode.card.expandDetails', 'Show options')}
                    data-coordinator-card-expand=""
                    {...stylex.props(styles.expandToggleBtn)}
                  >
                    <ChevronDown size={13} aria-hidden="true" />
                  </button>
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
              {activeSummary ? (
                <div {...stylex.props(styles.optionsHeaderRow)}>
                  <button
                    type="button"
                    onClick={() => setManualExpanded(false)}
                    title={t('projectMode.card.collapseDetails', 'Collapse options')}
                    aria-label={t('projectMode.card.collapseDetails', 'Collapse options')}
                    data-coordinator-card-collapse=""
                    {...stylex.props(styles.expandToggleBtn)}
                  >
                    <ChevronUp size={13} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              <CoordinatorDecisionOptionsList
                actions={card.actions}
                inFlightId={inFlightId}
                onSelectAction={onExecuteAction ? handleActionClick : undefined}
                onSkipForNow={activeSummary === null && onDismiss ? handleDismissClick : undefined}
              />
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

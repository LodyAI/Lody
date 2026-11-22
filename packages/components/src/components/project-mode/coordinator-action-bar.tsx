import * as stylex from '@stylexjs/stylex';
import {
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
  ArrowUp,
  Check,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  MessageSquarePlus,
  Play,
  Sparkles,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import type {
  ResolvedCoordinatorAction,
  ResolvedCoordinatorProactiveCard,
} from './coordinator-action-engine';
import { formatTaskNumber } from './project-board';

const REGION_SUBTLE = `color-mix(in oklab, transparent, ${colors.label} 3.5%)`;
const REGION_HOVER = `color-mix(in oklab, transparent, ${colors.label} 7%)`;
const ACCENT_TINT = `color-mix(in oklab, transparent, ${colors.accent} 8%)`;
const ACCENT_TINT_HOVER = `color-mix(in oklab, transparent, ${colors.accent} 13%)`;
const ACCENT_BORDER = `color-mix(in oklab, transparent, ${colors.accent} 32%)`;
const ACCENT_BADGE_BG = `color-mix(in oklab, transparent, ${colors.accent} 14%)`;
const WARNING_BADGE_BG = `color-mix(in oklab, transparent, ${colors.warning} 15%)`;
const SUCCESS_BADGE_BG = `color-mix(in oklab, transparent, ${colors.success} 14%)`;

const styles = stylex.create({
  card: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    width: '100%',
    maxWidth: 640,
    minWidth: 0,
    padding: space[3],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    color: colors.label,
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

  feedbackSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
    paddingTop: 2,
    minWidth: 0,
  },
  feedbackSubmittedRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    paddingBlock: 6,
    paddingInline: space[2],
    borderRadius: radius.medium,
    backgroundColor: REGION_SUBTLE,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  feedbackSubmittedText: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  feedbackTrigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    alignSelf: 'flex-start',
    height: 26,
    paddingBlock: 0,
    paddingInline: space[2],
    borderWidth: 0,
    borderRadius: radius.medium,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    cursor: 'pointer',
  },
  feedbackComposer: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    padding: 4,
    paddingLeft: space[2],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    borderRadius: radius.medium,
    backgroundColor: colors.background,
  },
  feedbackInput: {
    flex: 1,
    minWidth: 0,
    height: 28,
    padding: 0,
    borderWidth: 0,
    outlineStyle: 'none',
    backgroundColor: 'transparent',
    color: colors.label,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
  },
  feedbackSendBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: colors.accent,
    color: colors.onAccent,
    cursor: 'pointer',
    flexShrink: 0,
  },
  feedbackSendBtnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  feedbackCancelBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.tertiaryLabel,
    cursor: 'pointer',
    flexShrink: 0,
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
    width: 13,
    height: 13,
    flexShrink: 0,
  },
});

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
 * decision options, live child-task/diff/PR pills, and an inline custom-feedback
 * composer so the user rarely needs to open child conversations.
 */
export function CoordinatorProactiveCard({
  card,
  onExecuteAction,
  onSubmitFeedback,
  onOpenTask,
  onOpenPr,
}: {
  card: ResolvedCoordinatorProactiveCard;
  onExecuteAction?: (action: CoordinatorActionSpec) => Promise<void> | void;
  onSubmitFeedback?: (feedback: string) => Promise<boolean> | boolean;
  onOpenTask?: (sessionId: string) => void;
  onOpenPr?: (sessionId: string, pr: SessionPullRequestView) => void;
}) {
  const { t } = useTranslation();
  const [inFlightId, setInFlightId] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSendFeedback = async () => {
    const trimmed = feedbackText.trim();
    if (!trimmed || !onSubmitFeedback || submittingFeedback) return;
    setSubmittingFeedback(true);
    try {
      const ok = await onSubmitFeedback(trimmed);
      if (ok !== false) {
        setFeedbackText('');
        setFeedbackOpen(false);
      }
    } finally {
      setSubmittingFeedback(false);
    }
  };

  return (
    <div {...stylex.props(styles.card)} data-coordinator-proactive-card="">
      <div {...stylex.props(styles.metaRow)}>
        <div {...stylex.props(styles.metaLeft)}>
          <CardKindBadge kind={card.kind} />
          {card.linkedTasks.map((task) => {
            const num = formatTaskNumber(task.taskNumber);
            const title =
              task.session.title?.trim() || t('sessions.untitled', 'Untitled session');
            const diff = task.session.diffStats?.allChange;
            const showDiff = hasWorkspaceChanges(diff);
            const pr = task.pullRequest;
            return (
              <span key={task.session.id} {...stylex.props(styles.taskChipGroup)}>
                <button
                  type="button"
                  title={title}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenTask?.(task.session.id);
                  }}
                  {...stylex.props(styles.taskChip)}
                >
                  {num ? <span {...stylex.props(styles.taskNumber)}>{num}</span> : null}
                  <span {...stylex.props(styles.taskTitle)}>{title}</span>
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
                {pr ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (onOpenPr) {
                        onOpenPr(task.session.id, pr);
                      } else {
                        onOpenTask?.(task.session.id);
                      }
                    }}
                    {...stylex.props(styles.prChip)}
                  >
                    <GitPullRequest size={11} aria-hidden="true" />
                    <span>{pr.number !== null ? `#${pr.number}` : 'PR'}</span>
                  </button>
                ) : null}
              </span>
            );
          })}
        </div>
      </div>

      <div {...stylex.props(styles.headerText)}>
        <h4 {...stylex.props(styles.title)}>{card.title}</h4>
        {card.summary ? <p {...stylex.props(styles.summary)}>{card.summary}</p> : null}
      </div>

      {card.actions.length > 0 ? (
        <div {...stylex.props(styles.optionsList)} data-coordinator-action-bar="">
          {card.actions.map((resolved) => {
            const { spec, liveState, displayLabel } = resolved;
            const isBusy = inFlightId === spec.id || liveState === 'running';
            const isCompleted = liveState === 'completed';
            const isDisabled = liveState === 'disabled' || !onExecuteAction;
            const interactive =
              !isBusy && !isCompleted && !isDisabled && inFlightId === null && !submittingFeedback;
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
                  if (!interactive || !onExecuteAction) return;
                  setInFlightId(spec.id);
                  Promise.resolve(onExecuteAction(spec))
                    .catch(() => {})
                    .finally(() => {
                      setInFlightId((prev) => (prev === spec.id ? null : prev));
                    });
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
                    <Check size={13} {...stylex.props(styles.iconCompleted)} aria-hidden="true" />
                  ) : (
                    <ActionIcon icon={spec.icon} defaultKind={defaultIcon} />
                  )}
                </span>
                <span {...stylex.props(styles.optionBody)}>
                  <span {...stylex.props(styles.optionTitleRow)}>
                    <span {...stylex.props(styles.optionLabel)}>{displayLabel}</span>
                    {spec.tone === 'primary' && liveState === 'ready' ? (
                      <span {...stylex.props(styles.recommendedBadge)}>
                        {t('projectMode.card.recommended', 'Recommended')}
                      </span>
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
        </div>
      ) : null}

      {onSubmitFeedback || card.customFeedbackSummary ? (
        <div {...stylex.props(styles.feedbackSection)}>
          {card.customFeedbackSummary && !feedbackOpen ? (
            <div {...stylex.props(styles.feedbackSubmittedRow)}>
              <span {...stylex.props(styles.feedbackSubmittedText)}>
                <Check size={13} {...stylex.props(styles.iconCompleted)} aria-hidden="true" />
                <span>
                  {t('projectMode.card.feedbackSent', 'Sent feedback: {{text}}', {
                    text: card.customFeedbackSummary,
                  })}
                </span>
              </span>
              {onSubmitFeedback ? (
                <button
                  type="button"
                  onClick={() => {
                    setFeedbackOpen(true);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                  {...stylex.props(styles.feedbackTrigger)}
                >
                  {t('projectMode.card.addMoreFeedback', 'Add more…')}
                </button>
              ) : null}
            </div>
          ) : feedbackOpen ? (
            <div {...stylex.props(styles.feedbackComposer)}>
              <input
                ref={inputRef}
                type="text"
                value={feedbackText}
                disabled={submittingFeedback}
                placeholder={t(
                  'projectMode.card.feedbackPlaceholder',
                  'Describe other instructions or adjustments…'
                )}
                onChange={(event) => setFeedbackText(event.target.value)}
                onKeyDown={(event) => {
                  if (isImeComposingKeyboardEvent(event)) return;
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void handleSendFeedback();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setFeedbackOpen(false);
                  }
                }}
                data-coordinator-card-feedback-input=""
                {...stylex.props(styles.feedbackInput)}
              />
              <button
                type="button"
                onClick={() => setFeedbackOpen(false)}
                disabled={submittingFeedback}
                aria-label={t('common.cancel', 'Cancel')}
                {...stylex.props(styles.feedbackCancelBtn)}
              >
                <X size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled={!feedbackText.trim() || submittingFeedback}
                onClick={() => {
                  void handleSendFeedback();
                }}
                aria-label={t('projectMode.card.sendFeedback', 'Send feedback')}
                data-coordinator-card-feedback-send=""
                {...stylex.props(
                  styles.feedbackSendBtn,
                  (!feedbackText.trim() || submittingFeedback) && styles.feedbackSendBtnDisabled
                )}
              >
                {submittingFeedback ? (
                  <Spinner {...stylex.props(styles.spinner)} />
                ) : (
                  <ArrowUp size={14} aria-hidden="true" />
                )}
              </button>
            </div>
          ) : onSubmitFeedback ? (
            <button
              type="button"
              onClick={() => {
                setFeedbackOpen(true);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
              data-coordinator-card-feedback-toggle=""
              {...stylex.props(styles.feedbackTrigger)}
            >
              <MessageSquarePlus size={13} aria-hidden="true" />
              <span>{t('projectMode.card.otherFeedback', 'Give other feedback…')}</span>
            </button>
          ) : null}
        </div>
      ) : null}
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

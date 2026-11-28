import * as stylex from '@stylexjs/stylex';
import type {
  CoordinatorActionSpec,
  SessionHistory,
  SessionHistoryParsed,
  SessionId,
} from '@lody/shared';
import { Spinner } from '@lody/ui/spinner';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import {
  ArrowUp,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  Inbox,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import {
  buildSupersededCoordinatorCardKeys,
  collectPendingCoordinatorDecisions,
  streamItemsFromCoordinatorHistory,
  type PendingCoordinatorDecisionItem,
} from './coordinator-action-engine';
import { CoordinatorDecisionOptionsList } from './coordinator-action-bar';
import { useCoordinatorConversation } from './coordinator-conversation';
import { formatTaskNumber } from './project-board';

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';
const ISLAND_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const ACCENT_SOFT = `color-mix(in oklab, transparent, ${colors.accent} 12%)`;
const ACCENT_BORDER = `color-mix(in oklab, transparent, ${colors.accent} 38%)`;
const WARNING_SOFT = `color-mix(in oklab, transparent, ${colors.warning} 16%)`;
const WARNING_BORDER = `color-mix(in oklab, transparent, ${colors.warning} 42%)`;
const QUOTE_BG = `color-mix(in oklab, transparent, ${colors.label} 4%)`;
const FROSTED_BG = `color-mix(in oklab, ${colors.elevatedBackground} 92%, transparent)`;

const pulseDot = stylex.keyframes({
  '0%, 100%': { opacity: 1, transform: 'scale(1)' },
  '50%': { opacity: 0.45, transform: 'scale(0.84)' },
});

const styles = stylex.create({
  headerBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 28,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    borderRadius: radius.full,
    backgroundColor: { default: colors.elevatedBackground, ':hover': colors.hoverFill },
    color: colors.label,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    cursor: 'pointer',
    flexShrink: 0,
    transitionProperty: 'background-color, border-color, color',
    transitionDuration: '140ms',
  },
  headerBtnNeedsYou: {
    borderColor: WARNING_BORDER,
    backgroundColor: { default: WARNING_SOFT, ':hover': WARNING_SOFT },
  },
  headerBtnOpen: {
    borderColor: ACCENT_BORDER,
    backgroundColor: { default: ACCENT_SOFT, ':hover': ACCENT_SOFT },
  },
  headerDot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
    backgroundColor: colors.warning,
    flexShrink: 0,
    animationName: pulseDot,
    animationDuration: '1.8s',
    animationIterationCount: 'infinite',
    [REDUCED_MOTION]: {
      animationPlayState: 'paused',
    },
  },
  headerCount: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 18,
    height: 18,
    paddingInline: 5,
    borderRadius: radius.full,
    backgroundColor: colors.wellBackground,
    color: colors.secondaryLabel,
    fontSize: '11px',
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
  },
  headerCountActive: {
    backgroundColor: colors.warning,
    color: '#ffffff',
  },

  anchorOverlay: {
    position: 'absolute',
    top: 10,
    left: 0,
    right: 0,
    zIndex: 25,
    display: 'flex',
    justifyContent: 'center',
    paddingInline: space[3],
    pointerEvents: 'none',
  },
  islandCard: {
    pointerEvents: 'auto',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    width: '100%',
    maxWidth: 560,
    minWidth: 0,
    padding: space[3],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    borderRadius: 22,
    cornerShape: corner.shape,
    backgroundColor: FROSTED_BG,
    backdropFilter: 'blur(20px) saturate(1.4)',
    WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
    boxShadow: shadow.popover,
    color: colors.label,
    transformOrigin: 'top center',
    transitionProperty: 'opacity, transform',
    transitionDuration: { default: '200ms', [REDUCED_MOTION]: '0ms' },
    transitionTimingFunction: ISLAND_EASE,
  },

  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    minWidth: 0,
  },
  pagerGroup: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    minWidth: 0,
  },
  navBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    padding: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    borderRadius: radius.full,
    backgroundColor: { default: colors.elevatedBackground, ':hover': colors.hoverFill },
    color: colors.label,
    cursor: 'pointer',
    flexShrink: 0,
    ':disabled': {
      opacity: 0.4,
      cursor: 'not-allowed',
    },
  },
  counterPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 24,
    paddingInline: 9,
    borderRadius: radius.full,
    backgroundColor: colors.wellBackground,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    color: colors.label,
    flexShrink: 0,
  },
  taskBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    maxWidth: 190,
    height: 22,
    paddingInline: 8,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: colors.wellBackground, ':hover': colors.hoverFill },
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    cursor: 'pointer',
    minWidth: 0,
  },
  taskNum: {
    fontWeight: 600,
    color: colors.label,
    flexShrink: 0,
  },
  taskTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  topRight: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
  },
  jumpBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 26,
    paddingInline: 8,
    borderWidth: 0,
    borderRadius: radius.medium,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    cursor: 'pointer',
  },
  closeBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.tertiaryLabel,
    cursor: 'pointer',
  },

  bubbleQuoteBox: {
    boxSizing: 'border-box',
    maxHeight: 156,
    overflowY: 'auto',
    paddingBlock: space[2],
    paddingInline: space[3],
    borderRadius: radius.large,
    backgroundColor: QUOTE_BG,
    borderInlineStartWidth: 3,
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: ACCENT_BORDER,
    minWidth: 0,
  },

  composerRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: space[1.5],
    paddingTop: 2,
    minWidth: 0,
  },
  composerField: {
    boxSizing: 'border-box',
    flex: 1,
    minWidth: 0,
    minHeight: 36,
    maxHeight: 96,
    resize: 'none',
    paddingBlock: 8,
    paddingInline: 12,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: { default: colors.separator, ':focus': ACCENT_BORDER },
    borderRadius: radius.large,
    backgroundColor: colors.elevatedBackground,
    color: colors.label,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontFamily: 'inherit',
    outline: 'none',
    transitionProperty: 'border-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
    '::placeholder': {
      color: colors.tertiaryLabel,
    },
  },
  sendBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
    height: 34,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    color: '#ffffff',
    cursor: 'pointer',
    flexShrink: 0,
    transitionProperty: 'opacity, transform',
    transitionDuration: duration.fast,
    ':disabled': {
      opacity: 0.4,
      cursor: 'not-allowed',
    },
  },
  spinner: {
    width: 14,
    height: 14,
  },

  emptyStateRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingBlock: space[1],
    paddingInline: space[1],
    color: colors.secondaryLabel,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
  },
  emptyIcon: {
    color: colors.success,
    flexShrink: 0,
  },
});

export type CoordinatorNeedsYouController = {
  readonly isOpen: boolean;
  readonly pendingItems: readonly PendingCoordinatorDecisionItem[];
  readonly activeIndex: number;
  readonly activeItem: PendingCoordinatorDecisionItem | null;
  readonly toggle: () => void;
  readonly close: () => void;
  readonly goPrev: () => void;
  readonly goNext: () => void;
};

export function useCoordinatorNeedsYouController(options: {
  enabled: boolean;
  sessionId: SessionId;
  history: readonly (SessionHistory | SessionHistoryParsed)[];
  hasPendingLocalUserMessage?: boolean;
}): CoordinatorNeedsYouController {
  const { enabled, sessionId, history, hasPendingLocalUserMessage = false } = options;
  const { t } = useTranslation();
  const coordinator = useCoordinatorConversation();
  const [isOpen, setIsOpen] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const prevCountRef = useRef(0);

  const pendingItems = useMemo<PendingCoordinatorDecisionItem[]>(() => {
    if (!enabled || !coordinator) return [];
    const streamItems = streamItemsFromCoordinatorHistory(sessionId, history);
    const superseded = buildSupersededCoordinatorCardKeys({
      items: streamItems,
      tasksById: coordinator.tasks,
      hasPendingLocalUserMessage,
    });
    return collectPendingCoordinatorDecisions({
      items: streamItems,
      supersededCardKeys: superseded,
      tasksById: coordinator.tasks,
      supportedCommands: coordinator.supportedActionCommands,
      activeThreadRootId: coordinator.activeThreadRootId,
      translate: (key, fallback, opts) =>
        String(t(key as never, { defaultValue: fallback, ...opts } as never)),
    });
  }, [coordinator, enabled, hasPendingLocalUserMessage, history, sessionId, t]);

  useEffect(() => {
    setIsOpen(false);
    setActiveKey(null);
    prevCountRef.current = 0;
  }, [sessionId]);

  useEffect(() => {
    if (prevCountRef.current > 0 && pendingItems.length === 0 && isOpen) {
      setIsOpen(false);
    }
    prevCountRef.current = pendingItems.length;
  }, [isOpen, pendingItems.length]);

  const activeIndex = useMemo(() => {
    if (pendingItems.length === 0) return 0;
    if (activeKey) {
      const idx = pendingItems.findIndex((item) => item.key === activeKey);
      if (idx >= 0) return idx;
    }
    return 0;
  }, [activeKey, pendingItems]);

  const activeItem = pendingItems[activeIndex] ?? null;

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const goPrev = useCallback(() => {
    if (pendingItems.length <= 1) return;
    const prevIdx = (activeIndex - 1 + pendingItems.length) % pendingItems.length;
    setActiveKey(pendingItems[prevIdx]?.key ?? null);
  }, [activeIndex, pendingItems]);

  const goNext = useCallback(() => {
    if (pendingItems.length <= 1) return;
    const nextIdx = (activeIndex + 1) % pendingItems.length;
    setActiveKey(pendingItems[nextIdx]?.key ?? null);
  }, [activeIndex, pendingItems]);

  return {
    isOpen,
    pendingItems,
    activeIndex,
    activeItem,
    toggle,
    close,
    goPrev,
    goNext,
  };
}

export function CoordinatorNeedsYouHeaderButton({
  controller,
}: {
  controller: CoordinatorNeedsYouController;
}) {
  const { t } = useTranslation();
  const count = controller.pendingItems.length;
  const hasPending = count > 0;

  return (
    <button
      type="button"
      onClick={controller.toggle}
      aria-expanded={controller.isOpen}
      data-coordinator-needs-you-btn=""
      {...stylex.props(
        styles.headerBtn,
        hasPending && styles.headerBtnNeedsYou,
        controller.isOpen && styles.headerBtnOpen
      )}
    >
      {hasPending ? (
        <span {...stylex.props(styles.headerDot)} aria-hidden="true" />
      ) : (
        <Inbox size={13} aria-hidden="true" />
      )}
      <span>{t('projectMode.needsYouIsland.button', 'Needs your input')}</span>
      <span {...stylex.props(styles.headerCount, hasPending && styles.headerCountActive)}>
        {count}
      </span>
    </button>
  );
}

export function CoordinatorNeedsYouIslandBanner({
  controller,
  onJumpToTurn,
}: {
  controller: CoordinatorNeedsYouController;
  onJumpToTurn?: (turnId: string) => void;
}) {
  const { t } = useTranslation();
  const coordinator = useCoordinatorConversation();
  const [inFlightActionId, setInFlightActionId] = useState<string | null>(null);
  const [draftByKey, setDraftByKey] = useState<Record<string, string>>({});
  const [isSubmittingReply, setIsSubmittingReply] = useState(false);

  const { isOpen, pendingItems, activeIndex, activeItem, close, goPrev, goNext } = controller;

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, isOpen]);

  if (!isOpen) return null;

  const currentDraft = activeItem ? (draftByKey[activeItem.key] ?? '') : '';

  const advanceBeforeResolve = () => {
    if (pendingItems.length <= 1) return;
    const nextIdx = activeIndex + 1 < pendingItems.length ? activeIndex + 1 : activeIndex - 1;
    const nextCandidate = pendingItems[nextIdx];
    if (nextCandidate) {
      if (nextIdx > activeIndex) goNext();
      else goPrev();
    }
  };

  const handleSelectAction = (action: CoordinatorActionSpec) => {
    if (!activeItem || !coordinator?.onExecuteBubbleAction) return;
    setInFlightActionId(action.id);
    Promise.resolve(
      coordinator.onExecuteBubbleAction({
        turnId: activeItem.turnId,
        bubbleId: activeItem.bubbleId,
        bubbleBody: activeItem.bubbleBody,
        bubbleReplyTo: activeItem.bubbleReplyTo,
        activeThreadRootId: coordinator.activeThreadRootId,
        cardKind: activeItem.card.kind,
        action,
      })
    )
      .then(() => {
        advanceBeforeResolve();
      })
      .finally(() => {
        setInFlightActionId((prev) => (prev === action.id ? null : prev));
      });
  };

  const handleSkipForNow = () => {
    if (!activeItem || !coordinator?.onDismissBubbleCard) return;
    setInFlightActionId('__dismiss__');
    Promise.resolve(
      coordinator.onDismissBubbleCard({
        turnId: activeItem.turnId,
        bubbleId: activeItem.bubbleId,
      })
    )
      .then(() => {
        advanceBeforeResolve();
      })
      .finally(() => {
        setInFlightActionId((prev) => (prev === '__dismiss__' ? null : prev));
      });
  };

  const handleSubmitCustomReply = async () => {
    if (!activeItem || !coordinator?.onSubmitCardFeedback) return;
    const trimmed = currentDraft.trim();
    if (!trimmed || isSubmittingReply) return;
    setIsSubmittingReply(true);
    try {
      const ok = await coordinator.onSubmitCardFeedback({
        turnId: activeItem.turnId,
        bubbleId: activeItem.bubbleId,
        cardTitle: activeItem.card.title,
        bubbleBody: activeItem.bubbleBody,
        bubbleReplyTo: activeItem.bubbleReplyTo,
        activeThreadRootId: coordinator.activeThreadRootId,
        feedback: trimmed,
      });
      if (ok) {
        setDraftByKey((prev) => {
          const next = { ...prev };
          delete next[activeItem.key];
          return next;
        });
        advanceBeforeResolve();
      }
    } finally {
      setIsSubmittingReply(false);
    }
  };

  const primaryTask = activeItem?.card.linkedTasks[0];
  const primaryTaskNumber = primaryTask ? formatTaskNumber(primaryTask.taskNumber) : null;
  const primaryTaskTitle =
    primaryTask?.workItemTitle?.trim() || primaryTask?.session?.title?.trim() || null;

  return (
    <div {...stylex.props(styles.anchorOverlay)} data-coordinator-needs-you-island="">
      <div
        role="dialog"
        aria-label={t('projectMode.needsYouIsland.button', 'Needs your input')}
        {...stylex.props(styles.islandCard)}
      >
        <div {...stylex.props(styles.topBar)}>
          <div {...stylex.props(styles.pagerGroup)}>
            {pendingItems.length > 0 ? (
              <>
                <button
                  type="button"
                  disabled={pendingItems.length <= 1}
                  onClick={goPrev}
                  title={t('projectMode.needsYouIsland.prev', 'Previous')}
                  aria-label={t('projectMode.needsYouIsland.prev', 'Previous')}
                  {...stylex.props(styles.navBtn)}
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                </button>
                <span {...stylex.props(styles.counterPill)}>
                  {activeIndex + 1} / {pendingItems.length}
                </span>
                <button
                  type="button"
                  disabled={pendingItems.length <= 1}
                  onClick={goNext}
                  title={t('projectMode.needsYouIsland.next', 'Next')}
                  aria-label={t('projectMode.needsYouIsland.next', 'Next')}
                  {...stylex.props(styles.navBtn)}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
                {primaryTask && (primaryTaskNumber || primaryTaskTitle) ? (
                  <button
                    type="button"
                    title={primaryTaskTitle ?? undefined}
                    onClick={() => {
                      if (primaryTask.session) coordinator?.openTask(primaryTask.session.id);
                    }}
                    {...stylex.props(styles.taskBadge)}
                  >
                    {primaryTaskNumber ? (
                      <span {...stylex.props(styles.taskNum)}>{primaryTaskNumber}</span>
                    ) : null}
                    {primaryTaskTitle ? (
                      <span {...stylex.props(styles.taskTitle)}>{primaryTaskTitle}</span>
                    ) : null}
                  </button>
                ) : null}
              </>
            ) : (
              <span {...stylex.props(styles.counterPill)}>
                {t('projectMode.needsYouIsland.button', 'Needs your input')}
              </span>
            )}
          </div>

          <div {...stylex.props(styles.topRight)}>
            {activeItem && onJumpToTurn ? (
              <button
                type="button"
                onClick={() => onJumpToTurn(activeItem.turnId)}
                {...stylex.props(styles.jumpBtn)}
              >
                <CornerDownRight size={13} aria-hidden="true" />
                <span>{t('projectMode.needsYouIsland.jumpToMessage', 'Jump to message')}</span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={close}
              title={t('common.close', 'Close')}
              aria-label={t('common.close', 'Close')}
              {...stylex.props(styles.closeBtn)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </div>

        {!activeItem ? (
          <div {...stylex.props(styles.emptyStateRow)}>
            <CheckCircle2 size={16} {...stylex.props(styles.emptyIcon)} aria-hidden="true" />
            <span>
              {t(
                'projectMode.needsYouIsland.empty',
                'All caught up — nothing needs your decision right now.'
              )}
            </span>
          </div>
        ) : (
          <>
            <div {...stylex.props(styles.bubbleQuoteBox)} data-coordinator-island-quote="">
              <MarkdownRenderer text={activeItem.bubbleBody} size="sm" isStreaming={false} flush />
            </div>

            <CoordinatorDecisionOptionsList
              actions={activeItem.card.actions}
              inFlightId={inFlightActionId}
              onSelectAction={coordinator?.onExecuteBubbleAction ? handleSelectAction : undefined}
              onSkipForNow={coordinator?.onDismissBubbleCard ? handleSkipForNow : undefined}
            />

            <div {...stylex.props(styles.composerRow)}>
              <textarea
                rows={1}
                value={currentDraft}
                disabled={isSubmittingReply || Boolean(inFlightActionId)}
                placeholder={t(
                  'projectMode.needsYouIsland.inputPlaceholder',
                  'None of these? Type your own reply to this message…'
                )}
                onChange={(event) => {
                  const val = event.target.value;
                  setDraftByKey((prev) => ({ ...prev, [activeItem.key]: val }));
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !isImeComposingKeyboardEvent(event)
                  ) {
                    event.preventDefault();
                    void handleSubmitCustomReply();
                  }
                }}
                {...stylex.props(styles.composerField)}
              />
              <button
                type="button"
                disabled={!currentDraft.trim() || isSubmittingReply || Boolean(inFlightActionId)}
                onClick={() => void handleSubmitCustomReply()}
                title={t('projectMode.needsYouIsland.sendReply', 'Send reply')}
                aria-label={t('projectMode.needsYouIsland.sendReply', 'Send reply')}
                {...stylex.props(styles.sendBtn)}
              >
                {isSubmittingReply ? (
                  <Spinner {...stylex.props(styles.spinner)} />
                ) : (
                  <ArrowUp size={15} aria-hidden="true" />
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

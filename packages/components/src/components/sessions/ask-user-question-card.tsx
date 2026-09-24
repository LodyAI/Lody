import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ArrowUp, Check, ChevronLeft, ChevronRight, Clock3, Info, X } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import {
  getAskUserQuestionAnswerKey,
  type AskUserQuestion,
  type AskUserQuestionAnswerValue,
  type AskUserQuestionAnswers,
  type AskUserQuestionOption,
  type AskUserQuestionPermissionMeta,
  getServerNow,
} from '@lody/shared';

import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Textarea } from '@lody/ui/textarea';
import { Dialog } from '@/ui/dialog';
import { Tooltip } from '@lody/ui/tooltip';
import { colors, shadow, sheen } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { withClassName } from '@/lib/stylex';

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';
const RING = `0 0 0 2px ${colors.accent}`;
const REGION = `color-mix(in oklab, transparent, ${colors.label} 3%)`;

/** The card arrives from a hair below, the way a new block enters the conversation. */
const cardIn = stylex.keyframes({
  from: { opacity: 0, transform: 'translateY(8px)' },
  to: { opacity: 1, transform: 'none' },
});

const styles = stylex.create({
  // The card rung: it lifts off the conversation by its shadow, with no edge and
  // no bands inside it — the question, the choices and the answers are set apart
  // by space alone.
  card: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    minWidth: 0,
    padding: space[3],
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    borderRadius: radius.large,
    cornerShape: corner.shape,
    color: colors.label,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    touchAction: 'pan-y',
    animationName: { default: cardIn, [REDUCED_MOTION]: 'none' },
    animationDuration: duration.slow,
    animationTimingFunction: ease.standard,
  },

  header: { display: 'flex', alignItems: 'flex-start', gap: space[2], minWidth: 0 },
  question: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    fontWeight: 600,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  // Everything beside the question sits on its first line, however many it wraps to.
  headerMeta: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[2],
    height: text.bodyLeading,
  },
  count: {
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
    color: colors.tertiaryLabel,
  },
  countdown: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.tertiaryLabel,
  },
  glyph12: { display: 'block', flexShrink: 0, width: '12px', height: '12px' },
  glyph14: { display: 'block', flexShrink: 0, width: '14px', height: '14px' },
  glyph16: { display: 'block', flexShrink: 0, width: '16px', height: '16px' },
  glyphFill: { display: 'block', width: '100%', height: '100%' },
  // A 24px icon button on a 20px line: it overhangs the line rather than growing it.
  lineButton: { flexShrink: 0, marginBlock: '-2px' },

  choices: { display: 'flex', flexDirection: 'column', gap: '2px' },
  option: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    paddingBlock: space[1],
    paddingInline: space[2],
    borderRadius: radius.small,
    cornerShape: corner.round,
    fontSize: text.subheadlineSize,
    lineHeight: text.bodyLeading,
    textAlign: 'start',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    userSelect: 'none',
    color: colors.label,
    backgroundColor: 'transparent',
    outlineStyle: 'none',
    boxShadow: { default: 'none', ':focus-visible': RING },
    transitionProperty: 'background-color, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  optionInteractive: {
    cursor: 'pointer',
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
  },
  optionSelected: { backgroundColor: colors.selectedFill },
  optionDisabled: { cursor: 'not-allowed' },
  optionReadonly: { cursor: 'default' },
  dimmed: { opacity: 0.45 },
  optionLabel: { display: 'flex', flexGrow: 1, minWidth: 0, alignItems: 'center', gap: space[1] },
  optionText: { minWidth: 0 },
  // An inline (i) sits on the label's 20px line.
  infoButton: { flexShrink: 0, marginBlock: '-2px' },
  preWrap: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  breakWord: { overflowWrap: 'anywhere' },

  // The mark a choice wears is drawn as a checkbox or radio is: an empty well
  // until it holds the value, then the accent under the ink edge.
  mark: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    width: '16px',
    height: '16px',
    marginTop: '2px',
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
    color: colors.background,
    transitionProperty: 'background-color, box-shadow',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  markRadio: { borderRadius: radius.full, cornerShape: corner.round },
  markCheckbox: { borderRadius: radius.mini, cornerShape: corner.round },
  markChecked: {
    backgroundColor: colors.accent,
    backgroundImage: sheen.ink,
    boxShadow: shadow.inkEdge,
  },
  markCentered: { marginTop: 0 },
  dot: {
    width: '6px',
    height: '6px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: 'currentColor',
  },
  checkGlyph: { display: 'block', width: '12px', height: '12px' },
  customRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    paddingBlock: '2px',
    paddingInline: space[2],
  },

  note: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
    minWidth: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  noteHeading: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: space[2],
    rowGap: '2px',
  },
  noteTitle: { fontWeight: 500, color: colors.label },
  noteHint: { color: colors.tertiaryLabel },

  submitRow: { display: 'flex' },
  pager: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
  },
  dots: { display: 'flex', alignItems: 'center', gap: space[1.5] },
  dotButton: {
    flexShrink: 0,
    height: '6px',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: radius.full,
    cornerShape: corner.round,
    cursor: { default: 'pointer', ':disabled': 'default' },
    outlineStyle: 'none',
    boxShadow: { default: 'none', ':focus-visible': RING },
    transitionProperty: 'width, background-color',
    transitionDuration: duration.regular,
    transitionTimingFunction: ease.standard,
  },
  dotCurrent: { width: '20px', backgroundColor: colors.accent },
  dotAnswered: {
    width: '10px',
    backgroundColor: `color-mix(in oklab, transparent, ${colors.accent} 55%)`,
  },
  dotPending: {
    width: '6px',
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 15%)`,
  },

  // A notice is a tint and a mark: the region fill inside the card, no edge.
  notice: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[1.5],
    paddingBlock: space[1.5],
    paddingInline: space[2],
    backgroundColor: REGION,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  noticeMark: { marginTop: '1px', color: colors.tertiaryLabel },

  preview: {
    maxHeight: '60vh',
    margin: 0,
    overflow: 'auto',
    paddingBlock: space[2],
    paddingInline: space[3],
    backgroundColor: REGION,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    fontFamily: 'var(--font-mono)',
    fontSize: text.footnoteSize,
    lineHeight: 1.625,
    whiteSpace: 'pre',
    color: colors.label,
  },
});

type DraftAnswer = {
  selectedLabels: string[];
  customAnswer: string;
  note?: string;
};

type SwipeState = {
  pointerId: number;
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  active: boolean;
};

const SWIPE_ACTIVATION_DISTANCE_PX = 14;
const SWIPE_NAVIGATION_DISTANCE_PX = 56;
const SWIPE_MAX_VERTICAL_DRIFT_PX = 44;
const SWIPE_AXIS_LOCK_RATIO = 1.25;
const SWIPE_CLICK_SUPPRESSION_MS = 350;

const releasePointerCapture = (target: HTMLDivElement, pointerId: number) => {
  if (target.hasPointerCapture?.(pointerId)) {
    target.releasePointerCapture(pointerId);
  }
};

type AskUserQuestionInteractiveMode = {
  kind: 'interactive';
  isReady: boolean;
  isPendingSubmit: boolean;
  isPendingCancel: boolean;
  disabled: boolean;
  onSubmit: (answers: AskUserQuestionAnswers) => void;
  onCancel: () => void;
};

type AskUserQuestionReadonlyMode = {
  kind: 'readonly';
  answers: AskUserQuestionAnswers;
};

export type AskUserQuestionCardMode = AskUserQuestionInteractiveMode | AskUserQuestionReadonlyMode;

export interface AskUserQuestionCardProps {
  meta: AskUserQuestionPermissionMeta;
  mode: AskUserQuestionCardMode;
  className?: string;
}

const buildDraftsFromAnswers = (
  meta: AskUserQuestionPermissionMeta,
  answers: AskUserQuestionAnswers | undefined
): DraftAnswer[] =>
  meta.questions.map((question, index) => {
    const noteValue = question.note ? answers?.[question.note.fieldId] : undefined;
    const note = typeof noteValue === 'string' ? noteValue : '';
    const key = getAskUserQuestionAnswerKey(meta.questions, index);
    const value = answers?.[key];
    if (value === undefined) {
      return { selectedLabels: [], customAnswer: '', note };
    }
    const values = Array.isArray(value) ? value : [value];
    const optionLabels = new Set(question.options.map((option) => option.label));
    const selectedLabels: string[] = [];
    const customParts: string[] = [];
    for (const entry of values) {
      if (optionLabels.has(entry)) {
        selectedLabels.push(entry);
      } else {
        customParts.push(entry);
      }
    }
    return {
      selectedLabels,
      customAnswer: customParts.join('\n'),
      note,
    };
  });

const getDraftAnswerValue = (
  question: AskUserQuestion,
  draft: DraftAnswer
): AskUserQuestionAnswerValue | null => {
  const custom = draft.customAnswer.trim();
  if (custom) return custom;
  const labels = draft.selectedLabels.filter(Boolean);
  if (labels.length === 0) return null;
  return question.multiSelect ? labels : (labels[0] ?? null);
};

const isDraftComplete = (question: AskUserQuestion, draft: DraftAnswer): boolean =>
  getDraftAnswerValue(question, draft) !== null;

const buildAnswers = (
  meta: AskUserQuestionPermissionMeta,
  drafts: DraftAnswer[]
): AskUserQuestionAnswers | null => {
  const answers: AskUserQuestionAnswers = Object.create(null);
  for (const [index, question] of meta.questions.entries()) {
    const draft = drafts[index];
    if (!draft) return null;
    const value = getDraftAnswerValue(question, draft);
    if (value === null) return null;
    answers[getAskUserQuestionAnswerKey(meta.questions, index)] = value;
    if (question.note && draft.note?.trim()) answers[question.note.fieldId] = draft.note;
  }
  return answers;
};

const findFirstIncompleteIndex = (
  meta: AskUserQuestionPermissionMeta,
  drafts: DraftAnswer[]
): number => {
  for (let i = 0; i < meta.questions.length; i += 1) {
    const question = meta.questions[i];
    const draft = drafts[i];
    if (!question || !draft) return i;
    if (!isDraftComplete(question, draft)) return i;
  }
  return Math.max(0, meta.questions.length - 1);
};

// Card-level swipe keeps the gesture usable over option buttons. Editable
// fields opt out because stealing horizontal drags there breaks cursor
// placement and text selection.
const isEditableSwipeTarget = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));

export function AskUserQuestionCard({ meta, mode, className }: AskUserQuestionCardProps) {
  const { t } = useTranslation();
  const isInteractive = mode.kind === 'interactive';
  const initialAnswers = mode.kind === 'readonly' ? mode.answers : undefined;
  const swipeStateRef = useRef<SwipeState | null>(null);
  const suppressClickUntilRef = useRef(0);

  const [drafts, setDrafts] = useState<DraftAnswer[]>(() =>
    buildDraftsFromAnswers(meta, initialAnswers)
  );
  const [pageIndex, setPageIndex] = useState<number>(() =>
    isInteractive ? findFirstIncompleteIndex(meta, buildDraftsFromAnswers(meta, initialAnswers)) : 0
  );
  // Description + preview live behind this modal so option rows stay one line.
  // Tracking the option object (not just an id) makes the dialog content
  // stable while it animates out after `null` is set.
  const [infoModalOption, setInfoModalOption] = useState<AskUserQuestionOption | null>(null);
  const [autoResolveNow, setAutoResolveNow] = useState(() => getServerNow());

  useEffect(() => {
    if (!isInteractive || meta.autoResolveAt === undefined) return undefined;
    setAutoResolveNow(getServerNow());
    const interval = window.setInterval(() => setAutoResolveNow(getServerNow()), 250);
    return () => window.clearInterval(interval);
  }, [isInteractive, meta.autoResolveAt]);

  // Readonly: always mirror the latest streamed answers.
  // Interactive: skip the sync — re-deriving on every meta ref change would
  // clobber the user's in-progress input when streams emit identical _meta refs.
  useEffect(() => {
    if (mode.kind !== 'readonly') return;
    setDrafts(buildDraftsFromAnswers(meta, mode.answers));
    setPageIndex((current) =>
      Math.min(Math.max(0, current), Math.max(0, meta.questions.length - 1))
    );
  }, [meta, mode]);

  const total = meta.questions.length;
  const currentIndex = Math.min(Math.max(0, pageIndex), Math.max(0, total - 1));
  const question = meta.questions[currentIndex];
  const draft = drafts[currentIndex] ?? { selectedLabels: [], customAnswer: '' };

  const canSubmit = useMemo(() => {
    if (meta.questions.length === 0) return false;
    for (let i = 0; i < meta.questions.length; i += 1) {
      const q = meta.questions[i];
      const d = drafts[i];
      if (!q || !d) return false;
      if (!isDraftComplete(q, d)) return false;
    }
    return true;
  }, [meta, drafts]);

  const autoResolveSeconds =
    meta.autoResolveAt === undefined
      ? null
      : Math.max(0, Math.ceil((meta.autoResolveAt - autoResolveNow) / 1000));
  const isAutoResolveExpired = autoResolveSeconds === 0;
  const disabled =
    mode.kind === 'readonly' ||
    mode.disabled ||
    mode.isPendingSubmit ||
    mode.isPendingCancel ||
    !mode.isReady ||
    isAutoResolveExpired;
  const isReadonly = mode.kind === 'readonly';
  const isLast = currentIndex === total - 1;
  const isFirst = currentIndex === 0;
  const isCurrentComplete = question ? isDraftComplete(question, draft) : false;
  const canGoNext = isCurrentComplete;
  const canSwipePrev = !isFirst;
  const canSwipeNext = !isLast && (isReadonly || canGoNext);
  const isSwipeDisabled = mode.kind === 'interactive' && disabled;

  const allowCustomAnswer = question?.allowCustomAnswer ?? meta.allowCustomAnswer;
  const customAnswerActive = draft.customAnswer.trim().length > 0;

  const submit = useCallback(
    (next: DraftAnswer[]) => {
      if (mode.kind !== 'interactive') return;
      const answers = buildAnswers(meta, next);
      if (!answers) return;
      mode.onSubmit(answers);
    },
    [meta, mode]
  );

  const goPrev = useCallback(() => {
    setPageIndex((idx) => Math.max(0, idx - 1));
  }, []);

  const goNext = useCallback(() => {
    setPageIndex((idx) => Math.min(total - 1, idx + 1));
  }, [total]);

  const handleSwipePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (
        event.pointerType !== 'touch' ||
        !event.isPrimary ||
        total <= 1 ||
        isSwipeDisabled ||
        isEditableSwipeTarget(event.target)
      ) {
        swipeStateRef.current = null;
        return;
      }

      swipeStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        latestX: event.clientX,
        latestY: event.clientY,
        active: false,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [isSwipeDisabled, total]
  );

  const handleSwipePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const swipeState = swipeStateRef.current;
    if (!swipeState || event.pointerId !== swipeState.pointerId) return;

    swipeState.latestX = event.clientX;
    swipeState.latestY = event.clientY;
    const deltaX = event.clientX - swipeState.startX;
    const deltaY = event.clientY - swipeState.startY;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    if (!swipeState.active) {
      if (absY > SWIPE_ACTIVATION_DISTANCE_PX && absY > absX) {
        swipeStateRef.current = null;
        return;
      }
      if (absX < SWIPE_ACTIVATION_DISTANCE_PX || absX < absY * SWIPE_AXIS_LOCK_RATIO) {
        return;
      }
      swipeState.active = true;
    }

    if (event.cancelable) {
      event.preventDefault();
    }
  }, []);

  const finishSwipe = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const swipeState = swipeStateRef.current;
      if (!swipeState || event.pointerId !== swipeState.pointerId) return;

      swipeStateRef.current = null;
      releasePointerCapture(event.currentTarget, event.pointerId);

      if (!swipeState.active) return;

      const deltaX = swipeState.latestX - swipeState.startX;
      const deltaY = swipeState.latestY - swipeState.startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      suppressClickUntilRef.current = performance.now() + SWIPE_CLICK_SUPPRESSION_MS;

      if (
        absX < SWIPE_NAVIGATION_DISTANCE_PX ||
        absY > SWIPE_MAX_VERTICAL_DRIFT_PX ||
        absX < absY * SWIPE_AXIS_LOCK_RATIO
      ) {
        return;
      }

      if (deltaX < 0 && canSwipeNext) {
        goNext();
      } else if (deltaX > 0 && canSwipePrev) {
        goPrev();
      }
    },
    [canSwipeNext, canSwipePrev, goNext, goPrev]
  );

  const handleSwipePointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const swipeState = swipeStateRef.current;
    if (!swipeState || event.pointerId !== swipeState.pointerId) return;
    swipeStateRef.current = null;
    releasePointerCapture(event.currentTarget, event.pointerId);
  }, []);

  const handleSwipeClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const suppressClickUntil = suppressClickUntilRef.current;
    if (suppressClickUntil <= 0 || performance.now() > suppressClickUntil) return;
    suppressClickUntilRef.current = 0;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleOptionClick = useCallback(
    (label: string) => {
      if (disabled || !question) return;
      setDrafts((current) => {
        const next = current.map((entry, i) => {
          if (i !== currentIndex) return entry;
          if (!question.multiSelect) {
            return { ...entry, selectedLabels: [label], customAnswer: '' };
          }
          const selectedLabels = entry.selectedLabels.includes(label)
            ? entry.selectedLabels.filter((value) => value !== label)
            : [...entry.selectedLabels, label];
          return { ...entry, selectedLabels, customAnswer: '' };
        });

        // Single-select: auto-advance to the next unanswered question for
        // convenience, but never auto-submit. The user must click Submit
        // explicitly so the CRDT write (and downstream sync) happens only
        // after they have reviewed the full set of answers — rejected:
        // auto-submitting on the last click writes the full answer set
        // through to the CRDT before the user can revisit earlier answers.
        if (
          !question.multiSelect &&
          !question.note &&
          mode.kind === 'interactive' &&
          currentIndex < total - 1
        ) {
          queueMicrotask(() => setPageIndex(currentIndex + 1));
        }
        return next;
      });
    },
    [currentIndex, disabled, mode.kind, question, total]
  );

  const handleCustomAnswerChange = useCallback(
    (value: string) => {
      if (disabled) return;
      setDrafts((current) =>
        current.map((entry, i) =>
          i === currentIndex
            ? {
                ...entry,
                selectedLabels: value.trim() ? [] : entry.selectedLabels,
                customAnswer: value,
              }
            : entry
        )
      );
    },
    [currentIndex, disabled]
  );

  const handleCustomAnswerKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>
  ) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    if (!question || disabled) return;
    event.preventDefault();
    if (mode.kind !== 'interactive') return;
    if (!isDraftComplete(question, draft)) return;
    if (isLast) {
      if (canSubmit) submit(drafts);
      return;
    }
    goNext();
  };

  if (!question) return null;

  const noteInputProps = {
    value: isReadonly && question.note?.isSecret && draft.note ? '••••••••' : (draft.note ?? ''),
    disabled,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const note = event.target.value;
      setDrafts((current) =>
        current.map((entry, index) => (index === currentIndex ? { ...entry, note } : entry))
      );
    },
  };

  const PaginationDots =
    total > 1 ? (
      <div
        {...stylex.props(styles.dots)}
        aria-label={t('sessions.askQuestion.progressLabel', 'Progress')}
      >
        {meta.questions.map((_, idx) => {
          const isCurrent = idx === currentIndex;
          const isAnswered = isDraftComplete(
            meta.questions[idx]!,
            drafts[idx] ?? { selectedLabels: [], customAnswer: '' }
          );
          return (
            <button
              key={idx}
              type="button"
              disabled={disabled && !isReadonly}
              onClick={() => setPageIndex(idx)}
              aria-label={t('sessions.askQuestion.goToQuestion', 'Go to question {{n}}', {
                n: idx + 1,
              })}
              {...stylex.props(
                styles.dotButton,
                isCurrent ? styles.dotCurrent : isAnswered ? styles.dotAnswered : styles.dotPending
              )}
            />
          );
        })}
      </div>
    ) : null;

  const submitIcon =
    mode.kind === 'interactive' && mode.isPendingSubmit ? (
      <Spinner size="small" label={null} />
    ) : (
      <ArrowUp {...stylex.props(styles.glyph16)} />
    );

  return (
    <div
      {...withClassName(stylex.props(styles.card), className)}
      onClickCapture={handleSwipeClickCapture}
      onPointerCancel={handleSwipePointerCancel}
      onPointerDown={handleSwipePointerDown}
      onPointerMove={handleSwipePointerMove}
      onPointerUp={finishSwipe}
    >
      <div {...stylex.props(styles.header)}>
        <span {...stylex.props(styles.question)}>{question.question}</span>
        <div {...stylex.props(styles.headerMeta)}>
          {total > 1 ? (
            <span {...stylex.props(styles.count)}>
              {currentIndex + 1}/{total}
            </span>
          ) : null}
          {!isReadonly && autoResolveSeconds !== null ? (
            <span {...stylex.props(styles.countdown)}>
              {isAutoResolveExpired ? (
                <Spinner size="small" label={null} />
              ) : (
                <Clock3 {...stylex.props(styles.glyph12)} />
              )}
              {isAutoResolveExpired
                ? t('sessions.askQuestion.continuing', 'Continuing')
                : t('sessions.askQuestion.autoContinueIn', 'Continues in {{seconds}}s', {
                    seconds: autoResolveSeconds,
                  })}
            </span>
          ) : null}
          {isReadonly ? (
            <Badge tone="success" icon={<Check {...stylex.props(styles.glyphFill)} />}>
              {t('sessions.askQuestion.answered', 'Answered')}
            </Badge>
          ) : null}
          {!isReadonly && mode.kind === 'interactive' ? (
            <Button
              type="button"
              variant="ghost"
              size="mini"
              icon
              disabled={disabled && !mode.isPendingCancel}
              onClick={mode.onCancel}
              aria-label={t('sessions.cancel', 'Cancel')}
              {...stylex.props(styles.lineButton)}
            >
              {mode.isPendingCancel ? (
                <Spinner size="small" label={null} />
              ) : (
                <X {...stylex.props(styles.glyphFill)} />
              )}
            </Button>
          ) : null}
        </div>
      </div>

      {question.options.length > 0 || allowCustomAnswer ? (
        <div {...stylex.props(styles.choices)}>
          {question.options.map((option) => {
            const isSelected = draft.selectedLabels.includes(option.label);
            const isOptionDisabled = disabled || customAnswerActive;
            const hasInfo = Boolean(option.description || option.preview);
            const infoButton = (
              <Button
                type="button"
                variant="ghost"
                size="mini"
                icon
                aria-label={t('sessions.askQuestion.showDetails', 'Show details')}
                onClick={(event) => {
                  event.stopPropagation();
                  setInfoModalOption(option);
                }}
                {...stylex.props(styles.infoButton)}
              >
                <Info {...stylex.props(styles.glyphFill)} />
              </Button>
            );
            // A replayed answer reads at full strength and the choices it did
            // not take recede; a live row that cannot be pressed dims whole.
            const isDimmed = isReadonly ? !isSelected : isOptionDisabled;
            // Option container is a div with role="button", not a real
            // <button>, so the inline info button can nest next to the label
            // text. Nesting a real <button> inside <button> is invalid HTML;
            // a styled div sidesteps that and lets the (i) icon hug the
            // label end (including across wrapped lines) instead of floating
            // to the row's right edge where it gets overlooked.
            return (
              <div
                key={option.label}
                role="button"
                tabIndex={isOptionDisabled ? -1 : 0}
                aria-disabled={isOptionDisabled || undefined}
                aria-pressed={isSelected}
                onClick={() => {
                  if (!isOptionDisabled) handleOptionClick(option.label);
                }}
                onKeyDown={(event) => {
                  // Keydown on the inner info <button> bubbles here; without
                  // this guard we would preventDefault the browser's native
                  // Enter→click on that button and toggle the parent option
                  // instead of opening the info dialog.
                  if (event.target !== event.currentTarget) return;
                  if ((event.key === 'Enter' || event.key === ' ') && !isOptionDisabled) {
                    event.preventDefault();
                    handleOptionClick(option.label);
                  }
                }}
                {...stylex.props(
                  styles.option,
                  !isOptionDisabled && styles.optionInteractive,
                  isSelected && styles.optionSelected,
                  isOptionDisabled && (isReadonly ? styles.optionReadonly : styles.optionDisabled),
                  isDimmed && styles.dimmed
                )}
              >
                <ChoiceMark multiple={Boolean(question.multiSelect)} checked={isSelected} />
                <span {...stylex.props(styles.optionLabel)}>
                  <span {...stylex.props(styles.optionText)}>{option.label}</span>
                  {hasInfo ? (
                    // Tooltip only when the description adds information
                    // beyond the button's aria-label; otherwise rendering
                    // "Show details" twice (label + tooltip) is noise.
                    option.description ? (
                      <Tooltip.Root>
                        <Tooltip.Trigger render={infoButton} />
                        <Tooltip.Content side="top" align="start">
                          <span {...stylex.props(styles.preWrap)}>{option.description}</span>
                        </Tooltip.Content>
                      </Tooltip.Root>
                    ) : (
                      infoButton
                    )
                  ) : null}
                </span>
              </div>
            );
          })}
          {allowCustomAnswer ? (
            <div {...stylex.props(styles.customRow)}>
              <ChoiceMark multiple={false} checked={customAnswerActive} centered />
              <Input
                size="small"
                type={question.isSecret ? 'password' : 'text'}
                value={
                  isReadonly && question.isSecret && draft.customAnswer
                    ? '••••••••'
                    : draft.customAnswer
                }
                disabled={disabled}
                placeholder={t('sessions.customAnswerPlaceholder', 'Type a custom answer...')}
                onChange={(event) => handleCustomAnswerChange(event.target.value)}
                onKeyDown={handleCustomAnswerKeyDown}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {question.note ? (
        <label {...stylex.props(styles.note)}>
          <span {...stylex.props(styles.noteHeading)}>
            <span {...stylex.props(styles.noteTitle)}>
              {question.note.title ||
                t('sessions.askQuestion.noteLabel', 'Additional context (optional)')}
            </span>
            {question.note.description ? (
              <span {...stylex.props(styles.noteHint)}>{question.note.description}</span>
            ) : null}
          </span>
          {question.note.isSecret ? (
            <Input type="password" {...noteInputProps} />
          ) : (
            <Textarea rows={2} {...noteInputProps} />
          )}
        </label>
      ) : null}

      {/* Custom answer is an inline option row in the list above; Submit is a
          small button (bottom-left), a discrete action rather than a full bar.
          The pager below only renders for multi-question flows. */}
      {!isReadonly && mode.kind === 'interactive' && total === 1 ? (
        <div {...stylex.props(styles.submitRow)}>
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={disabled || !canSubmit}
            onClick={() => mode.kind === 'interactive' && submit(drafts)}
          >
            {submitIcon}
            {t('sessions.askQuestion.submit', 'Submit')}
          </Button>
        </div>
      ) : null}

      {total > 1 ? (
        <div {...stylex.props(styles.pager)}>
          <Button type="button" variant="ghost" size="small" disabled={isFirst} onClick={goPrev}>
            <ChevronLeft {...stylex.props(styles.glyph16)} />
            {t('sessions.askQuestion.prev', 'Prev')}
          </Button>

          {PaginationDots}

          {isReadonly ? (
            <Button type="button" variant="ghost" size="small" disabled={isLast} onClick={goNext}>
              {t('sessions.askQuestion.next', 'Next')}
              <ChevronRight {...stylex.props(styles.glyph16)} />
            </Button>
          ) : isLast ? (
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={disabled || !canSubmit}
              onClick={() => mode.kind === 'interactive' && submit(drafts)}
            >
              {submitIcon}
              {t('sessions.askQuestion.submit', 'Submit')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="small"
              disabled={!canGoNext}
              onClick={goNext}
            >
              {t('sessions.askQuestion.next', 'Next')}
              <ChevronRight {...stylex.props(styles.glyph16)} />
            </Button>
          )}
        </div>
      ) : null}

      {mode.kind === 'interactive' && !mode.isReady ? (
        <div {...stylex.props(styles.notice)}>
          <Info {...stylex.props(styles.glyph14, styles.noticeMark)} aria-hidden="true" />
          <span>
            {t(
              'sessions.permissionActionsDisabled',
              'Permission actions are disabled in this environment.'
            )}
          </span>
        </div>
      ) : null}

      <Dialog.Root
        open={infoModalOption !== null}
        onOpenChange={(open) => {
          if (!open) setInfoModalOption(null);
        }}
      >
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>
              <span {...stylex.props(styles.breakWord)}>{infoModalOption?.label}</span>
            </Dialog.Title>
            {infoModalOption?.description ? (
              <Dialog.Description>
                <span {...stylex.props(styles.preWrap)}>{infoModalOption.description}</span>
              </Dialog.Description>
            ) : null}
          </Dialog.Header>
          {infoModalOption?.preview ? (
            <pre {...stylex.props(styles.preview)}>{infoModalOption.preview}</pre>
          ) : null}
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}

/**
 * What a choice wears: a radio's dot for one-of, a checkbox's tick for any-of.
 * It is decoration on a row that is itself the pressable, so it is drawn rather
 * than rendered as a second control inside the first.
 */
function ChoiceMark({
  multiple,
  checked,
  centered = false,
}: {
  multiple: boolean;
  checked: boolean;
  centered?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      {...stylex.props(
        styles.mark,
        multiple ? styles.markCheckbox : styles.markRadio,
        checked && styles.markChecked,
        centered && styles.markCentered
      )}
    >
      {checked ? (
        multiple ? (
          <Check strokeWidth={3} {...stylex.props(styles.checkGlyph)} />
        ) : (
          <span {...stylex.props(styles.dot)} />
        )
      ) : null}
    </span>
  );
}

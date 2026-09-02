import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ArrowUp, Check, ChevronLeft, ChevronRight, Clock3, Info, Loader2, X } from 'lucide-react';
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

import { Button } from '@lody/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { cn } from '@/lib/utils';

type DraftAnswer = {
  selectedLabels: string[];
  customAnswer: string;
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
    if (!answers) {
      return { selectedLabels: [], customAnswer: '' };
    }
    const key = getAskUserQuestionAnswerKey(meta.questions, index);
    const value = answers[key];
    if (value === undefined) {
      return { selectedLabels: [], customAnswer: '' };
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
  const answers: AskUserQuestionAnswers = {};
  for (const [index, question] of meta.questions.entries()) {
    const draft = drafts[index];
    if (!draft) return null;
    const value = getDraftAnswerValue(question, draft);
    if (value === null) return null;
    answers[getAskUserQuestionAnswerKey(meta.questions, index)] = value;
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
            return { selectedLabels: [label], customAnswer: '' };
          }
          const selectedLabels = entry.selectedLabels.includes(label)
            ? entry.selectedLabels.filter((value) => value !== label)
            : [...entry.selectedLabels, label];
          return { selectedLabels, customAnswer: '' };
        });

        // Single-select: auto-advance to the next unanswered question for
        // convenience, but never auto-submit. The user must click Submit
        // explicitly so the CRDT write (and downstream sync) happens only
        // after they have reviewed the full set of answers — rejected:
        // auto-submitting on the last click writes the full answer set
        // through to the CRDT before the user can revisit earlier answers.
        if (!question.multiSelect && mode.kind === 'interactive' && currentIndex < total - 1) {
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

  const PaginationDots =
    total > 1 ? (
      <div
        className="flex items-center gap-1.5"
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
              className={cn(
                'h-1.5 rounded-full transition-all',
                isCurrent
                  ? 'w-5 bg-primary'
                  : isAnswered
                    ? 'w-2.5 bg-primary/55'
                    : 'w-1.5 bg-border'
              )}
            />
          );
        })}
      </div>
    ) : null;

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border border-border/60 bg-secondary/25 text-sm shadow-sm touch-pan-y',
        'animate-in fade-in slide-in-from-bottom-2 duration-300',
        className
      )}
      onClickCapture={handleSwipeClickCapture}
      onPointerCancel={handleSwipePointerCancel}
      onPointerDown={handleSwipePointerDown}
      onPointerMove={handleSwipePointerMove}
      onPointerUp={finishSwipe}
    >
      <div className="flex items-start justify-between gap-2 border-b border-border/40 bg-secondary/55 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-start gap-2 whitespace-pre-wrap break-words text-sm font-medium leading-snug text-foreground">
          <span className="min-w-0 flex-1">{question.question}</span>
          {total > 1 ? (
            <span className="mt-0.5 shrink-0 tabular-nums text-[11px] font-medium text-primary/70">
              {currentIndex + 1}/{total}
            </span>
          ) : null}
          {!isReadonly && autoResolveSeconds !== null ? (
            <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-[10px] font-normal text-muted-foreground">
              {isAutoResolveExpired ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Clock3 className="h-3 w-3" />
              )}
              {isAutoResolveExpired
                ? t('sessions.askQuestion.continuing', 'Continuing')
                : t('sessions.askQuestion.autoContinueIn', 'Continues in {{seconds}}s', {
                    seconds: autoResolveSeconds,
                  })}
            </span>
          ) : null}
          {isReadonly ? (
            <span className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 rounded-full border border-status-success/30 bg-status-success/[0.08] px-1.5 py-0 text-[9px] font-medium uppercase tracking-wide text-status-success">
              <Check className="h-2.5 w-2.5" />
              {t('sessions.askQuestion.answered', 'Answered')}
            </span>
          ) : null}
        </div>
        {!isReadonly && mode.kind === 'interactive' ? (
          <Button
            type="button"
            variant="ghost"
            size="mini"
            icon
            disabled={disabled && !mode.isPendingCancel}
            onClick={mode.onCancel}
            aria-label={t('sessions.cancel', 'Cancel')}
            className="-mr-1 mt-0.5 shrink-0"
          >
            {mode.isPendingCancel ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <X className="h-3 w-3" />
            )}
          </Button>
        ) : null}
      </div>

      <div className="px-3 py-2">
        {question.options.length > 0 || allowCustomAnswer ? (
          <div className="flex flex-col gap-0.5">
            {question.options.map((option) => {
              const isSelected = draft.selectedLabels.includes(option.label);
              const isOptionDisabled = disabled || customAnswerActive;
              const hasInfo = Boolean(option.description || option.preview);
              const infoButton = (
                <button
                  type="button"
                  aria-label={t('sessions.askQuestion.showDetails', 'Show details')}
                  onClick={(event) => {
                    event.stopPropagation();
                    setInfoModalOption(option);
                  }}
                  className={cn(
                    'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors',
                    'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                  )}
                >
                  <Info className="h-3 w-3" />
                </button>
              );
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
                  className={cn(
                    'flex w-full min-w-0 select-none items-start justify-start gap-2.5 rounded-md px-2.5 py-1 text-left text-xs leading-5 transition-colors',
                    'whitespace-normal break-words',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    isSelected
                      ? 'bg-hover text-foreground'
                      : 'text-foreground/85 hover:bg-hover hover:text-foreground',
                    isOptionDisabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
                    isReadonly && !isSelected && 'opacity-55'
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors',
                      question.multiSelect ? 'rounded-[5px]' : '',
                      isSelected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/40 bg-transparent'
                    )}
                  >
                    {isSelected ? <Check className="h-2.5 w-2.5" /> : null}
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-1">
                    <span className="min-w-0 break-words">{option.label}</span>
                    {hasInfo ? (
                      // Tooltip only when the description adds information
                      // beyond the button's aria-label; otherwise rendering
                      // "Show details" twice (label + tooltip) is noise.
                      option.description ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{infoButton}</TooltipTrigger>
                          <TooltipContent
                            side="top"
                            align="start"
                            className="max-w-[260px] whitespace-pre-wrap"
                          >
                            {option.description}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        infoButton
                      )
                    ) : null}
                  </span>
                </div>
              );
            })}
            {allowCustomAnswer ? (
              <div className="flex items-start gap-2.5 rounded-md px-2.5 py-1">
                <span
                  className={cn(
                    'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors',
                    customAnswerActive
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-muted-foreground/40 bg-transparent'
                  )}
                >
                  {customAnswerActive ? <Check className="h-2.5 w-2.5" /> : null}
                </span>
                <input
                  type={question.isSecret ? 'password' : 'text'}
                  value={draft.customAnswer}
                  disabled={disabled}
                  placeholder={t('sessions.customAnswerPlaceholder', 'Type a custom answer...')}
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 text-xs leading-5 text-foreground shadow-none placeholder:text-muted-foreground/60 focus:outline-none focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed"
                  onChange={(event) => handleCustomAnswerChange(event.target.value)}
                  onKeyDown={handleCustomAnswerKeyDown}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Custom answer is an inline option row in the list above; Submit is a
            small button (bottom-left), a discrete action rather than a full bar.
            The footer below only renders for multi-question flows. */}
        {!isReadonly && mode.kind === 'interactive' && total === 1 ? (
          <div className="mt-2">
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={disabled || !canSubmit}
              onClick={() => mode.kind === 'interactive' && submit(drafts)}
            >
              {mode.kind === 'interactive' && mode.isPendingSubmit ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowUp className="h-3.5 w-3.5" />
              )}
              {t('sessions.askQuestion.submit', 'Submit')}
            </Button>
          </div>
        ) : null}
      </div>

      {total > 1 ? (
        <div className="flex items-center justify-between gap-2 border-t border-border/40 bg-transparent px-3 py-1">
          <Button
            type="button"
            variant="ghost"
            size="small"
            disabled={isFirst}
            onClick={goPrev}
            className="disabled:opacity-50"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t('sessions.askQuestion.prev', 'Prev')}
          </Button>

          {PaginationDots}

          {isReadonly ? (
            <Button
              type="button"
              variant="ghost"
              size="small"
              disabled={isLast}
              onClick={goNext}
              className="disabled:opacity-50"
            >
              {t('sessions.askQuestion.next', 'Next')}
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          ) : isLast ? (
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={disabled || !canSubmit}
              onClick={() => mode.kind === 'interactive' && submit(drafts)}
            >
              {mode.kind === 'interactive' && mode.isPendingSubmit ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowUp className="h-3.5 w-3.5" />
              )}
              {t('sessions.askQuestion.submit', 'Submit')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="small"
              disabled={!canGoNext}
              onClick={goNext}
              className={cn(canGoNext ? '' : '')}
            >
              {t('sessions.askQuestion.next', 'Next')}
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ) : null}

      {mode.kind === 'interactive' && !mode.isReady ? (
        <div className="border-t border-border/40 bg-transparent px-3 py-1 text-[11px] text-muted-foreground">
          {t(
            'sessions.permissionActionsDisabled',
            'Permission actions are disabled in this environment.'
          )}
        </div>
      ) : null}

      <Dialog
        open={infoModalOption !== null}
        onOpenChange={(open) => {
          if (!open) setInfoModalOption(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="break-words text-left">{infoModalOption?.label}</DialogTitle>
            {infoModalOption?.description ? (
              <DialogDescription className="whitespace-pre-wrap break-words text-left">
                {infoModalOption.description}
              </DialogDescription>
            ) : null}
          </DialogHeader>
          {infoModalOption?.preview ? (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
              {infoModalOption.preview}
            </pre>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

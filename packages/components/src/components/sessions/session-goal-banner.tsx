import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type SVGProps,
} from 'react';
import { ChevronDown, Clock, Loader2, Pause, Play, Target, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { getGoalStatusPresentation } from '@/lib/session-goal-status';
import { formatDurationCompact, type DurationUnitLabels } from '@/lib/format-duration';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import {
  isSessionGoalCleared,
  sanitizeGoalObjective,
  type SessionGoalCommand,
  type SessionGoalMessage,
} from '@lody/shared';

export type SessionGoalBannerCommandHandler = (
  command: SessionGoalCommand,
  goal: SessionGoalMessage
) => void;

interface SessionGoalBannerProps {
  goal: SessionGoalMessage | null | undefined;
  /** Commands the current session transport can safely dispatch. */
  commands?: readonly SessionGoalCommand[];
  pendingCommand?: SessionGoalCommand | null;
  onGoalCommand?: SessionGoalBannerCommandHandler;
  /** Dismiss the banner once the goal is in a terminal state. When omitted
   *  the cleared snapshot stays visible until a new goal arrives. */
  onDismiss?: (goal: SessionGoalMessage) => void;
}

type ActionIcon = ComponentType<SVGProps<SVGSVGElement> & { className?: string }>;

interface GoalActionButtonProps {
  icon: ActionIcon;
  label: string;
  onClick: () => void;
  disabled: boolean;
  loading: boolean;
  /** Color emphasis. Default = neutral; success = green; danger = destructive. */
  tone?: 'default' | 'success' | 'danger';
}

export const GoalActionButton = ({
  icon: Icon,
  label,
  onClick,
  disabled,
  loading,
  tone = 'default',
}: GoalActionButtonProps) => {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'h-7 gap-1.5 rounded-md px-2.5 text-xs font-medium',
        'bg-background/70 backdrop-blur-xs',
        tone === 'success' &&
          'border-status-success/40 text-status-success hover:text-status-success hover:bg-status-success/10',
        tone === 'danger' &&
          'border-destructive/40 text-destructive hover:text-destructive hover:bg-destructive/10',
        tone === 'default' && 'text-foreground/80 hover:text-foreground'
      )}
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      <span>{label}</span>
    </Button>
  );
};

/** Compact token formatter (e.g. `12.4K`, `1.2M`). Mirrors the helper used by
 *  the context-window ring so banner values stay visually consistent with the
 *  other token surfaces in the chat view. */
export const formatTokensCompact = (value: number): string => {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const trim = (input: string) => input.replace(/\.0$/, '');

  if (abs >= 1_000_000) {
    const scaled = abs / 1_000_000;
    const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    return `${sign}${trim(scaled.toFixed(digits))}M`;
  }
  if (abs >= 1_000) {
    const scaled = abs / 1_000;
    const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    return `${sign}${trim(scaled.toFixed(digits))}K`;
  }
  return `${sign}${Math.round(abs)}`;
};

/**
 * Sticky goal banner. Renders beneath the session tab bar (and beneath
 * `SessionPin` when both are present), giving the active goal a tinted
 * surface, a labeled status pill, ACP-reported runtime/token metrics,
 * the objective on its own row, and full-text Pause / Resume / Clear controls.
 *
 * The banner stays visible while a goal exists — including the cleared
 * state, which persists until a new goal arrives or the user dismisses it.
 */
export const SessionGoalBanner = memo(function SessionGoalBanner({
  goal,
  commands,
  pendingCommand,
  onGoalCommand,
  onDismiss,
}: SessionGoalBannerProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);
  const [overflowsCollapsed, setOverflowsCollapsed] = useState(false);
  const objectiveRef = useRef<HTMLSpanElement>(null);

  const objective = goal ? sanitizeGoalObjective(goal.objective) : '';

  // Detect whether the single-line render would clip. We only re-measure while
  // collapsed: once expanded the span shows the full multi-line text, so its
  // scrollWidth no longer reflects the collapsed bound. Re-observe on objective
  // change and on parent width changes (sidebar toggle, window resize, etc.).
  useLayoutEffect(() => {
    if (expanded) return undefined;
    const el = objectiveRef.current;
    if (!el) return undefined;

    const measure = () => {
      // Defensive: a detached node reports scroll/client widths of 0, which
      // would otherwise clobber a correct overflow=true with a stale false.
      if (!el.isConnected) return;
      setOverflowsCollapsed(el.scrollWidth - el.clientWidth > 1);
    };
    measure();

    return observeResizeOnAnimationFrame(el, () => measure());
  }, [objective, expanded]);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleObjectiveKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setExpanded((prev) => !prev);
    }
  }, []);

  if (!goal) return null;
  if (!objective) return null;

  const meta = getGoalStatusPresentation(goal.status);
  const statusLabel = t(meta.labelKey, meta.fallbackLabel);
  const isPending = pendingCommand != null;
  const isCleared = isSessionGoalCleared(goal);
  const showPause =
    goal.status === 'active' && commands?.includes('pause') === true && onGoalCommand != null;
  const showResume =
    goal.status === 'paused' && commands?.includes('resume') === true && onGoalCommand != null;
  const showClear =
    !isCleared && commands?.includes('clear') === true && onGoalCommand != null;
  const showDismiss = isCleared && onDismiss != null;

  const triggerCommand = (command: SessionGoalCommand) => {
    if (isPending) return;
    onGoalCommand?.(command, goal);
  };

  const durationUnitLabels: DurationUnitLabels = {
    hour: t('time.unitShort.hour', 'h'),
    minute: t('time.unitShort.minute', 'm'),
    second: t('time.unitShort.second', 's'),
  };
  const tokensUsed = Math.max(0, Math.floor(goal.tokensUsed ?? 0));
  const tokenBudget =
    typeof goal.tokenBudget === 'number' && goal.tokenBudget > 0
      ? Math.floor(goal.tokenBudget)
      : null;
  const timeUsedMs = Math.max(0, Math.floor((goal.timeUsedSeconds ?? 0) * 1000));
  const timeLabel = timeUsedMs > 0 ? formatDurationCompact(timeUsedMs, durationUnitLabels) : '';
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
  const tokensA11yLabel =
    tokenBudget != null
      ? t('sessions.goal.metrics.tokensWithBudget', '{{used}} of {{budget}} tokens used', {
          used: tokensUsed.toLocaleString(),
          budget: tokenBudget.toLocaleString(),
        })
      : t('sessions.goal.metrics.tokens', '{{used}} tokens used', {
          used: tokensUsed.toLocaleString(),
        });
  const showMetrics = timeLabel.length > 0 || showTokens;

  const isExpandable = overflowsCollapsed || expanded;
  const expandLabel = expanded
    ? t('sessions.goal.banner.collapseObjective', 'Collapse goal objective')
    : t('sessions.goal.banner.expandObjective', 'Expand goal objective');

  return (
    <div
      className={cn(
        'relative z-10 w-full border-b',
        meta.surfaceClassName,
        meta.borderClassName,
        // Desktop: dim at rest so the banner yields to the conversation; lift
        // on hover. Skipped on mobile — touch UI shouldn't dim chrome based on
        // a (non-existent) cursor.
        !isMobile && 'opacity-75 transition-opacity hover:opacity-100'
      )}
      role="status"
      aria-label={statusLabel}
    >
      <div className="flex flex-col gap-1 px-3 py-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Target className={cn('h-4 w-4 flex-none', meta.textClassName)} aria-hidden="true" />
            <span
              className={cn(
                'text-[11px] font-semibold uppercase tracking-wide',
                meta.textClassName
              )}
            >
              {t('sessions.goal.banner.label', 'Goal')}
            </span>
            {showMetrics ? (
              <div
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground"
                aria-label={t('sessions.goal.metrics.label', 'Goal usage')}
              >
                {timeLabel ? (
                  <span
                    className="inline-flex items-center gap-1 tabular-nums leading-none"
                    title={t('sessions.goal.metrics.elapsed', 'Elapsed time')}
                  >
                    {/* Inter sits ~1px above the line-box center; nudge the
                        icon up so it optically aligns with the digit row. */}
                    <Clock className="relative -top-px h-3 w-3" aria-hidden="true" />
                    <span>{timeLabel}</span>
                  </span>
                ) : null}
                {showTokens ? (
                  <span
                    className="tabular-nums"
                    title={tokensA11yLabel}
                    aria-label={tokensA11yLabel}
                  >
                    {tokensLabel}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
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
                onClick={() => onDismiss(goal)}
                aria-label={t('sessions.goal.actions.dismiss', 'Dismiss goal banner')}
                title={t('sessions.goal.actions.dismiss', 'Dismiss goal banner')}
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        </div>

        {/* Objective row. Renders as a button only when the collapsed text
            actually clips — keeps short objectives unfocusable so keyboard users
            don't tab through dead controls. The toggle swaps `truncate` for
            `whitespace-pre-wrap` so the full multi-line text reflows in place. */}
        {/* Objective row. Same wrapper regardless of expandable state so the
            measured span keeps the same DOM identity — switching wrapper type
            on overflow detection would re-mount the span and clobber the
            ResizeObserver-driven measurement with a stale 0/0 reading from the
            detached node. When expandable we promote the wrapper to a button-
            style control with a chevron; otherwise it stays a plain region. */}
        <div
          {...(isExpandable
            ? {
                role: 'button',
                tabIndex: 0,
                onClick: toggleExpanded,
                onKeyDown: handleObjectiveKeyDown,
                'aria-expanded': expanded,
                'aria-label': expandLabel,
                title: !expanded ? objective : undefined,
              }
            : {
                title: objective,
                'aria-label': t('sessions.goal.banner.objective', 'Goal objective'),
              })}
          className={cn(
            'flex w-full min-w-0 items-start gap-2 px-1 py-0.5',
            isExpandable &&
              'cursor-pointer rounded-xs transition-colors hover:bg-background/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40'
          )}
        >
          <span
            ref={objectiveRef}
            className={cn(
              'min-w-0 flex-1 text-sm font-medium leading-snug',
              expanded ? 'whitespace-pre-wrap break-words' : 'truncate',
              isCleared ? 'text-muted-foreground line-through' : 'text-foreground'
            )}
          >
            {objective}
          </span>
          {isExpandable ? (
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'mt-0.5 h-3.5 w-3.5 flex-none text-muted-foreground transition-transform',
                expanded && 'rotate-180'
              )}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
});

SessionGoalBanner.displayName = 'SessionGoalBanner';

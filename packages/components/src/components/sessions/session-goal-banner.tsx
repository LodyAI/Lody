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
import { ChevronDown, Clock, Pause, Play, Target, X } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { getGoalStatusPresentation } from '@/lib/session-goal-status';
import { formatDurationCompact, getDurationUnitLabels } from '@/lib/format-duration';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import {
  isSessionGoalCleared,
  isSessionGoalResumable,
  sanitizeGoalObjective,
  type SessionGoalCommand,
  type SessionGoalMessage,
} from '@lody/shared';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontSize,
  themeFontWeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const styles = stylex.create({
  banner: {
    position: 'relative',
    zIndex: 10,
    width: '100%',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
  },
  /** Desktop dims the banner at rest so it yields to the conversation. */
  bannerDimmed: {
    opacity: {
      default: 0.75,
      '@media (hover: hover)': { ':hover': 1 },
    },
    transitionProperty: 'opacity',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[1],
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[1.5],
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: themeSpace[2],
  },
  headerStart: {
    display: 'flex',
    minWidth: 0,
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: themeSpace[2],
    rowGap: themeSpace[1],
  },
  targetGlyph: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
  },
  label: {
    fontSize: '11px',
    fontWeight: themeFontWeight.semibold,
    textTransform: 'uppercase',
    letterSpacing: '0.025em',
  },
  metrics: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: themeSpace[2],
    rowGap: themeSpace[0.5],
    fontSize: '11px',
    color: themeColors.mutedForeground,
  },
  metric: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[1],
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1,
  },
  clockGlyph: {
    position: 'relative',
    top: '-1px',
    width: themeSpace[3],
    height: themeSpace[3],
  },
  metricValue: { fontVariantNumeric: 'tabular-nums' },
  actions: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1.5],
  },
  actionGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },
  objectiveRow: {
    display: 'flex',
    width: '100%',
    minWidth: 0,
    alignItems: 'flex-start',
    gap: themeSpace[2],
    paddingInline: themeSpace[1],
    paddingBlock: themeSpace[0.5],
  },
  /** The expandable objective row answers the pointer like a control. */
  objectiveRowExpandable: {
    cursor: 'pointer',
    borderRadius: themeRadius.xs,
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': 'hsl(var(--background) / 0.4)' },
    },
    // The old Tailwind `focus-visible:ring-*` painted nothing — the app forces
    // Tailwind's own ring transparent — but it still declared a `box-shadow`,
    // and a utility-layer shadow beats the base layer's inset focus ring. So
    // the row showed NO focus indicator at all. Keep it that way.
    boxShadow: { default: null, ':focus-visible': 'none' },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  objective: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: themeFontSize.sm,
    fontWeight: themeFontWeight.medium,
    lineHeight: 1.375,
  },
  objectiveExpanded: {
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  },
  objectiveCollapsed: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  objectiveCleared: {
    color: themeColors.mutedForeground,
    textDecorationLine: 'line-through',
  },
  objectiveActive: { color: themeColors.foreground },
  chevron: {
    marginTop: themeSpace[0.5],
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: themeColors.mutedForeground,
    transitionProperty: 'transform, translate, scale, rotate',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  chevronOpen: { rotate: '180deg' },
});

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
      variant="secondary"
      size="small"
      disabled={disabled}
      onClick={onClick}
      labelColor={
        tone === 'success'
          ? 'hsl(var(--status-success) / 1)'
          : tone === 'danger'
            ? 'hsl(var(--destructive) / 1)'
            : undefined
      }
      className={
        tone === 'success' ? 'border-status-success/40 hover:bg-status-success/10' : undefined
      }
    >
      {loading ? (
        <Spinner diameter="calc(var(--spacing) * 3.5)" aria-hidden="true" />
      ) : (
        <Icon {...stylex.props(styles.actionGlyph)} aria-hidden="true" />
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
    isSessionGoalResumable(goal) && commands?.includes('resume') === true && onGoalCommand != null;
  const showClear = !isCleared && commands?.includes('clear') === true && onGoalCommand != null;
  const showDismiss = isCleared && onDismiss != null;

  const triggerCommand = (command: SessionGoalCommand) => {
    if (isPending) return;
    onGoalCommand?.(command, goal);
  };

  const durationUnitLabels = getDurationUnitLabels(t);
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

  const bannerProps = stylex.props(styles.banner, !isMobile && styles.bannerDimmed);
  const objectiveRowProps = stylex.props(
    styles.objectiveRow,
    isExpandable && styles.objectiveRowExpandable
  );
  const objectiveProps = stylex.props(
    styles.objective,
    expanded ? styles.objectiveExpanded : styles.objectiveCollapsed,
    isCleared ? styles.objectiveCleared : styles.objectiveActive
  );
  const chevronProps = stylex.props(styles.chevron, expanded && styles.chevronOpen);
  const targetGlyphProps = stylex.props(styles.targetGlyph);
  const labelProps = stylex.props(styles.label);

  return (
    <div
      {...bannerProps}
      className={clsx(bannerProps.className, meta.surfaceClassName, meta.borderClassName)}
      role="status"
      aria-label={statusLabel}
    >
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.headerRow)}>
          <div {...stylex.props(styles.headerStart)}>
            <Target
              {...targetGlyphProps}
              className={clsx(targetGlyphProps.className, meta.textClassName)}
              aria-hidden="true"
            />
            <span {...labelProps} className={clsx(labelProps.className, meta.textClassName)}>
              {t('sessions.goal.banner.label', 'Goal')}
            </span>
            {showMetrics ? (
              <div
                {...stylex.props(styles.metrics)}
                aria-label={t('sessions.goal.metrics.label', 'Goal usage')}
              >
                {timeLabel ? (
                  <span
                    {...stylex.props(styles.metric)}
                    title={t('sessions.goal.metrics.elapsed', 'Elapsed time')}
                  >
                    {/* Inter sits ~1px above the line-box center; nudge the
                        icon up so it optically aligns with the digit row. */}
                    <Clock {...stylex.props(styles.clockGlyph)} aria-hidden="true" />
                    <span>{timeLabel}</span>
                  </span>
                ) : null}
                {showTokens ? (
                  <span
                    {...stylex.props(styles.metricValue)}
                    title={tokensA11yLabel}
                    aria-label={tokensA11yLabel}
                  >
                    {tokensLabel}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          <div {...stylex.props(styles.actions)}>
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
                onClick={() => onDismiss(goal)}
                aria-label={t('sessions.goal.actions.dismiss', 'Dismiss goal banner')}
                title={t('sessions.goal.actions.dismiss', 'Dismiss goal banner')}
              >
                <X {...stylex.props(styles.actionGlyph)} aria-hidden="true" />
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
          {...objectiveRowProps}
        >
          <span ref={objectiveRef} {...objectiveProps}>
            {objective}
          </span>
          {isExpandable ? <ChevronDown aria-hidden="true" {...chevronProps} /> : null}
        </div>
      </div>
    </div>
  );
});

SessionGoalBanner.displayName = 'SessionGoalBanner';

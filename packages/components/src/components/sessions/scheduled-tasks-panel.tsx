import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { AlarmClock, CalendarClock, ChevronDown, Repeat } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { getServerNow, resolveFireMs, type PendingScheduledTask } from '@lody/shared';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const styles = stylex.create({
  panel: {
    marginBottom: themeSpace[2],
    overflow: 'hidden',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.6)',
    borderRadius: themeRadius.md,
    backgroundColor: 'hsl(var(--muted) / 0.5)',
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
  },
  toggle: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[1.5],
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[1.5],
    textAlign: 'left',
    color: {
      default: themeColors.mutedForeground,
      '@media (hover: hover)': { ':hover': themeColors.foreground },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  toggleGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: themeColors.primary,
  },
  toggleTitle: {
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  toggleSummary: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  toggleChevron: {
    marginLeft: 'auto',
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    transitionProperty: 'transform, translate, scale, rotate',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  toggleChevronOpen: { rotate: '180deg' },
  listFrame: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.5)',
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[1.5],
  },
  list: {
    display: 'flex',
    maxHeight: '13rem',
    flexDirection: 'column',
    gap: themeSpace[1.5],
    overflowY: 'auto',
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
  },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: themeSpace[2],
  },
  time: {
    width: '3.25rem',
    flexShrink: 0,
    paddingTop: '1px',
    textAlign: 'right',
    fontWeight: themeFontWeight.medium,
    fontVariantNumeric: 'tabular-nums',
    color: themeColors.foreground,
  },
  timeFallback: {
    display: 'flex',
    width: '3.25rem',
    flexShrink: 0,
    justifyContent: 'flex-end',
    paddingTop: themeSpace[0.5],
  },
  timeGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    color: themeColors.mutedForeground,
  },
  rowBody: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  rowMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: themeSpace[1.5],
    rowGap: themeSpace[0.5],
    color: themeColors.mutedForeground,
  },
  rowMetaTitle: {
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  recurring: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[0.5],
  },
  recurringGlyph: { width: themeSpace[3], height: themeSpace[3] },
  rowSummary: {
    overflowWrap: 'break-word',
    color: themeColors.mutedForeground,
  },
});

export interface ScheduledTasksPanelProps {
  tasks: readonly PendingScheduledTask[] | undefined;
  className?: string;
}

/** A one-shot task (wakeup or non-recurring cron) past its fire time by this much is
 *  treated as already fired and hidden. Kept short so the row clears right at fire time
 *  (after a brief "firing now…"), not minutes later. */
const FIRED_HIDE_GRACE_MS = 2_000;

/** Within this window before a fire, tick every second so the countdown/clear is snappy;
 *  the coarse interval elsewhere keeps this cheap. Wider than 60s so a coarse tick can't
 *  skip the whole final minute. */
const FINE_GRAINED_WINDOW_MS = 90_000;
const COARSE_TICK_MS = 30_000;
const FINE_TICK_MS = 1_000;

export type ResolvedScheduledTask = {
  task: PendingScheduledTask;
  /** Concrete next fire time (epoch ms) when we can resolve one. */
  fireMs: number | undefined;
};

/**
 * Ticks the clock so time-derived UI (countdown, absolute time, fired-task hiding) stays
 * live. Self-reschedules and reads `fineGrainedRef` each tick: a 1s cadence in the final
 * ~minute before a fire and while a just-fired task clears, coarse otherwise.
 */
function useAdaptiveClock(active: boolean, fineGrainedRef: RefObject<boolean>): number {
  const [nowMs, setNowMs] = useState(() => getServerNow());
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = () => {
      const delay = fineGrainedRef.current ? FINE_TICK_MS : COARSE_TICK_MS;
      timer = setTimeout(() => {
        if (cancelled) return;
        setNowMs(getServerNow());
        loop();
      }, delay);
    };
    if (active) loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, fineGrainedRef]);
  return nowMs;
}

function useFireTimeFormatter(): (fireMs: number, nowMs: number) => string {
  const { i18n } = useTranslation();
  const locale = i18n.language.replace('_', '-');
  return (fireMs, nowMs) => {
    const fire = new Date(fireMs);
    const now = new Date(nowMs);
    const sameDay =
      fire.getFullYear() === now.getFullYear() &&
      fire.getMonth() === now.getMonth() &&
      fire.getDate() === now.getDate();
    const options: Intl.DateTimeFormatOptions = sameDay
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
    try {
      return new Intl.DateTimeFormat(locale, options).format(fire);
    } catch {
      return new Intl.DateTimeFormat(undefined, options).format(fire);
    }
  };
}

function useRelativeFireLabel(): (fireMs: number, nowMs: number) => string {
  const { t } = useTranslation();
  return (fireMs, nowMs) => {
    const diffMs = fireMs - nowMs;
    if (diffMs <= 5_000) return t('sessions.scheduledTasks.firing');
    const seconds = Math.round(diffMs / 1000);
    if (seconds < 60) return t('sessions.scheduledTasks.firesInSeconds', { count: seconds });
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return t('sessions.scheduledTasks.firesInMinutes', { count: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 24) return t('sessions.scheduledTasks.firesInHours', { count: hours });
    const days = Math.round(hours / 24);
    return t('sessions.scheduledTasks.firesInDays', { count: days });
  };
}

/**
 * Live-resolved view of a session's pending scheduled tasks: concrete next
 * fire times + an adaptive clock (1s cadence in the final ~minute before a
 * fire, coarse otherwise). Shared by the composer panel and the info-bar
 * schedule chip so their countdowns can never drift apart.
 */
export function useResolvedScheduledTasks(tasks: readonly PendingScheduledTask[] | undefined): {
  rows: ResolvedScheduledTask[];
  nowMs: number;
} {
  const hasTimedTask = useMemo(
    () =>
      (tasks ?? []).some((task) =>
        task.kind === 'wakeup'
          ? typeof task.scheduledForMs === 'number'
          : typeof task.humanSchedule === 'string'
      ),
    [tasks]
  );
  // The clock effect reads this each tick to choose its cadence (updated below).
  const fineGrainedRef = useRef(false);
  const nowMs = useAdaptiveClock(hasTimedTask, fineGrainedRef);

  const rows = useMemo<ResolvedScheduledTask[]>(() => {
    return (
      (tasks ?? [])
        .map((task) => ({ task, fireMs: resolveFireMs(task, nowMs) }))
        .filter(({ task, fireMs }) => {
          // Hide one-shot tasks (wakeups + non-recurring cron) once they have fired.
          // Recurring cron always resolves to a future occurrence, so it stays.
          const recurring = task.kind === 'cron' && task.recurring === true;
          if (!recurring && typeof fireMs === 'number') {
            return fireMs > nowMs - FIRED_HIDE_GRACE_MS;
          }
          return true;
        })
        // Soonest fire first; tasks without a resolvable time sink to the bottom.
        .sort((a, b) => (a.fireMs ?? Infinity) - (b.fireMs ?? Infinity))
    );
  }, [tasks, nowMs]);

  // Tick every second while any visible task is within the final window before firing
  // (or just fired and clearing); coarse otherwise.
  fineGrainedRef.current = rows.some(
    ({ fireMs }) => fireMs !== undefined && fireMs - nowMs <= FINE_GRAINED_WINDOW_MS
  );

  return { rows, nowMs };
}

/**
 * Compact panel shown above the composer when a session has future-firing scheduled
 * tasks (cron jobs / wakeups). Lets the user know the session is not fully finished and
 * will trigger again. Tasks are derived from session history (see
 * `collectPendingScheduledTasksFromHistory`); nothing extra is persisted.
 */
export function ScheduledTasksPanel({ tasks, className }: ScheduledTasksPanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { rows, nowMs } = useResolvedScheduledTasks(tasks);

  if (rows.length === 0) return null;

  const panelProps = stylex.props(styles.panel);
  const chevronProps = stylex.props(styles.toggleChevron, expanded && styles.toggleChevronOpen);

  return (
    <div {...panelProps} className={clsx(panelProps.className, className)}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={t('sessions.scheduledTasks.toggle')}
        {...stylex.props(styles.toggle)}
      >
        <AlarmClock {...stylex.props(styles.toggleGlyph)} aria-hidden="true" />
        <span {...stylex.props(styles.toggleTitle)}>{t('sessions.scheduledTasks.heading')}</span>
        <span {...stylex.props(styles.toggleSummary)}>
          · {t('sessions.scheduledTasks.summary', { count: rows.length })}
        </span>
        <ChevronDown {...chevronProps} aria-hidden="true" />
      </button>
      {expanded ? (
        <ScheduledTaskList
          rows={rows}
          nowMs={nowMs}
          className={stylex.props(styles.listFrame).className}
        />
      ) : null}
    </div>
  );
}

/**
 * The resolved task rows (fire time · kind · countdown · summary). Shared by
 * the panel's expanded state and the info-bar schedule chip popover.
 */
export function ScheduledTaskList({
  rows,
  nowMs,
  className,
}: {
  rows: readonly ResolvedScheduledTask[];
  nowMs: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const formatFireTime = useFireTimeFormatter();
  const relativeFireLabel = useRelativeFireLabel();
  const listProps = stylex.props(styles.list);

  return (
    <ul {...listProps} className={clsx('scrollbar-pro', listProps.className, className)}>
      {rows.map(({ task, fireMs }) => {
        const isWakeup = task.kind === 'wakeup';
        const timeLabel = fireMs !== undefined ? formatFireTime(fireMs, nowMs) : undefined;
        const countdown = fireMs !== undefined ? relativeFireLabel(fireMs, nowMs) : undefined;
        return (
          <li key={task.id} {...stylex.props(styles.row)}>
            {/* Fire time, left-aligned. Falls back to a kind icon when unresolved. */}
            {timeLabel ? (
              <time {...stylex.props(styles.time)}>{timeLabel}</time>
            ) : (
              <span {...stylex.props(styles.timeFallback)}>
                {isWakeup ? (
                  <AlarmClock {...stylex.props(styles.timeGlyph)} aria-hidden="true" />
                ) : (
                  <CalendarClock {...stylex.props(styles.timeGlyph)} aria-hidden="true" />
                )}
              </span>
            )}
            <div {...stylex.props(styles.rowBody)}>
              <div {...stylex.props(styles.rowMeta)}>
                <span {...stylex.props(styles.rowMetaTitle)}>
                  {isWakeup
                    ? t('sessions.scheduledTasks.wakeupLabel')
                    : t('sessions.scheduledTasks.cronLabel')}
                </span>
                {countdown ? <span>· {countdown}</span> : null}
                {!isWakeup && task.recurring ? (
                  <span {...stylex.props(styles.recurring)}>
                    <Repeat {...stylex.props(styles.recurringGlyph)} aria-hidden="true" />
                    {t('sessions.scheduledTasks.recurring')}
                  </span>
                ) : null}
              </div>
              {task.summary ? <div {...stylex.props(styles.rowSummary)}>{task.summary}</div> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

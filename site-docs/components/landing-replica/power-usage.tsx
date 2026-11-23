/**
 * Display-only replica of the app's Settings → Usage view (`StatsSettingsView`)
 * for the landing "power" section: range tabs, the two KPI tiles, the "Usage
 * skyline" card (token donut + hourly matrix for 24h/7d, 53-week heatmap for
 * 30d/All, composition rules, range stats) and the two stacked-area charts.
 *
 * Clicking a day (7d dot, 24h bar, heatmap cell) opens the app's day-breakdown
 * panel; the host supplies that day's data through `usageDay`.
 * Framer Motion / Recharts are replaced by CSS animations and a hand-drawn SVG;
 * chart hover tooltips, keyboard grid navigation and the R3F skyline are not replicated.
 */

import NumberFlow from '@number-flow/react';
import { Coins, DollarSign, MousePointerClick, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Button } from './button';
import { cn } from './utils';

// ---- Types -----------------------------------------------------------------

export type UsageRange = 'day' | 'week' | 'month' | 'total';
export type UsageMetric = 'tokens' | 'costUSD';

export type UsageTimelineBucket = {
  bucketStartMs: number;
  bucketLabel: string;
  tokens: number;
  costUSD: number;
  byModel: readonly { modelId: string; tokens: number }[];
  byUser: readonly { userId: string; tokens: number }[];
};

export type UsageTimeline = {
  range: UsageRange;
  startMs: number;
  endMs: number;
  totals: {
    tokens: number;
    costUSD: number;
    breakdown?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      reasoningOutputTokens: number;
    };
  };
  users: Readonly<Record<string, { name: string }>>;
  buckets: readonly UsageTimelineBucket[];
};

export type UsageCalendarDay = {
  dayStartMs: number;
  tokens: number;
  costUSD: number;
  isFuture: boolean;
};

export type UsageCalendar = { startMs: number; days: readonly UsageCalendarDay[] };

/** Breakdown of one calendar day, shown in the panel a day click opens. */
export type UsageDayDetail = {
  dayStartMs: number;
  totals: {
    tokens: number;
    costUSD: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    reasoningOutputTokens: number;
    webSearchRequests: number;
  };
  byModel: readonly { modelId: string; tokens: number }[];
  byUser: readonly { userId: string; tokens: number }[];
  users: Readonly<Record<string, { name: string }>>;
};

export type StackedAreaBucket = {
  label: string;
  values: { id: string; label: string; value: number }[];
};

export type StackedAreaSeries = { id: string; label: string; color: string; total: number };

export type StackedAreaSeriesMarkerRender = (series: StackedAreaSeries) => ReactNode;

export type PowerUsageLabels = {
  title: string;
  range: string;
  windowShort: Record<UsageRange, string>;
  windowLong: Record<UsageRange, string>;
  tokens: string;
  cost: string;
  byModel: string;
  byUser: string;
  empty: string;
  other: string;
  breakdown: { title: string; cache: string; input: string; output: string; reasoning: string };
  skyline: {
    title: string;
    subtitle: string;
    windowSubtitle: string;
    metric: string;
    heatmap: string;
    less: string;
    more: string;
    clickHint: string;
    clickForDetails: string;
    future: string;
    dayDetail: string;
    close: string;
    peakShare: (percent: string) => string;
    webSearches: (count: number) => string;
    otherRows: (count: number, tokens: string) => string;
    activeIntervals: string;
    peakInterval: string;
    averagePerInterval: string;
    total: string;
    dailyAverage: string;
    peakDay: string;
    activeDays: string;
    longestStreak: string;
    noUsage: string;
    currentStreakDetail: (days: number) => string;
    currentIntervalStreakDetail: (count: number) => string;
  };
};

export type PowerUsageViewProps = {
  labels: PowerUsageLabels;
  /** BCP 47 locale for compact units and dates (en → K/M/B, zh-CN → 万/亿). */
  intlLocale: string;
  workspaceName: string;
  range: UsageRange;
  onRangeChange?: (range: UsageRange) => void;
  totals: { tokens: number; costUSD: number };
  byModelBuckets: StackedAreaBucket[];
  byMemberBuckets: StackedAreaBucket[];
  calendar: UsageCalendar;
  timeline: UsageTimeline;
  renderModelSeriesMarker?: StackedAreaSeriesMarkerRender;
  renderMemberSeriesMarker?: StackedAreaSeriesMarkerRender;
  tintModelSeriesLabel?: boolean;
  tintMemberSeriesLabel?: boolean;
  /** USD fraction digits on the cost KPI (0–2). */
  costFractionDigits?: number;
  /** Breakdown for the day selected in the skyline, when one is open. */
  usageDay?: UsageDayDetail;
  onSelectedUsageDayChange?: (dayStartMs: number | null) => void;
  /** Monochrome provider mark for a model row in the day breakdown. */
  renderModelIcon?: (modelId: string) => ReactNode;
};

// ---- Helpers ---------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RANGE_ORDER: UsageRange[] = ['day', 'week', 'month', 'total'];
const SWEEP_EASE = 'cubic-bezier(0.22,1,0.36,1)';

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}

const useReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)');

/** False on the first paint, true one frame later — lets CSS transitions grow from 0. */
function useMountedFrame(skip: boolean): boolean {
  const [ready, setReady] = useState(skip);
  useEffect(() => {
    if (ready) return undefined;
    const id = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(id);
  }, [ready]);
  return ready || skip;
}

function formatCompact(value: number, locale: string): string {
  if (!Number.isFinite(value)) return '0';
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(
    value
  );
}

function formatUsd(value: number, locale: string): string {
  const safe = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(safe);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: abs > 0 && abs < 1 ? 3 : 2,
  }).format(safe);
}

function formatMetric(value: number, metric: UsageMetric, locale: string): string {
  return metric === 'tokens' ? formatCompact(value, locale) : formatUsd(value, locale);
}

function useFormats(locale: string) {
  return useMemo(
    () => ({
      month: new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }),
      weekday: new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }),
      dayShort: new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
      dayOfMonth: new Intl.DateTimeFormat(locale, { day: 'numeric', timeZone: 'UTC' }),
      day: new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      }),
    }),
    [locale]
  );
}

type Formats = ReturnType<typeof useFormats>;

const bucketValue = (bucket: { tokens: number; costUSD: number }, metric: UsageMetric) =>
  metric === 'tokens' ? bucket.tokens : bucket.costUSD;

// ---- Small chrome ----------------------------------------------------------

function StatTile({
  label,
  children,
  footer,
}: {
  label: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="@container relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-lg border border-border/70 bg-card/60 p-4">
      <p className="text-[0.8rem] font-normal text-muted-foreground">{label}</p>
      <div className="mt-auto">
        <div className="flex min-h-[4.25rem] min-w-0 items-center whitespace-nowrap text-3xl font-normal leading-none tracking-tight tabular-nums text-foreground text-[clamp(1.5rem,16cqw,2.75rem)]">
          {children}
        </div>
        <div className="mt-2">{footer}</div>
      </div>
    </div>
  );
}

function TabList<Value extends string>({
  value,
  onChange,
  options,
  label,
  className,
  tabClassName,
  activeClassName,
}: {
  value: Value;
  onChange?: (value: Value) => void;
  options: Array<{ value: Value; label: string }>;
  label: string;
  className: string;
  tabClassName: string;
  activeClassName: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={className}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => onChange?.(option.value)}
          className={cn(
            tabClassName,
            option.value === value ? activeClassName : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const heatColor = (intensity: number) => `hsl(var(--chart-1) / ${intensity.toFixed(3)})`;
const EMPTY_DAY_COLOR = 'hsl(var(--muted-foreground) / 0.14)';
const FUTURE_DAY_COLOR = 'hsl(var(--muted-foreground) / 0.05)';
const RANGE_EMPTY_COLOR = 'hsl(var(--muted-foreground) / 0.11)';
const rangeHeatColor = (intensity: number) => heatColor(0.18 + (0.92 - 0.18) * intensity);

/** Percentile-anchored so one spike hour cannot flatten a whole week. */
function createRangeIntensity(values: number[]): (value: number) => number {
  const active = values.filter((value) => value > 0).sort((a, b) => a - b);
  const reference = active[Math.min(active.length - 1, Math.ceil((active.length - 1) * 0.9))] ?? 0;
  return (value) => (value > 0 && reference > 0 ? Math.min(1, value / reference) ** 0.62 : 0);
}

function HeatLegend({ labels }: { labels: PowerUsageLabels['skyline'] }) {
  return (
    <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
      <span>{labels.less}</span>
      <span
        aria-hidden="true"
        className="h-2 w-20 rounded-full"
        style={{
          backgroundImage: `linear-gradient(to right, ${EMPTY_DAY_COLOR}, ${heatColor(0.2)}, ${heatColor(0.55)}, ${heatColor(1)})`,
        }}
      />
      <span>{labels.more}</span>
    </div>
  );
}

function ClickHint({ text }: { text: string }) {
  return (
    <p className="min-w-0 flex-1 truncate text-xs tabular-nums text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <MousePointerClick className="h-3.5 w-3.5" aria-hidden="true" />
        {text}
      </span>
    </p>
  );
}

/** One track of the hourly matrix; sweeps in with a blurred slide per index. */
function Sweep({
  index,
  reduced,
  axis = 'column',
  children,
}: {
  index: number;
  reduced: boolean;
  axis?: 'column' | 'row';
  children: ReactNode;
}) {
  return (
    <div
      role="presentation"
      className={cn(
        'min-w-0',
        !reduced &&
          'animate-in fade-in blur-in-5 fill-mode-both animation-duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
        !reduced && (axis === 'column' ? 'slide-in-from-bottom-[6px]' : 'slide-in-from-left-2')
      )}
      style={reduced ? undefined : { animationDelay: `${index * 22}ms` }}
    >
      {children}
    </div>
  );
}

const CROSS_FADE = 'animate-in fade-in blur-in-6 duration-200 ease-out';
const HOUR_COLUMNS_CLASS = 'grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[3px]';

function HourAxis() {
  return (
    <div aria-hidden="true" className={cn(HOUR_COLUMNS_CLASS, 'mt-1.5')}>
      {Array.from({ length: 24 }, (_, hour) => (
        <span
          key={hour}
          className="text-center text-[9px] leading-none tabular-nums text-muted-foreground/60"
        >
          {hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}
        </span>
      ))}
    </div>
  );
}

// ---- Hourly matrices (24h / 7d) ---------------------------------------------

/** Opens (or switches) the day breakdown; `null` closes it. */
type SelectDay = (day: { dayStartMs: number; element: HTMLElement } | null) => void;

type ToggleCell = (dayStartMs: number, cellMs: number, element: HTMLElement) => void;

function UsageDayMatrix({
  buckets,
  metric,
  intensityOf,
  reduced,
  locale,
  selectedCellMs,
  onToggleDay,
}: {
  buckets: readonly UsageTimelineBucket[];
  metric: UsageMetric;
  intensityOf: (value: number) => number;
  reduced: boolean;
  locale: string;
  selectedCellMs: number | null;
  onToggleDay: ToggleCell;
}) {
  const maxValue = buckets.reduce((peak, bucket) => Math.max(peak, bucketValue(bucket, metric)), 0);
  return (
    <div>
      <div className={HOUR_COLUMNS_CLASS} role="row">
        {buckets.map((bucket, index) => {
          const value = bucketValue(bucket, metric);
          const height = value > 0 && maxValue > 0 ? Math.max(7, (value / maxValue) * 100) : 0;
          const label = `${bucket.bucketLabel} · ${formatMetric(value, metric, locale)}`;
          const dayStartMs = Math.floor(bucket.bucketStartMs / DAY_MS) * DAY_MS;
          const selected = bucket.bucketStartMs === selectedCellMs;
          return (
            <Sweep key={bucket.bucketStartMs} index={index} reduced={reduced}>
              <button
                type="button"
                role="gridcell"
                title={label}
                aria-label={label}
                aria-selected={selected}
                className="group relative flex w-full cursor-pointer items-end rounded-[3px] outline-none focus-visible:shadow-none hover:bg-muted-foreground/[0.06]"
                style={{ height: 148 }}
                onClick={(event) =>
                  onToggleDay(dayStartMs, bucket.bucketStartMs, event.currentTarget)
                }
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'relative w-full rounded-t-[3px] transition-[height,background-color] duration-300 motion-reduce:transition-none',
                    'group-hover:brightness-110 group-focus-visible:ring-2 group-focus-visible:ring-ring',
                    selected && 'ring-1 ring-foreground'
                  )}
                  style={{
                    height: `${height}%`,
                    backgroundColor: rangeHeatColor(intensityOf(value)),
                  }}
                />
              </button>
            </Sweep>
          );
        })}
      </div>
      <div aria-hidden="true" className="h-px w-full bg-border/70" />
      <HourAxis />
    </div>
  );
}

const WEEK_ROW_PX = 18;

function UsageWeekMatrix({
  timeline,
  metric,
  intensityOf,
  reduced,
  locale,
  formats,
  selectedCellMs,
  onToggleDay,
}: {
  timeline: UsageTimeline;
  metric: UsageMetric;
  intensityOf: (value: number) => number;
  reduced: boolean;
  locale: string;
  formats: Formats;
  selectedCellMs: number | null;
  onToggleDay: ToggleCell;
}) {
  const startDayMs = Math.floor(timeline.startMs / DAY_MS) * DAY_MS;
  const dayStarts = Array.from({ length: 7 }, (_, index) => startDayMs + index * DAY_MS);
  const valuesByBucket = useMemo(
    () =>
      new Map(
        timeline.buckets.map((bucket) => [bucket.bucketStartMs, bucketValue(bucket, metric)])
      ),
    [metric, timeline.buckets]
  );

  return (
    <div className="flex gap-2">
      <div aria-hidden="true" className="flex shrink-0 flex-col gap-[3px]">
        {dayStarts.map((dayStartMs) => (
          <span
            key={dayStartMs}
            className="flex items-center justify-end gap-1 text-[10px] leading-none text-muted-foreground"
            style={{ height: WEEK_ROW_PX }}
          >
            <span>{formats.weekday.format(new Date(dayStartMs))}</span>
            <span className="tabular-nums text-muted-foreground/55">
              {formats.dayOfMonth.format(new Date(dayStartMs))}
            </span>
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-[3px]">
          {dayStarts.map((dayStartMs, dayIndex) => (
            <Sweep key={dayStartMs} index={dayIndex} reduced={reduced} axis="row">
              <div className={HOUR_COLUMNS_CLASS} role="row">
                {Array.from({ length: 24 }, (_, hour) => {
                  const cellMs = dayStartMs + hour * HOUR_MS;
                  const value = valuesByBucket.get(cellMs) ?? 0;
                  const intensity = intensityOf(value);
                  const size = intensity > 0 ? 5 + (13 - 5) * intensity : 4;
                  const label = `${formats.weekday.format(new Date(dayStartMs))} ${String(hour).padStart(2, '0')}:00 · ${formatMetric(value, metric, locale)}`;
                  const selected = cellMs === selectedCellMs;
                  return (
                    <button
                      key={hour}
                      type="button"
                      role="gridcell"
                      title={label}
                      aria-label={label}
                      aria-selected={selected}
                      className="group flex cursor-pointer items-center justify-center outline-none focus-visible:shadow-none"
                      style={{ height: WEEK_ROW_PX }}
                      onClick={(event) => onToggleDay(dayStartMs, cellMs, event.currentTarget)}
                    >
                      {/* `.uw-power__demo--manual-scroll [role='gridcell'] > span.rounded-full`
                          keeps these circular once the 24 tracks get narrower than the dot. */}
                      <span
                        aria-hidden="true"
                        className={cn(
                          'block rounded-full transition-[width,height,background-color,filter] duration-300 motion-reduce:transition-none',
                          'group-hover:brightness-110 group-hover:ring-1 group-hover:ring-foreground/40',
                          'group-focus-visible:ring-2 group-focus-visible:ring-ring',
                          selected && 'ring-1 ring-foreground'
                        )}
                        style={{
                          width: size,
                          height: size,
                          backgroundColor:
                            intensity > 0 ? rangeHeatColor(intensity) : RANGE_EMPTY_COLOR,
                        }}
                      />
                    </button>
                  );
                })}
              </div>
            </Sweep>
          ))}
        </div>
        <HourAxis />
      </div>
    </div>
  );
}

function UsageRangePanel({
  timeline,
  metric,
  labels,
  tokensLabel,
  locale,
  formats,
  reduced,
  selectedDayMs,
  onSelectDay,
}: {
  timeline: UsageTimeline;
  metric: UsageMetric;
  labels: PowerUsageLabels['skyline'];
  tokensLabel: string;
  locale: string;
  formats: Formats;
  reduced: boolean;
  selectedDayMs: number | null;
  onSelectDay: SelectDay;
}) {
  const [selectedCellMs, setSelectedCellMs] = useState<number | null>(null);
  const values = useMemo(
    () => timeline.buckets.map((bucket) => bucketValue(bucket, metric)),
    [metric, timeline.buckets]
  );
  const intensityOf = useMemo(() => createRangeIntensity(values), [values]);
  const peakIndex = values.reduce(
    (peak, value, index) => (value > (values[peak] ?? 0) ? index : peak),
    0
  );
  const peakBucket = timeline.buckets[peakIndex];
  const activeCount = values.filter((value) => value > 0).length;
  const spanLabel =
    timeline.range === 'day'
      ? formats.day.format(new Date(timeline.startMs))
      : `${formats.dayShort.format(new Date(timeline.startMs))} – ${formats.dayShort.format(
          new Date(Math.max(timeline.startMs, timeline.endMs - DAY_MS))
        )}`;

  // Only the very cell that opened the breakdown closes it again; any other cell
  // switches the selection in place, even within the same day.
  const toggleDay: ToggleCell = (dayStartMs, cellMs, element) => {
    if (cellMs === selectedCellMs) {
      setSelectedCellMs(null);
      onSelectDay(null);
      return;
    }
    setSelectedCellMs(cellMs);
    onSelectDay({ dayStartMs, element });
  };

  // The cell ring dies with the selection (e.g. the panel's close button).
  useEffect(() => {
    if (selectedDayMs === null) setSelectedCellMs(null);
  }, [selectedDayMs]);

  const selectedDayTotal =
    selectedDayMs === null
      ? null
      : timeline.buckets.reduce(
          (total, bucket) =>
            Math.floor(bucket.bucketStartMs / DAY_MS) * DAY_MS === selectedDayMs
              ? total + bucketValue(bucket, metric)
              : total,
          0
        );

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="min-w-0 truncate text-[11px] tabular-nums text-muted-foreground">
          {spanLabel}
          <span className="text-muted-foreground/60">
            {` · ${labels.activeIntervals} ${activeCount}/${values.length}`}
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-3">
          {peakBucket && (values[peakIndex] ?? 0) > 0 ? (
            <p className="text-[11px] tabular-nums text-muted-foreground">
              <span className="text-muted-foreground/60">{`${labels.peakInterval} `}</span>
              <span className="font-normal text-foreground">
                {formatMetric(values[peakIndex] ?? 0, metric, locale)}
              </span>
              <span className="text-muted-foreground/60">{` · ${peakBucket.bucketLabel}`}</span>
            </p>
          ) : null}
          <HeatLegend labels={labels} />
        </div>
      </div>
      <div className="mt-3">
        <div role="grid" aria-label={labels.heatmap} className="relative min-h-[10.5rem] min-w-0">
          <div key={timeline.range} className={cn(!reduced && CROSS_FADE)}>
            {timeline.range === 'week' ? (
              <UsageWeekMatrix
                timeline={timeline}
                metric={metric}
                intensityOf={intensityOf}
                reduced={reduced}
                locale={locale}
                formats={formats}
                selectedCellMs={selectedCellMs}
                onToggleDay={toggleDay}
              />
            ) : (
              <UsageDayMatrix
                buckets={timeline.buckets}
                metric={metric}
                intensityOf={intensityOf}
                reduced={reduced}
                locale={locale}
                selectedCellMs={selectedCellMs}
                onToggleDay={toggleDay}
              />
            )}
          </div>
        </div>
      </div>
      <div className="mt-3 flex h-5 items-center">
        {selectedDayMs !== null && selectedDayTotal !== null ? (
          <p
            className="min-w-0 flex-1 truncate text-xs tabular-nums text-muted-foreground"
            aria-live="polite"
          >
            {formats.day.format(new Date(selectedDayMs))}
            {selectedDayTotal > 0
              ? ` · ${formatMetric(selectedDayTotal, metric, locale)}${
                  metric === 'tokens' ? ` ${tokensLabel}` : ''
                }`
              : ` · ${labels.noUsage}`}
          </p>
        ) : (
          <ClickHint text={labels.clickHint} />
        )}
      </div>
    </div>
  );
}

// ---- 53-week heatmap (30d / All) --------------------------------------------

const CAL_COLUMNS = 53;
const CAL_ROWS = 7;
const CAL_CELLS = CAL_COLUMNS * CAL_ROWS;
const CAL_COLUMN_TEMPLATE = `repeat(${CAL_COLUMNS}, minmax(0, 1fr))`;
const CAL_MIN_TRACK_WIDTH = CAL_COLUMNS * 8 + (CAL_COLUMNS - 1) * 4;
const MIN_COLUMNS_BETWEEN_MONTH_LABELS = 3;

type CalendarCell = UsageCalendarDay & { column: number; value: number };

type CalendarModel = {
  cells: CalendarCell[];
  maxValue: number;
  totalValue: number;
  activeDays: number;
  longestStreak: number;
  currentStreak: number;
};

function createCalendarModel(calendar: UsageCalendar, metric: UsageMetric): CalendarModel {
  const cells = Array.from({ length: CAL_CELLS }, (_, index): CalendarCell => {
    const day = calendar.days[index] ?? {
      dayStartMs: calendar.startMs + index * DAY_MS,
      tokens: 0,
      costUSD: 0,
      isFuture: false,
    };
    return { ...day, column: Math.floor(index / CAL_ROWS), value: bucketValue(day, metric) };
  });
  let longestStreak = 0;
  let run = 0;
  let lastCompletedRun = 0;
  for (const cell of cells) {
    if (cell.isFuture) continue;
    if (cell.value > 0) {
      run += 1;
      longestStreak = Math.max(longestStreak, run);
    } else {
      lastCompletedRun = run;
      run = 0;
    }
  }
  return {
    cells,
    maxValue: cells.reduce((peak, cell) => Math.max(peak, cell.value), 0),
    totalValue: cells.reduce((total, cell) => total + cell.value, 0),
    activeDays: cells.filter((cell) => !cell.isFuture && cell.value > 0).length,
    longestStreak,
    currentStreak: run > 0 ? run : lastCompletedRun,
  };
}

/** Outlier-resistant ramp: the 90th percentile maps to full intensity, floor 0.12. */
function createHeatScale(model: CalendarModel): (value: number) => number {
  const active = model.cells
    .filter((cell) => !cell.isFuture && cell.value > 0)
    .map((cell) => cell.value)
    .sort((a, b) => a - b);
  const reference = active[Math.min(active.length - 1, Math.ceil((active.length - 1) * 0.9))] ?? 0;
  return (value) =>
    value > 0 && reference > 0 ? 0.12 + 0.88 * Math.min(1, value / reference) ** 0.6 : 0;
}

function UsageHeatmap({
  model,
  metric,
  labels,
  tokensLabel,
  locale,
  formats,
  windowStartMs,
  selectedDayMs,
  onSelectDay,
}: {
  model: CalendarModel;
  metric: UsageMetric;
  labels: PowerUsageLabels['skyline'];
  tokensLabel: string;
  locale: string;
  formats: Formats;
  windowStartMs?: number;
  selectedDayMs: number | null;
  onSelectDay: SelectDay;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ left: number; top: number } | null>(null);
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const intensityOf = useMemo(() => createHeatScale(model), [model]);
  const todayIndex = model.cells.reduce(
    (latest, cell, index) => (cell.isFuture ? latest : index),
    -1
  );
  const monthLabels = useMemo(() => {
    const candidates: Array<{ column: number; label: string }> = [];
    let previousMonth = -1;
    for (let column = 0; column < CAL_COLUMNS; column += 1) {
      const first = model.cells[column * CAL_ROWS];
      if (!first) continue;
      const month = new Date(first.dayStartMs).getUTCMonth();
      if (month === previousMonth) continue;
      previousMonth = month;
      candidates.push({ column, label: formats.month.format(new Date(first.dayStartMs)) });
    }
    const out: typeof candidates = [];
    let nextLabelColumn = CAL_COLUMNS;
    for (const candidate of candidates.reverse()) {
      if (nextLabelColumn - candidate.column < MIN_COLUMNS_BETWEEN_MONTH_LABELS) continue;
      nextLabelColumn = candidate.column;
      out.unshift(candidate);
    }
    return out;
  }, [formats.month, model.cells]);

  const cellLabel = (cell: CalendarCell) => {
    const date = formats.day.format(new Date(cell.dayStartMs));
    if (cell.isFuture) return `${date} · ${labels.future}`;
    if (cell.value <= 0) return `${date} · ${labels.noUsage}`;
    const suffix = metric === 'tokens' ? ` ${tokensLabel}` : '';
    return `${date} · ${formatMetric(cell.value, metric, locale)}${suffix}`;
  };

  const showDetail = (index: number, element: HTMLElement) => {
    setDetailIndex(index);
    const root = rootRef.current;
    if (!root) return;
    const cellRect = element.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const center = cellRect.left + cellRect.width / 2 - rootRect.left;
    // Keep the bubble inside the card so the first and last weeks stay readable.
    const margin = Math.min(72, rootRect.width / 2);
    setTooltip({
      left: Math.min(Math.max(center, margin), Math.max(margin, rootRect.width - margin)),
      top: cellRect.top - rootRect.top - 6,
    });
  };

  const clearDetail = () => {
    setTooltip(null);
    setDetailIndex(null);
  };

  const toggleDay = (cell: CalendarCell, element: HTMLElement) => {
    if (cell.isFuture) return;
    onSelectDay(
      cell.dayStartMs === selectedDayMs ? null : { dayStartMs: cell.dayStartMs, element }
    );
  };

  const detailCell = detailIndex === null ? null : model.cells[detailIndex];
  const peakShare =
    detailCell && model.maxValue > 0 && detailCell.value > 0
      ? (detailCell.value / model.maxValue) * 100 < 1
        ? '<1'
        : String(Math.round((detailCell.value / model.maxValue) * 100))
      : null;

  return (
    <div ref={rootRef} className="relative space-y-3">
      <div className="@container flex gap-1.5">
        <div
          aria-hidden="true"
          className="mt-[calc(0.625rem+0.375rem)] grid w-7 shrink-0 grid-rows-7 gap-[4px] text-[10px] leading-none text-muted-foreground"
        >
          {Array.from({ length: CAL_ROWS }, (_, row) => {
            const sample = model.cells[row];
            return (
              <span key={row} className="flex items-center">
                {row % 2 === 1 && sample ? formats.weekday.format(new Date(sample.dayStartMs)) : ''}
              </span>
            );
          })}
        </div>
        {/* RTL gives the overflowing calendar a right-edge scroll origin. */}
        <div dir="rtl" className="min-w-0 flex-1 overflow-x-auto pb-1">
          <div
            dir="ltr"
            className="min-w-[var(--usage-heatmap-min-track-width)] px-0.5 @[672px]:min-w-0"
            style={
              { '--usage-heatmap-min-track-width': `${CAL_MIN_TRACK_WIDTH}px` } as CSSProperties
            }
          >
            <div
              className="mb-1.5 grid gap-[4px] text-[10px] leading-none text-muted-foreground"
              style={{ gridTemplateColumns: CAL_COLUMN_TEMPLATE }}
            >
              {monthLabels.map(({ column, label }) => (
                <span
                  key={column}
                  className="whitespace-nowrap"
                  style={{ gridColumn: `${column + 1} / span ${MIN_COLUMNS_BETWEEN_MONTH_LABELS}` }}
                >
                  {label}
                </span>
              ))}
            </div>
            <div
              role="grid"
              aria-label={labels.heatmap}
              className="relative grid grid-rows-7 gap-[4px]"
              style={{ gridTemplateColumns: CAL_COLUMN_TEMPLATE, gridAutoFlow: 'column' }}
              onPointerLeave={clearDetail}
            >
              {model.cells.map((cell, index) => {
                const intensity = cell.isFuture ? 0 : intensityOf(cell.value);
                return (
                  <button
                    key={cell.dayStartMs}
                    type="button"
                    role="gridcell"
                    aria-label={cellLabel(cell)}
                    aria-selected={index === detailIndex}
                    className={cn(
                      'aspect-square w-full rounded-[20%] outline-none',
                      'transition-[filter,opacity] duration-300 motion-reduce:transition-none',
                      !cell.isFuture &&
                        'hover:brightness-110 hover:ring-1 hover:ring-foreground/40',
                      'focus-visible:ring-2 focus-visible:ring-ring',
                      cell.isFuture ? 'cursor-default' : 'cursor-pointer',
                      index === todayIndex && 'ring-1 ring-inset ring-foreground/45',
                      cell.dayStartMs === selectedDayMs && 'ring-1 ring-foreground'
                    )}
                    style={{
                      backgroundColor: cell.isFuture
                        ? FUTURE_DAY_COLOR
                        : intensity > 0
                          ? heatColor(intensity)
                          : EMPTY_DAY_COLOR,
                      opacity:
                        windowStartMs !== undefined && cell.dayStartMs < windowStartMs ? 0.3 : 1,
                    }}
                    onClick={(event) => toggleDay(cell, event.currentTarget)}
                    onPointerEnter={(event) => showDetail(index, event.currentTarget)}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {tooltip && detailCell ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-popover px-2 py-1.5 text-[11px] leading-tight text-popover-foreground shadow-md ring-1 ring-border/70"
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          <span className="font-normal tabular-nums">
            {detailCell.isFuture
              ? labels.future
              : detailCell.value > 0
                ? formatMetric(detailCell.value, metric, locale)
                : labels.noUsage}
          </span>
          <span className="ml-1.5 text-popover-foreground/60">
            {formats.day.format(new Date(detailCell.dayStartMs))}
          </span>
          {!detailCell.isFuture && detailCell.dayStartMs !== selectedDayMs ? (
            <span className="mt-0.5 block text-popover-foreground/50">
              {labels.clickForDetails}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex h-5 items-center justify-between gap-4">
        {detailCell ? (
          <p
            className="min-w-0 flex-1 truncate text-xs tabular-nums text-muted-foreground"
            aria-live="polite"
          >
            {cellLabel(detailCell)}
            {peakShare !== null ? (
              <span className="text-muted-foreground/70">{` · ${labels.peakShare(peakShare)}`}</span>
            ) : null}
          </p>
        ) : (
          <ClickHint text={labels.clickHint} />
        )}
        <HeatLegend labels={labels} />
      </div>
    </div>
  );
}

// ---- Day breakdown panel -------------------------------------------------------

/** Rank-tinted fills: a light tint of the chart blue so eight bars never read as a wall. */
const RANK_FILL_ALPHAS = [0.42, 0.33, 0.26, 0.2, 0.15] as const;
const COMPOSITION_ALPHAS = [0.75, 0.55, 0.38, 0.24] as const;
const DAY_DETAIL_ROW_LIMIT = 5;

type BreakdownRow = { id: string; label: string; tokens: number; icon?: ReactNode };

function RankedBars({
  rows,
  locale,
  otherRows,
}: {
  rows: BreakdownRow[];
  locale: string;
  otherRows: PowerUsageLabels['skyline']['otherRows'];
}) {
  const visible = rows.slice(0, DAY_DETAIL_ROW_LIMIT);
  const max = visible.reduce((peak, row) => Math.max(peak, row.tokens), 0);
  const restTokens = rows
    .slice(DAY_DETAIL_ROW_LIMIT)
    .reduce((sum, row) => sum + Math.max(0, row.tokens), 0);
  return (
    <ul className="space-y-1">
      {visible.map((row, rank) => (
        <li
          key={row.id}
          className="relative h-6 overflow-hidden rounded-[5px] bg-muted-foreground/[0.06]"
        >
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 rounded-[5px]"
            style={{
              width: `${max > 0 ? Math.max(3, (row.tokens / max) * 100) : 0}%`,
              backgroundColor: heatColor(
                RANK_FILL_ALPHAS[Math.min(rank, RANK_FILL_ALPHAS.length - 1)]!
              ),
            }}
          />
          <span className="relative flex h-full items-center gap-1.5 px-2">
            {row.icon}
            <span className="truncate text-[11px] font-normal text-foreground">{row.label}</span>
            <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">
              {formatCompact(row.tokens, locale)}
            </span>
          </span>
        </li>
      ))}
      {restTokens > 0 ? (
        <li className="px-2 pt-0.5 text-[11px] tabular-nums text-muted-foreground/80">
          {otherRows(rows.length - DAY_DETAIL_ROW_LIMIT, formatCompact(restTokens, locale))}
        </li>
      ) : null}
    </ul>
  );
}

function UsageDayDetailPanel({
  dayStartMs,
  anchorX,
  detail,
  labels,
  locale,
  formats,
  renderModelIcon,
  onClose,
}: {
  dayStartMs: number;
  anchorX: number;
  detail: UsageDayDetail | undefined;
  labels: PowerUsageLabels;
  locale: string;
  formats: Formats;
  renderModelIcon?: (modelId: string) => ReactNode;
  onClose: () => void;
}) {
  // Only render numbers once they belong to the day that was actually clicked.
  const day = detail?.dayStartMs === dayStartMs ? detail : undefined;
  const composition = day
    ? [
        {
          key: 'cache',
          label: labels.breakdown.cache,
          value: day.totals.cacheReadInputTokens + day.totals.cacheCreationInputTokens,
        },
        { key: 'input', label: labels.breakdown.input, value: day.totals.inputTokens },
        { key: 'output', label: labels.breakdown.output, value: day.totals.outputTokens },
        {
          key: 'reasoning',
          label: labels.breakdown.reasoning,
          value: day.totals.reasoningOutputTokens,
        },
      ]
        .filter((segment) => segment.value > 0)
        .sort((a, b) => b.value - a.value)
    : [];
  const compositionTotal = composition.reduce((sum, segment) => sum + segment.value, 0);
  const hasUsage = Boolean(day && day.totals.tokens > 0);
  const compositionFill = (index: number) =>
    heatColor(COMPOSITION_ALPHAS[index % COMPOSITION_ALPHAS.length]!);

  return (
    <div className="relative pt-2">
      <span
        aria-hidden="true"
        className="absolute top-0.5 h-3 w-3 -translate-x-1/2 rotate-45 rounded-[2px] bg-muted/60"
        style={{ left: anchorX }}
      />
      <section
        aria-label={labels.skyline.dayDetail}
        className="relative rounded-lg bg-muted/40 p-4"
      >
        <Button
          size="icon"
          variant="ghost"
          aria-label={labels.skyline.close}
          className="absolute right-2 top-2 h-6 w-6 text-muted-foreground"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
        <div className="grid gap-x-6 gap-y-4 lg:grid-cols-[minmax(0,13rem)_1fr]">
          <div className="min-w-0">
            <p className="text-[11px] font-normal text-muted-foreground">
              {formats.day.format(new Date(dayStartMs))}
            </p>
            <p className="mt-1 flex items-baseline gap-1.5">
              <span className="text-2xl font-normal leading-none tabular-nums text-foreground">
                {day ? (
                  <NumberFlow
                    value={day.totals.tokens}
                    locales={locale}
                    format={{ notation: 'compact', maximumFractionDigits: 1 }}
                  />
                ) : (
                  '—'
                )}
              </span>
              <span className="text-xs text-muted-foreground">{labels.tokens}</span>
            </p>
            <p className="mt-1.5 min-h-4 text-xs tabular-nums text-muted-foreground">
              {day
                ? [
                    formatUsd(day.totals.costUSD, locale),
                    day.totals.webSearchRequests > 0
                      ? labels.skyline.webSearches(day.totals.webSearchRequests)
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : ''}
            </p>
            {hasUsage ? (
              <>
                <div aria-hidden="true" className="mt-4 flex h-1.5 overflow-hidden rounded-full">
                  {composition.map((segment, index) => (
                    <span
                      key={segment.key}
                      style={{
                        width: `${(segment.value / compositionTotal) * 100}%`,
                        backgroundColor: compositionFill(index),
                      }}
                    />
                  ))}
                </div>
                <ul className="mt-2 space-y-1">
                  {composition.map((segment, index) => (
                    <li key={segment.key} className="flex items-center gap-1.5 text-[11px]">
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: compositionFill(index) }}
                      />
                      <span className="truncate text-muted-foreground">{segment.label}</span>
                      <span className="ml-auto shrink-0 tabular-nums text-foreground/80">
                        {formatCompact(segment.value, locale)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {day && !hasUsage ? (
              <p className="mt-4 text-xs text-muted-foreground">{labels.skyline.noUsage}</p>
            ) : null}
          </div>

          {hasUsage && day ? (
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <div className="min-w-0">
                <p className="mb-2 text-[11px] font-normal text-muted-foreground">
                  {labels.byModel}
                </p>
                <RankedBars
                  locale={locale}
                  otherRows={labels.skyline.otherRows}
                  rows={day.byModel.map((row) => ({
                    id: row.modelId,
                    label: row.modelId,
                    tokens: row.tokens,
                    icon: renderModelIcon?.(row.modelId),
                  }))}
                />
              </div>
              <div className="min-w-0">
                <p className="mb-2 text-[11px] font-normal text-muted-foreground">
                  {labels.byUser}
                </p>
                <RankedBars
                  locale={locale}
                  otherRows={labels.skyline.otherRows}
                  rows={day.byUser.map((row) => {
                    const label = day.users[row.userId]?.name || row.userId;
                    return {
                      id: row.userId,
                      label,
                      tokens: row.tokens,
                      icon: (
                        <span
                          data-slot="avatar"
                          className="relative flex size-4 shrink-0 overflow-hidden rounded-full"
                        >
                          <span
                            data-slot="avatar-fallback"
                            className="flex size-full items-center justify-center rounded-full bg-foreground/15 text-[8px] font-normal uppercase text-foreground/80"
                          >
                            {label.slice(0, 2)}
                          </span>
                        </span>
                      ),
                    };
                  })}
                />
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

// ---- Donut + composition rules ------------------------------------------------

type Segment = { id: string; label: string; value: number; share: number; color: string };

const RING_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
] as const;
const MODEL_SERIES_COLORS = ['#2563eb', '#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe'] as const;
const MEMBER_SERIES_COLORS = ['#7c3aed', '#9333ea', '#a855f7', '#c084fc', '#e9d5ff'] as const;
const RING_VIEWBOX = 168;
const RING_RADIUS = 66;
const RING_STROKE = 26;
const RING_SLICE_GAP = 0.006;

/** Top 4 rows by tokens plus an "Other" rest, as shares of the total. */
function compositionSegments(
  rows: Array<{ id: string; label: string; tokens: number }>,
  otherLabel: string,
  colors: readonly string[]
): Segment[] {
  const totals = new Map<string, { label: string; tokens: number }>();
  for (const row of rows) {
    if (!(row.tokens > 0)) continue;
    const previous = totals.get(row.id);
    totals.set(row.id, { label: row.label, tokens: (previous?.tokens ?? 0) + row.tokens });
  }
  const sorted = [...totals.entries()]
    .map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
  const visible = sorted.slice(0, 4);
  const hidden = sorted.slice(4);
  if (hidden.length > 0) {
    visible.push({
      id: '__other__',
      label: otherLabel,
      tokens: hidden.reduce((sum, row) => sum + row.tokens, 0),
    });
  }
  const total = visible.reduce((sum, row) => sum + row.tokens, 0);
  return visible.map((row, index) => ({
    id: row.id,
    label: row.label,
    value: row.tokens,
    share: total > 0 ? row.tokens / total : 0,
    color: colors[index % colors.length]!,
  }));
}

function ringSegments(timeline: UsageTimeline, labels: PowerUsageLabels): Segment[] {
  const breakdown = timeline.totals.breakdown;
  if (!breakdown) return [];
  const rows = [
    {
      id: 'cache',
      label: labels.breakdown.cache,
      value: breakdown.cacheReadInputTokens + breakdown.cacheCreationInputTokens,
    },
    { id: 'input', label: labels.breakdown.input, value: breakdown.inputTokens },
    { id: 'output', label: labels.breakdown.output, value: breakdown.outputTokens },
    { id: 'reasoning', label: labels.breakdown.reasoning, value: breakdown.reasoningOutputTokens },
  ].filter((row) => row.value > 0);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return rows.map((row, index) => ({
    ...row,
    share: total > 0 ? row.value / total : 0,
    color: RING_COLORS[index % RING_COLORS.length]!,
  }));
}

function UsageTokenRings({
  segments,
  caption,
  total,
  totalLabel,
  metric,
  locale,
  reduced,
}: {
  segments: Segment[];
  caption: string;
  total: number;
  totalLabel: string;
  metric: UsageMetric;
  locale: string;
  reduced: boolean;
}) {
  const drawn = useMountedFrame(reduced);
  const center = RING_VIEWBOX / 2;
  let start = 0;
  const slices = segments.map((segment) => {
    const slice = { ...segment, start };
    start += segment.share;
    return slice;
  });
  return (
    <div className="flex min-w-0 flex-col items-center">
      <div className="relative w-[9.5rem] max-w-full sm:w-[10.5rem]">
        <svg
          viewBox={`0 0 ${RING_VIEWBOX} ${RING_VIEWBOX}`}
          role="img"
          aria-label={`${caption}: ${segments
            .map((segment) => `${segment.label} ${Math.round(segment.share * 100)}%`)
            .join(', ')}`}
          className="w-full -rotate-90"
        >
          <circle
            cx={center}
            cy={center}
            r={RING_RADIUS}
            fill="none"
            stroke="hsl(var(--muted-foreground))"
            strokeOpacity={0.08}
            strokeWidth={RING_STROKE}
          />
          {slices.map((slice, index) => (
            <g key={slice.id} transform={`rotate(${slice.start * 360} ${center} ${center})`}>
              <circle
                cx={center}
                cy={center}
                r={RING_RADIUS}
                fill="none"
                stroke={slice.color}
                strokeWidth={RING_STROKE}
                pathLength={1}
                strokeDasharray={`${drawn ? Math.max(0.004, slice.share - RING_SLICE_GAP) : 0} 1`}
                style={{
                  transition: reduced
                    ? 'none'
                    : `stroke-dasharray 850ms ${SWEEP_EASE} ${index * 60}ms`,
                }}
              />
            </g>
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-10 text-center">
          <span className="w-full truncate text-[15px] font-normal leading-none tabular-nums tracking-tight text-foreground sm:text-base">
            {metric === 'tokens' ? (
              <NumberFlow
                value={total}
                locales={locale}
                format={{ notation: 'compact', maximumFractionDigits: 1 }}
              />
            ) : (
              formatUsd(total, locale)
            )}
          </span>
          <span className="mt-1 w-full truncate text-[9px] font-normal uppercase tracking-[0.08em] text-muted-foreground">
            {totalLabel}
          </span>
        </div>
      </div>
      <p className="mt-3 w-full text-[10px] font-normal uppercase tracking-[0.08em] text-muted-foreground/80">
        {caption}
      </p>
      <ul className="mt-1.5 grid w-full grid-cols-2 gap-x-3 gap-y-1">
        {segments.map((segment) => (
          <li key={segment.id} className="flex min-w-0 items-center gap-1 text-[10px]">
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: segment.color }}
            />
            <span className="truncate text-muted-foreground">{segment.label}</span>
            <span className="ml-auto shrink-0 tabular-nums text-foreground/70">
              {Math.round(segment.share * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CompositionBar({
  label,
  segments,
  reduced,
}: {
  label: string;
  segments: Segment[];
  reduced: boolean;
}) {
  const grown = useMountedFrame(reduced);
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-normal uppercase tracking-[0.08em] text-muted-foreground/80">
        {label}
      </p>
      <div className="mt-1.5 flex h-1.5 gap-px overflow-hidden rounded-full bg-muted-foreground/10">
        {segments.map((segment) => (
          <span
            key={segment.id}
            title={`${segment.label} · ${Math.round(segment.share * 100)}%`}
            className="h-full transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
            style={{
              backgroundColor: segment.color,
              width: grown ? `${segment.share * 100}%` : 0,
            }}
          />
        ))}
      </div>
      <ul className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {segments.map((segment) => (
          <li key={segment.id} className="flex min-w-0 items-center gap-1 text-[10px]">
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: segment.color }}
            />
            <span className="max-w-[8rem] truncate text-muted-foreground">{segment.label}</span>
            <span className="tabular-nums text-foreground/70">
              {Math.round(segment.share * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Range stats -------------------------------------------------------------

function SummaryStat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] font-normal text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-normal tabular-nums text-foreground">{value}</dd>
      {detail ? <p className="truncate text-[11px] text-muted-foreground/80">{detail}</p> : null}
    </div>
  );
}

const SUMMARY_GRID = 'grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5';

function CalendarSummary({
  model,
  metric,
  labels,
  locale,
  formats,
}: {
  model: CalendarModel;
  metric: UsageMetric;
  labels: PowerUsageLabels['skyline'];
  locale: string;
  formats: Formats;
}) {
  const completed = model.cells.filter((cell) => !cell.isFuture);
  const peak = completed.reduce<CalendarCell | null>(
    (best, cell) => (!best || cell.value > best.value ? cell : best),
    null
  );
  const dailyAverage = completed.length > 0 ? model.totalValue / completed.length : 0;
  return (
    <dl className={SUMMARY_GRID}>
      <SummaryStat label={labels.total} value={formatMetric(model.totalValue, metric, locale)} />
      <SummaryStat label={labels.dailyAverage} value={formatMetric(dailyAverage, metric, locale)} />
      <SummaryStat
        label={labels.peakDay}
        value={formatMetric(peak?.value ?? 0, metric, locale)}
        detail={
          peak && peak.value > 0 ? formats.day.format(new Date(peak.dayStartMs)) : labels.noUsage
        }
      />
      <SummaryStat
        label={labels.activeDays}
        value={String(model.activeDays)}
        detail={labels.currentStreakDetail(model.currentStreak)}
      />
      <SummaryStat label={labels.longestStreak} value={String(model.longestStreak)} />
    </dl>
  );
}

function TimelineSummary({
  timeline,
  metric,
  labels,
  locale,
}: {
  timeline: UsageTimeline;
  metric: UsageMetric;
  labels: PowerUsageLabels['skyline'];
  locale: string;
}) {
  const values = timeline.buckets.map((bucket) => bucketValue(bucket, metric));
  const total = bucketValue(timeline.totals, metric);
  const peakIndex = values.reduce(
    (peak, value, index) => (value > (values[peak] ?? 0) ? index : peak),
    0
  );
  let currentStreak = 0;
  for (let index = values.length - 1; index >= 0 && values[index]! > 0; index -= 1) {
    currentStreak += 1;
  }
  let longestStreak = 0;
  let streak = 0;
  for (const value of values) {
    streak = value > 0 ? streak + 1 : 0;
    longestStreak = Math.max(longestStreak, streak);
  }
  return (
    <dl className={SUMMARY_GRID}>
      <SummaryStat label={labels.total} value={formatMetric(total, metric, locale)} />
      <SummaryStat
        label={labels.averagePerInterval}
        value={formatMetric(values.length > 0 ? total / values.length : 0, metric, locale)}
      />
      <SummaryStat
        label={labels.peakInterval}
        value={formatMetric(values[peakIndex] ?? 0, metric, locale)}
        detail={timeline.buckets[peakIndex]?.bucketLabel ?? labels.noUsage}
      />
      <SummaryStat
        label={labels.activeIntervals}
        value={String(values.filter((value) => value > 0).length)}
        detail={labels.currentIntervalStreakDetail(currentStreak)}
      />
      <SummaryStat label={labels.longestStreak} value={String(longestStreak)} />
    </dl>
  );
}

// ---- Usage skyline card --------------------------------------------------------

type SelectedDay = { dayStartMs: number; anchorX: number };

function UsageSkylineCard({
  calendar,
  timeline,
  labels,
  locale,
  reduced,
  usageDay,
  onSelectedUsageDayChange,
  renderModelIcon,
}: {
  calendar: UsageCalendar;
  timeline: UsageTimeline;
  labels: PowerUsageLabels;
  locale: string;
  reduced: boolean;
  usageDay?: UsageDayDetail;
  onSelectedUsageDayChange?: (dayStartMs: number | null) => void;
  renderModelIcon?: (modelId: string) => ReactNode;
}) {
  const [metric, setMetric] = useState<UsageMetric>('tokens');
  const formats = useFormats(locale);
  const model = useMemo(() => createCalendarModel(calendar, metric), [calendar, metric]);
  const hourly = timeline.range === 'day' || timeline.range === 'week' ? timeline : null;
  const cardRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const selectedElementRef = useRef<HTMLElement | null>(null);
  const [selectedDay, setSelectedDay] = useState<SelectedDay | null>(null);
  // Kept so the panel still has content to render while it collapses.
  const [collapsingDay, setCollapsingDay] = useState<SelectedDay | null>(null);
  const notifiedDayRef = useRef<number | null>(null);

  /** Caret x for a cell, in coordinates of the day panel below the views. */
  const measureAnchorX = (element: HTMLElement) => {
    const container = detailRef.current;
    if (!container) return 0;
    const cellRect = element.getBoundingClientRect();
    return cellRect.left + cellRect.width / 2 - container.getBoundingClientRect().left;
  };

  const selectDay: SelectDay = (day) => {
    selectedElementRef.current = day?.element ?? null;
    const next = day ? { dayStartMs: day.dayStartMs, anchorX: measureAnchorX(day.element) } : null;
    setSelectedDay(next);
    if (next) setCollapsingDay(next);
    const nextDayStartMs = next?.dayStartMs ?? null;
    if (notifiedDayRef.current === nextDayStartMs) return;
    notifiedDayRef.current = nextDayStartMs;
    onSelectedUsageDayChange?.(nextDayStartMs);
  };
  const selectDayRef = useRef(selectDay);
  selectDayRef.current = selectDay;

  // The hourly matrices remount on every range switch, which strands the caret
  // anchor — a selection only survives 30d <-> all-time.
  const hourlyRange = hourly?.range ?? null;
  const previousHourlyRangeRef = useRef(hourlyRange);
  useEffect(() => {
    if (previousHourlyRangeRef.current === hourlyRange) return;
    previousHourlyRangeRef.current = hourlyRange;
    selectDayRef.current(null);
  }, [hourlyRange]);

  // The caret follows its cell when the card resizes or the heatmap scrolls.
  const selectedDayMs = selectedDay?.dayStartMs ?? null;
  useEffect(() => {
    const card = cardRef.current;
    if (selectedDayMs === null || !card) return undefined;
    const sync = () => {
      const element = selectedElementRef.current;
      if (!element || !card.contains(element)) return;
      const anchorX = measureAnchorX(element);
      setSelectedDay((current) => (current ? { ...current, anchorX } : current));
      setCollapsingDay((current) => (current ? { ...current, anchorX } : current));
    };
    const observer = new ResizeObserver(sync);
    observer.observe(card);
    card.addEventListener('scroll', sync, { capture: true, passive: true });
    return () => {
      observer.disconnect();
      card.removeEventListener('scroll', sync, { capture: true });
    };
  }, [selectedDayMs]);
  const rings = useMemo(() => (hourly ? ringSegments(hourly, labels) : []), [hourly, labels]);
  const showRings = hourly !== null && rings.length > 0;
  const modelSegments = useMemo(
    () =>
      compositionSegments(
        timeline.buckets.flatMap((bucket) =>
          bucket.byModel.map((row) => ({ id: row.modelId, label: row.modelId, tokens: row.tokens }))
        ),
        labels.other,
        MODEL_SERIES_COLORS
      ),
    [labels.other, timeline.buckets]
  );
  const memberSegments = useMemo(
    () =>
      compositionSegments(
        timeline.buckets.flatMap((bucket) =>
          bucket.byUser.map((row) => ({
            id: row.userId,
            label: timeline.users[row.userId]?.name ?? row.userId,
            tokens: row.tokens,
          }))
        ),
        labels.other,
        MEMBER_SERIES_COLORS
      ),
    [labels.other, timeline.buckets, timeline.users]
  );

  return (
    <section
      ref={cardRef}
      className="overflow-hidden rounded-lg border border-border/60 bg-card/40"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <h3 className="text-sm font-normal text-foreground">{labels.skyline.title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {hourly
              ? labels.windowLong[hourly.range]
              : timeline.range === 'month'
                ? labels.skyline.windowSubtitle
                : labels.skyline.subtitle}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <TabList
            label={labels.skyline.metric}
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'tokens', label: labels.tokens },
              { value: 'costUSD', label: labels.cost },
            ]}
            className="inline-flex items-center rounded-md bg-muted/60 p-0.5"
            tabClassName="rounded-[5px] px-2.5 py-1 text-xs font-normal transition-colors"
            activeClassName="bg-background text-foreground shadow-xs ring-1 ring-border/70"
          />
        </div>
      </header>

      <div className="p-4">
        <div
          className={cn(
            'relative min-w-0',
            showRings &&
              'grid items-center gap-x-6 gap-y-5 sm:grid-cols-[minmax(0,10.5rem)_minmax(0,1fr)]'
          )}
        >
          {showRings && hourly ? (
            <div className="min-w-0">
              <UsageTokenRings
                segments={rings}
                caption={labels.breakdown.title}
                total={bucketValue(hourly.totals, metric)}
                totalLabel={metric === 'tokens' ? labels.tokens : labels.cost}
                metric={metric}
                locale={locale}
                reduced={reduced}
              />
            </div>
          ) : null}
          <div
            key={hourly ? 'hourly' : 'skyline'}
            className={cn('w-full min-w-0', !reduced && CROSS_FADE)}
          >
            {hourly ? (
              <UsageRangePanel
                timeline={hourly}
                metric={metric}
                labels={labels.skyline}
                tokensLabel={labels.tokens}
                locale={locale}
                formats={formats}
                reduced={reduced}
                selectedDayMs={selectedDayMs}
                onSelectDay={selectDay}
              />
            ) : (
              <UsageHeatmap
                model={model}
                metric={metric}
                labels={labels.skyline}
                tokensLabel={labels.tokens}
                locale={locale}
                formats={formats}
                windowStartMs={timeline.range === 'month' ? timeline.startMs : undefined}
                selectedDayMs={selectedDayMs}
                onSelectDay={selectDay}
              />
            )}
          </div>
        </div>
        {/* A 0fr -> 1fr grid track expands the panel without measuring it; the
            bezier approximates a soft spring. */}
        <div
          ref={detailRef}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-[450ms] ease-[cubic-bezier(0.34,1.25,0.64,1)] motion-reduce:transition-none',
            selectedDay ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          )}
          onTransitionEnd={() => {
            if (!selectedDay) setCollapsingDay(null);
          }}
        >
          <div className="min-h-0 overflow-hidden">
            {collapsingDay ? (
              <UsageDayDetailPanel
                dayStartMs={collapsingDay.dayStartMs}
                anchorX={collapsingDay.anchorX}
                detail={usageDay}
                labels={labels}
                locale={locale}
                formats={formats}
                renderModelIcon={renderModelIcon}
                onClose={() => selectDay(null)}
              />
            ) : null}
          </div>
        </div>
      </div>

      <div className="bg-muted/25 px-4 py-4 sm:px-5">
        <div className="mb-6 grid gap-x-6 gap-y-3 border-t border-border/50 pt-3 sm:grid-cols-2">
          <CompositionBar label={labels.byModel} segments={modelSegments} reduced={reduced} />
          <CompositionBar label={labels.byUser} segments={memberSegments} reduced={reduced} />
        </div>
        {timeline.range === 'total' ? (
          <CalendarSummary
            model={model}
            metric={metric}
            labels={labels.skyline}
            locale={locale}
            formats={formats}
          />
        ) : (
          <TimelineSummary
            timeline={timeline}
            metric={metric}
            labels={labels.skyline}
            locale={locale}
          />
        )}
      </div>
    </section>
  );
}

// ---- Stacked area chart (Recharts replacement) --------------------------------

const AREA_COLORS = ['#2563eb', '#0ea5e9', '#06b6d4', '#10b981', '#f59e0b', '#ef4444'] as const;
const AREA_OTHER_COLOR = '#6b7280';
const AREA_MAX_SERIES = 6;
const AXIS_COLOR = 'hsl(var(--muted-foreground))';
const GRID_COLOR = 'hsl(var(--border))';
const Y_AXIS_WIDTH = 52;
const X_AXIS_HEIGHT = 30;
const PLOT_MARGIN = { top: 8, right: 12 };

type PreparedChart = { series: StackedAreaSeries[]; rows: Array<Record<string, number>> };

function prepareChart(buckets: StackedAreaBucket[], otherLabel: string): PreparedChart | null {
  if (buckets.length === 0) return null;
  const totals = new Map<string, { label: string; total: number }>();
  for (const bucket of buckets) {
    for (const item of bucket.values) {
      const existing = totals.get(item.id);
      if (existing) existing.total += item.value;
      else totals.set(item.id, { label: item.label, total: item.value });
    }
  }
  const sorted = [...totals.entries()]
    .map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => b.total - a.total);
  const visible = sorted.slice(0, AREA_MAX_SERIES);
  const hidden = sorted.slice(AREA_MAX_SERIES);
  const series: StackedAreaSeries[] = visible.map((entry, index) => ({
    id: entry.id,
    label: entry.label,
    color: AREA_COLORS[index % AREA_COLORS.length]!,
    total: entry.total,
  }));
  if (hidden.length > 0) {
    series.push({
      id: '__other__',
      label: otherLabel,
      color: AREA_OTHER_COLOR,
      total: hidden.reduce((sum, entry) => sum + entry.total, 0),
    });
  }
  const visibleIds = new Set(visible.map((entry) => entry.id));
  const rows = buckets.map((bucket) => {
    const row: Record<string, number> = Object.fromEntries(series.map((s) => [s.id, 0]));
    for (const item of bucket.values) {
      const key = visibleIds.has(item.id) ? item.id : '__other__';
      row[key] = (row[key] ?? 0) + item.value;
    }
    return row;
  });
  return { series, rows };
}

/** Recharts-style nice ticks: 4 steps from 0, step rounded up to 0.05 × 10ⁿ. */
function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0, 1, 2, 3, 4];
  const rough = max / 4;
  const digits = Math.floor(Math.log10(rough)) + 1;
  const unit = 10 ** digits;
  const step = Math.ceil(rough / unit / 0.05 - 1e-9) * 0.05 * unit;
  return [0, 1, 2, 3, 4].map((index) => index * step);
}

/** d3 `curveMonotoneX` as an SVG path fragment (no leading move). */
function monotonePath(points: Array<[number, number]>): string {
  const n = points.length;
  if (n < 2) return '';
  if (n === 2) return `L${points[1]![0]},${points[1]![1]}`;
  const sign = (value: number) => (value < 0 ? -1 : 1);
  const tangents = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i += 1) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[i + 1]!;
    const h0 = x1 - x0;
    const h1 = x2 - x1;
    const s0 = (y1 - y0) / (h0 || (h1 < 0 ? -0 : 0));
    const s1 = (y2 - y1) / (h1 || (h0 < 0 ? -0 : 0));
    const p = (s0 * h1 + s1 * h0) / (h0 + h1);
    tangents[i] =
      (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }
  const endSlope = (a: [number, number], b: [number, number], t: number) => {
    const h = b[0] - a[0];
    return h ? ((3 * (b[1] - a[1])) / h - t) / 2 : t;
  };
  tangents[0] = endSlope(points[0]!, points[1]!, tangents[1]!);
  tangents[n - 1] = endSlope(points[n - 2]!, points[n - 1]!, tangents[n - 2]!);
  let path = '';
  for (let i = 0; i < n - 1; i += 1) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const dx = (x1 - x0) / 3;
    path += `C${x0 + dx},${y0 + dx * tangents[i]!},${x1 - dx},${y1 - dx * tangents[i + 1]!},${x1},${y1}`;
  }
  return path;
}

function useElementWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function StackedAreaPlot({
  prepared,
  labels,
  width,
  height,
  formatValue,
}: {
  prepared: PreparedChart;
  labels: string[];
  width: number;
  height: number;
  formatValue: (value: number) => string;
}) {
  const gradientPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const left = Y_AXIS_WIDTH;
  const right = width - PLOT_MARGIN.right;
  const top = PLOT_MARGIN.top;
  const bottom = height - X_AXIS_HEIGHT;
  const stacks = prepared.rows.map((row) => {
    let sum = 0;
    return prepared.series.map((s) => (sum += row[s.id] ?? 0));
  });
  const ticks = niceTicks(Math.max(0, ...stacks.map((stack) => stack.at(-1) ?? 0)));
  const domainMax = ticks.at(-1) || 1;
  const count = prepared.rows.length;
  const xAt = (index: number) =>
    count === 1 ? (left + right) / 2 : left + ((right - left) * index) / (count - 1);
  const yAt = (value: number) => bottom - ((bottom - top) * value) / domainMax;
  const xInterval = Math.max(0, Math.ceil(count / 8) - 1);

  return (
    <svg width={width} height={height} className="block overflow-visible">
      {ticks.map((tick) => (
        <line
          key={tick}
          x1={left}
          x2={right}
          y1={yAt(tick)}
          y2={yAt(tick)}
          stroke={GRID_COLOR}
          strokeOpacity={0.4}
        />
      ))}
      {prepared.series.map((s, seriesIndex) => {
        const upper = stacks.map((stack, index): [number, number] => [
          xAt(index),
          yAt(stack[seriesIndex] ?? 0),
        ]);
        const lower = stacks
          .map((stack, index): [number, number] => [
            xAt(index),
            yAt(seriesIndex > 0 ? (stack[seriesIndex - 1] ?? 0) : 0),
          ])
          .reverse();
        const line = `M${upper[0]![0]},${upper[0]![1]}${monotonePath(upper)}`;
        const area = `${line}L${lower[0]![0]},${lower[0]![1]}${monotonePath(lower)}Z`;
        const gradientId = `${gradientPrefix}-${seriesIndex}`;
        return (
          <g key={s.id}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.42} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0.08} />
              </linearGradient>
            </defs>
            <path d={area} fill={`url(#${gradientId})`} stroke="none" />
            <path d={line} fill="none" stroke={s.color} strokeWidth={1.25} strokeOpacity={0.9} />
          </g>
        );
      })}
      <line x1={left} x2={right} y1={bottom} y2={bottom} stroke={GRID_COLOR} strokeOpacity={0.6} />
      {labels.map((label, index) =>
        index % (xInterval + 1) === 0 ? (
          <text
            key={index}
            x={xAt(index)}
            y={bottom + 14}
            dy="0.71em"
            textAnchor="middle"
            fill={AXIS_COLOR}
            fontSize={10}
          >
            {label}
          </text>
        ) : null
      )}
      {ticks.map((tick) => (
        <text
          key={tick}
          x={left - 8}
          y={yAt(tick)}
          dy="0.355em"
          textAnchor="end"
          fill={AXIS_COLOR}
          fontSize={10}
        >
          {formatValue(tick)}
        </text>
      ))}
    </svg>
  );
}

function UsageStackedAreaChart({
  title,
  buckets,
  emptyText,
  otherLabel,
  formatValue,
  renderSeriesMarker,
  tintSeriesLabel = false,
}: {
  title: string;
  buckets: StackedAreaBucket[];
  emptyText: string;
  otherLabel: string;
  formatValue: (value: number) => string;
  renderSeriesMarker?: StackedAreaSeriesMarkerRender;
  tintSeriesLabel?: boolean;
}) {
  const isMobile = useMediaQuery('(max-width: 639px)');
  const chartHeight = isMobile ? 184 : 224;
  const prepared = useMemo(() => prepareChart(buckets, otherLabel), [buckets, otherLabel]);
  const [plotRef, width] = useElementWidth();
  const header = (
    <header className="flex min-h-10 items-center gap-2 border-b border-border/70 dark:bg-muted/40 px-3 py-1.5">
      <p className="text-xs font-normal text-muted-foreground">{title}</p>
    </header>
  );

  if (!prepared) {
    return (
      <div className="rounded-lg border border-border/70 bg-card/60 text-sm">
        {header}
        <div className="p-4">
          <p className="text-sm text-muted-foreground">{emptyText}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-card/60">
      {header}
      <div className="p-4">
        <div ref={plotRef} style={{ height: chartHeight }}>
          {width > 0 ? (
            <StackedAreaPlot
              prepared={prepared}
              labels={buckets.map((bucket) => bucket.label)}
              width={width}
              height={chartHeight}
              formatValue={formatValue}
            />
          ) : null}
        </div>
      </div>
      <div className="border-t border-border/60 px-4 pb-3 pt-2">
        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
          {prepared.series.map((s) => (
            <div key={s.id} className="inline-flex items-center gap-1.5 text-xs">
              {renderSeriesMarker ? (
                renderSeriesMarker(s)
              ) : (
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-xs"
                  style={{ backgroundColor: s.color }}
                />
              )}
              <span
                className={
                  tintSeriesLabel
                    ? 'max-w-[200px] truncate whitespace-nowrap font-normal'
                    : 'max-w-[200px] truncate whitespace-nowrap text-muted-foreground'
                }
                style={tintSeriesLabel ? { color: s.color } : undefined}
              >
                {s.label}
              </span>
              <span className="shrink-0 whitespace-nowrap font-mono text-foreground">
                {formatValue(s.total)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- View ----------------------------------------------------------------------

export function PowerUsageView({
  labels,
  intlLocale,
  workspaceName,
  range,
  onRangeChange,
  totals,
  byModelBuckets,
  byMemberBuckets,
  calendar,
  timeline,
  renderModelSeriesMarker,
  renderMemberSeriesMarker,
  tintModelSeriesLabel,
  tintMemberSeriesLabel,
  costFractionDigits = 2,
  usageDay,
  onSelectedUsageDayChange,
  renderModelIcon,
}: PowerUsageViewProps) {
  const reduced = useReducedMotion();
  const costDigits = Math.max(0, Math.min(2, costFractionDigits));
  const formatTokens = useMemo(
    () => (value: number) => formatCompact(value, intlLocale),
    [intlLocale]
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-normal leading-tight text-foreground">
            {workspaceName || labels.title}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{labels.windowLong[range]}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <TabList
            label={labels.range}
            value={range}
            onChange={onRangeChange}
            options={RANGE_ORDER.map((value) => ({ value, label: labels.windowShort[value] }))}
            className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5"
            tabClassName="rounded-md px-3 py-1 text-xs font-normal transition-colors"
            activeClassName="bg-background text-foreground shadow-xs"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatTile
          label={labels.tokens}
          footer={
            <Coins className="absolute -bottom-8 -right-8 h-60 w-60 text-muted-foreground/10 dark:text-muted-foreground/5" />
          }
        >
          <NumberFlow
            value={totals.tokens}
            locales={intlLocale}
            format={{ notation: 'compact', maximumFractionDigits: 1 }}
          />
        </StatTile>
        <StatTile
          label={labels.cost}
          footer={
            <DollarSign className="absolute -bottom-5 -right-10 h-50 w-50 text-muted-foreground/10 dark:text-muted-foreground/5 rotate-[-25deg]" />
          }
        >
          <NumberFlow
            value={totals.costUSD}
            locales={intlLocale}
            format={{
              style: 'currency',
              currency: 'USD',
              currencyDisplay: 'narrowSymbol',
              minimumFractionDigits: costDigits,
              maximumFractionDigits: costDigits,
            }}
          />
        </StatTile>
      </div>

      <UsageSkylineCard
        calendar={calendar}
        timeline={timeline}
        labels={labels}
        locale={intlLocale}
        reduced={reduced}
        usageDay={usageDay}
        onSelectedUsageDayChange={onSelectedUsageDayChange}
        renderModelIcon={renderModelIcon}
      />

      <UsageStackedAreaChart
        title={labels.byModel}
        buckets={byModelBuckets}
        emptyText={labels.empty}
        otherLabel={labels.other}
        formatValue={formatTokens}
        renderSeriesMarker={renderModelSeriesMarker}
        tintSeriesLabel={tintModelSeriesLabel}
      />
      <UsageStackedAreaChart
        title={labels.byUser}
        buckets={byMemberBuckets}
        emptyText={labels.empty}
        otherLabel={labels.other}
        formatValue={formatTokens}
        renderSeriesMarker={renderMemberSeriesMarker}
        tintSeriesLabel={tintMemberSeriesLabel}
      />
    </div>
  );
}

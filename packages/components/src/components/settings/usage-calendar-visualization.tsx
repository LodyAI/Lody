import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import NumberFlow from '@number-flow/react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  Box,
  Copy,
  Download,
  FileText,
  LoaderCircle,
  MousePointerClick,
  Share2,
  X,
} from 'lucide-react';
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@/ui/avatar';
import { Button } from '@/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { formatCompactNumber, formatUsdAmount } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { cn } from '@/lib/utils';
import { ModelBrandIcon } from '@/components/icons/model-brand-icon';
import { stripRecommended } from '@/components/shared/acp-selector-options';
import type {
  SettingsUsageCalendarData,
  SettingsUsageDayData,
  SettingsUsageTimelineBucket,
  SettingsUsageTimelineData,
} from './settings-data-cache';
import {
  createUsageCalendarModel,
  createUsageHeatScale,
  createUsageSkylineLodyLogoTriangles,
  createUsageSkylineAscii,
  createUsageSkylineBinaryStl,
  getUsageColumnHeight,
  USAGE_CALENDAR_CELLS,
  USAGE_CALENDAR_COLUMNS,
  USAGE_CALENDAR_ROWS,
  USAGE_SKYLINE_STL_BASE_HEIGHT,
  USAGE_SKYLINE_STL_BACK_MARGIN,
  USAGE_SKYLINE_STL_BASE_DEPTH,
  USAGE_SKYLINE_STL_BASE_WIDTH,
  USAGE_SKYLINE_STL_CELL_SIZE,
  USAGE_SKYLINE_STL_COLUMN_HEIGHT_MULTIPLIER,
  type UsageCalendarCell,
  type UsageCalendarMetric,
  type UsageCalendarModel,
} from './usage-calendar-model';
import { createUsageShareCard, type UsageShareCardStyle } from './usage-share-card';
import { scheduleUsageShareCardFontPreload } from './usage-share-card-fonts';

type UsageShareCardPreview = {
  file: File;
  style: UsageShareCardStyle;
  url: string;
};

// Export generation remains available in code while the settings UI focuses on the active views.
const SHOW_SKYLINE_EXPORTS = false;
// Share card is hidden while its ticket art is being reworked. The renderer, the
// preview popover, and the Storybook gallery all stay wired up behind this flag.
const SHOW_SHARE_CARD = false;

/**
 * The heatmap paints one theme token at varying alpha instead of a fixed five-step
 * palette, so the ramp reads the same way in light and dark mode and stays smooth.
 * `--chart-1` is the blue anchor of the chart palette and is defined only in the
 * light/dark roots, so it stays blue under themes that repaint `--primary`.
 */
const heatColor = (intensity: number) => `hsl(var(--chart-1) / ${intensity.toFixed(3)})`;
const EMPTY_DAY_COLOR = 'hsl(var(--muted-foreground) / 0.14)';
const FUTURE_DAY_COLOR = 'hsl(var(--muted-foreground) / 0.05)';

/** Product language for compact units — never the host OS default. */
function usageIntlLocale(): string {
  return toIntlLocaleOrEn(i18next.resolvedLanguage ?? i18next.language);
}

function formatTokens(value: number, locale: string = usageIntlLocale()): string {
  return formatCompactNumber(value, locale);
}

function formatCost(value: number, locale: string = usageIntlLocale()): string {
  // Daily costs are often fractions of a cent; two digits would render them all as $0.00.
  return formatUsdAmount(value, locale);
}

function formatMetric(
  value: number,
  metric: UsageCalendarMetric,
  locale: string = usageIntlLocale()
): string {
  return metric === 'tokens' ? formatTokens(value, locale) : formatCost(value, locale);
}

function fileStem(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'lody-usage';
}

function downloadBlob(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function SegmentedControl<Value extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: Value;
  onChange: (value: Value) => void;
  options: Array<{ value: Value; label: ReactNode; title?: string }>;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex items-center rounded-md bg-muted/60 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          title={option.title}
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors',
            value === option.value
              ? 'bg-background text-foreground shadow-xs ring-1 ring-border/70'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Columns that open a new month, thinned out so short month names cannot collide. */
const MIN_COLUMNS_BETWEEN_MONTH_LABELS = 3;
/** Per-week delay of the reveal sweep; 53 weeks land in roughly 0.6s. */
const CELL_REVEAL_STAGGER_MS = 11;
/** Floor on a day's rendered size in a compact panel. */
const CELL_MIN_SIZE_PX = 8;
// One additional pixel keeps a wide 53-week calendar airy without making the
// calendar itself narrower; the tracks still consume the entire container.
const CELL_GAP_PX = 4;
// The compact panel keeps its own minimum track width. Once its actual container
// is wide enough, the grid itself owns all available width instead of introducing
// a desktop scrollbar from an unrelated fixed width.
const HEATMAP_COLUMN_TEMPLATE = `repeat(${USAGE_CALENDAR_COLUMNS}, minmax(0, 1fr))`;
const HEATMAP_MIN_TRACK_WIDTH =
  USAGE_CALENDAR_COLUMNS * CELL_MIN_SIZE_PX + (USAGE_CALENDAR_COLUMNS - 1) * CELL_GAP_PX;

function useCalendarFormats() {
  const { i18n } = useTranslation();
  const locale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  return useMemo(
    () => ({
      locale,
      month: new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }),
      weekday: new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }),
      /** Compact span endpoints such as "Jul 20"; the year lives in the range label. */
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

function useMonthLabels(model: UsageCalendarModel, format: Intl.DateTimeFormat) {
  return useMemo(() => {
    const candidates: Array<{ column: number; label: string }> = [];
    let previousMonth = -1;
    for (const [column, week] of model.weeks.entries()) {
      const firstDay = week[0];
      if (!firstDay) continue;
      const month = new Date(firstDay.dayStartMs).getUTCMonth();
      if (month === previousMonth) continue;
      previousMonth = month;
      candidates.push({ column, label: format.format(new Date(firstDay.dayStartMs)) });
    }
    // Thin out from the right so a crowded partial month at the very start is what
    // gets dropped, never the full month that follows it.
    const labels: Array<{ column: number; label: string }> = [];
    let nextLabelColumn = USAGE_CALENDAR_COLUMNS;
    for (const candidate of candidates.reverse()) {
      if (nextLabelColumn - candidate.column < MIN_COLUMNS_BETWEEN_MONTH_LABELS) continue;
      nextLabelColumn = candidate.column;
      labels.unshift(candidate);
    }
    return labels;
  }, [format, model.weeks]);
}

function HeatLegend() {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
      <span>{t('workspace.usage.skyline.less')}</span>
      <span
        aria-hidden="true"
        className="h-2 w-20 rounded-full"
        style={{
          backgroundImage: `linear-gradient(to right, ${EMPTY_DAY_COLOR}, ${heatColor(0.2)}, ${heatColor(0.55)}, ${heatColor(1)})`,
        }}
      />
      <span>{t('workspace.usage.skyline.more')}</span>
    </div>
  );
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The range panel keeps its blue deliberately quiet: even the densest hour stops
 * short of the full-saturation chart blue, so a busy week reads as light rather
 * than a solid slab. The year heatmap above still uses the full ramp — it has far
 * more empty space to carry it.
 */
const RANGE_HEAT_FLOOR = 0.18;
const RANGE_HEAT_CEILING = 0.92;
const rangeHeatColor = (intensity: number) =>
  heatColor(RANGE_HEAT_FLOOR + (RANGE_HEAT_CEILING - RANGE_HEAT_FLOOR) * intensity);
const RANGE_EMPTY_COLOR = 'hsl(var(--muted-foreground) / 0.11)';

/**
 * Percentile-anchored so one spike hour cannot flatten a whole week; the gamma
 * lifts the quiet-but-not-empty buckets that a linear ramp loses.
 */
function createRangeIntensity(values: number[]): (value: number) => number {
  const active = values.filter((value) => value > 0).sort((a, b) => a - b);
  const reference = active[Math.min(active.length - 1, Math.ceil((active.length - 1) * 0.9))] ?? 0;
  return (value: number) =>
    value > 0 && reference > 0 ? Math.min(1, value / reference) ** 0.62 : 0;
}

/** Per-track delay of the reveal sweep; the widest range (24 columns) lands in ~0.8s. */
const RANGE_SWEEP_STEP_S = 0.022;
const RANGE_SWEEP_EASE = [0.22, 1, 0.36, 1] as const;

/**
 * One track of the matrix — an hour column in 24h, a day row in 7d. The sweep is
 * a blurred slide that resolves in order, which is what makes the ranges read as
 * one object changing shape rather than three separate charts. Motion lives on
 * the track, not on each of the 168 cells, so the blur stays cheap.
 */
function RangeSweep({
  index,
  reduced,
  axis = 'column',
  className,
  children,
}: {
  index: number;
  reduced: boolean;
  axis?: 'column' | 'row';
  className?: string;
  children: ReactNode;
}) {
  return (
    <motion.div
      // Presentational: the wrapper only carries the sweep, so the grid still
      // sees its cells directly.
      role="presentation"
      className={cn('min-w-0', className)}
      initial={
        reduced
          ? false
          : { opacity: 0, filter: 'blur(5px)', ...(axis === 'column' ? { y: 6 } : { x: -8 }) }
      }
      animate={{ opacity: 1, x: 0, y: 0, filter: 'blur(0px)' }}
      transition={
        reduced
          ? { duration: 0 }
          : { duration: 0.36, delay: index * RANGE_SWEEP_STEP_S, ease: RANGE_SWEEP_EASE }
      }
    >
      {children}
    </motion.div>
  );
}

/** Hours are labelled every three; a label on all 24 becomes noise. */
const HOUR_LABEL_STEP = 3;
/** 24 hour tracks, shared by the 24h bars, the 7d dot rows, and the hour axis. */
const HOUR_COLUMNS_CLASS = 'grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[3px]';

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function HourAxis() {
  return (
    <div aria-hidden="true" className={cn(HOUR_COLUMNS_CLASS, 'mt-1.5')}>
      {Array.from({ length: 24 }, (_, hour) => (
        <span
          key={hour}
          className="text-center text-[9px] leading-none tabular-nums text-muted-foreground/60"
        >
          {hour % HOUR_LABEL_STEP === 0 ? String(hour).padStart(2, '0') : ''}
        </span>
      ))}
    </div>
  );
}

/** Tallest an hour bar gets; the 7d rows below are sized to land near the same block. */
const DAY_BAR_TRACK_PX = 148;

/**
 * 24h: a skyline silhouette — one flat bar per hour standing on a baseline, no
 * empty track behind it. Height carries magnitude and the fill's light carries
 * share of the peak. Every bar opens the breakdown of the day it belongs to.
 */
function UsageDayMatrix({
  buckets,
  metric,
  intensityOf,
  reduced,
  selectedCellMs,
  onToggleDay,
}: {
  buckets: SettingsUsageTimelineBucket[];
  metric: UsageCalendarMetric;
  intensityOf: (value: number) => number;
  reduced: boolean;
  /** Exact hour bucket that opened the breakdown; only it carries the ring. */
  selectedCellMs: number | null;
  onToggleDay: (dayStartMs: number, cellMs: number, element: HTMLElement | null) => void;
}) {
  const maxValue = buckets.reduce(
    (peak, bucket) => Math.max(peak, metric === 'tokens' ? bucket.tokens : bucket.costUSD),
    0
  );
  // Roving tabindex: the 24 bars are one tab stop, arrow keys walk hours.
  const cellRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const focusCell = useCallback(
    (index: number) => {
      const next = Math.min(Math.max(index, 0), buckets.length - 1);
      setFocusIndex(next);
      cellRefs.current[next]?.focus();
    },
    [buckets.length]
  );
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const deltas: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
    const delta = deltas[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      focusCell(index + delta);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusCell(event.key === 'Home' ? 0 : buckets.length - 1);
    }
  };

  return (
    <div>
      <div className={HOUR_COLUMNS_CLASS} role="row">
        {buckets.map((bucket, index) => {
          const value = metric === 'tokens' ? bucket.tokens : bucket.costUSD;
          const intensity = intensityOf(value);
          const height = value > 0 && maxValue > 0 ? Math.max(7, (value / maxValue) * 100) : 0;
          const label = `${bucket.bucketLabel} · ${formatMetric(value, metric)}`;
          const dayStartMs = Math.floor(bucket.bucketStartMs / DAY_MS) * DAY_MS;
          const selected = bucket.bucketStartMs === selectedCellMs;
          return (
            <RangeSweep key={bucket.bucketStartMs} index={index} reduced={reduced}>
              <button
                ref={(element) => {
                  cellRefs.current[index] = element;
                }}
                type="button"
                role="gridcell"
                tabIndex={index === focusIndex ? 0 : -1}
                title={label}
                aria-label={label}
                aria-selected={selected}
                className={cn(
                  // focus-visible:shadow-none opts out of the global inset
                  // primary focus border; the bar carries the focus ring instead.
                  'group relative flex w-full cursor-pointer items-end rounded-[3px] outline-none',
                  'focus-visible:shadow-none',
                  // The hover wash marks the whole column as a target, since an
                  // empty hour has no bar to point at. No transition: hover
                  // feedback should be instant.
                  'hover:bg-muted-foreground/[0.06]'
                )}
                style={{ height: DAY_BAR_TRACK_PX }}
                onClick={(event) =>
                  onToggleDay(dayStartMs, bucket.bucketStartMs, event.currentTarget)
                }
                onKeyDown={(event) => onKeyDown(event, index)}
                onFocus={() => setFocusIndex(index)}
              >
                {/* Ring lives on the bar, not the button: the global focus reset
                    kills ring shadows on any focused element, so a ring on the
                    button would vanish right after the click. */}
                <span
                  aria-hidden="true"
                  className={cn(
                    // Filter is excluded so the hover brightening is instant;
                    // height and color still animate on a metric switch.
                    'relative w-full rounded-t-[3px] transition-[height,background-color] duration-300 motion-reduce:transition-none',
                    'group-hover:brightness-110 group-focus-visible:ring-2 group-focus-visible:ring-ring',
                    selected && 'ring-1 ring-foreground'
                  )}
                  style={{
                    height: `${height}%`,
                    backgroundColor: rangeHeatColor(intensity),
                  }}
                />
              </button>
            </RangeSweep>
          );
        })}
      </div>
      <div aria-hidden="true" className="h-px w-full bg-border/70" />
      <HourAxis />
    </div>
  );
}

/** Row pitch of the 7d grid, chosen so seven days land near the 24h bar block. */
const WEEK_ROW_PX = 18;
const WEEK_DOT_MIN_PX = 5;
const WEEK_DOT_MAX_PX = 13;
const WEEK_CELL_COUNT = 7 * 24;

/**
 * 7d: the same 24 hour tracks as the 24h view, stacked seven deep. Dots rather
 * than tiles — a circle that grows and brightens with its hour keeps a quiet
 * week readable as texture, where a full-bleed grid turns into a wall. Clicking
 * a dot opens that day's breakdown.
 */
function UsageWeekMatrix({
  timeline,
  metric,
  intensityOf,
  reduced,
  weekdayFormat,
  dayOfMonthFormat,
  selectedCellMs,
  onToggleDay,
}: {
  timeline: SettingsUsageTimelineData;
  metric: UsageCalendarMetric;
  intensityOf: (value: number) => number;
  reduced: boolean;
  weekdayFormat: Intl.DateTimeFormat;
  dayOfMonthFormat: Intl.DateTimeFormat;
  /** Exact hour cell that opened the breakdown; only it carries the ring. */
  selectedCellMs: number | null;
  onToggleDay: (dayStartMs: number, cellMs: number, element: HTMLElement | null) => void;
}) {
  const startDayMs = Math.floor(timeline.startMs / DAY_MS) * DAY_MS;
  const dayStarts = Array.from({ length: 7 }, (_, index) => startDayMs + index * DAY_MS);
  const valuesByBucket = useMemo(() => {
    const values = new Map<number, number>();
    for (const bucket of timeline.buckets) {
      values.set(bucket.bucketStartMs, metric === 'tokens' ? bucket.tokens : bucket.costUSD);
    }
    return values;
  }, [metric, timeline.buckets]);

  // Roving tabindex: the 7×24 grid is one tab stop, arrow keys walk cells.
  const cellRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const focusCell = useCallback((index: number) => {
    const next = Math.min(Math.max(index, 0), WEEK_CELL_COUNT - 1);
    setFocusIndex(next);
    cellRefs.current[next]?.focus();
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const deltas: Record<string, number> = {
      ArrowUp: -24,
      ArrowDown: 24,
      ArrowLeft: -1,
      ArrowRight: 1,
    };
    const delta = deltas[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      focusCell(index + delta);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusCell(event.key === 'Home' ? 0 : WEEK_CELL_COUNT - 1);
    }
  };

  return (
    <div className="flex gap-2">
      {/* Day gutter, outside the rows so the sweep cannot drag the labels. */}
      <div aria-hidden="true" className="flex shrink-0 flex-col gap-[3px]">
        {dayStarts.map((dayStartMs) => (
          <span
            key={dayStartMs}
            className="flex items-center justify-end gap-1 text-[10px] leading-none text-muted-foreground"
            style={{ height: WEEK_ROW_PX }}
          >
            <span>{weekdayFormat.format(new Date(dayStartMs))}</span>
            <span className="tabular-nums text-muted-foreground/55">
              {dayOfMonthFormat.format(new Date(dayStartMs))}
            </span>
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-[3px]">
          {dayStarts.map((dayStartMs, dayIndex) => (
            <RangeSweep key={dayStartMs} index={dayIndex} reduced={reduced} axis="row">
              <div className={HOUR_COLUMNS_CLASS} role="row">
                {Array.from({ length: 24 }, (_, hour) => {
                  const cellIndex = dayIndex * 24 + hour;
                  const cellMs = dayStartMs + hour * HOUR_MS;
                  const value = valuesByBucket.get(cellMs) ?? 0;
                  const intensity = intensityOf(value);
                  const size =
                    intensity > 0
                      ? WEEK_DOT_MIN_PX + (WEEK_DOT_MAX_PX - WEEK_DOT_MIN_PX) * intensity
                      : WEEK_DOT_MIN_PX - 1;
                  const label = `${weekdayFormat.format(new Date(dayStartMs))} ${hourLabel(hour)} · ${formatMetric(value, metric)}`;
                  const selected = cellMs === selectedCellMs;
                  return (
                    <button
                      key={hour}
                      ref={(element) => {
                        cellRefs.current[cellIndex] = element;
                      }}
                      type="button"
                      role="gridcell"
                      tabIndex={cellIndex === focusIndex ? 0 : -1}
                      title={label}
                      aria-label={label}
                      aria-selected={selected}
                      // focus-visible:shadow-none opts out of the global inset
                      // primary focus border; the dot carries the focus ring instead.
                      className="group flex cursor-pointer items-center justify-center outline-none focus-visible:shadow-none"
                      style={{ height: WEEK_ROW_PX }}
                      onClick={(event) => onToggleDay(dayStartMs, cellMs, event.currentTarget)}
                      onKeyDown={(event) => onKeyDown(event, cellIndex)}
                      onFocus={() => setFocusIndex(cellIndex)}
                    >
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
            </RangeSweep>
          ))}
        </div>
        <HourAxis />
      </div>
    </div>
  );
}

const COMPOSITION_SEGMENT_LIMIT = 5;
const MODEL_SERIES_COLORS = ['#2563eb', '#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe'] as const;
const MEMBER_SERIES_COLORS = ['#7c3aed', '#9333ea', '#a855f7', '#c084fc', '#e9d5ff'] as const;

type UsageCompositionSegment = {
  id: string;
  label: string;
  tokens: number;
  share: number;
};

function createUsageCompositionSegments(
  rows: Array<{ id: string; label: string; tokens: number }>,
  otherLabel: string
): UsageCompositionSegment[] {
  const totals = new Map<string, { label: string; tokens: number }>();
  for (const row of rows) {
    if (!Number.isFinite(row.tokens) || row.tokens <= 0) continue;
    const previous = totals.get(row.id);
    totals.set(row.id, {
      label: row.label,
      tokens: (previous?.tokens ?? 0) + row.tokens,
    });
  }

  const sorted = [...totals.entries()]
    .map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
  const visible = sorted.slice(0, COMPOSITION_SEGMENT_LIMIT - 1);
  const hidden = sorted.slice(COMPOSITION_SEGMENT_LIMIT - 1);
  if (hidden.length > 0) {
    visible.push({
      id: '__other__',
      label: otherLabel,
      tokens: hidden.reduce((total, row) => total + row.tokens, 0),
    });
  }

  const total = visible.reduce((sum, row) => sum + row.tokens, 0);
  return visible.map((row) => ({ ...row, share: total > 0 ? row.tokens / total : 0 }));
}

/**
 * A pair of 6px rules carries the by-model and by-member shares inside the
 * panel's own text rhythm, under whichever matrix is on screen.
 */
function UsageCompositionBar({
  label,
  segments,
  colors,
  reduced,
}: {
  label: string;
  segments: UsageCompositionSegment[];
  colors: readonly string[];
  reduced: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
        {label}
      </p>
      <div className="mt-1.5 flex h-1.5 gap-px overflow-hidden rounded-full bg-muted-foreground/10">
        {segments.map((segment, index) => (
          <motion.span
            key={segment.id}
            title={`${segment.label} · ${Math.round(segment.share * 100)}%`}
            className="h-full"
            style={{ backgroundColor: colors[index % colors.length] }}
            initial={reduced ? false : { width: 0 }}
            animate={{ width: `${segment.share * 100}%` }}
            transition={reduced ? { duration: 0 } : { duration: 0.5, ease: RANGE_SWEEP_EASE }}
          />
        ))}
      </div>
      <ul className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {segments.map((segment, index) => (
          <li key={segment.id} className="flex min-w-0 items-center gap-1 text-[10px]">
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: colors[index % colors.length] }}
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

/** By-model and by-member rules, shared by every range that has a timeline. */
function UsageCompositionSummary({
  timeline,
  reduced,
  className,
}: {
  timeline: SettingsUsageTimelineData;
  reduced: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const modelSegments = useMemo(
    () =>
      createUsageCompositionSegments(
        timeline.buckets.flatMap((bucket) =>
          bucket.byModel.map((row) => ({
            id: row.modelId,
            label: stripRecommended(row.modelId),
            tokens: row.tokens,
          }))
        ),
        t('workspace.usage.skyline.other')
      ),
    [t, timeline.buckets]
  );
  const memberSegments = useMemo(
    () =>
      createUsageCompositionSegments(
        timeline.buckets.flatMap((bucket) =>
          bucket.byUser.map((row) => ({
            id: row.userId,
            label:
              timeline.users?.[row.userId]?.name ||
              timeline.users?.[row.userId]?.email ||
              row.userId,
            tokens: row.tokens,
          }))
        ),
        t('workspace.usage.skyline.other')
      ),
    [t, timeline.buckets, timeline.users]
  );

  return (
    <div
      className={cn(
        'grid gap-x-6 gap-y-3 border-t border-border/50 pt-3 sm:grid-cols-2',
        className
      )}
    >
      <UsageCompositionBar
        label={t('workspace.usage.byModel')}
        segments={modelSegments}
        colors={MODEL_SERIES_COLORS}
        reduced={reduced}
      />
      <UsageCompositionBar
        label={t('workspace.usage.byUser')}
        segments={memberSegments}
        colors={MEMBER_SERIES_COLORS}
        reduced={reduced}
      />
    </div>
  );
}

type UsageRingSegment = {
  id: string;
  label: string;
  value: number;
  share: number;
  color: string;
};

/**
 * Ring hues come from the chart palette so they follow the theme; three.js is
 * the only place in this file that needs literal colours.
 */
const RING_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
] as const;

const RING_VIEWBOX = 168;
const RING_RADIUS = 66;
const RING_STROKE = 26;
/** Tiny angular gap between donut slices so adjacent colours do not bleed. */
const RING_SLICE_GAP = 0.006;

/**
 * Which composition the rings show. The token-type split is the intended one;
 * it is optional on the timeline contract, so when the range carries no
 * breakdown the rings show the model split and the caption says so. An empty
 * ring stack would read as a broken panel.
 */
function useUsageRingComposition(timeline: SettingsUsageTimelineData | undefined): {
  caption: string;
  segments: UsageRingSegment[];
} | null {
  const { t } = useTranslation();
  return useMemo(() => {
    const breakdown = timeline?.totals.breakdown;
    const typeRows = breakdown
      ? [
          {
            id: 'cache',
            label: t('workspace.usage.breakdown.cache'),
            value: breakdown.cacheReadInputTokens + breakdown.cacheCreationInputTokens,
          },
          {
            id: 'input',
            label: t('workspace.usage.breakdown.input'),
            value: breakdown.inputTokens,
          },
          {
            id: 'output',
            label: t('workspace.usage.breakdown.output'),
            value: breakdown.outputTokens,
          },
          {
            id: 'reasoning',
            label: t('workspace.usage.breakdown.reasoning'),
            value: breakdown.reasoningOutputTokens,
          },
        ].filter((row) => row.value > 0)
      : [];
    const typeTotal = typeRows.reduce((sum, row) => sum + row.value, 0);
    if (typeTotal > 0) {
      return {
        caption: t('workspace.usage.breakdown.title'),
        segments: typeRows.map((row, index) => ({
          ...row,
          share: row.value / typeTotal,
          color: RING_COLORS[index % RING_COLORS.length]!,
        })),
      };
    }

    if (!timeline) return null;

    return {
      caption: t('workspace.usage.byModel'),
      segments: createUsageCompositionSegments(
        timeline.buckets.flatMap((bucket) =>
          bucket.byModel.map((row) => ({
            id: row.modelId,
            label: stripRecommended(row.modelId),
            tokens: row.tokens,
          }))
        ),
        t('workspace.usage.skyline.other')
      ).map((segment, index) => ({
        id: segment.id,
        label: segment.label,
        value: segment.tokens,
        share: segment.share,
        color: RING_COLORS[index % RING_COLORS.length]!,
      })),
    };
  }, [t, timeline]);
}

/**
 * Single donut ring. The composition slices are arcs of one circle that tile the
 * full 360° — pure share-of-total, with no per-slice track that would read as
 * progress toward a goal that does not exist. The total sits in the middle,
 * which is the number the panel is really about.
 */
function UsageTokenRings({
  segments,
  caption,
  total,
  totalLabel,
  metric,
  reduced,
}: {
  segments: UsageRingSegment[];
  caption: string;
  total: number;
  totalLabel: string;
  metric: UsageCalendarMetric;
  reduced: boolean;
}) {
  const { locale } = useCalendarFormats();
  const center = RING_VIEWBOX / 2;
  const slices = useMemo(() => {
    let start = 0;
    return segments.map((segment) => {
      const slice = { ...segment, start };
      start += segment.share;
      return slice;
    });
  }, [segments]);
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
            // Each slice is a full circle rotated to its start angle, with
            // pathLength drawing only its share of the circumference.
            <g key={slice.id} transform={`rotate(${slice.start * 360} ${center} ${center})`}>
              <motion.circle
                cx={center}
                cy={center}
                r={RING_RADIUS}
                fill="none"
                stroke={slice.color}
                strokeWidth={RING_STROKE}
                initial={reduced ? false : { pathLength: 0 }}
                animate={{
                  pathLength: Math.max(0.004, slice.share - RING_SLICE_GAP),
                }}
                transition={
                  reduced
                    ? { duration: 0 }
                    : { duration: 0.85, delay: 0.06 * index, ease: RANGE_SWEEP_EASE }
                }
              />
            </g>
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-10 text-center">
          <span className="w-full truncate text-[15px] font-semibold leading-none tabular-nums tracking-tight text-foreground sm:text-base">
            {metric === 'tokens' ? (
              <NumberFlow
                value={total}
                locales={locale}
                format={{ notation: 'compact', maximumFractionDigits: 1 }}
              />
            ) : (
              formatCost(total, locale)
            )}
          </span>
          <span className="mt-1 w-full truncate text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {totalLabel}
          </span>
        </div>
      </div>

      <p className="mt-3 w-full text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
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

/**
 * The hourly range view. 24h and 7d share one frame — the donut ring is a
 * persistent sibling rendered by the parent, so switching between them only
 * deforms the matrix. 30d and all-time hand off to the year skyline. Cells open
 * the same day breakdown the heatmap offers; composition rules live in the
 * metrics band.
 */
function UsageRangePanel({
  timeline,
  metric,
  selectedDayMs,
  onSelectDay,
}: {
  timeline: SettingsUsageTimelineData;
  metric: UsageCalendarMetric;
  selectedDayMs: number | null;
  onSelectDay: (day: UsageSelectedDay | null) => void;
}) {
  const { t } = useTranslation();
  const formats = useCalendarFormats();
  const reduced = useReducedMotion() ?? false;
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedCellRef = useRef<HTMLElement | null>(null);
  const [selectedCellMs, setSelectedCellMs] = useState<number | null>(null);

  const values = useMemo(
    () => timeline.buckets.map((bucket) => (metric === 'tokens' ? bucket.tokens : bucket.costUSD)),
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

  /** Caret x for a cell, in coordinates of the panel root the detail panel shares. */
  const measureAnchorX = useCallback((element: HTMLElement | null) => {
    const root = rootRef.current;
    if (!element || !root) return 0;
    const cellRect = element.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    return cellRect.left + cellRect.width / 2 - rootRect.left;
  }, []);

  const toggleDay = useCallback(
    (dayStartMs: number, cellMs: number, element: HTMLElement | null) => {
      // Only the very cell that opened the breakdown closes it again; any other
      // cell switches the selection in place, even within the same day (in 24h
      // every bar usually shares one day, so a day-level compare would close
      // the panel on every second click).
      if (cellMs === selectedCellMs) {
        selectedCellRef.current = null;
        setSelectedCellMs(null);
        onSelectDay(null);
        return;
      }
      selectedCellRef.current = element;
      setSelectedCellMs(cellMs);
      onSelectDay({ dayStartMs, anchorX: measureAnchorX(element) });
    },
    [measureAnchorX, onSelectDay, selectedCellMs]
  );

  // The ring marks the exact cell that opened the breakdown; it dies with the
  // selection (e.g. when a range switch clears it from above).
  useEffect(() => {
    if (selectedDayMs === null) setSelectedCellMs(null);
  }, [selectedDayMs]);

  // The caret must follow its cell when the panel resizes.
  useEffect(() => {
    if (selectedDayMs === null) return undefined;
    const root = rootRef.current;
    if (!root) return undefined;
    const sync = () => {
      const element = selectedCellRef.current;
      if (!element || !root.contains(element)) return;
      onSelectDay({ dayStartMs: selectedDayMs, anchorX: measureAnchorX(element) });
    };
    const observer = new ResizeObserver(sync);
    observer.observe(root);
    return () => observer.disconnect();
  }, [measureAnchorX, onSelectDay, selectedDayMs]);

  const selectedDayTotal = useMemo(() => {
    if (selectedDayMs === null) return null;
    let total = 0;
    for (const bucket of timeline.buckets) {
      if (Math.floor(bucket.bucketStartMs / DAY_MS) * DAY_MS === selectedDayMs) {
        total += metric === 'tokens' ? bucket.tokens : bucket.costUSD;
      }
    }
    return total;
  }, [metric, selectedDayMs, timeline.buckets]);

  return (
    <div ref={rootRef} className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="min-w-0 truncate text-[11px] tabular-nums text-muted-foreground">
          {spanLabel}
          <span className="text-muted-foreground/60">
            {` · ${t('workspace.usage.skyline.activeIntervals')} ${activeCount}/${values.length}`}
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-3">
          {peakBucket && (values[peakIndex] ?? 0) > 0 ? (
            <p className="text-[11px] tabular-nums text-muted-foreground">
              <span className="text-muted-foreground/60">{`${t('workspace.usage.skyline.peakInterval')} `}</span>
              <span className="font-medium text-foreground">
                {formatMetric(values[peakIndex] ?? 0, metric)}
              </span>
              <span className="text-muted-foreground/60">{` · ${peakBucket.bucketLabel}`}</span>
            </p>
          ) : null}
          <HeatLegend />
        </div>
      </div>

      {/* The donut ring lives outside this panel (and outside the range-switch
          cross-fade) as its own column — only the matrix deforms on 24h <-> 7d. */}
      <div className="mt-3">
        {/* The frame keeps its height across ranges so the panel below it does
            not jump while a range animates in. */}
        <div
          role="grid"
          aria-label={t('workspace.usage.skyline.heatmap')}
          className="relative min-h-[10.5rem] min-w-0"
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={timeline.range}
              initial={reduced ? false : { opacity: 0, filter: 'blur(6px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, filter: 'blur(6px)' }}
              transition={{ duration: reduced ? 0 : 0.2, ease: 'easeOut' }}
            >
              {timeline.range === 'week' ? (
                <UsageWeekMatrix
                  timeline={timeline}
                  metric={metric}
                  intensityOf={intensityOf}
                  reduced={reduced}
                  weekdayFormat={formats.weekday}
                  dayOfMonthFormat={formats.dayOfMonth}
                  selectedCellMs={selectedCellMs}
                  onToggleDay={toggleDay}
                />
              ) : (
                <UsageDayMatrix
                  buckets={timeline.buckets}
                  metric={metric}
                  intensityOf={intensityOf}
                  reduced={reduced}
                  selectedCellMs={selectedCellMs}
                  onToggleDay={toggleDay}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Fixed height, single line: the idle hint and the selected-day readout
          trade places without resizing the panel. */}
      <div className="mt-3 flex h-5 items-center">
        <p
          className="min-w-0 flex-1 truncate text-xs tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          {selectedDayMs !== null && selectedDayTotal !== null ? (
            <>
              {formats.day.format(new Date(selectedDayMs))}
              {selectedDayTotal > 0
                ? ` · ${formatMetric(selectedDayTotal, metric)}${
                    metric === 'tokens' ? ` ${t('workspace.usage.tokens')}` : ''
                  }`
                : ` · ${t('workspace.usage.skyline.noUsage')}`}
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <MousePointerClick className="h-3.5 w-3.5" aria-hidden="true" />
              {t('workspace.usage.skyline.clickHint')}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * Position only — the cell is resolved at render time so a metric switch cannot
 * stale it. Coordinates are relative to the heatmap root, not the scrolling
 * grid, so the bubble can always sit above a cell without the scroller clipping
 * it (`overflow-x: auto` forces `overflow-y: auto`).
 */
type HeatmapTooltip = { left: number; top: number };

/** A clicked day plus where its caret should sit, in heatmap-root coordinates. */
export type UsageSelectedDay = { dayStartMs: number; anchorX: number };

/** Opacity of a day that sits outside the selected window; it stays as context. */
const OUT_OF_WINDOW_OPACITY = 0.3;

function UsageHeatmap({
  model,
  metric,
  selectedDayMs,
  onSelectDay,
  windowStartMs,
}: {
  model: UsageCalendarModel;
  metric: UsageCalendarMetric;
  selectedDayMs: number | null;
  onSelectDay: (day: UsageSelectedDay | null) => void;
  /**
   * First day of the selected range. Earlier days stay on screen but recede, so
   * 30d and all-time are the same skyline with a different day lit.
   */
  windowStartMs?: number;
}) {
  const { t } = useTranslation();
  const formats = useCalendarFormats();
  const monthLabels = useMonthLabels(model, formats.month);
  const scale = useMemo(() => createUsageHeatScale(model), [model]);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [tooltip, setTooltip] = useState<HeatmapTooltip | null>(null);
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const selectedIndex = useMemo(
    () =>
      selectedDayMs === null
        ? -1
        : model.cells.findIndex((cell) => cell.dayStartMs === selectedDayMs),
    [model.cells, selectedDayMs]
  );

  const todayIndex = useMemo(() => {
    let latest = -1;
    for (const [index, cell] of model.cells.entries()) if (!cell.isFuture) latest = index;
    return latest;
  }, [model.cells]);
  // Roving tabindex: the grid is one tab stop, arrow keys walk days and weeks.
  const [focusIndex, setFocusIndex] = useState(() => Math.max(0, todayIndex));

  // Show the newest weeks initially without overriding later user scrolling.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  }, []);

  const cellLabel = useCallback(
    (cell: UsageCalendarCell) => {
      const date = formats.day.format(new Date(cell.dayStartMs));
      if (cell.isFuture) return `${date} · ${t('workspace.usage.skyline.future')}`;
      if (cell.value <= 0) return `${date} · ${t('workspace.usage.skyline.noUsage')}`;
      const suffix = metric === 'tokens' ? ` ${t('workspace.usage.tokens')}` : '';
      return `${date} · ${formatMetric(cell.value, metric)}${suffix}`;
    },
    [formats.day, metric, t]
  );

  const showDetail = useCallback(
    (index: number, element: HTMLButtonElement | null) => {
      if (!model.cells[index]) return;
      setDetailIndex(index);
      const root = rootRef.current;
      if (!element || !root) return;
      const cellRect = element.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const center = cellRect.left + cellRect.width / 2 - rootRect.left;
      // Keep the bubble inside the card so the first and last weeks stay readable.
      const margin = Math.min(72, rootRect.width / 2);
      setTooltip({
        left: Math.min(Math.max(center, margin), Math.max(margin, rootRect.width - margin)),
        top: cellRect.top - rootRect.top - 6,
      });
    },
    [model.cells]
  );

  const clearDetail = useCallback(() => {
    setTooltip(null);
    setDetailIndex(null);
  }, []);

  /** Caret x for a cell, in coordinates of the heatmap root the panel shares. */
  const measureAnchorX = useCallback((index: number) => {
    const element = cellRefs.current[index];
    const root = rootRef.current;
    if (!element || !root) return 0;
    const cellRect = element.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    return cellRect.left + cellRect.width / 2 - rootRect.left;
  }, []);

  const toggleDay = useCallback(
    (index: number) => {
      const cell = model.cells[index];
      // A future day has nothing to expand.
      if (!cell || cell.isFuture) return;
      if (cell.dayStartMs === selectedDayMs) {
        onSelectDay(null);
        return;
      }
      onSelectDay({ dayStartMs: cell.dayStartMs, anchorX: measureAnchorX(index) });
    },
    [measureAnchorX, model.cells, onSelectDay, selectedDayMs]
  );

  // The caret must follow its cell when the calendar scrolls or the panel resizes.
  useEffect(() => {
    if (selectedIndex < 0 || selectedDayMs === null) return undefined;
    const scroller = scrollerRef.current;
    const root = rootRef.current;
    if (!scroller || !root) return undefined;
    const sync = () =>
      onSelectDay({ dayStartMs: selectedDayMs, anchorX: measureAnchorX(selectedIndex) });
    scroller.addEventListener('scroll', sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(root);
    return () => {
      scroller.removeEventListener('scroll', sync);
      observer.disconnect();
    };
  }, [measureAnchorX, onSelectDay, selectedDayMs, selectedIndex]);

  const focusCell = useCallback((index: number) => {
    const next = Math.min(Math.max(index, 0), USAGE_CALENDAR_CELLS - 1);
    setFocusIndex(next);
    cellRefs.current[next]?.focus();
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const deltas: Record<string, number> = {
      ArrowUp: -1,
      ArrowDown: 1,
      ArrowLeft: -USAGE_CALENDAR_ROWS,
      ArrowRight: USAGE_CALENDAR_ROWS,
    };
    const delta = deltas[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      focusCell(index + delta);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusCell(event.key === 'Home' ? 0 : Math.max(0, todayIndex));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleDay(index);
    }
  };

  const detailCell = detailIndex === null ? null : model.cells[detailIndex];
  const peakShare = useMemo(() => {
    if (!detailCell || model.maxValue <= 0 || detailCell.value <= 0) return null;
    const percent = (detailCell.value / model.maxValue) * 100;
    // A quiet day next to a launch-day spike must not read as a flat "0%".
    return percent < 1 ? '<1' : String(Math.round(percent));
  }, [detailCell, model.maxValue]);

  return (
    <div ref={rootRef} className="relative space-y-3">
      {/* Use the heatmap's real container, not the viewport, to decide whether
          the compact mobile minimum is needed. A desktop settings panel can then
          use every available pixel without manufacturing horizontal overflow. */}
      <div className="@container flex gap-1.5">
        <div
          aria-hidden="true"
          className="mt-[calc(0.625rem+0.375rem)] grid w-7 shrink-0 grid-rows-7 gap-[4px] text-[10px] leading-none text-muted-foreground"
        >
          {Array.from({ length: USAGE_CALENDAR_ROWS }, (_, row) => {
            const sample = model.cells[row];
            return (
              <span key={row} className="flex items-center">
                {row % 2 === 1 && sample ? formats.weekday.format(new Date(sample.dayStartMs)) : ''}
              </span>
            );
          })}
        </div>

        <div ref={scrollerRef} className="scrollbar-pro min-w-0 flex-1 overflow-x-auto pb-1">
          <div
            className="min-w-[var(--usage-heatmap-min-track-width)] @[672px]:min-w-0"
            style={
              {
                '--usage-heatmap-min-track-width': `${HEATMAP_MIN_TRACK_WIDTH}px`,
              } as CSSProperties
            }
          >
            <div
              className="mb-1.5 grid gap-[4px] text-[10px] leading-none text-muted-foreground"
              style={{ gridTemplateColumns: HEATMAP_COLUMN_TEMPLATE }}
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
              aria-label={t('workspace.usage.skyline.heatmap')}
              className="relative grid grid-rows-7 gap-[4px]"
              style={{ gridTemplateColumns: HEATMAP_COLUMN_TEMPLATE, gridAutoFlow: 'column' }}
              onPointerLeave={clearDetail}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  clearDetail();
              }}
            >
              {model.cells.map((cell, index) => {
                const intensity = cell.isFuture ? 0 : scale.intensity(cell.value);
                const outsideWindow =
                  windowStartMs !== undefined && cell.dayStartMs < windowStartMs;
                return (
                  <button
                    key={cell.dayStartMs}
                    ref={(element) => {
                      cellRefs.current[index] = element;
                    }}
                    type="button"
                    role="gridcell"
                    tabIndex={index === focusIndex ? 0 : -1}
                    aria-label={cellLabel(cell)}
                    aria-selected={index === detailIndex}
                    className={cn(
                      'animate-usage-heatmap-cell aspect-square w-full rounded-[20%] outline-none',
                      'transition-[filter,opacity] duration-300 motion-reduce:transition-none',
                      !cell.isFuture &&
                        'hover:brightness-110 hover:ring-1 hover:ring-foreground/40',
                      'focus-visible:ring-2 focus-visible:ring-ring',
                      cell.isFuture ? 'cursor-default' : 'cursor-pointer',
                      index === todayIndex && 'ring-1 ring-inset ring-foreground/45',
                      // No ring offset: the offset ring leaves a gap and reads as
                      // a detached circle around a 32%-rounded cell. A plain ring
                      // is a box-shadow spread, so its corners stay parallel to
                      // the cell's own and it sits flush against it.
                      index === selectedIndex && 'ring-1 ring-foreground'
                    )}
                    style={{
                      backgroundColor: cell.isFuture
                        ? FUTURE_DAY_COLOR
                        : intensity > 0
                          ? heatColor(intensity)
                          : EMPTY_DAY_COLOR,
                      opacity: outsideWindow ? OUT_OF_WINDOW_OPACITY : 1,
                      animationDelay: `${cell.column * CELL_REVEAL_STAGGER_MS}ms`,
                    }}
                    onClick={() => toggleDay(index)}
                    onKeyDown={(event) => onKeyDown(event, index)}
                    onFocus={(event) => {
                      setFocusIndex(index);
                      showDetail(index, event.currentTarget);
                    }}
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
          <span className="font-medium tabular-nums">
            {detailCell.isFuture
              ? t('workspace.usage.skyline.future')
              : detailCell.value > 0
                ? formatMetric(detailCell.value, metric)
                : t('workspace.usage.skyline.noUsage')}
          </span>
          <span className="ml-1.5 text-popover-foreground/60">
            {formats.day.format(new Date(detailCell.dayStartMs))}
          </span>
          {!detailCell.isFuture && detailCell.dayStartMs !== selectedDayMs ? (
            <span className="mt-0.5 block text-popover-foreground/50">
              {t('workspace.usage.skyline.clickForDetails')}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Fixed height, single line, no wrapping: the idle hint carries an icon and
          the selected-day readout does not, and either can be long enough to wrap.
          Without this the row grew and shrank as the pointer moved. */}
      <div className="flex h-5 items-center justify-between gap-4">
        <p
          className="min-w-0 flex-1 truncate text-xs tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          {detailCell ? (
            <>
              {cellLabel(detailCell)}
              {peakShare !== null ? (
                <span className="text-muted-foreground/70">
                  {` · ${t('workspace.usage.skyline.peakShare', { percent: peakShare })}`}
                </span>
              ) : null}
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <MousePointerClick className="h-3.5 w-3.5" aria-hidden="true" />
              {t('workspace.usage.skyline.clickHint')}
            </span>
          )}
        </p>
        <HeatLegend />
      </div>
    </div>
  );
}

/**
 * Bar fills are a light tint of the chart blue rather than solid blue: a panel
 * with eight bars reads as a wall of colour otherwise. The label sits on top in
 * the foreground colour, so contrast never depends on the fill.
 */
const RANK_FILL_ALPHAS = [0.42, 0.33, 0.26, 0.2, 0.15] as const;
const rankFill = (rank: number) =>
  heatColor(RANK_FILL_ALPHAS[Math.min(rank, RANK_FILL_ALPHAS.length - 1)]!);
/** The composition rule is small, so it can carry more weight than the bars. */
const COMPOSITION_ALPHAS = [0.75, 0.55, 0.38, 0.24] as const;
const compositionFill = (index: number) =>
  heatColor(COMPOSITION_ALPHAS[index % COMPOSITION_ALPHAS.length]!);

/** Longest model/member list the panel shows before folding the rest into "other". */
const DAY_DETAIL_ROW_LIMIT = 5;

type BreakdownRow = { id: string; label: string; tokens: number; icon?: ReactNode };

function RankedBars({ rows }: { rows: BreakdownRow[] }) {
  const { t } = useTranslation();
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
              backgroundColor: rankFill(rank),
            }}
          />
          <span className="relative flex h-full items-center gap-1.5 px-2">
            {row.icon}
            <span className="truncate text-[11px] font-medium text-foreground">{row.label}</span>
            <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">
              {formatTokens(row.tokens)}
            </span>
          </span>
        </li>
      ))}
      {restTokens > 0 ? (
        <li className="px-2 pt-0.5 text-[11px] tabular-nums text-muted-foreground/80">
          {t('workspace.usage.skyline.otherRows', {
            count: rows.length - DAY_DETAIL_ROW_LIMIT,
            tokens: formatTokens(restTokens),
          })}
        </li>
      ) : null}
    </ul>
  );
}

function UsageDayDetailPanel({
  dayStartMs,
  anchorX,
  detail,
  loading,
  onClose,
}: {
  dayStartMs: number;
  anchorX: number;
  detail: SettingsUsageDayData | undefined;
  loading: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const formats = useCalendarFormats();
  const { locale } = formats;
  // While a new day is in flight the previous payload is still mounted; only
  // render numbers once they belong to the day the user actually clicked.
  const day = detail?.dayStartMs === dayStartMs ? detail : undefined;

  const composition = day
    ? [
        {
          key: 'cache',
          label: t('workspace.usage.breakdown.cache'),
          value: day.totals.cacheReadInputTokens + day.totals.cacheCreationInputTokens,
        },
        {
          key: 'input',
          label: t('workspace.usage.breakdown.input'),
          value: day.totals.inputTokens,
        },
        {
          key: 'output',
          label: t('workspace.usage.breakdown.output'),
          value: day.totals.outputTokens,
        },
        {
          key: 'reasoning',
          label: t('workspace.usage.breakdown.reasoning'),
          value: day.totals.reasoningOutputTokens,
        },
      ]
        .filter((segment) => segment.value > 0)
        .sort((a, b) => b.value - a.value)
    : [];
  const compositionTotal = composition.reduce((sum, segment) => sum + segment.value, 0);
  const hasUsage = Boolean(day && day.totals.tokens > 0);

  return (
    <div className="relative pt-2">
      <span
        aria-hidden="true"
        className="absolute top-0.5 h-3 w-3 -translate-x-1/2 rotate-45 rounded-[2px] bg-muted/60"
        style={{ left: anchorX }}
      />
      <section
        aria-label={t('workspace.usage.skyline.dayDetail')}
        className="relative rounded-lg bg-muted/40 p-4"
      >
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('common.close')}
          className="absolute right-2 top-2 h-6 w-6 text-muted-foreground"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
        <div className="grid gap-x-6 gap-y-4 lg:grid-cols-[minmax(0,13rem)_1fr]">
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-muted-foreground">
              {formats.day.format(new Date(dayStartMs))}
            </p>
            <p className="mt-1 flex items-baseline gap-1.5">
              <span className="text-2xl font-semibold leading-none tabular-nums text-foreground">
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
              <span className="text-xs text-muted-foreground">{t('workspace.usage.tokens')}</span>
            </p>
            <p className="mt-1.5 min-h-4 text-xs tabular-nums text-muted-foreground">
              {day
                ? [
                    formatCost(day.totals.costUSD, locale),
                    day.totals.webSearchRequests > 0
                      ? t('workspace.usage.skyline.webSearches', {
                          count: day.totals.webSearchRequests,
                        })
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
                        {formatTokens(segment.value)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {!day && loading ? (
              <div className="mt-4 space-y-2" aria-busy="true">
                <div className="h-1.5 w-full animate-pulse rounded-full bg-muted-foreground/15" />
                <div className="h-1.5 w-2/3 animate-pulse rounded-full bg-muted-foreground/15" />
              </div>
            ) : null}
            {day && !hasUsage ? (
              <p className="mt-4 text-xs text-muted-foreground">
                {t('workspace.usage.skyline.noUsage')}
              </p>
            ) : null}
          </div>

          {hasUsage && day ? (
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <div className="min-w-0">
                <p className="mb-2 text-[11px] font-medium text-muted-foreground">
                  {t('workspace.usage.byModel')}
                </p>
                <RankedBars
                  rows={day.byModel.map((row) => ({
                    id: row.modelId,
                    label: row.modelId,
                    tokens: row.tokens,
                    icon: (
                      <ModelBrandIcon
                        modelId={row.modelId}
                        className="h-3 w-3 shrink-0 text-foreground/50"
                      />
                    ),
                  }))}
                />
              </div>
              <div className="min-w-0">
                <p className="mb-2 text-[11px] font-medium text-muted-foreground">
                  {t('workspace.usage.byUser')}
                </p>
                <RankedBars
                  rows={day.byUser.map((row) => {
                    const user = day.users[row.userId];
                    const label = user?.name || user?.email || row.userId;
                    return {
                      id: row.userId,
                      label,
                      tokens: row.tokens,
                      icon: (
                        <Avatar className="size-4 shrink-0">
                          {user?.image ? <AvatarImage src={user.image} alt="" /> : null}
                          <AvatarFallback className="bg-foreground/15 text-[8px] font-medium uppercase text-foreground/80">
                            {label.slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
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

function FitCamera({
  width,
  depth,
  height,
  centerX = 0,
  padding = 1,
  framing = 1,
  front = false,
}: {
  width: number;
  depth: number;
  height: number;
  centerX?: number;
  padding?: number;
  framing?: number;
  front?: boolean;
}) {
  const { camera, size } = useThree();
  useEffect(() => {
    const orthographic = camera as THREE.OrthographicCamera;
    const aspect = Math.max(0.5, size.width / Math.max(1, size.height));
    // Account for both horizontal and vertical spans of the isometric projection.
    // The previous width-only calculation cropped the far edge on wide canvases.
    const horizontalSpan = (width + depth) * 0.78;
    const verticalSpan = (width + depth) * 0.52 + height;
    const fittedFrustumHeight = Math.max(
      17,
      verticalSpan * padding,
      (horizontalSpan * padding) / aspect
    );
    const frustumHeight = fittedFrustumHeight * framing;
    const cameraDistance = Math.max(width, depth) * 0.88;
    orthographic.zoom = 1;
    orthographic.left = (-frustumHeight * aspect) / 2;
    orthographic.right = (frustumHeight * aspect) / 2;
    orthographic.top = frustumHeight / 2;
    orthographic.bottom = -frustumHeight / 2;
    orthographic.position.set(
      centerX + (front ? cameraDistance * 0.45 : cameraDistance),
      cameraDistance * 0.72 + height,
      front ? -cameraDistance : cameraDistance
    );
    orthographic.lookAt(centerX, height * 0.16, 0);
    orthographic.updateProjectionMatrix();
  }, [camera, centerX, depth, framing, front, height, padding, size.height, size.width, width]);
  return null;
}

function SceneOrbitControls({ targetY }: { targetY: number }) {
  const { camera, gl } = useThree();
  const controls = useMemo(() => new OrbitControls(camera, gl.domElement), [camera, gl]);

  useEffect(() => {
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minZoom = 0.65;
    controls.maxZoom = 3.2;
    controls.target.set(0, targetY, 0);
    controls.update();
    return () => controls.dispose();
  }, [controls, targetY]);

  useFrame(() => controls.update());
  return null;
}

function SummaryStat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums text-foreground">
        {value}
      </dd>
      {detail ? <p className="truncate text-[11px] text-muted-foreground/80">{detail}</p> : null}
    </div>
  );
}

function UsageSummary({
  model,
  metric,
}: {
  model: UsageCalendarModel;
  metric: UsageCalendarMetric;
}) {
  const { t } = useTranslation();
  const formats = useCalendarFormats();
  const completedCells = useMemo(() => model.cells.filter((cell) => !cell.isFuture), [model.cells]);
  const peakCell = useMemo(
    () =>
      completedCells.reduce<UsageCalendarCell | null>(
        (peak, cell) => (!peak || cell.value > peak.value ? cell : peak),
        null
      ),
    [completedCells]
  );
  const dailyAverage = completedCells.length > 0 ? model.totalValue / completedCells.length : 0;
  const peakDate =
    peakCell && peakCell.value > 0
      ? formats.day.format(new Date(peakCell.dayStartMs))
      : t('workspace.usage.skyline.noUsage');

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
      <SummaryStat
        label={t('workspace.usage.skyline.total')}
        value={formatMetric(model.totalValue, metric)}
      />
      <SummaryStat
        label={t('workspace.usage.skyline.dailyAverage')}
        value={formatMetric(dailyAverage, metric)}
      />
      <SummaryStat
        label={t('workspace.usage.skyline.peakDay')}
        value={formatMetric(peakCell?.value ?? 0, metric)}
        detail={peakDate}
      />
      <SummaryStat
        label={t('workspace.usage.skyline.activeDays')}
        value={String(model.activeDays)}
        detail={t('workspace.usage.skyline.currentStreakDetail', { days: model.currentStreak })}
      />
      <SummaryStat
        label={t('workspace.usage.skyline.longestStreak')}
        value={String(model.longestStreak)}
      />
    </dl>
  );
}

function UsageTimelineSummary({
  timeline,
  metric,
}: {
  timeline: SettingsUsageTimelineData;
  metric: UsageCalendarMetric;
}) {
  const { t } = useTranslation();
  const values = timeline.buckets.map((bucket) =>
    metric === 'tokens' ? bucket.tokens : bucket.costUSD
  );
  const active = values.filter((value) => value > 0);
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
  const peakBucket = timeline.buckets[peakIndex];

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
      <SummaryStat
        label={t('workspace.usage.skyline.total')}
        value={formatMetric(
          metric === 'tokens' ? timeline.totals.tokens : timeline.totals.costUSD,
          metric
        )}
      />
      <SummaryStat
        label={t('workspace.usage.skyline.averagePerInterval')}
        value={formatMetric(
          values.length > 0
            ? (metric === 'tokens' ? timeline.totals.tokens : timeline.totals.costUSD) /
                values.length
            : 0,
          metric
        )}
      />
      <SummaryStat
        label={t('workspace.usage.skyline.peakInterval')}
        value={formatMetric(values[peakIndex] ?? 0, metric)}
        detail={peakBucket?.bucketLabel ?? t('workspace.usage.skyline.noUsage')}
      />
      <SummaryStat
        label={t('workspace.usage.skyline.activeIntervals')}
        value={String(active.length)}
        detail={t('workspace.usage.skyline.currentIntervalStreakDetail', { count: currentStreak })}
      />
      <SummaryStat
        label={t('workspace.usage.skyline.longestStreak')}
        value={String(longestStreak)}
      />
    </dl>
  );
}

function StlMetalColumns({ model }: { model: UsageCalendarModel }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const activeCells = useMemo(
    () => model.cells.filter((cell) => !cell.isFuture && cell.value > 0),
    [model.cells]
  );

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.count = activeCells.length;
    for (const [index, cell] of activeCells.entries()) {
      const height =
        getUsageColumnHeight(cell.value, model.maxValue, 'skyline') *
        USAGE_SKYLINE_STL_COLUMN_HEIGHT_MULTIPLIER;
      dummy.position.set(
        USAGE_SKYLINE_STL_BASE_WIDTH / 2 -
          (USAGE_SKYLINE_STL_CELL_SIZE +
            cell.column * USAGE_SKYLINE_STL_CELL_SIZE +
            USAGE_SKYLINE_STL_CELL_SIZE / 2),
        height / 2,
        USAGE_SKYLINE_STL_BACK_MARGIN +
          cell.row * USAGE_SKYLINE_STL_CELL_SIZE +
          USAGE_SKYLINE_STL_CELL_SIZE / 2 -
          USAGE_SKYLINE_STL_BASE_DEPTH / 2
      );
      dummy.scale.set(USAGE_SKYLINE_STL_CELL_SIZE, height, USAGE_SKYLINE_STL_CELL_SIZE);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [activeCells, dummy, model.maxValue]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, Math.max(1, activeCells.length)]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#c8d1d9" metalness={0.72} roughness={0.23} />
    </instancedMesh>
  );
}

function StlLodyLogoRelief() {
  const geometry = useMemo(() => {
    const triangles = createUsageSkylineLodyLogoTriangles();
    // The STL keeps a closed back face for printing, but it lies exactly on the base face.
    // Excluding it from the preview prevents depth-buffer flicker while orbiting the model.
    const visualTriangles = triangles.filter(
      (triangle) => ![triangle.a, triangle.b, triangle.c].every(([, y]) => y === 0)
    );
    const positions = new Float32Array(visualTriangles.length * 9);
    let offset = 0;
    for (const triangle of visualTriangles) {
      for (const [x, y, z] of [triangle.a, triangle.c, triangle.b]) {
        positions[offset++] = USAGE_SKYLINE_STL_BASE_WIDTH / 2 - x;
        positions[offset++] = z;
        positions[offset++] = y - USAGE_SKYLINE_STL_BASE_DEPTH / 2;
      }
    }
    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    result.computeVertexNormals();
    return result;
  }, []);

  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#e8eef2" metalness={0.84} roughness={0.24} />
    </mesh>
  );
}

function StlMetalView({ model }: { model: UsageCalendarModel }) {
  const { t } = useTranslation();
  return (
    <div
      aria-label={t('workspace.usage.skyline.stlMetalPreview')}
      className="h-[300px] overflow-hidden rounded-md border border-border/70 bg-muted/35 sm:h-[360px]"
    >
      <Canvas
        orthographic
        dpr={[1, 2]}
        gl={{ alpha: true, antialias: true }}
        className="touch-none cursor-grab active:cursor-grabbing"
      >
        <ambientLight intensity={1.15} />
        <hemisphereLight args={['#d6e8ff', '#27303a', 1.5]} />
        <directionalLight position={[80, 110, 65]} intensity={4.2} color="#f5f7fa" />
        <directionalLight position={[-60, 38, 48]} intensity={3.1} color="#86b8ff" />
        <directionalLight position={[24, 18, -72]} intensity={2.1} color="#f3c68b" />
        <FitCamera
          width={USAGE_SKYLINE_STL_BASE_WIDTH}
          depth={USAGE_SKYLINE_STL_BASE_DEPTH}
          height={30}
          padding={1.2}
          front
        />
        <SceneOrbitControls targetY={4} />
        <mesh position={[0, -USAGE_SKYLINE_STL_BASE_HEIGHT / 2, 0]}>
          <boxGeometry
            args={[
              USAGE_SKYLINE_STL_BASE_WIDTH,
              USAGE_SKYLINE_STL_BASE_HEIGHT,
              USAGE_SKYLINE_STL_BASE_DEPTH,
            ]}
          />
          <meshStandardMaterial color="#68737d" metalness={0.78} roughness={0.3} />
        </mesh>
        <StlLodyLogoRelief />
        <StlMetalColumns model={model} />
      </Canvas>
    </div>
  );
}

function SkylineAscii({ content }: { content: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border/70 bg-[#0d1117] p-3 font-mono text-[9px] leading-[1.15] text-[#39d353] select-text sm:text-[11px]">
      {content}
    </pre>
  );
}

export function UsageCalendarVisualization({
  calendar,
  timeline,
  workspaceName,
  dayDetail,
  dayDetailLoading = false,
  onSelectedDayChange,
}: {
  calendar: SettingsUsageCalendarData;
  /** Selected-range timeline used for the compact skyline and 100% composition rings. */
  timeline?: SettingsUsageTimelineData;
  workspaceName?: string;
  /** Breakdown for the currently selected day; the container owns the query. */
  dayDetail?: SettingsUsageDayData;
  dayDetailLoading?: boolean;
  onSelectedDayChange?: (dayStartMs: number | null) => void;
}) {
  const { t } = useTranslation();
  const [selectedDay, setSelectedDay] = useState<UsageSelectedDay | null>(null);
  // Kept so the panel still has content to render while it collapses.
  const [collapsingDay, setCollapsingDay] = useState<UsageSelectedDay | null>(null);
  const notifiedDayRef = useRef<number | null>(null);
  const [metric, setMetric] = useState<UsageCalendarMetric>('tokens');
  const [shareCardStyle, setShareCardStyle] = useState<UsageShareCardStyle>('isometric');
  const [sharePopoverOpen, setSharePopoverOpen] = useState(false);
  const [sharePreview, setSharePreview] = useState<UsageShareCardPreview | null>(null);
  const [isSharePreviewLoading, setIsSharePreviewLoading] = useState(false);
  // Exports and the share card are always token-denominated; only the on-screen
  // views follow the metric toggle.
  const tokenModel = useMemo(() => createUsageCalendarModel(calendar, 'tokens'), [calendar]);
  const costModel = useMemo(() => createUsageCalendarModel(calendar, 'costUSD'), [calendar]);
  const model = metric === 'tokens' ? tokenModel : costModel;
  const reduced = useReducedMotion() ?? false;
  /**
   * 24h and 7d get the hourly range panel. 30d is the widest range and stays on
   * the year skyline with its window lit, so 30d and all-time are one view.
   */
  const hourlyTimeline =
    timeline && (timeline.range === 'day' || timeline.range === 'week') ? timeline : null;
  const windowTimeline = timeline && timeline.range === 'month' ? timeline : null;
  const rings = useUsageRingComposition(hourlyTimeline ?? undefined);
  const ascii = useMemo(() => createUsageSkylineAscii(tokenModel), [tokenModel]);
  const stem = fileStem(workspaceName || 'lody-usage');

  useEffect(() => {
    scheduleUsageShareCardFontPreload();
  }, []);

  const selectDay = useCallback(
    (day: UsageSelectedDay | null) => {
      setSelectedDay(day);
      if (day) setCollapsingDay(day);
      // Scroll and resize syncs only move the caret. Re-notifying the container
      // on those would restart the day query for a day it already has.
      const nextDayStartMs = day?.dayStartMs ?? null;
      if (notifiedDayRef.current === nextDayStartMs) return;
      notifiedDayRef.current = nextDayStartMs;
      onSelectedDayChange?.(nextDayStartMs);
    },
    [onSelectedDayChange]
  );

  // The hourly matrices remount on every range switch, which strands the caret
  // anchor — a selection only survives 30d <-> all-time, where the heatmap
  // re-measures its own cell.
  const hourlyRange = hourlyTimeline?.range ?? null;
  const previousHourlyRangeRef = useRef(hourlyRange);
  useEffect(() => {
    if (previousHourlyRangeRef.current === hourlyRange) return;
    previousHourlyRangeRef.current = hourlyRange;
    if (selectedDay) selectDay(null);
  }, [hourlyRange, selectDay, selectedDay]);

  const copyAscii = async () => {
    try {
      await navigator.clipboard.writeText(ascii);
      toast.success(t('workspace.usage.skyline.asciiCopied'));
    } catch {
      toast.error(t('workspace.usage.skyline.copyFailed'));
    }
  };

  const exportAscii = () => {
    downloadBlob(
      new Blob([ascii], { type: 'text/plain;charset=utf-8' }),
      `${stem}-usage-skyline.txt`
    );
  };

  const exportStl = () => {
    downloadBlob(
      new Blob([createUsageSkylineBinaryStl(tokenModel)], { type: 'model/stl' }),
      `${stem}-usage-skyline.stl`
    );
  };

  const createCard = useCallback(async () => {
    const card = await createUsageShareCard(
      tokenModel,
      workspaceName || t('workspace.usage.title'),
      `${formatTokens(tokenModel.totalValue)} ${t('workspace.usage.tokens')}`,
      shareCardStyle
    );
    const cardKind = shareCardStyle === 'flat' ? 'heatmap' : 'skyline';
    return new File([card], `${stem}-usage-${cardKind}.png`, { type: 'image/png' });
  }, [shareCardStyle, stem, t, tokenModel, workspaceName]);

  useEffect(() => {
    let cancelled = false;
    if (sharePopoverOpen) {
      setIsSharePreviewLoading(true);
      setSharePreview(null);

      void createCard()
        .then((file) => {
          const url = URL.createObjectURL(file);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          setSharePreview({ file, style: shareCardStyle, url });
        })
        .catch(() => {
          if (!cancelled) toast.error(t('workspace.usage.skyline.cardFailed'));
        })
        .finally(() => {
          if (!cancelled) setIsSharePreviewLoading(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [createCard, shareCardStyle, sharePopoverOpen, t]);

  useEffect(() => {
    const url = sharePreview?.url;
    return () => {
      if (url !== undefined) URL.revokeObjectURL(url);
    };
  }, [sharePreview]);

  const shareCard = async () => {
    try {
      const file = sharePreview?.style === shareCardStyle ? sharePreview.file : await createCard();
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: t('workspace.usage.skyline.shareCard') });
      } else {
        downloadBlob(file, file.name);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      toast.error(t('workspace.usage.skyline.cardFailed'));
    }
  };

  return (
    <section className="overflow-hidden rounded-lg border border-border/60 bg-card/40">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            {t('workspace.usage.skyline.title')}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {hourlyTimeline
              ? t(`workspace.usage.window.${hourlyTimeline.range}.long`)
              : windowTimeline
                ? t('workspace.usage.skyline.windowSubtitle')
                : t('workspace.usage.skyline.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <SegmentedControl
            label={t('workspace.usage.skyline.metric')}
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'tokens', label: t('workspace.usage.tokens') },
              { value: 'costUSD', label: t('workspace.usage.cost') },
            ]}
          />
          {SHOW_SHARE_CARD ? (
            <Popover open={sharePopoverOpen} onOpenChange={setSharePopoverOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t('workspace.usage.skyline.shareCard')}
                    >
                      <Share2 />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>{t('workspace.usage.skyline.shareCard')}</TooltipContent>
              </Tooltip>
              <PopoverContent align="end" className="w-[min(24rem,calc(100vw-1rem))] p-0">
                <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <p className="text-xs font-medium text-popover-foreground/70">
                    {t('workspace.usage.skyline.shareCard')}
                  </p>
                  <SegmentedControl
                    label={t('workspace.usage.skyline.view')}
                    value={shareCardStyle}
                    onChange={setShareCardStyle}
                    options={[
                      { value: 'flat', label: '2D' },
                      { value: 'isometric', label: '3D' },
                    ]}
                  />
                </div>
                <div className="p-3">
                  <div className="relative aspect-[40/21] overflow-hidden rounded-sm border border-border/70 bg-muted/40">
                    {sharePreview ? (
                      <img
                        src={sharePreview.url}
                        alt={t('workspace.usage.skyline.shareCard')}
                        className="h-full w-full object-contain"
                      />
                    ) : null}
                    {isSharePreviewLoading ? (
                      <LoaderCircle className="absolute inset-0 m-auto h-5 w-5 animate-spin text-muted-foreground" />
                    ) : null}
                  </div>
                  <div className="mt-3 flex justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isSharePreviewLoading}
                      onClick={() => void shareCard()}
                    >
                      <Share2 className="h-4 w-4" />
                      {t('workspace.usage.skyline.shareCard')}
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </header>

      <div className="p-4">
        {/* The donut ring is hourly-only chrome with its own fade; it never
            joins the blur cross-fade of the matrix/heatmap container, it only
            re-slices itself when the range's composition changes. One key for
            both skyline ranges: 30d and all-time never unmount each other, so
            widening the window only relights days in place. The hourly panel is
            a different object — popLayout cross-fades the swap instead of
            letting the old view vanish before the new one starts. */}
        <div
          className={cn(
            'relative min-w-0',
            rings
              ? 'grid items-center gap-x-6 gap-y-5 sm:grid-cols-[minmax(0,10.5rem)_minmax(0,1fr)]'
              : ''
          )}
        >
          {/* Hourly ranges only: the ring runs its own plain fade, independent
              of the matrix container's blur cross-fade. popLayout pops the
              leaving ring out of flow at its old spot — otherwise the grid
              collapses to one column first and the exiting ring reflows to
              full width for a frame before fading out. */}
          <AnimatePresence mode="popLayout" initial={false}>
            {rings && hourlyTimeline ? (
              <motion.div
                key="rings"
                className="min-w-0"
                initial={reduced ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduced ? 0 : 0.15, ease: 'easeOut' }}
              >
                <UsageTokenRings
                  segments={rings.segments}
                  caption={rings.caption}
                  total={
                    metric === 'tokens'
                      ? hourlyTimeline.totals.tokens
                      : hourlyTimeline.totals.costUSD
                  }
                  totalLabel={
                    metric === 'tokens' ? t('workspace.usage.tokens') : t('workspace.usage.cost')
                  }
                  metric={metric}
                  reduced={reduced}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={hourlyTimeline ? 'hourly' : 'skyline'}
              className="w-full min-w-0"
              initial={reduced ? false : { opacity: 0, filter: 'blur(6px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, filter: 'blur(6px)' }}
              transition={{ duration: reduced ? 0 : 0.2, ease: 'easeOut' }}
            >
              {hourlyTimeline ? (
                <UsageRangePanel
                  timeline={hourlyTimeline}
                  metric={metric}
                  selectedDayMs={selectedDay?.dayStartMs ?? null}
                  onSelectDay={selectDay}
                />
              ) : (
                <UsageHeatmap
                  model={model}
                  metric={metric}
                  selectedDayMs={selectedDay?.dayStartMs ?? null}
                  onSelectDay={selectDay}
                  windowStartMs={windowTimeline?.startMs}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        {/* Expanding a row height needs a definite value; the 0fr -> 1fr grid
            track does it without measuring the panel. The bezier approximates a
            soft spring — fast start, slight overshoot, gentle settle. */}
        <div
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
                detail={dayDetail}
                loading={dayDetailLoading}
                onClose={() => selectDay(null)}
              />
            ) : null}
          </div>
        </div>
      </div>

      {/* Metrics band: the by-model / by-member composition rules sit above the
          range stats for whichever range is on screen. */}
      <div className="bg-muted/25 px-4 py-4 sm:px-5">
        {timeline ? (
          <UsageCompositionSummary timeline={timeline} reduced={reduced} className="mb-6" />
        ) : null}
        {timeline ? (
          timeline.range === 'total' ? (
            <UsageSummary model={model} metric={metric} />
          ) : (
            <UsageTimelineSummary timeline={timeline} metric={metric} />
          )
        ) : (
          <UsageSummary model={model} metric={metric} />
        )}
      </div>

      <div className="space-y-4 p-4 empty:hidden">
        {SHOW_SKYLINE_EXPORTS ? (
          <>
            <StlMetalView model={tokenModel} />
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3">
              <div className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <FileText className="h-4 w-4" />
                <span>{t('workspace.usage.skyline.asciiPreview')}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => void copyAscii()}
                      aria-label={t('workspace.usage.skyline.copyAscii')}
                    >
                      <Copy />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('workspace.usage.skyline.copyAscii')}</TooltipContent>
                </Tooltip>
                <Button size="sm" variant="outline" onClick={exportAscii}>
                  <Download className="h-4 w-4" />
                  {t('workspace.usage.skyline.downloadAscii')}
                </Button>
                <Button size="sm" onClick={exportStl}>
                  <Box className="h-4 w-4" />
                  {t('workspace.usage.skyline.downloadBinaryStl')}
                </Button>
              </div>
            </div>
            <SkylineAscii content={ascii} />
          </>
        ) : null}
      </div>
    </section>
  );
}

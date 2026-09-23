import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Skeleton } from '../../ui/skeleton';
import type { SettingsUsageRange } from './settings-data-cache';
import {
  CELL_GAP_PX,
  HEATMAP_COLUMN_TEMPLATE,
  HEATMAP_MIN_TRACK_WIDTH,
  USAGE_CALENDAR_CELLS,
  USAGE_CALENDAR_COLUMNS,
  USAGE_CALENDAR_ROWS,
} from './usage-calendar-geometry';

/**
 * Presentational placeholder for UsageCalendarVisualization. Rendered while the
 * usage data is loading and while the lazy three.js chunk resolves, so the card
 * keeps its eventual shape and the page does not reflow.
 *
 * The real card renders three different bodies depending on the selected range
 * (24h/7d hourly matrices with the donut ring, 30d/all-time year heatmap), so
 * the skeleton mirrors that dispatch one level down: shared chrome here, one
 * `*Skeleton` per body shape. Dimensions are copied from the real components —
 * keep them in sync when the visualization changes.
 *
 * Deliberately shares only the plain geometry constants — nothing here may
 * import three.js or usage-calendar-model, which live behind the lazy boundary.
 */
export function UsageCalendarSkeleton({ range }: { range: SettingsUsageRange }) {
  const { t } = useTranslation();
  const shape = range === 'day' ? 'day' : range === 'week' ? 'week' : 'year';

  return (
    <section
      className="overflow-hidden rounded-lg border border-border/60 bg-card/40"
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">{t('workspace.usage.loading', 'Loading usage data...')}</span>
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <h3 className="text-sm font-normal text-foreground">
            {t('workspace.usage.skyline.title')}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {shape === 'year'
              ? range === 'month'
                ? t('workspace.usage.skyline.windowSubtitle')
                : t('workspace.usage.skyline.subtitle')
              : t(`workspace.usage.window.${range}.long`)}
          </p>
        </div>
        {/* Metric toggle chrome — static size, pulsing like the rest. */}
        <Skeleton className="h-8 w-56 rounded-lg" />
      </header>

      <div className="p-4">
        {shape === 'year' ? <YearSkeleton /> : <HourlySkeleton shape={shape} />}
      </div>

      {/* Metrics band: composition rules above the range stats, same as the
         real card's `bg-muted/25` footer. */}
      <div className="bg-muted/25 px-4 py-4 sm:px-5">
        <CompositionSkeleton className="mb-6" />
        <SummarySkeleton />
      </div>
    </section>
  );
}

/* ---------------------------------- shared ---------------------------------- */

/**
 * A pill laid out on a real text line. The row keeps the line-height the loaded
 * copy occupies, so swapping skeleton for text never changes the card's height.
 */
function LinePill({
  size,
  width,
  className,
}: {
  /** Font-size class of the real line, e.g. `text-[11px]` — sets the row height. */
  size: string;
  width: number;
  className?: string;
}) {
  return (
    // `normal` line-height lands near 1.45 for the UI font — the real rows
    // measure that, so the pills stand on the same metric rather than 1.5.
    <div aria-hidden="true" className={cn(size, 'leading-[1.45]', className)}>
      <Skeleton className="inline-block h-[0.75em] align-middle" style={{ width }} />
    </div>
  );
}

function HeatLegendSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
      <span>{t('workspace.usage.skyline.less')}</span>
      <Skeleton className="h-2 w-20 rounded-full" />
      <span>{t('workspace.usage.skyline.more')}</span>
    </div>
  );
}

/** One composition rule + its legend (UsageCompositionBar), times two. */
function CompositionSkeleton({ className }: { className?: string }) {
  const { t } = useTranslation();
  const columns = [t('workspace.usage.byModel'), t('workspace.usage.byUser')];
  return (
    <div
      className={cn(
        'grid gap-x-6 gap-y-3 border-t border-border/50 pt-3 sm:grid-cols-2',
        className
      )}
    >
      {columns.map((label) => (
        <div key={label} className="min-w-0">
          <p className="text-[10px] font-normal uppercase tracking-[0.08em] text-muted-foreground/80">
            {label}
          </p>
          <Skeleton className="mt-1.5 h-1.5 w-full rounded-full" />
          {/* The real legend wraps to two `text-[10px]` rows at this width. */}
          <div className="mt-1.5 flex flex-col gap-y-1 text-[10px]">
            {[
              [88, 72, 96],
              [76, 60],
            ].map((widths, row) => (
              <div key={row} className="flex h-[1.45em] items-center gap-2.5">
                {widths.map((width) => (
                  <span key={width} className="flex items-center gap-1">
                    <Skeleton className="size-1.5 shrink-0 rounded-full" />
                    <Skeleton className="h-[0.75em]" style={{ width }} />
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The five-stat dl both UsageSummary and UsageTimelineSummary render. */
function SummarySkeleton() {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
      {[64, 88, 72, 80, 68].map((width, index) => (
        <div key={index} className="min-w-0">
          <LinePill size="text-[11px]" width={width} />
          <LinePill size="text-sm" width={48} className="mt-0.5" />
          {index === 2 || index === 3 ? <LinePill size="text-[11px]" width={96} /> : null}
        </div>
      ))}
    </dl>
  );
}

/* --------------------------- hourly (24h / 7d) ------------------------------ */

/** 24 hour tracks, shared by the bars, the dot rows, and the hour axis. */
const HOUR_COLUMNS_CLASS = 'grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[3px]';
/** UsageDayMatrix track height. */
const DAY_BAR_TRACK_PX = 148;
/** UsageWeekMatrix row pitch. */
const WEEK_ROW_PX = 18;

/** Skyline silhouette for the 24h skeleton: busy morning/evening, quiet midday. */
const DAY_BAR_HEIGHTS = [
  72, 78, 84, 86, 82, 74, 64, 52, 42, 34, 28, 24, 23, 24, 27, 32, 38, 48, 58, 68, 76, 82, 84, 78,
];

function HourlySkeleton({ shape }: { shape: 'day' | 'week' }) {
  return (
    // Ring column + panel, same grid as the real hourly layout.
    <div className="grid items-center gap-x-6 gap-y-5 sm:grid-cols-[minmax(0,10.5rem)_minmax(0,1fr)]">
      <RingSkeleton />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <LinePill size="text-[11px]" width={192} />
          <div className="flex items-center gap-3">
            <LinePill size="text-[11px]" width={128} />
            <HeatLegendSkeleton />
          </div>
        </div>
        <div className="mt-3">
          <div className="min-h-[10.5rem] min-w-0">
            {shape === 'day' ? <DayBarsSkeleton /> : <WeekDotsSkeleton />}
          </div>
        </div>
        <div className="mt-3 flex h-5 items-center">
          <Skeleton className="h-3 w-52" />
        </div>
      </div>
    </div>
  );
}

/** UsageTokenRings: donut + caption + two-column segment legend. */
function RingSkeleton() {
  return (
    <div className="flex min-w-0 flex-col items-center">
      <div className="relative w-[9.5rem] max-w-full sm:w-[10.5rem]">
        {/* Ring, not a filled disc: border carries the pulse so the centre stays
           open like the real donut (RING_VIEWBOX 168 / RING_STROKE 26). */}
        <Skeleton className="aspect-square w-full rounded-full border-[26px] border-primary/10 bg-transparent" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-2 w-9" />
        </div>
      </div>
      <LinePill size="text-[10px]" width={96} className="mt-3 w-full" />
      {/* Segment rows stand on real text-[10px] lines, like the ring legend. */}
      <div className="mt-1.5 grid w-full grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="flex h-[1.45em] items-center gap-1">
            <Skeleton className="size-1.5 shrink-0 rounded-full" />
            <Skeleton className="h-[0.75em] w-12" />
            <Skeleton className="ml-auto h-[0.75em] w-5" />
          </div>
        ))}
      </div>
    </div>
  );
}

function HourAxisSkeleton() {
  return (
    <div aria-hidden="true" className={cn(HOUR_COLUMNS_CLASS, 'mt-1.5')}>
      {Array.from({ length: 24 }, (_, hour) => (
        <div key={hour} className="flex justify-center">
          {hour % 3 === 0 ? <Skeleton className="h-2 w-4 rounded-sm" /> : null}
        </div>
      ))}
    </div>
  );
}

function DayBarsSkeleton() {
  return (
    <div>
      <div className={HOUR_COLUMNS_CLASS}>
        {DAY_BAR_HEIGHTS.map((height, hour) => (
          <div key={hour} className="flex w-full items-end" style={{ height: DAY_BAR_TRACK_PX }}>
            <Skeleton className="w-full rounded-t-[3px]" style={{ height: `${height}%` }} />
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="h-px w-full bg-border/70" />
      <HourAxisSkeleton />
    </div>
  );
}

/** Deterministic dot sizes for the 7×24 texture; no Math.random. */
function weekDotSize(dayIndex: number, hour: number): number {
  const wave = ((dayIndex * 29 + hour * 17) % 23) / 23;
  return wave > 0.22 ? 4 + Math.round(wave * 9) : 4;
}

function WeekDotsSkeleton() {
  return (
    <div className="flex gap-2">
      <div aria-hidden="true" className="flex shrink-0 flex-col gap-[3px]">
        {Array.from({ length: 7 }, (_, dayIndex) => (
          <div key={dayIndex} className="flex items-center" style={{ height: WEEK_ROW_PX }}>
            <Skeleton className="h-2.5 w-16" />
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-[3px]">
          {Array.from({ length: 7 }, (_, dayIndex) => (
            <div key={dayIndex} className={HOUR_COLUMNS_CLASS}>
              {Array.from({ length: 24 }, (_cell, hour) => {
                const size = weekDotSize(dayIndex, hour);
                return (
                  <div
                    key={hour}
                    className="flex items-center justify-center"
                    style={{ height: WEEK_ROW_PX }}
                  >
                    <Skeleton className="rounded-full" style={{ width: size, height: size }} />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <HourAxisSkeleton />
      </div>
    </div>
  );
}

/* ------------------------------- year (30d / all) ---------------------------- */

function YearSkeleton() {
  return (
    <div className="space-y-3">
      <div className="@container flex gap-1.5">
        {/* Weekday gutter: labels only on rows 1/3/5, like the real heatmap. */}
        <div
          aria-hidden="true"
          className="mt-[calc(0.625rem+0.375rem)] grid w-7 shrink-0 grid-rows-7 gap-[4px]"
        >
          {Array.from({ length: USAGE_CALENDAR_ROWS }, (_, row) => (
            <div key={row} className="flex items-center">
              {row % 2 === 1 ? <Skeleton className="h-2.5 w-6" /> : null}
            </div>
          ))}
        </div>

        <div className="min-w-0 flex-1 overflow-x-auto pb-1">
          <div className="min-w-[var(--usage-heatmap-min-track-width)] px-0.5 @[672px]:min-w-0">
            {/* Month labels row. */}
            <div
              className="mb-1.5 grid gap-[4px]"
              style={{ gridTemplateColumns: HEATMAP_COLUMN_TEMPLATE }}
            >
              {Array.from({ length: USAGE_CALENDAR_COLUMNS }, (_, column) => (
                <div key={column} className="flex">
                  {column % 4 === 1 ? <Skeleton className="h-2.5 w-6" /> : null}
                </div>
              ))}
            </div>

            <div
              className="grid grid-rows-7"
              style={{
                gridTemplateColumns: HEATMAP_COLUMN_TEMPLATE,
                gridAutoFlow: 'column',
                gap: `${CELL_GAP_PX}px`,
                minWidth: HEATMAP_MIN_TRACK_WIDTH,
              }}
            >
              {Array.from({ length: USAGE_CALENDAR_CELLS }, (_, index) => (
                <Skeleton key={index} className="aspect-square w-full rounded-[20%]" />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex h-5 items-center justify-between gap-4">
        <Skeleton className="h-3 w-48" />
        <HeatLegendSkeleton />
      </div>
    </div>
  );
}

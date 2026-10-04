import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Skeleton } from '@lody/ui/skeleton';
import type { SettingsUsageRange } from './settings-data-cache';
import {
  CELL_GAP_PX,
  HEATMAP_COLUMN_TEMPLATE,
  HEATMAP_MIN_TRACK_WIDTH,
  USAGE_CALENDAR_CELLS,
  USAGE_CALENDAR_COLUMNS,
  USAGE_CALENDAR_ROWS,
} from './usage-calendar-geometry';

const COLOR_MIX = '@supports (color: color-mix(in lab, red, red))';

const styles = stylex.create({
  screenReaderOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
  card: {
    overflow: 'hidden',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: {
      default: 'hsl(var(--border) / 1)',
      [COLOR_MIX]: 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
    },
    borderRadius: 'var(--radius-lg)',
    backgroundColor: {
      default: 'hsl(var(--card) / 1)',
      [COLOR_MIX]: 'color-mix(in oklab, hsl(var(--card) / 1) 40%, transparent)',
    },
  },
  header: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    paddingInline: '16px',
    paddingTop: '16px',
  },
  headerText: { minWidth: 0 },
  cardTitle: {
    fontSize: '0.875rem',
    lineHeight: '1.25rem',
    fontWeight: 400,
    color: 'hsl(var(--foreground))',
  },
  subtitle: {
    marginTop: '2px',
    fontSize: '0.75rem',
    lineHeight: '1rem',
    color: 'hsl(var(--muted-foreground))',
  },
  body: { padding: '16px' },
  metricsBand: {
    backgroundColor: {
      default: 'hsl(var(--muted) / 1)',
      [COLOR_MIX]: 'color-mix(in oklab, hsl(var(--muted) / 1) 25%, transparent)',
    },
    padding: '16px',
    '@media (min-width: 640px)': { paddingInline: '20px' },
  },
  compositionSpace: { marginBottom: '24px' },
  line: { lineHeight: 1.45 },
  lineTiny: { fontSize: '10px' },
  lineCaption: { fontSize: '11px' },
  lineFootnote: { fontSize: '0.875rem' },
  heatLegend: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: '8px',
    fontSize: '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  composition: {
    display: 'grid',
    columnGap: '24px',
    rowGap: '12px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.5)',
    paddingTop: '12px',
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  compositionColumn: { minWidth: 0 },
  compositionTitle: {
    fontSize: '10px',
    fontWeight: 400,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: 'hsl(var(--muted-foreground) / 0.8)',
  },
  compositionLegend: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: '4px',
    marginTop: '6px',
    fontSize: '10px',
  },
  legendRow: { display: 'flex', height: '1.45em', alignItems: 'center', gap: '10px' },
  legendItem: { display: 'flex', alignItems: 'center', gap: '4px' },
  summary: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    columnGap: '16px',
    rowGap: '12px',
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
    '@media (min-width: 1024px)': { gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' },
  },
  summaryCell: { minWidth: 0 },
  lineValue: { marginTop: '2px' },
  lineRing: { width: '100%', marginTop: '12px' },
  hourlyGrid: {
    display: 'grid',
    alignItems: 'center',
    columnGap: '24px',
    rowGap: '20px',
    '@media (min-width: 640px)': { gridTemplateColumns: 'minmax(0, 10.5rem) minmax(0, 1fr)' },
  },
  hourlyPanel: { minWidth: 0 },
  hourlyHeading: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    columnGap: '16px',
    rowGap: '4px',
  },
  headingActions: { display: 'flex', alignItems: 'center', gap: '12px' },
  chartSpacing: { marginTop: '12px' },
  chartTrack: { minHeight: '10.5rem', minWidth: 0 },
  axisFooter: { display: 'flex', height: '20px', alignItems: 'center', marginTop: '12px' },
  ringColumn: { display: 'flex', minWidth: 0, flexDirection: 'column', alignItems: 'center' },
  ringBox: {
    position: 'relative',
    width: '9.5rem',
    maxWidth: '100%',
    '@media (min-width: 640px)': { width: '10.5rem' },
  },
  ringOverlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
  },
  ringCaption: { width: '100%', marginTop: '12px' },
  ringLegend: {
    display: 'grid',
    width: '100%',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    columnGap: '12px',
    rowGap: '4px',
    marginTop: '6px',
    fontSize: '10px',
  },
  ringLegendItem: { display: 'flex', height: '1.45em', alignItems: 'center', gap: '4px' },
  hourColumns: { display: 'grid', gridTemplateColumns: 'repeat(24, minmax(0, 1fr))', gap: '3px' },
  hourAxisSpacing: { marginTop: '6px' },
  hourAxisCell: { display: 'flex', justifyContent: 'center' },
  dayTrack: (height: number) => ({
    display: 'flex',
    width: '100%',
    height,
    alignItems: 'flex-end',
  }),
  axisRule: { width: '100%', height: '1px', backgroundColor: 'hsl(var(--border) / 0.7)' },
  weekDots: { display: 'flex', gap: '8px' },
  dayLabels: { display: 'flex', flexShrink: 0, flexDirection: 'column', gap: '3px' },
  weekLabelRow: { display: 'flex', height: '18px', alignItems: 'center' },
  centeredRow: { display: 'flex', alignItems: 'center' },
  weekGrid: { minWidth: 0, flex: 1 },
  weekRows: { display: 'flex', flexDirection: 'column', gap: '3px' },
  weekHourGrid: { display: 'grid', gridTemplateColumns: 'repeat(24, minmax(0, 1fr))', gap: '3px' },
  weekDotRow: (height: number) => ({
    display: 'flex',
    height,
    alignItems: 'center',
    justifyContent: 'center',
  }),
  year: { display: 'flex', flexDirection: 'column', gap: '12px' },
  yearHeatmap: { display: 'flex', gap: '6px', containerType: 'inline-size' },
  weekdayGutter: {
    display: 'grid',
    width: '28px',
    flexShrink: 0,
    gridTemplateRows: 'repeat(7, minmax(0, 1fr))',
    gap: '4px',
    marginTop: '16px',
  },
  calendarScroll: { minWidth: 0, flex: 1, overflowX: 'auto', paddingBottom: '4px' },
  calendarTrack: {
    minWidth: 'var(--usage-heatmap-min-track-width)',
    paddingInline: '2px',
    '@container (min-width: 672px)': { minWidth: 0 },
  },
  monthLabels: { display: 'grid', gap: '4px', marginBottom: '6px' },
  monthCell: { display: 'flex' },
  yearCells: {
    display: 'grid',
    gridTemplateRows: 'repeat(7, minmax(0, 1fr))',
    gridAutoFlow: 'column',
  },
  yearFooter: {
    display: 'flex',
    height: '20px',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
  },
  dynamicColumns: (value: string) => ({ gridTemplateColumns: value }),
  dynamicGap: (value: number) => ({ gap: `${value}px` }),
  dynamicMinWidth: (value: number) => ({ minWidth: value }),
});

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
    <section {...stylex.props(styles.card)} role="status" aria-busy="true">
      <span {...stylex.props(styles.screenReaderOnly)}>
        {t('workspace.usage.loading', 'Loading usage data...')}
      </span>
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.headerText)}>
          <h3 {...stylex.props(styles.cardTitle)}>{t('workspace.usage.skyline.title')}</h3>
          <p {...stylex.props(styles.subtitle)}>
            {shape === 'year'
              ? range === 'month'
                ? t('workspace.usage.skyline.windowSubtitle')
                : t('workspace.usage.skyline.subtitle')
              : t(`workspace.usage.window.${range}.long`)}
          </p>
        </div>
        {/* Metric toggle chrome — static size, pulsing like the rest. */}
        <Skeleton shape="block" width={224} height={32} />
      </header>

      <div {...stylex.props(styles.body)}>
        {shape === 'year' ? <YearSkeleton /> : <HourlySkeleton shape={shape} />}
      </div>

      {/* Metrics band: composition rules above the range stats, same as the
         real card's `bg-muted/25` footer. */}
      <div {...stylex.props(styles.metricsBand)}>
        <CompositionSkeleton />
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
  variant,
}: {
  /** Font size of the real line; it sets the row height. */
  size: 'tiny' | 'caption' | 'footnote';
  width: number;
  variant?: 'value' | 'ring';
}) {
  const lineStyle =
    size === 'tiny'
      ? styles.lineTiny
      : size === 'caption'
        ? styles.lineCaption
        : styles.lineFootnote;
  const variantStyle =
    variant === 'value' ? styles.lineValue : variant === 'ring' ? styles.lineRing : null;
  return (
    <div aria-hidden="true" {...stylex.props(styles.line, lineStyle, variantStyle)}>
      <Skeleton height="0.75em" width={width} className="inline-block align-middle" />
    </div>
  );
}

function HeatLegendSkeleton() {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.heatLegend)}>
      <span>{t('workspace.usage.skyline.less')}</span>
      <Skeleton shape="circle" width={80} height={8} />
      <span>{t('workspace.usage.skyline.more')}</span>
    </div>
  );
}

/** One composition rule + its legend (UsageCompositionBar), times two. */
function CompositionSkeleton() {
  const { t } = useTranslation();
  const columns = [t('workspace.usage.byModel'), t('workspace.usage.byUser')];
  return (
    <div {...stylex.props(styles.composition, styles.compositionSpace)}>
      {columns.map((label) => (
        <div key={label} {...stylex.props(styles.compositionColumn)}>
          <p {...stylex.props(styles.compositionTitle)}>{label}</p>
          <Skeleton shape="circle" height={6} width="100%" className="mt-1.5" />
          {/* The real legend wraps to two `text-[10px]` rows at this width. */}
          <div {...stylex.props(styles.compositionLegend)}>
            {[
              [88, 72, 96],
              [76, 60],
            ].map((widths, row) => (
              <div key={row} {...stylex.props(styles.legendRow)}>
                {widths.map((width) => (
                  <span key={width} {...stylex.props(styles.legendItem)}>
                    <Skeleton shape="circle" width={6} height={6} />
                    <Skeleton height="0.75em" width={width} />
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
    <dl {...stylex.props(styles.summary)}>
      {[64, 88, 72, 80, 68].map((width, index) => (
        <div key={index} {...stylex.props(styles.summaryCell)}>
          <LinePill size="caption" width={width} />
          <LinePill size="footnote" width={48} variant="value" />
          {index === 2 || index === 3 ? <LinePill size="caption" width={96} /> : null}
        </div>
      ))}
    </dl>
  );
}

/* --------------------------- hourly (24h / 7d) ------------------------------ */

/** 24 hour tracks, shared by the bars, the dot rows, and the hour axis. */
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
    <div {...stylex.props(styles.hourlyGrid)}>
      <RingSkeleton />
      <div {...stylex.props(styles.hourlyPanel)}>
        <div {...stylex.props(styles.hourlyHeading)}>
          <LinePill size="caption" width={192} />
          <div {...stylex.props(styles.headingActions)}>
            <LinePill size="caption" width={128} />
            <HeatLegendSkeleton />
          </div>
        </div>
        <div {...stylex.props(styles.chartSpacing)}>
          <div {...stylex.props(styles.chartTrack)}>
            {shape === 'day' ? <DayBarsSkeleton /> : <WeekDotsSkeleton />}
          </div>
        </div>
        <div {...stylex.props(styles.axisFooter)}>
          <Skeleton width={208} height={12} />
        </div>
      </div>
    </div>
  );
}

/** UsageTokenRings: donut + caption + two-column segment legend. */
function RingSkeleton() {
  return (
    <div {...stylex.props(styles.ringColumn)}>
      <div {...stylex.props(styles.ringBox)}>
        {/* Ring, not a filled disc: border carries the pulse so the centre stays
           open like the real donut (RING_VIEWBOX 168 / RING_STROKE 26). */}
        {/* The primitive has no prop for this pre-existing ring appearance.
            Keep the original override as a documented holdout until its API can
            represent the same border and transparent fill. */}
        <Skeleton
          shape="circle"
          width="100%"
          className="aspect-square border-[26px] border-primary/10 bg-transparent"
        />
        <div {...stylex.props(styles.ringOverlay)}>
          <Skeleton width={48} height={16} />
          <Skeleton width={36} height={8} />
        </div>
      </div>
      <LinePill size="tiny" width={96} variant="ring" />
      {/* Segment rows stand on real text-[10px] lines, like the ring legend. */}
      <div {...stylex.props(styles.ringLegend)}>
        {[0, 1, 2, 3].map((index) => (
          <div key={index} {...stylex.props(styles.ringLegendItem)}>
            <Skeleton shape="circle" width={6} height={6} />
            <Skeleton height="0.75em" width={48} />
            <Skeleton className="ml-auto" height="0.75em" width={20} />
          </div>
        ))}
      </div>
    </div>
  );
}

function HourAxisSkeleton() {
  return (
    <div aria-hidden="true" {...stylex.props(styles.hourColumns, styles.hourAxisSpacing)}>
      {Array.from({ length: 24 }, (_, hour) => (
        <div key={hour} {...stylex.props(styles.hourAxisCell)}>
          {hour % 3 === 0 ? <Skeleton width={16} height={8} /> : null}
        </div>
      ))}
    </div>
  );
}

function DayBarsSkeleton() {
  return (
    <div>
      <div {...stylex.props(styles.hourColumns)}>
        {DAY_BAR_HEIGHTS.map((height, hour) => (
          <div key={hour} {...stylex.props(styles.dayTrack(DAY_BAR_TRACK_PX))}>
            <Skeleton width="100%" height={`${height}%`} className="rounded-t-[3px]" />
          </div>
        ))}
      </div>
      <div aria-hidden="true" {...stylex.props(styles.axisRule)} />
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
    <div {...stylex.props(styles.weekDots)}>
      <div aria-hidden="true" {...stylex.props(styles.dayLabels)}>
        {Array.from({ length: 7 }, (_, dayIndex) => (
          <div key={dayIndex} {...stylex.props(styles.weekLabelRow)}>
            <Skeleton width={64} height={10} />
          </div>
        ))}
      </div>
      <div {...stylex.props(styles.weekGrid)}>
        <div {...stylex.props(styles.weekRows)}>
          {Array.from({ length: 7 }, (_, dayIndex) => (
            <div key={dayIndex} {...stylex.props(styles.weekHourGrid)}>
              {Array.from({ length: 24 }, (_cell, hour) => {
                const size = weekDotSize(dayIndex, hour);
                return (
                  <div key={hour} {...stylex.props(styles.weekDotRow(WEEK_ROW_PX))}>
                    <Skeleton shape="circle" width={size} height={size} />
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
    <div {...stylex.props(styles.year)}>
      <div {...stylex.props(styles.yearHeatmap)}>
        {/* Weekday gutter: labels only on rows 1/3/5, like the real heatmap. */}
        <div aria-hidden="true" {...stylex.props(styles.weekdayGutter)}>
          {Array.from({ length: USAGE_CALENDAR_ROWS }, (_, row) => (
            <div key={row} {...stylex.props(styles.centeredRow)}>
              {row % 2 === 1 ? <Skeleton width={24} height={10} /> : null}
            </div>
          ))}
        </div>

        <div {...stylex.props(styles.calendarScroll)}>
          <div {...stylex.props(styles.calendarTrack)}>
            {/* Month labels row. */}
            <div
              {...stylex.props(styles.monthLabels, styles.dynamicColumns(HEATMAP_COLUMN_TEMPLATE))}
            >
              {Array.from({ length: USAGE_CALENDAR_COLUMNS }, (_, column) => (
                <div key={column} {...stylex.props(styles.monthCell)}>
                  {column % 4 === 1 ? <Skeleton width={24} height={10} /> : null}
                </div>
              ))}
            </div>

            <div
              {...stylex.props(
                styles.yearCells,
                styles.dynamicColumns(HEATMAP_COLUMN_TEMPLATE),
                styles.dynamicGap(CELL_GAP_PX),
                styles.dynamicMinWidth(HEATMAP_MIN_TRACK_WIDTH)
              )}
            >
              {Array.from({ length: USAGE_CALENDAR_CELLS }, (_, index) => (
                <Skeleton
                  key={index}
                  shape="block"
                  width="100%"
                  className="aspect-square rounded-[20%]"
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div {...stylex.props(styles.yearFooter)}>
        <Skeleton width={192} height={12} />
        <HeatLegendSkeleton />
      </div>
    </div>
  );
}

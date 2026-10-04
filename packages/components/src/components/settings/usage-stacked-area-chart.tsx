import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { withClassName } from '@/lib/stylex';
import { Skeleton } from '@lody/ui/skeleton';

export type StackedAreaSeriesValue = {
  id: string;
  label: string;
  value: number;
};

export type StackedAreaBucket = {
  label: string;
  values: StackedAreaSeriesValue[];
};

export type StackedAreaSeriesDef = {
  id: string;
  label: string;
  color: string;
  total: number;
};

type SeriesDef = StackedAreaSeriesDef;

/** Custom legend / tooltip marker (defaults to a color swatch). */
export type StackedAreaSeriesMarkerRender = (series: StackedAreaSeriesDef) => ReactNode;

type UsageStackedAreaChartProps = {
  title: string;
  buckets: StackedAreaBucket[];
  emptyText: string;
  className?: string;
  maxSeries?: number;
  valueFormatter?: (value: number) => string;
  tooltipValueFormatter?: (value: number) => string;
  /**
   * Optional legend/tooltip marker. Defaults to a small color square.
   * Use for avatars, agent glyphs, etc. without changing chart geometry.
   */
  renderSeriesMarker?: StackedAreaSeriesMarkerRender;
  /**
   * When true, the series name in the legend/tooltip is colored with the series
   * stroke color (instead of relying on a swatch or ring).
   */
  tintSeriesLabel?: boolean;
  /**
   * Render a chart-shaped placeholder while the range data resolves. Only takes
   * effect when there is no data to show yet — populated charts stay mounted
   * during background refreshes so they never flash back into a skeleton.
   */
  loading?: boolean;
  /** Accessible loading announcement; rendered visually hidden. */
  loadingText?: string;
};

type UsagePerspectiveChartProps = {
  title: string;
  buckets: StackedAreaBucket[];
  emptyText: string;
  className?: string;
};

const DEFAULT_COLORS = [
  '#2563eb',
  '#0ea5e9',
  '#06b6d4',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#14b8a6',
];
const OTHER_COLOR = '#6b7280';
const OTHER_ID = '__other__';

const CHART_HEIGHT_DESKTOP = 224;
const CHART_HEIGHT_MOBILE = 184;
const AXIS_COLOR = 'hsl(var(--muted-foreground))';
const GRID_COLOR = 'hsl(var(--border))';

const darkTheme =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';

const styles = stylex.create({
  card: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--card)) 60%, transparent)',
  },
  clippedCard: { overflow: 'hidden' },
  emptyCard: { fontSize: '0.875rem', lineHeight: '1.25rem' },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minHeight: '40px',
    paddingInline: space[3],
    paddingBlock: space[1.5],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    backgroundColor: {
      default: 'transparent',
      [darkTheme]: 'color-mix(in oklab, hsl(var(--muted)) 40%, transparent)',
    },
  },
  headerTitle: {
    margin: 0,
    color: 'hsl(var(--muted-foreground))',
    fontSize: '0.75rem',
    fontWeight: 400,
    lineHeight: '1rem',
  },
  plotInset: { padding: space[4] },
  emptyMessage: {
    margin: 0,
    color: 'hsl(var(--muted-foreground))',
    fontSize: '0.875rem',
    lineHeight: '1.25rem',
  },
  tooltip: {
    minWidth: '180px',
    maxWidth: '260px',
    paddingInline: space[3],
    paddingBlock: space[2],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab, hsl(var(--border)) 80%, transparent)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--background)) 95%, transparent)',
    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    backdropFilter: 'blur(var(--blur-sm))',
    fontSize: '0.75rem',
    lineHeight: '1rem',
  },
  tooltipLabel: { color: 'hsl(var(--foreground))', fontWeight: 400 },
  tooltipTotal: {
    marginBlockStart: space[1],
    color: 'hsl(var(--muted-foreground))',
    fontFamily: 'var(--font-mono)',
  },
  tooltipRows: { display: 'flex', flexDirection: 'column', gap: space[1], marginBlockStart: '6px' },
  tooltipRow: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
  },
  tooltipMarkerLabel: {
    display: 'inline-flex',
    minWidth: 0,
    alignItems: 'center',
    gap: space[1.5],
    color: 'hsl(var(--muted-foreground))',
  },
  truncate: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tooltipValue: { flexShrink: 0, color: 'hsl(var(--foreground))', fontFamily: 'var(--font-mono)' },
  marker: { display: 'inline-block', flexShrink: 0, borderRadius: 'var(--radius-xs)' },
  markerSmall: { width: space[2], height: space[2] },
  markerMedium: { width: '10px', height: '10px' },
  loadingSvg: { position: 'absolute', inset: 0, width: '100%', height: '100%' },
  loadingPlot: {
    position: 'relative',
    overflow: 'hidden',
  },
  loadingAxis: {
    position: 'absolute',
    insetInline: '56px',
    bottom: space[1.5],
    display: 'flex',
    justifyContent: 'space-between',
  },
  legendFrame: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    paddingInline: space[4],
    paddingTop: space[2],
    paddingBottom: space[3],
  },
  loadingLegend: { display: 'flex', flexWrap: 'wrap', columnGap: space[3], rowGap: space[1.5] },
  legend: { display: 'flex', flexWrap: 'wrap', columnGap: space[3], rowGap: space[1.5] },
  legendItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    fontSize: '0.75rem',
    lineHeight: '1rem',
  },
  legendLabel: {
    maxWidth: '200px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 400,
  },
  mutedText: { color: 'hsl(var(--muted-foreground))' },
  totalValue: {
    flexShrink: 0,
    whiteSpace: 'nowrap',
    color: 'hsl(var(--foreground))',
    fontFamily: 'var(--font-mono)',
  },
  perspectivePlot: {
    position: 'relative',
    height: { default: '238px', '@media (min-width: 640px)': '272px' },
    overflow: 'hidden',
    backgroundColor: 'hsl(var(--muted) / 0.2)',
  },
  perspectiveCanvas: {
    position: 'absolute',
    insetBlockStart: space[2],
    insetInline: { default: space[3], '@media (min-width: 640px)': '20px' },
    height: '250px',
    transform: 'perspective(700px) rotateY(-30deg) scale(0.9)',
    transformOrigin: '50% 50%',
  },
  perspectiveSvg: { width: '100%', height: '100%' },
  markerColor: (color: string) => ({ backgroundColor: color }),
  seriesColor: (color: string) => ({ color }),
  visuallyHidden: {
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
});

function formatPerspectiveAxisValue(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${Math.round(value)}`;
}

function useIsMobileChart() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 639px)').matches;
  });

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 639px)');
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isMobile;
}

type PreparedChart = {
  series: SeriesDef[];
  /** One row per bucket: `{ label, [seriesId]: value }`. */
  data: Array<Record<string, number | string>>;
};

function prepareChart(buckets: StackedAreaBucket[], maxSeries: number): PreparedChart | null {
  if (buckets.length === 0) {
    return null;
  }

  const totalsBySeries = new Map<string, { label: string; total: number }>();
  for (const bucket of buckets) {
    for (const item of bucket.values) {
      const existing = totalsBySeries.get(item.id);
      if (existing) {
        existing.total += item.value;
      } else {
        totalsBySeries.set(item.id, { label: item.label, total: item.value });
      }
    }
  }

  const sorted = [...totalsBySeries.entries()]
    .map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => b.total - a.total);

  const visibleSeries = sorted.slice(0, maxSeries);
  const hiddenSeries = sorted.slice(maxSeries);
  const visibleIds = new Set(visibleSeries.map((series) => series.id));

  const series: SeriesDef[] = visibleSeries.map((entry, index) => ({
    id: entry.id,
    label: entry.label,
    color: DEFAULT_COLORS[index % DEFAULT_COLORS.length],
    total: entry.total,
  }));

  if (hiddenSeries.length > 0) {
    series.push({
      id: OTHER_ID,
      label: 'Other',
      color: OTHER_COLOR,
      total: hiddenSeries.reduce((sum, entry) => sum + entry.total, 0),
    });
  }

  const data = buckets.map((bucket) => {
    const row: Record<string, number | string> = { label: bucket.label };
    for (const s of series) {
      row[s.id] = 0;
    }
    for (const item of bucket.values) {
      if (visibleIds.has(item.id)) {
        row[item.id] = (row[item.id] as number) + item.value;
      } else {
        row[OTHER_ID] = ((row[OTHER_ID] as number) ?? 0) + item.value;
      }
    }
    return row;
  });

  return { series, data };
}

function DefaultSeriesMarker({ color, size = 'sm' }: { color: string; size?: 'sm' | 'md' }) {
  return (
    <span
      {...stylex.props(
        styles.marker,
        size === 'sm' ? styles.markerSmall : styles.markerMedium,
        styles.markerColor(color)
      )}
    />
  );
}

function UsageTooltip({
  active,
  payload,
  label,
  series,
  tooltipValueFormatter,
  renderSeriesMarker,
  tintSeriesLabel,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number }>;
  label?: string;
  series: SeriesDef[];
  tooltipValueFormatter: (value: number) => string;
  renderSeriesMarker?: StackedAreaSeriesMarkerRender;
  tintSeriesLabel?: boolean;
}) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  const seriesById = new Map(series.map((s) => [s.id, s]));
  const rows = payload
    .map((entry) => {
      const def = seriesById.get(String(entry.dataKey));
      return {
        id: String(entry.dataKey),
        label: def?.label ?? String(entry.dataKey),
        color: def?.color ?? OTHER_COLOR,
        total: def?.total ?? 0,
        value: entry.value ?? 0,
      };
    })
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = rows.reduce((sum, row) => sum + row.value, 0);

  return (
    <div {...stylex.props(styles.tooltip)}>
      <div {...stylex.props(styles.tooltipLabel)}>{label}</div>
      <div {...stylex.props(styles.tooltipTotal)}>{tooltipValueFormatter(total)}</div>
      <div {...stylex.props(styles.tooltipRows)}>
        {rows.slice(0, 6).map((row) => (
          <div key={row.id} {...stylex.props(styles.tooltipRow)}>
            <span {...stylex.props(styles.tooltipMarkerLabel)}>
              {renderSeriesMarker ? (
                renderSeriesMarker({
                  id: row.id,
                  label: row.label,
                  color: row.color,
                  total: row.total,
                })
              ) : (
                <DefaultSeriesMarker color={row.color} size="sm" />
              )}
              <span
                {...stylex.props(styles.truncate, tintSeriesLabel && styles.seriesColor(row.color))}
              >
                {row.label}
              </span>
            </span>
            <span {...stylex.props(styles.tooltipValue)}>{tooltipValueFormatter(row.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const LEGEND_PLACEHOLDER_WIDTHS = [112, 96, 128, 88, 104];

function ChartLoadingPlaceholder({ chartHeight }: { chartHeight: number }) {
  return (
    <>
      <div {...stylex.props(styles.plotInset)}>
        {/* Same footprint as the real chart: a full-height plot with layered
           area silhouettes, gridlines, and axis tick placeholders. */}
        <Skeleton
          shape="block"
          width="100%"
          height={chartHeight}
          {...withClassName(stylex.props(styles.loadingPlot), 'bg-primary/[0.06]')}
        >
          <svg
            aria-hidden="true"
            {...stylex.props(styles.loadingSvg)}
            viewBox="0 0 600 200"
            preserveAspectRatio="none"
          >
            {[0.25, 0.5, 0.75].map((progress) => (
              <line
                key={progress}
                x1="0"
                x2="600"
                y1={200 * progress}
                y2={200 * progress}
                stroke={GRID_COLOR}
                strokeOpacity="0.4"
              />
            ))}
            <path
              d="M0,150 C60,142 100,92 160,82 C240,68 300,112 380,92 C460,74 540,42 600,52 L600,200 L0,200 Z"
              fill="hsl(var(--chart-1) / 0.14)"
            />
            <path
              d="M0,176 C80,170 140,132 220,126 C320,118 400,142 500,120 C550,109 580,106 600,102 L600,200 L0,200 Z"
              fill="hsl(var(--chart-2, var(--chart-1)) / 0.18)"
            />
          </svg>
          <div {...stylex.props(styles.loadingAxis)}>
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} width={24} height={8} />
            ))}
          </div>
        </Skeleton>
      </div>
      <div {...stylex.props(styles.legendFrame)}>
        <div {...stylex.props(styles.loadingLegend)}>
          {LEGEND_PLACEHOLDER_WIDTHS.map((width) => (
            <Skeleton key={width} height={16} width={width} />
          ))}
        </div>
      </div>
    </>
  );
}

export function UsageStackedAreaChart({
  title,
  buckets,
  emptyText,
  className,
  maxSeries = 6,
  valueFormatter = (value) => new Intl.NumberFormat().format(Math.round(value)),
  tooltipValueFormatter = (value) => new Intl.NumberFormat().format(Math.round(value)),
  renderSeriesMarker,
  tintSeriesLabel = false,
  loading = false,
  loadingText,
}: UsageStackedAreaChartProps) {
  const gradientPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const isMobile = useIsMobileChart();
  const chartHeight = isMobile ? CHART_HEIGHT_MOBILE : CHART_HEIGHT_DESKTOP;

  const prepared = useMemo(() => prepareChart(buckets, maxSeries), [buckets, maxSeries]);

  if (loading && !prepared) {
    return (
      <div
        {...withClassName(stylex.props(styles.card, styles.clippedCard), className)}
        role="status"
        aria-busy="true"
      >
        <header {...stylex.props(styles.header)}>
          <p {...stylex.props(styles.headerTitle)}>{title}</p>
        </header>
        <ChartLoadingPlaceholder chartHeight={chartHeight} />
        {loadingText ? <span {...stylex.props(styles.visuallyHidden)}>{loadingText}</span> : null}
      </div>
    );
  }

  if (!prepared) {
    return (
      <div {...withClassName(stylex.props(styles.card, styles.emptyCard), className)}>
        <header {...stylex.props(styles.header)}>
          <p {...stylex.props(styles.headerTitle)}>{title}</p>
        </header>
        <div {...stylex.props(styles.plotInset)}>
          <p {...stylex.props(styles.emptyMessage)}>{emptyText}</p>
        </div>
      </div>
    );
  }

  // Keep the x-axis to ~8 labels regardless of bucket count so the "All time"
  // range (which can have many daily buckets) does not crowd the axis.
  const xTickStep = Math.max(1, Math.ceil(prepared.data.length / 8));
  const xTicks = prepared.data
    .filter((_, index) => index % xTickStep === 0)
    .map((row) => row.label);

  return (
    <div {...withClassName(stylex.props(styles.card, styles.clippedCard), className)}>
      <header {...stylex.props(styles.header)}>
        <p {...stylex.props(styles.headerTitle)}>{title}</p>
      </header>
      <div {...stylex.props(styles.plotInset)}>
        {/* ResponsiveContainer measures the parent and never overflows, so the
           chart always fits its column — no horizontal scroll. */}
        <ResponsiveContainer width="100%" height={chartHeight}>
          <AreaChart data={prepared.data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <defs>
              {prepared.series.map((s) => {
                const gradientId = `${gradientPrefix}-${s.id}`;
                return (
                  <linearGradient key={gradientId} id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.42} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0.08} />
                  </linearGradient>
                );
              })}
            </defs>

            <CartesianGrid vertical={false} stroke={GRID_COLOR} strokeOpacity={0.4} />

            <XAxis
              dataKey="label"
              ticks={xTicks}
              interval="preserveStartEnd"
              tickLine={false}
              axisLine={{ stroke: GRID_COLOR, strokeOpacity: 0.6 }}
              tick={{ fill: AXIS_COLOR, fontSize: 10 }}
              tickMargin={8}
              minTickGap={8}
            />
            <YAxis
              width={52}
              tickLine={false}
              axisLine={false}
              tick={{ fill: AXIS_COLOR, fontSize: 10 }}
              tickFormatter={(value: number) => valueFormatter(value)}
            />
            <Tooltip
              cursor={{ stroke: AXIS_COLOR, strokeOpacity: 0.5, strokeDasharray: '3 3' }}
              // Recharts keeps the tooltip inside the chart bounds, so the
              // right-most bucket flips leftward instead of being clipped.
              content={
                <UsageTooltip
                  series={prepared.series}
                  tooltipValueFormatter={tooltipValueFormatter}
                  renderSeriesMarker={renderSeriesMarker}
                  tintSeriesLabel={tintSeriesLabel}
                />
              }
            />

            {prepared.series.map((s) => (
              <Area
                key={s.id}
                type="monotone"
                dataKey={s.id}
                name={s.label}
                stackId="usage"
                stroke={s.color}
                strokeWidth={1.25}
                strokeOpacity={0.9}
                fill={`url(#${gradientPrefix}-${s.id})`}
                isAnimationActive={false}
                activeDot={{ r: 2.5, strokeWidth: 0 }}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div {...stylex.props(styles.legendFrame)}>
        <div {...stylex.props(styles.legend)}>
          {prepared.series.map((s) => (
            <div key={s.id} {...stylex.props(styles.legendItem)}>
              {renderSeriesMarker ? (
                renderSeriesMarker(s)
              ) : (
                <DefaultSeriesMarker color={s.color} size="md" />
              )}
              <span
                {...stylex.props(
                  styles.legendLabel,
                  tintSeriesLabel ? styles.seriesColor(s.color) : styles.mutedText
                )}
              >
                {s.label}
              </span>
              <span {...stylex.props(styles.totalValue)}>{valueFormatter(s.total)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function UsagePerspectiveChart({
  title,
  buckets,
  emptyText,
  className,
}: UsagePerspectiveChartProps) {
  const gradientId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const chart = useMemo(() => {
    const values = buckets.map((bucket) =>
      bucket.values.reduce((total, value) => total + value.value, 0)
    );
    if (values.length === 0) return null;

    const width = 1000;
    const chartTop = 34;
    const baseline = 186;
    const horizontalPadding = 98;
    const maximum = Math.max(...values, 1);
    const points = values.map((value, index) => {
      const progress = values.length === 1 ? 0.5 : index / (values.length - 1);
      return {
        x: horizontalPadding + progress * (width - horizontalPadding * 2),
        y: baseline - (value / maximum) * (baseline - chartTop),
      };
    });
    const linePath = points
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
      .join(' ');
    const first = points[0]!;
    const last = points.at(-1)!;
    const xTickIndexes = [...new Set([0, Math.floor((values.length - 1) / 2), values.length - 1])];
    return {
      areaPath: `${linePath} L ${last.x} ${baseline} L ${first.x} ${baseline} Z`,
      baseline,
      linePath,
      xTicks: xTickIndexes.map((index) => ({ label: buckets[index]!.label, x: points[index]!.x })),
      yTicks: [0, 0.5, 1].map((progress) => ({
        value: maximum * progress,
        y: baseline - progress * (baseline - chartTop),
      })),
    };
  }, [buckets]);

  if (!chart) {
    return (
      <div {...withClassName(stylex.props(styles.card, styles.emptyCard), className)}>
        <header {...stylex.props(styles.header)}>
          <p {...stylex.props(styles.headerTitle)}>{title}</p>
        </header>
        <div {...stylex.props(styles.plotInset, styles.mutedText)}>{emptyText}</div>
      </div>
    );
  }

  return (
    <div {...withClassName(stylex.props(styles.card, styles.clippedCard), className)}>
      <header {...stylex.props(styles.header)}>
        <p {...stylex.props(styles.headerTitle)}>{title}</p>
      </header>
      <div {...stylex.props(styles.perspectivePlot)}>
        <div {...stylex.props(styles.perspectiveCanvas)}>
          <svg
            aria-hidden="true"
            {...stylex.props(styles.perspectiveSvg)}
            viewBox="0 0 1000 260"
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id={`${gradientId}-area`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#22c55e" stopOpacity="0.52" />
                <stop offset="100%" stopColor="#22c55e" stopOpacity="0.08" />
              </linearGradient>
            </defs>
            <rect
              x="46"
              y="18"
              width="916"
              height="220"
              rx="5"
              fill="currentColor"
              fillOpacity="0.025"
              stroke="currentColor"
              strokeOpacity="0.14"
            />
            {chart.yTicks.map((tick) => (
              <g key={tick.y}>
                <line
                  x1="98"
                  x2="932"
                  y1={tick.y}
                  y2={tick.y}
                  stroke="currentColor"
                  strokeOpacity="0.12"
                  strokeDasharray="3 8"
                />
                <text
                  x="82"
                  y={tick.y + 4}
                  fill="currentColor"
                  fontSize="12"
                  opacity="0.58"
                  textAnchor="end"
                >
                  {formatPerspectiveAxisValue(tick.value)}
                </text>
              </g>
            ))}
            <line
              x1="98"
              x2="932"
              y1={chart.baseline}
              y2={chart.baseline}
              stroke="currentColor"
              strokeOpacity="0.35"
            />
            <line
              x1="98"
              x2="98"
              y1="34"
              y2={chart.baseline}
              stroke="currentColor"
              strokeOpacity="0.35"
            />
            {chart.xTicks.map((tick) => (
              <g key={tick.x}>
                <line
                  x1={tick.x}
                  x2={tick.x}
                  y1={chart.baseline}
                  y2={chart.baseline + 6}
                  stroke="currentColor"
                  strokeOpacity="0.35"
                />
                <text
                  x={tick.x}
                  y={chart.baseline + 23}
                  fill="currentColor"
                  fontSize="12"
                  opacity="0.58"
                  textAnchor="middle"
                >
                  {tick.label}
                </text>
              </g>
            ))}
            <path d={chart.areaPath} fill={`url(#${gradientId}-area)`} />
            <path
              d={chart.linePath}
              fill="none"
              stroke="#16a34a"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="5"
            />
          </svg>
        </div>
      </div>
    </div>
  );
}

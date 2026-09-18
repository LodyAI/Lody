import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/lib/utils';

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
      className={cn(
        'inline-block shrink-0 rounded-xs',
        size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5'
      )}
      style={{ backgroundColor: color }}
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
    <div className="min-w-[180px] max-w-[260px] rounded-md border border-border/80 bg-background/95 px-3 py-2 text-xs shadow-md backdrop-blur-sm">
      <div className="font-normal text-foreground">{label}</div>
      <div className="mt-1 font-mono text-muted-foreground">{tooltipValueFormatter(total)}</div>
      <div className="mt-1.5 space-y-1">
        {rows.slice(0, 6).map((row) => (
          <div key={row.id} className="flex min-w-0 items-center justify-between gap-3">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
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
                className="min-w-0 truncate whitespace-nowrap"
                style={tintSeriesLabel ? { color: row.color } : undefined}
              >
                {row.label}
              </span>
            </span>
            <span className="shrink-0 font-mono text-foreground">
              {tooltipValueFormatter(row.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
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
}: UsageStackedAreaChartProps) {
  const gradientPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const isMobile = useIsMobileChart();
  const chartHeight = isMobile ? CHART_HEIGHT_MOBILE : CHART_HEIGHT_DESKTOP;

  const prepared = useMemo(() => prepareChart(buckets, maxSeries), [buckets, maxSeries]);

  if (!prepared) {
    return (
      <div className={cn('rounded-lg border border-border/70 bg-card/60 text-sm', className)}>
        <header className="flex min-h-10 items-center gap-2 border-b border-border/70 bg-muted/40 px-3 py-1.5">
          <p className="text-xs font-normal text-muted-foreground">{title}</p>
        </header>
        <div className="p-4">
          <p className="text-sm text-muted-foreground">{emptyText}</p>
        </div>
      </div>
    );
  }

  // Keep the x-axis to ~8 labels regardless of bucket count so the "All time"
  // range (which can have many daily buckets) does not crowd the axis.
  const xInterval = Math.max(0, Math.ceil(prepared.data.length / 8) - 1);

  return (
    <div className={cn('overflow-hidden rounded-lg border border-border/70 bg-card/60', className)}>
      <header className="flex min-h-10 items-center gap-2 border-b border-border/70 bg-muted/40 px-3 py-1.5">
        <p className="text-xs font-normal text-muted-foreground">{title}</p>
      </header>
      <div className="p-4">
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
              interval={xInterval}
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

      <div className="border-t border-border/60 px-4 pb-3 pt-2">
        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
          {prepared.series.map((s) => (
            <div key={s.id} className="inline-flex items-center gap-1.5 text-xs">
              {renderSeriesMarker ? (
                renderSeriesMarker(s)
              ) : (
                <DefaultSeriesMarker color={s.color} size="md" />
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
                {valueFormatter(s.total)}
              </span>
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
      <div className={cn('rounded-lg border border-border/70 bg-card/60 text-sm', className)}>
        <header className="flex min-h-10 items-center border-b border-border/70 bg-muted/40 px-3 py-1.5">
          <p className="text-xs font-normal text-muted-foreground">{title}</p>
        </header>
        <div className="p-4 text-muted-foreground">{emptyText}</div>
      </div>
    );
  }

  return (
    <div className={cn('overflow-hidden rounded-lg border border-border/70 bg-card/60', className)}>
      <header className="flex min-h-10 items-center border-b border-border/70 bg-muted/40 px-3 py-1.5">
        <p className="text-xs font-normal text-muted-foreground">{title}</p>
      </header>
      <div className="relative h-[238px] overflow-hidden bg-muted/20 sm:h-[272px]">
        <div
          className="absolute inset-x-3 top-2 h-[250px] sm:inset-x-5"
          style={{
            transform: 'perspective(700px) rotateY(-30deg) scale(0.9)',
            transformOrigin: '50% 50%',
          }}
        >
          <svg
            aria-hidden="true"
            className="h-full w-full"
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
            <line x1="98" x2="932" y1={chart.baseline} y2={chart.baseline} stroke="currentColor" strokeOpacity="0.35" />
            <line x1="98" x2="98" y1="34" y2={chart.baseline} stroke="currentColor" strokeOpacity="0.35" />
            {chart.xTicks.map((tick) => (
              <g key={tick.x}>
                <line x1={tick.x} x2={tick.x} y1={chart.baseline} y2={chart.baseline + 6} stroke="currentColor" strokeOpacity="0.35" />
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

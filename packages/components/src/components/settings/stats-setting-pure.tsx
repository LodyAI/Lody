import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import NumberFlow from '@number-flow/react';
import { useTranslation } from 'react-i18next';
import { Coins, DollarSign, Share2 } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';
import { formatCompactNumber, formatUsdAmount } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import {
  UsageStackedAreaChart,
  type StackedAreaBucket,
  type StackedAreaSeriesMarkerRender,
} from './usage-stacked-area-chart';
import { UsageCalendarSkeleton } from './usage-calendar-skeleton';
import type {
  SettingsUsageCalendarData,
  SettingsUsageDayData,
  SettingsUsageRange,
  SettingsUsageTimelineData,
} from './settings-data-cache';

export type StatsSettingsViewProps = {
  workspaceName?: string;
  range: SettingsUsageRange;
  onRangeChange: (range: SettingsUsageRange) => void;
  /** True once the timeline for the active range has loaded. */
  ready: boolean;
  totals: { tokens: number; costUSD: number } | null;
  byModelBuckets: StackedAreaBucket[];
  byMemberBuckets: StackedAreaBucket[];
  usageCalendar?: SettingsUsageCalendarData;
  /** Timeline for the selected range; drives the range-aware skyline and composition rings. */
  usageTimeline?: SettingsUsageTimelineData;
  /** Breakdown for the day selected in the calendar, when one is open. */
  usageDay?: SettingsUsageDayData;
  usageDayLoading?: boolean;
  onSelectedUsageDayChange?: (dayStartMs: number | null) => void;
  /** null when no workspace is selected. */
  workspaceId: string | null;
  /** True while the active-range timeline is still resolving. */
  loading: boolean;
  /** Optional legend/tooltip markers for the by-model chart. */
  renderModelSeriesMarker?: StackedAreaSeriesMarkerRender;
  /** Optional legend/tooltip markers for the by-member chart. */
  renderMemberSeriesMarker?: StackedAreaSeriesMarkerRender;
  /** Color series names with chart stroke colors (model chart). */
  tintModelSeriesLabel?: boolean;
  /** Color series names with chart stroke colors (member chart). */
  tintMemberSeriesLabel?: boolean;
  /**
   * USD fraction digits for the cost KPI. Defaults to 2. Landing demos pass 0
   * so large totals ($23,740) fit the tile without clipping.
   */
  costFractionDigits?: number;
  /**
   * Opt-in share entry. Off by default so the public landing demo neither shows
   * an action it cannot perform nor pulls the capture pipeline into its bundle.
   */
  shareCard?: boolean;
};

const RANGE_ORDER: SettingsUsageRange[] = ['day', 'week', 'month', 'total'];
const DARK_THEME =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';
const COLOR_MIX = '@supports (color: color-mix(in lab, red, red))';

const styles = stylex.create({
  page: { display: 'flex', flexDirection: 'column', gap: '16px' },
  header: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: '12px',
  },
  workspaceName: { minWidth: 0 },
  workspaceHeading: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '1.125rem',
    fontWeight: 400,
    lineHeight: 1.25,
    color: 'hsl(var(--foreground))',
  },
  windowCaption: {
    marginTop: '2px',
    fontSize: '0.75rem',
    lineHeight: '1rem',
    color: 'hsl(var(--muted-foreground))',
  },
  headerActions: { display: 'flex', alignItems: 'center', gap: '6px' },
  rangeTray: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.6)',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'hsl(var(--muted) / 0.4)',
    padding: '2px',
  },
  rangeTab: {
    borderRadius: 'var(--radius-md)',
    paddingInline: '12px',
    paddingBlock: '4px',
    fontSize: '0.75rem',
    lineHeight: '1rem',
    fontWeight: 400,
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    color: {
      default: 'hsl(var(--muted-foreground))',
      ':hover': 'hsl(var(--foreground))',
    },
  },
  rangeTabSelected: {
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
    boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  },
  statGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px' },
  statTile: {
    position: 'relative',
    containerType: 'inline-size',
    display: 'flex',
    minWidth: 0,
    flexDirection: 'column',
    gap: '12px',
    overflow: 'hidden',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.7)',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'hsl(var(--card) / 0.6)',
    padding: '16px',
  },
  statLabel: { fontSize: '0.8rem', fontWeight: 400, color: 'hsl(var(--muted-foreground))' },
  statContents: { marginTop: 'auto' },
  statValue: {
    display: 'flex',
    minWidth: 0,
    minHeight: '4.25rem',
    alignItems: 'center',
    whiteSpace: 'nowrap',
    fontSize: 'clamp(1.5rem, 16cqw, 2.75rem)',
    fontWeight: 400,
    lineHeight: 1,
    letterSpacing: '-0.025em',
    fontVariantNumeric: 'tabular-nums',
    color: 'hsl(var(--foreground))',
  },
  statFooter: { marginTop: '8px' },
  watermarkTokens: {
    position: 'absolute',
    right: '-32px',
    bottom: '-32px',
    width: '15rem',
    height: '15rem',
    color: {
      default: 'hsl(var(--muted-foreground) / 1)',
      [COLOR_MIX]: 'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 10%, transparent)',
      [DARK_THEME]: {
        default: 'hsl(var(--muted-foreground) / 1)',
        [COLOR_MIX]: 'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 5%, transparent)',
      },
    },
  },
  watermarkCost: {
    position: 'absolute',
    right: '-40px',
    bottom: '-20px',
    width: '12.5rem',
    height: '12.5rem',
    transform: 'rotate(-25deg)',
    color: {
      default: 'hsl(var(--muted-foreground) / 1)',
      [COLOR_MIX]: 'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 10%, transparent)',
      [DARK_THEME]: {
        default: 'hsl(var(--muted-foreground) / 1)',
        [COLOR_MIX]: 'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 5%, transparent)',
      },
    },
  },
  workspaceRequired: {
    borderWidth: '1px',
    borderStyle: 'dashed',
    borderColor: 'hsl(var(--border))',
    borderRadius: 'var(--radius-md)',
    padding: '16px',
    fontSize: '0.875rem',
    lineHeight: '1.25rem',
    color: 'hsl(var(--muted-foreground))',
  },
});

// The calendar's optional skyline view uses React Three Fiber. Keep it out of
// consumers that only render the summary charts (including the public landing)
// so it cannot pull a second React renderer into their initial hydration path.
const UsageCalendarVisualization = lazy(async () => {
  const module = await import('./usage-calendar-visualization');
  return { default: module.UsageCalendarVisualization };
});

// snapdom + qrcode are only needed once someone opens the share dialog.
const UsageShareImageDialog = lazy(async () => {
  const module = await import('./usage-share-image-dialog');
  return { default: module.UsageShareImageDialog };
});

export function formatTokens(value: number, locale?: string | null): string {
  return new Intl.NumberFormat(locale ?? 'en').format(Math.round(value));
}

export function formatTokensCompact(value: number, locale?: string | null): string {
  return formatCompactNumber(value, locale);
}

export function formatUSD(value: number, locale?: string | null): string {
  return formatUsdAmount(value, locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

type NumberFlowFormat = {
  notation?: 'standard' | 'compact';
  compactDisplay?: 'short' | 'long';
  style?: 'decimal' | 'currency' | 'percent' | 'unit';
  currency?: string;
  currencyDisplay?: 'code' | 'symbol' | 'narrowSymbol' | 'name';
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
};

function CountUpValue({
  value,
  ready,
  format,
  locale,
  suffix,
}: {
  value: number;
  ready: boolean;
  format: NumberFlowFormat;
  locale: string;
  suffix?: string;
}) {
  if (!ready) return <>—</>;
  return <NumberFlow value={value} locales={locale} format={format} suffix={suffix} />;
}

function StatTile({
  label,
  children,
  footer,
}: {
  label: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.statTile)}>
      <p {...stylex.props(styles.statLabel)}>{label}</p>
      <div {...stylex.props(styles.statContents)}>
        {/* NumberFlow measures ~68px tall at the clamp's 2.75rem cap; reserve
           that height so the loading "—" cannot grow into it on resolve. */}
        <div {...stylex.props(styles.statValue)}>{children}</div>
        {footer ? <div {...stylex.props(styles.statFooter)}>{footer}</div> : null}
      </div>
    </div>
  );
}

function RangeSelector({
  range,
  onRangeChange,
}: {
  range: SettingsUsageRange;
  onRangeChange: (range: SettingsUsageRange) => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="tablist" aria-label={t('workspace.usage.range')} {...stylex.props(styles.rangeTray)}>
      {RANGE_ORDER.map((value) => {
        const active = value === range;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onRangeChange(value)}
            {...stylex.props(styles.rangeTab, active && styles.rangeTabSelected)}
          >
            {t(`workspace.usage.window.${value}.short`)}
          </button>
        );
      })}
    </div>
  );
}

export function StatsSettingsView({
  workspaceName,
  range,
  onRangeChange,
  ready,
  totals,
  byModelBuckets,
  byMemberBuckets,
  usageCalendar,
  usageTimeline,
  usageDay,
  usageDayLoading,
  onSelectedUsageDayChange,
  workspaceId,
  loading,
  renderModelSeriesMarker,
  renderMemberSeriesMarker,
  tintModelSeriesLabel,
  tintMemberSeriesLabel,
  costFractionDigits = 2,
  shareCard = false,
}: StatsSettingsViewProps) {
  const { t, i18n } = useTranslation();
  const [shareOpen, setShareOpen] = useState(false);
  const locale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const windowCaption = t(`workspace.usage.window.${range}.long`);
  const costDigits = Math.max(0, Math.min(2, costFractionDigits));
  const tokensCompact = useMemo(
    () => (value: number) => formatTokensCompact(value, locale),
    [locale]
  );
  return (
    <div {...stylex.props(styles.page)}>
      {/* Page header — no redundant "Usage" title (the settings tab already
         says Usage). Workspace name + the time-window selector. */}
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.workspaceName)}>
          <h2 {...stylex.props(styles.workspaceHeading)}>
            {workspaceName || t('workspace.usage.title')}
          </h2>
          <p {...stylex.props(styles.windowCaption)}>{windowCaption}</p>
        </div>
        <div {...stylex.props(styles.headerActions)}>
          <RangeSelector range={range} onRangeChange={onRangeChange} />
          {shareCard && usageCalendar ? (
            <Tooltip.Root>
              <Tooltip.Trigger
                render={
                  <Button
                    icon
                    variant="ghost"
                    aria-label={t('workspace.usage.shareImage.action')}
                    onClick={() => setShareOpen(true)}
                  >
                    <Share2 />
                  </Button>
                }
              />
              <Tooltip.Content>{t('workspace.usage.shareImage.action')}</Tooltip.Content>
            </Tooltip.Root>
          ) : null}
        </div>
      </div>

      {shareCard && usageCalendar && shareOpen ? (
        <Suspense fallback={null}>
          <UsageShareImageDialog
            open={shareOpen}
            onOpenChange={setShareOpen}
            calendar={usageCalendar}
            timeline={usageTimeline}
            range={range}
            workspaceName={workspaceName}
          />
        </Suspense>
      ) : null}

      {/* KPI overview band — 2 cards with icon watermarks. */}
      <div {...stylex.props(styles.statGrid)}>
        <StatTile
          label={t('workspace.usage.tokens')}
          footer={<Coins {...stylex.props(styles.watermarkTokens)} />}
        >
          <CountUpValue
            value={totals?.tokens ?? 0}
            ready={ready}
            locale={locale}
            format={{ notation: 'compact', maximumFractionDigits: 1 }}
          />
        </StatTile>
        <StatTile
          label={t('workspace.usage.cost')}
          footer={<DollarSign {...stylex.props(styles.watermarkCost)} />}
        >
          <CountUpValue
            value={totals?.costUSD ?? 0}
            ready={ready}
            locale={locale}
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

      {/* The calendar keeps its eventual footprint while either its data or the
         lazy three.js chunk is still resolving; `undefined` after a workspace is
         selected always means "query in flight" — an empty workspace still gets
         a zeroed calendar object. */}
      {usageCalendar ? (
        <Suspense fallback={<UsageCalendarSkeleton range={range} />}>
          <UsageCalendarVisualization
            calendar={usageCalendar}
            timeline={usageTimeline}
            workspaceName={workspaceName}
            dayDetail={usageDay}
            dayDetailLoading={usageDayLoading}
            onSelectedDayChange={onSelectedUsageDayChange}
          />
        </Suspense>
      ) : workspaceId ? (
        <UsageCalendarSkeleton range={range} />
      ) : null}

      <UsageStackedAreaChart
        title={t('workspace.usage.byModel')}
        buckets={byModelBuckets}
        emptyText={t('workspace.usage.empty', 'No usage data in this range')}
        valueFormatter={tokensCompact}
        tooltipValueFormatter={tokensCompact}
        renderSeriesMarker={renderModelSeriesMarker}
        tintSeriesLabel={tintModelSeriesLabel}
        loading={loading}
        loadingText={t('workspace.usage.loading', 'Loading usage data...')}
      />
      <UsageStackedAreaChart
        title={t('workspace.usage.byUser')}
        buckets={byMemberBuckets}
        emptyText={t('workspace.usage.empty', 'No usage data in this range')}
        valueFormatter={tokensCompact}
        tooltipValueFormatter={tokensCompact}
        renderSeriesMarker={renderMemberSeriesMarker}
        tintSeriesLabel={tintMemberSeriesLabel}
        loading={loading}
        loadingText={t('workspace.usage.loading', 'Loading usage data...')}
      />

      {!workspaceId && (
        <div {...stylex.props(styles.workspaceRequired)}>
          {t('workspace.usage.workspaceRequired', 'Select a workspace to view usage')}
        </div>
      )}
    </div>
  );
}

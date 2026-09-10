import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import NumberFlow from '@number-flow/react';
import { useTranslation } from 'react-i18next';
import { Coins, DollarSign, Share2 } from 'lucide-react';
import { Button } from '@/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { formatCompactNumber, formatUsdAmount } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { cn } from '@/lib/utils';
import {
  UsageStackedAreaChart,
  type StackedAreaBucket,
  type StackedAreaSeriesMarkerRender,
} from './usage-stacked-area-chart';
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
  className,
  children,
  footer,
}: {
  label: string;
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div
      className={cn(
        '@container relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-lg border border-border/70 bg-card/60 p-4',
        className
      )}
    >
      <p className="text-[0.8rem] font-medium text-muted-foreground">{label}</p>
      <div className="mt-auto">
        <div className="min-w-0 whitespace-nowrap text-3xl font-bold leading-none tracking-tight tabular-nums text-foreground text-[clamp(1.5rem,16cqw,2.75rem)]">
          {children}
        </div>
        {footer ? <div className="mt-2">{footer}</div> : null}
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
    <div
      role="tablist"
      aria-label={t('workspace.usage.range')}
      className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5"
    >
      {RANGE_ORDER.map((value) => {
        const active = value === range;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onRangeChange(value)}
            className={cn(
              'rounded-md px-3 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            )}
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
    <div className="space-y-4">
      {/* Page header — no redundant "Usage" title (the settings tab already
         says Usage). Workspace name + the time-window selector. */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold leading-tight text-foreground">
            {workspaceName || t('workspace.usage.title')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{windowCaption}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <RangeSelector range={range} onRangeChange={onRangeChange} />
          {shareCard && usageCalendar ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('workspace.usage.shareImage.action')}
                  onClick={() => setShareOpen(true)}
                >
                  <Share2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('workspace.usage.shareImage.action')}</TooltipContent>
            </Tooltip>
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
      <div className="grid grid-cols-2 gap-3">
        <StatTile
          label={t('workspace.usage.tokens')}
          footer={
            <Coins className="absolute -bottom-8 -right-8 h-60 w-60 text-muted-foreground/10 dark:text-muted-foreground/5" />
          }
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
          footer={
            <DollarSign className="absolute -bottom-5 -right-10 h-50 w-50 text-muted-foreground/10 dark:text-muted-foreground/5 rotate-[-25deg]" />
          }
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

      {usageCalendar ? (
        <Suspense fallback={null}>
          <UsageCalendarVisualization
            calendar={usageCalendar}
            timeline={usageTimeline}
            workspaceName={workspaceName}
            dayDetail={usageDay}
            dayDetailLoading={usageDayLoading}
            onSelectedDayChange={onSelectedUsageDayChange}
          />
        </Suspense>
      ) : null}

      <UsageStackedAreaChart
        title={t('workspace.usage.byModel')}
        buckets={byModelBuckets}
        emptyText={t('workspace.usage.empty', 'No usage data in this range')}
        valueFormatter={tokensCompact}
        tooltipValueFormatter={tokensCompact}
        renderSeriesMarker={renderModelSeriesMarker}
        tintSeriesLabel={tintModelSeriesLabel}
      />
      <UsageStackedAreaChart
        title={t('workspace.usage.byUser')}
        buckets={byMemberBuckets}
        emptyText={t('workspace.usage.empty', 'No usage data in this range')}
        valueFormatter={tokensCompact}
        tooltipValueFormatter={tokensCompact}
        renderSeriesMarker={renderMemberSeriesMarker}
        tintSeriesLabel={tintMemberSeriesLabel}
      />

      {!workspaceId && (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t('workspace.usage.workspaceRequired', 'Select a workspace to view usage')}
        </div>
      )}
      {workspaceId && loading && (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t('workspace.usage.loading', 'Loading usage data...')}
        </div>
      )}
    </div>
  );
}

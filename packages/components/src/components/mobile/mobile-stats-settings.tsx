import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrganization } from '@/hooks/useOrganization';
import { Tabs } from '@lody/ui/tabs';
import {
  UsageStackedAreaChart,
  type StackedAreaBucket,
} from '@/components/settings/usage-stacked-area-chart';
import { MobileSettingsSection } from '@/components/mobile/mobile-settings-row';
import { useCountUp } from '@/hooks/use-count-up';
import { stripRecommended } from '@/components/shared/acp-selector-options';
import {
  useSettingsDataCache,
  useSettingsUsageDay,
  type SettingsUsageRange,
  type SettingsUsageTimelineData,
} from '@/components/settings/settings-data-cache';
import { UsageCalendarVisualization } from '@/components/settings/usage-calendar-visualization';
import { formatUsageTimelineBucketLabel } from '@/components/settings/usage-timeline-bucket-label';
import { formatCompactNumber, formatUsdAmount } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';

/* Full-bleed hero stat: oversized count-up number with a quiet label
   above it. Used for the headline tokens + cost totals so they read
   as the page's "wow" moment rather than a plain settings row. The
   number tweens up from 0 on first appearance (and re-counts when the
   user switches the usage-range tab) via `useCountUp`; `ready` gates
   the animation so it starts only once real data has arrived (no
   count-up from 0 to 0 during loading). */
function HeroStat({
  label,
  value,
  ready,
  format,
}: {
  label: string;
  value: number;
  ready: boolean;
  format: (value: number) => string;
}) {
  const animated = useCountUp(value, { enabled: ready });
  return (
    <div className="rounded-2xl border border-border/40 bg-card px-5 py-5">
      <div className="text-[0.82rem] font-semibold text-muted-foreground">{label}</div>
      <div className="mt-2 text-[2.5rem] font-semibold leading-none tracking-tight tabular-nums text-foreground">
        {ready ? format(animated) : '—'}
      </div>
    </div>
  );
}

export function MobileStatsSettings() {
  const { t, i18n } = useTranslation();
  const locale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const { activeOrganization } = useOrganization();
  const [range, setRange] = useState<SettingsUsageRange>('day');
  const { workspaceId, usageTimelineByRange, usageCalendar } = useSettingsDataCache();
  const [selectedUsageDayMs, setSelectedUsageDayMs] = useState<number | null>(null);
  const { day: usageDay, loading: usageDayLoading } = useSettingsUsageDay(selectedUsageDayMs);
  const dayTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    [locale]
  );
  const formatTokensCompact = useMemo(
    () => (value: number) => formatCompactNumber(value, locale),
    [locale]
  );
  const formatUSD = useMemo(
    () => (value: number) =>
      formatUsdAmount(value, locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    [locale]
  );

  const usageTimeline = usageTimelineByRange[range];

  const activeTotals = usageTimeline?.totals;

  const getBucketLabel = useCallback(
    (bucket: SettingsUsageTimelineData['buckets'][number]): string => {
      if (!usageTimeline) {
        return bucket.bucketLabel;
      }
      return formatUsageTimelineBucketLabel(usageTimeline, bucket, dayTimeFormatter);
    },
    [dayTimeFormatter, usageTimeline]
  );

  const byModelBuckets = useMemo<StackedAreaBucket[]>(() => {
    if (!usageTimeline) return [];
    return usageTimeline.buckets.map((bucket) => ({
      label: getBucketLabel(bucket),
      values: bucket.byModel.map((item) => ({
        id: item.modelId,
        label: stripRecommended(item.modelId),
        value: item.tokens,
      })),
    }));
  }, [getBucketLabel, usageTimeline]);

  const byMemberBuckets = useMemo<StackedAreaBucket[]>(() => {
    if (!usageTimeline) return [];
    return usageTimeline.buckets.map((bucket) => ({
      label: getBucketLabel(bucket),
      values: bucket.byUser.map((item) => ({
        id: item.userId,
        label:
          usageTimeline.users?.[item.userId]?.name ||
          usageTimeline.users?.[item.userId]?.email ||
          item.userId,
        value: item.tokens,
      })),
    }));
  }, [getBucketLabel, usageTimeline]);

  return (
    <div className="pb-6 pt-1">
      <MobileSettingsSection title={activeOrganization?.name || t('workspace.usage.title')}>
        <div className="px-3 py-3">
          <Tabs.Root
            value={range}
            onValueChange={(nextValue) => {
              setRange(nextValue as SettingsUsageRange);
            }}
          >
            <Tabs.List size="large" stretch>
              <Tabs.Tab value="day">{t('workspace.usage.tabs.day')}</Tabs.Tab>
              <Tabs.Tab value="week">{t('workspace.usage.tabs.week')}</Tabs.Tab>
              <Tabs.Tab value="month">{t('workspace.usage.tabs.month')}</Tabs.Tab>
              <Tabs.Tab value="total">{t('workspace.usage.tabs.total')}</Tabs.Tab>
            </Tabs.List>
          </Tabs.Root>
        </div>
      </MobileSettingsSection>

      <MobileSettingsSection title={t('workspace.usage.title')} noCard>
        <div className="mx-3 grid grid-cols-1 gap-3">
          <HeroStat
            label={t('workspace.usage.tokens')}
            value={activeTotals?.tokens ?? 0}
            ready={Boolean(activeTotals)}
            format={formatTokensCompact}
          />
          <HeroStat
            label={t('workspace.usage.cost')}
            value={activeTotals?.costUSD ?? 0}
            ready={Boolean(activeTotals)}
            format={formatUSD}
          />
        </div>
      </MobileSettingsSection>

      {usageCalendar ? (
        <MobileSettingsSection noCard>
          <div className="mx-3">
            <UsageCalendarVisualization
              calendar={usageCalendar}
              workspaceName={activeOrganization?.name}
              dayDetail={usageDay}
              dayDetailLoading={usageDayLoading}
              onSelectedDayChange={setSelectedUsageDayMs}
            />
          </div>
        </MobileSettingsSection>
      ) : null}

      {/* No section title here: `UsageStackedAreaChart` renders its own
         bordered card header with the same section label, so a section
         title would duplicate it. `noCard` lets the chart claim the full
         horizontal scroll area inside the section gutter. */}
      <MobileSettingsSection noCard>
        <div className="mx-3">
          <UsageStackedAreaChart
            title={t('workspace.usage.byModel')}
            buckets={byModelBuckets}
            emptyText={t('workspace.usage.empty', 'No usage data in this range')}
            valueFormatter={formatTokensCompact}
            tooltipValueFormatter={formatTokensCompact}
          />
        </div>
      </MobileSettingsSection>

      <MobileSettingsSection noCard>
        <div className="mx-3">
          <UsageStackedAreaChart
            title={t('workspace.usage.byUser')}
            buckets={byMemberBuckets}
            emptyText={t('workspace.usage.empty', 'No usage data in this range')}
            valueFormatter={formatTokensCompact}
            tooltipValueFormatter={formatTokensCompact}
          />
        </div>
      </MobileSettingsSection>

      {!workspaceId && (
        <div className="mx-3 mt-5 rounded-2xl border border-dashed border-border/60 bg-card p-4 text-sm text-muted-foreground">
          {t('workspace.usage.workspaceRequired', 'Select a workspace to view usage')}
        </div>
      )}
      {workspaceId && !usageTimeline && (
        <div className="mx-3 mt-5 rounded-2xl border border-dashed border-border/60 bg-card p-4 text-sm text-muted-foreground">
          {t('workspace.usage.loading', 'Loading usage data...')}
        </div>
      )}
    </div>
  );
}

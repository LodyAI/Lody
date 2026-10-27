import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
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
import { UsageCalendarSkeleton } from '@/components/settings/usage-calendar-skeleton';
import {
  createUsageTimelineFormatter,
  formatUsageTimelineBucketLabel,
} from '@/components/settings/usage-timeline-bucket-label';
import { formatCompactNumber, formatUsdAmount } from '@/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
// The theme tokens are imported by path, not by the `@/` alias: the StyleX
// compiler links a theme file on its own and does not follow bundler aliases.
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const styles = stylex.create({
  /** The page: the sections stacked, set apart by the page's own rhythm. */
  page: { paddingBottom: themeSpace[6], paddingTop: themeSpace[1] },
  /** The range tabs, in the section's card. */
  tabs: { paddingInline: themeSpace[3], paddingBlock: themeSpace[3] },
  /** The hero stats, one per line. */
  heroes: {
    marginInline: themeSpace[3],
    display: 'grid',
    gridTemplateColumns: 'repeat(1, minmax(0, 1fr))',
    gap: themeSpace[3],
  },
  /** The page's own inset for the sections that own their card. */
  inset: { marginInline: themeSpace[3] },
  /** A hero stat: a quiet label above a big number, in its own card. */
  hero: {
    borderRadius: themeRadius['2xl'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.4)',
    backgroundColor: themeColors.card,
    paddingInline: themeSpace[5],
    paddingBlock: themeSpace[5],
  },
  heroLabel: {
    fontSize: '0.82rem',
    fontWeight: themeFontWeight.semibold,
    color: themeColors.mutedForeground,
  },
  heroValue: {
    marginTop: themeSpace[2],
    fontSize: '2.5rem',
    fontWeight: themeFontWeight.semibold,
    lineHeight: 1,
    letterSpacing: '-0.025em',
    fontVariantNumeric: 'tabular-nums',
    color: themeColors.foreground,
  },
  /** The note that stands in for the charts when no workspace is chosen. */
  hint: {
    marginInline: themeSpace[3],
    marginTop: themeSpace[5],
    borderRadius: themeRadius['2xl'],
    borderWidth: '1px',
    borderStyle: 'dashed',
    borderColor: 'hsl(var(--border) / 0.6)',
    backgroundColor: themeColors.card,
    padding: themeSpace[4],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
});

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
    <div {...stylex.props(styles.hero)}>
      <div {...stylex.props(styles.heroLabel)}>{label}</div>
      <div {...stylex.props(styles.heroValue)}>{ready ? format(animated) : '—'}</div>
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
  const dayTimeFormatter = useMemo(() => createUsageTimelineFormatter(locale), [locale]);
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
  const loading = Boolean(workspaceId) && !usageTimeline;

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
    <div {...stylex.props(styles.page)}>
      <MobileSettingsSection title={activeOrganization?.name || t('workspace.usage.title')}>
        <div {...stylex.props(styles.tabs)}>
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
        <div {...stylex.props(styles.heroes)}>
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

      {/* While a workspace is selected, a missing calendar only means its query
         is still in flight — keep the section's shape with the skeleton. */}
      {workspaceId ? (
        <MobileSettingsSection noCard>
          <div {...stylex.props(styles.inset)}>
            {usageCalendar ? (
              <UsageCalendarVisualization
                calendar={usageCalendar}
                timeline={usageTimeline}
                workspaceName={activeOrganization?.name}
                dayDetail={usageDay}
                dayDetailLoading={usageDayLoading}
                onSelectedDayChange={setSelectedUsageDayMs}
              />
            ) : (
              <UsageCalendarSkeleton range={range} />
            )}
          </div>
        </MobileSettingsSection>
      ) : null}

      {/* No section title here: `UsageStackedAreaChart` renders its own
         bordered card header with the same section label, so a section
         title would duplicate it. `noCard` lets the chart claim the full
         horizontal scroll area inside the section gutter. */}
      <MobileSettingsSection noCard>
        <div {...stylex.props(styles.inset)}>
          <UsageStackedAreaChart
            title={t('workspace.usage.byModel')}
            buckets={byModelBuckets}
            emptyText={t('workspace.usage.empty', 'No usage data in this range')}
            valueFormatter={formatTokensCompact}
            tooltipValueFormatter={formatTokensCompact}
            loading={loading}
            loadingText={t('workspace.usage.loading', 'Loading usage data...')}
          />
        </div>
      </MobileSettingsSection>

      <MobileSettingsSection noCard>
        <div {...stylex.props(styles.inset)}>
          <UsageStackedAreaChart
            title={t('workspace.usage.byUser')}
            buckets={byMemberBuckets}
            emptyText={t('workspace.usage.empty', 'No usage data in this range')}
            valueFormatter={formatTokensCompact}
            tooltipValueFormatter={formatTokensCompact}
            loading={loading}
            loadingText={t('workspace.usage.loading', 'Loading usage data...')}
          />
        </div>
      </MobileSettingsSection>

      {!workspaceId && (
        <div {...stylex.props(styles.hint)}>
          {t('workspace.usage.workspaceRequired', 'Select a workspace to view usage')}
        </div>
      )}
    </div>
  );
}

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAppCapability } from '@/lib/app-platform';
import { useOrganization } from '@/hooks/useOrganization';
import { MobileStatsSettings } from '@/components/mobile/mobile-stats-settings';
import { settingContainerClass } from '.';
import {
  useSettingsDataCache,
  useSettingsUsageDay,
  type SettingsUsageRange,
  type SettingsUsageTimelineData,
} from './settings-data-cache';
import {
  createUsageTimelineFormatter,
  formatUsageTimelineBucketLabel,
} from './usage-timeline-bucket-label';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { stripRecommended } from '@/components/shared/acp-selector-options';
import { AiUsageSettingsView } from './ai-usage-setting-view';
import { StatsSettingsView } from './stats-setting-pure';

export function AiUsageSettingsComponent() {
  const isMobile = useIsMobile();
  const usageAnalytics = useAppCapability('usageAnalytics');
  if (!usageAnalytics) return null;
  return isMobile ? <MobileStatsSettings /> : <AiUsageConsumption />;
}

function AiUsageConsumption() {
  const { i18n } = useTranslation();
  const locale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const [range, setRange] = useState<SettingsUsageRange>('week');
  const { activeOrganization } = useOrganization();
  const { workspaceId, usageTimelineByRange, usageCalendar } = useSettingsDataCache();
  const usageTimeline = usageTimelineByRange[range];
  const [selectedUsageDayMs, setSelectedUsageDayMs] = useState<number | null>(null);
  const { day: usageDay, loading: usageDayLoading } = useSettingsUsageDay(selectedUsageDayMs);
  const dayTimeFormatter = useMemo(() => createUsageTimelineFormatter(locale), [locale]);
  const getBucketLabel = useCallback(
    (bucket: SettingsUsageTimelineData['buckets'][number]) => {
      if (!usageTimeline) return bucket.bucketLabel;
      return formatUsageTimelineBucketLabel(usageTimeline, bucket, dayTimeFormatter);
    },
    [dayTimeFormatter, usageTimeline]
  );

  const byModelBuckets = useMemo(() => {
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

  const byMemberBuckets = useMemo(() => {
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
    <div className={settingContainerClass}>
      <StatsSettingsView
        workspaceName={activeOrganization?.name}
        range={range}
        onRangeChange={setRange}
        ready={Boolean(usageTimeline?.totals)}
        totals={usageTimeline?.totals ?? null}
        byModelBuckets={byModelBuckets}
        byMemberBuckets={byMemberBuckets}
        usageCalendar={usageCalendar}
        usageTimeline={usageTimeline}
        usageDay={usageDay}
        usageDayLoading={usageDayLoading}
        onSelectedUsageDayChange={setSelectedUsageDayMs}
        workspaceId={workspaceId}
        loading={Boolean(workspaceId) && !usageTimeline}
        shareCard
        showBreakdown={false}
      />
      <AiUsageSettingsView
        surface="usage"
        quotaRows={[]}
        quotaLoading={false}
        byModelBuckets={byModelBuckets}
        byMemberBuckets={byMemberBuckets}
        usageLoading={Boolean(workspaceId) && !usageTimeline}
        providerRows={[]}
      />
    </div>
  );
}

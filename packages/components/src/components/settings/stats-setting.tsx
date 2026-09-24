import { useCallback, useMemo, useState } from 'react';
import { useOrganization } from '@/hooks/useOrganization';
import { useIsMobile } from '@/hooks/use-mobile';
import { settingContainerClass } from '.';
import { type StackedAreaBucket } from './usage-stacked-area-chart';
import { StatsSettingsView } from './stats-setting-pure';
import { MobileStatsSettings } from '@/components/mobile/mobile-stats-settings';
import { stripRecommended } from '@/components/shared/acp-selector-options';
import { useAppCapability } from '@/lib/app-platform';
import {
  useSettingsDataCache,
  useSettingsUsageDay,
  type SettingsUsageRange,
  type SettingsUsageTimelineData,
} from './settings-data-cache';
import { formatUsageTimelineBucketLabel } from './usage-timeline-bucket-label';

export function StatsSettingsComponent() {
  const usageAnalyticsAvailable = useAppCapability('usageAnalytics');
  if (!usageAnalyticsAvailable) {
    return null;
  }
  return <CloudStatsSettings />;
}

function CloudStatsSettings() {
  const isMobile = useIsMobile();
  const { activeOrganization } = useOrganization();
  const [range, setRange] = useState<SettingsUsageRange>('day');
  const { workspaceId, usageTimelineByRange, usageCalendar } = useSettingsDataCache();
  const [selectedUsageDayMs, setSelectedUsageDayMs] = useState<number | null>(null);
  const { day: usageDay, loading: usageDayLoading } = useSettingsUsageDay(selectedUsageDayMs);
  const dayTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    []
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

  if (isMobile) return <MobileStatsSettings />;

  return (
    <div className={settingContainerClass}>
      <StatsSettingsView
        workspaceName={activeOrganization?.name}
        range={range}
        onRangeChange={setRange}
        ready={Boolean(activeTotals)}
        totals={activeTotals ?? null}
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
      />
    </div>
  );
}

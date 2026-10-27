import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '@/hooks/use-mobile';
import { useMachineFlockAgentConfigs } from '@/hooks/use-machine-flock-agent-configs';
import { useAppCapability } from '@/lib/app-platform';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useOrganization } from '@/hooks/useOrganization';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { onlineMachineIdsAtom } from '@/atoms/presence';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { MobileStatsSettings } from '@/components/mobile/mobile-stats-settings';
import { settingContainerClass } from '.';
import {
  useSettingsDataCache,
  useSettingsUsageDay,
  type SettingsUsageCalendarData,
  type SettingsUsageRange,
  type SettingsUsageTimelineData,
} from './settings-data-cache';
import {
  createUsageTimelineFormatter,
  formatUsageTimelineBucketLabel,
} from './usage-timeline-bucket-label';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { stripRecommended } from '@/components/shared/acp-selector-options';
import { buildProviderRows, buildProviderUsage, buildQuotaRows } from './ai-usage-model';
import { AiUsageSettingsView } from './ai-usage-setting-view';
import { StatsSettingsView } from './stats-setting-pure';

export function AiUsageSettingsComponent() {
  const isMobile = useIsMobile();
  if (isMobile) return <MobileStatsSettings />;
  return <AiUsageSettingsDesktop />;
}

function AiUsageSettingsDesktop() {
  const { i18n } = useTranslation();
  const locale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const [range, setRange] = useState<SettingsUsageRange>('week');
  const usageAnalytics = useAppCapability('usageAnalytics');
  const { activeOrganization } = useOrganization();
  const { workspaceId, usageTimelineByRange, usageCalendar } = useSettingsDataCache();
  const usageTimeline = usageTimelineByRange[range];
  const [selectedUsageDayMs, setSelectedUsageDayMs] = useState<number | null>(null);
  const { day: usageDay, loading: usageDayLoading } = useSettingsUsageDay(selectedUsageDayMs);
  const { machines, isLoading: machinesLoading } = useVisibleMachineMetas();
  useMachineFlockAgentConfigs();
  const configs = useAtomValue(getAllAgentConfigAtom);
  const onlineMachineIds = useAtomValue(onlineMachineIdsAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);

  const quotaRows = useMemo(
    () => buildQuotaRows({ machines, configs, onlineMachineIds }),
    [configs, machines, onlineMachineIds]
  );

  const dayTimeFormatter = useMemo(() => createUsageTimelineFormatter(locale), [locale]);
  const getBucketLabel = useCallback(
    (bucket: SettingsUsageTimelineData['buckets'][number]) => {
      if (!usageTimeline) return bucket.bucketLabel;
      return formatUsageTimelineBucketLabel(usageTimeline, bucket, dayTimeFormatter);
    },
    [dayTimeFormatter, usageTimeline]
  );

  const providerUsage = useMemo(() => {
    if (!usageTimeline) return null;
    return buildProviderUsage(
      usageTimeline.buckets.map((bucket) => ({
        bucketLabel: getBucketLabel(bucket),
        byModel: bucket.byModel,
      }))
    );
  }, [getBucketLabel, usageTimeline]);

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

  const providerRows = useMemo(
    () =>
      buildProviderRows({
        usage: providerUsage?.totals ?? [],
        quotaRows,
        totalTokens: providerUsage?.totalTokens ?? 0,
      }),
    [providerUsage, quotaRows]
  );

  const autoRefreshed = useRef(new Set<string>());
  useEffect(() => {
    if (!runtime?.requestProviderRateLimitsRefresh) return;
    for (const row of quotaRows) {
      if (!row.machineOnline || !row.supportsQuery) continue;
      if (autoRefreshed.current.has(row.id)) continue;
      autoRefreshed.current.add(row.id);
      void runtime.requestProviderRateLimitsRefresh(row.machineId, row.configId);
    }
  }, [quotaRows, runtime]);

  const refreshQuota = useCallback(() => {
    if (!runtime?.requestProviderRateLimitsRefresh) return;
    for (const row of quotaRows) {
      if (!row.machineOnline || !row.supportsQuery) continue;
      void runtime.requestProviderRateLimitsRefresh(row.machineId, row.configId);
    }
  }, [quotaRows, runtime]);

  const legacyUsage =
    usageAnalytics || usageTimeline ? (
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
    ) : null;

  return (
    <div className={settingContainerClass}>
      {legacyUsage}
      <AiUsageSettingsView
        quotaRows={quotaRows}
        quotaLoading={machinesLoading}
        onRefreshQuota={refreshQuota}
        byModelBuckets={byModelBuckets}
        byMemberBuckets={byMemberBuckets}
        usageLoading={Boolean(workspaceId) && !usageTimeline}
        providerRows={providerRows}
      />
    </div>
  );
}

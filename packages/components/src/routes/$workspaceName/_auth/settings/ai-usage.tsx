import { lazy } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RouteSuspense } from '@/components/route-suspense';

const LazyStatsSettings = lazy(async () => {
  const module = await import('@/components/settings/stats-setting');
  return { default: module.StatsSettingsComponent };
});

export const Route = createFileRoute('/$workspaceName/_auth/settings/ai-usage')({
  component: AiUsageSettingsRoute,
});

function AiUsageSettingsRoute() {
  return (
    <RouteSuspense>
      <LazyStatsSettings />
    </RouteSuspense>
  );
}

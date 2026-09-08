import { lazy } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RouteSuspense } from '@/components/route-suspense';

const LazyIntegrationsSettings = lazy(async () => {
  const module = await import('@/components/settings/integrations-setting');
  return { default: module.IntegrationsSettingsComponent };
});

export const Route = createFileRoute('/$workspaceName/_auth/settings/github')({
  component: GithubSettingsRoute,
});

function GithubSettingsRoute() {
  return (
    <RouteSuspense>
      <LazyIntegrationsSettings />
    </RouteSuspense>
  );
}

import { lazy } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RouteSuspense } from '@/components/route-suspense';

const LazyAboutSettings = lazy(async () => {
  const module = await import('@/components/settings/about-setting');
  return { default: module.AboutSettingsComponent };
});

export const Route = createFileRoute('/$workspaceName/_auth/settings/about')({
  component: AboutSettingsRoute,
});

function AboutSettingsRoute() {
  return (
    <RouteSuspense>
      <LazyAboutSettings />
    </RouteSuspense>
  );
}

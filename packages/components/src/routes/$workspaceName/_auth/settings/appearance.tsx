import { lazy } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RouteSuspense } from '@/components/route-suspense';

const LazyAppearanceSettings = lazy(async () => {
  const module = await import('@/components/settings/appearance-setting');
  return { default: module.AppearanceSettingsComponent };
});

export const Route = createFileRoute('/$workspaceName/_auth/settings/appearance')({
  component: AppearanceSettingsRoute,
});

function AppearanceSettingsRoute() {
  return (
    <RouteSuspense>
      <LazyAppearanceSettings />
    </RouteSuspense>
  );
}

import { lazy } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RouteSuspense } from '@/components/route-suspense';

const LazyGeneralSettings = lazy(async () => {
  const module = await import('@/components/settings/general-setting');
  return { default: module.GeneralSettingsComponent };
});

export const Route = createFileRoute('/$workspaceName/_auth/settings/preferences')({
  component: PreferencesSettingsRoute,
});

function PreferencesSettingsRoute() {
  return (
    <RouteSuspense>
      <LazyGeneralSettings />
    </RouteSuspense>
  );
}

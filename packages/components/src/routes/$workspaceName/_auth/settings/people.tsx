import { lazy } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RouteSuspense } from '@/components/route-suspense';

const LazyAccountSettings = lazy(async () => {
  const module = await import('@/components/settings/account-setting');
  return { default: module.AccountSettingsComponent };
});

export const Route = createFileRoute('/$workspaceName/_auth/settings/people')({
  component: PeopleSettingsRoute,
});

function PeopleSettingsRoute() {
  return (
    <RouteSuspense>
      <LazyAccountSettings surface="workspace" />
    </RouteSuspense>
  );
}

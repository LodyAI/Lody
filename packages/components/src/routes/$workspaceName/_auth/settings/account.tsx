import { lazy } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RouteSuspense } from '@/components/route-suspense';

const LazyAccountSettings = lazy(async () => {
  const module = await import('@/components/settings/account-setting');
  return { default: module.AccountSettingsComponent };
});

export const Route = createFileRoute('/$workspaceName/_auth/settings/account')({
  component: AccountSettingsRoute,
});

function AccountSettingsRoute() {
  return (
    <RouteSuspense>
      <LazyAccountSettings />
    </RouteSuspense>
  );
}

import { lazy } from 'react';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { isNativeAppShell } from '@/lib/native-platform';
import { RouteSuspense } from '@/components/route-suspense';

const LazyBillingSettings = lazy(async () => {
  const module = await import('@/components/settings/billing-setting');
  return { default: module.BillingSettingsComponent };
});

export const Route = createFileRoute('/$workspaceName/_auth/settings/billing')({
  component: BillingSettingsRoute,
});

export function BillingSettingsRoute() {
  const { workspaceName } = Route.useParams();

  if (isNativeAppShell()) {
    return (
      <Navigate
        to="/$workspaceName/settings"
        params={{ workspaceName }}
        search={(previous) => previous}
        replace
      />
    );
  }

  return (
    <RouteSuspense>
      <LazyBillingSettings />
    </RouteSuspense>
  );
}

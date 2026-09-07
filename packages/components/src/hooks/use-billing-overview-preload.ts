import { useEffect, useRef } from 'react';
import { useCloudQuery } from '@lody/platform/react';
import { useAuthenticatedConvex } from '@/hooks/use-authenticated-convex';
import { useAppCapability } from '@/lib/app-platform';
import { cloudOperations } from '@/lib/cloud-api-operations';
import {
  areBillingOverviewsEqual,
  clearBillingOverviewCache,
  readBillingOverviewCache,
  writeBillingOverviewCache,
} from '@/components/settings/billing-overview-cache';

/** Warm the existing billing-page cache as soon as user and workspace data are ready. */
export function useBillingOverviewPreload(workspaceId: string | null): void {
  const billingAvailable = useAppCapability('billing');
  const { authSessionId } = useAuthenticatedConvex();
  const previousWorkspaceAuthRef = useRef<{ workspaceId: string; authSessionId: string | null } | null>(
    null
  );
  const overview = useCloudQuery(
    cloudOperations.billing.getBillingOverview,
    billingAvailable && authSessionId && workspaceId ? { workspaceId } : 'skip'
  );

  useEffect(() => {
    if (!workspaceId) return;

    const previousWorkspaceAuth = previousWorkspaceAuthRef.current;
    if (
      previousWorkspaceAuth &&
      previousWorkspaceAuth.authSessionId !== authSessionId &&
      previousWorkspaceAuth.workspaceId !== workspaceId
    ) {
      clearBillingOverviewCache(previousWorkspaceAuth.workspaceId);
    } else if (
      previousWorkspaceAuth?.workspaceId === workspaceId &&
      previousWorkspaceAuth.authSessionId !== authSessionId
    ) {
      clearBillingOverviewCache(workspaceId);
    }
    previousWorkspaceAuthRef.current = { workspaceId, authSessionId };

    if (!billingAvailable) {
      clearBillingOverviewCache(workspaceId);
      return;
    }
    if (!authSessionId || overview === undefined) return;

    const cached = readBillingOverviewCache(workspaceId, authSessionId);
    if (overview === null) {
      if (cached) clearBillingOverviewCache(workspaceId);
    } else if (!areBillingOverviewsEqual(cached, overview)) {
      writeBillingOverviewCache(workspaceId, authSessionId, overview);
    }
  }, [authSessionId, billingAvailable, overview, workspaceId]);
}

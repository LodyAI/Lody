import { Component, createElement, useEffect, useRef, type ReactNode } from 'react';
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
  const previousWorkspaceAuthRef = useRef<{
    workspaceId: string;
    authSessionId: string | null;
  } | null>(null);
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

function BillingOverviewPreloadProbe({ workspaceId }: { workspaceId: string | null }) {
  useBillingOverviewPreload(workspaceId);
  return null;
}

/**
 * The preload only saves latency, so a rejected query (e.g. a member admitted
 * only through the encrypted ledger) must not reach the route error boundary.
 * The billing page still reads live and reports its own errors.
 */
class BillingOverviewPreloadBoundary extends Component<
  { scope: string; workspaceId: string | null; children?: ReactNode },
  { failedScope: string | null }
> {
  override state = { failedScope: null as string | null };

  static getDerivedStateFromError() {
    return { failedScope: '' };
  }

  override componentDidCatch() {
    // Record which scope failed; a new workspace or auth session retries.
    this.setState({ failedScope: this.props.scope });
    if (this.props.workspaceId) clearBillingOverviewCache(this.props.workspaceId);
  }

  override render() {
    const { failedScope } = this.state;
    return failedScope === '' || failedScope === this.props.scope ? null : this.props.children;
  }
}

/** Leaf that renders nothing. The probe stays mounted across scope changes so
 * its cache-invalidation history survives a workspace or session switch. */
export function BillingOverviewPreload({ workspaceId }: { workspaceId: string | null }) {
  const { authSessionId } = useAuthenticatedConvex();
  return createElement(
    BillingOverviewPreloadBoundary,
    { scope: `${workspaceId ?? ''}:${authSessionId ?? ''}`, workspaceId },
    createElement(BillingOverviewPreloadProbe, { workspaceId })
  );
}

import { useMemo } from 'react';
import { useCloudQuery } from '@lody/platform/react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import type { WorkspaceDeleteBillingGuard } from './account-setting-pure';

/**
 * The billing-aware guard on deleting a workspace: a live subscription blocks deletion
 * (cancel first); a cancel-scheduled one gets a warning that deletion preserves its
 * scheduled end and any accrued charges. A subscription belongs to the workspace, not to
 * its content mode, so encrypted workspaces are guarded exactly like plaintext ones.
 * No overview (loading, no billing capability, or none for this workspace) means no guard.
 */
export function useWorkspaceDeleteBillingGuard(
  workspaceId: string | undefined
): WorkspaceDeleteBillingGuard | null {
  const billingOverview = useCloudQuery(
    cloudOperations.billing.getBillingOverview,
    workspaceId ? { workspaceId } : 'skip'
  );
  return useMemo(() => {
    if (
      !billingOverview ||
      billingOverview.effectivePlanTier === 'free' ||
      (billingOverview.entitlementSource === 'stripe_gift' && !billingOverview.autoRenewAfterGift)
    ) {
      return null;
    }
    if (billingOverview.cancelAtPeriodEnd) {
      const entitlementEnd =
        billingOverview.giftEndsAt && billingOverview.giftEndsAt > Date.now()
          ? billingOverview.giftEndsAt
          : billingOverview.currentPeriodEnd;
      return {
        kind: 'cancel-scheduled',
        formattedPeriodEnd: entitlementEnd
          ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
              new Date(entitlementEnd)
            )
          : null,
      };
    }
    return { kind: 'active-subscription' };
  }, [billingOverview]);
}

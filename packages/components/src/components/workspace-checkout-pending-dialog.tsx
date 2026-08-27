import { cloudOperations } from '@/lib/cloud-api-operations';
import { atom, useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useLocation } from '@tanstack/react-router';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { useOpenSettings } from '@/hooks/use-open-settings';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { useCloudQuery } from '@lody/platform/react';
import { useIsMobile } from '@/hooks/use-mobile';
import { isNativeAppShell } from '@/lib/native-platform';
import { useAppCapability } from '@/lib/app-platform';

/**
 * Workspaces the user already dismissed the prompt for, per app load. Session
 * scoped on purpose: a pending checkout is a blocking state, so re-surfacing
 * it once per visit is the point — but it must not nag on every navigation.
 */
const dismissedCheckoutPendingWorkspacesAtom = atom<ReadonlySet<string>>(new Set<string>());

/**
 * A paid workspace created through `createPaidWorkspaceCheckout` stays locked
 * (`checkoutPending`) until Stripe checkout completes. If the user closed the
 * browser/app mid-checkout, this dialog greets them on their next visit with
 * a direct path back to checkout instead of letting them discover the lock
 * through failing sends.
 */
export function WorkspaceCheckoutPendingDialog() {
  const isMobile = useIsMobile();
  // Already unmounted by the local `_auth` layout; the capability check is a
  // safety net so a stray mount can never query billing on the local platform.
  const billingAvailable = useAppCapability('billing');
  const hidesBillingUi = isMobile || isNativeAppShell() || !billingAvailable;
  const { workspaceId } = useResolvedWorkspaceScope();
  const location = useLocation();
  const { openSettings } = useOpenSettings();
  const [dismissed, setDismissed] = useAtom(dismissedCheckoutPendingWorkspacesAtom);

  const entitlement = useCloudQuery(
    cloudOperations.billing.getWorkspaceBillingEntitlement,
    !hidesBillingUi && workspaceId ? { workspaceId } : 'skip'
  );
  // The billing page has its own pending-checkout UI; don't stack a dialog on it.
  const onSettingsSurface = location.pathname.includes('/settings');
  const checkoutPending = entitlement?.checkoutPending === true;
  // Only queried while relevant; tells us whether the viewer can pay at all.
  const overview = useCloudQuery(
    cloudOperations.billing.getBillingOverview,
    !hidesBillingUi && checkoutPending && workspaceId ? { workspaceId } : 'skip'
  );

  if (
    hidesBillingUi ||
    !workspaceId ||
    !checkoutPending ||
    onSettingsSurface ||
    dismissed.has(workspaceId)
  ) {
    return null;
  }

  const dismiss = () => {
    setDismissed(new Set([...dismissed, workspaceId]));
  };

  return (
    <WorkspaceCheckoutPendingDialogView
      canManageBilling={overview?.canManageBilling === true}
      onDismiss={dismiss}
      onGoToCheckout={() => {
        dismiss();
        openSettings('billing');
      }}
    />
  );
}

export interface WorkspaceCheckoutPendingDialogViewProps {
  canManageBilling: boolean;
  onDismiss: () => void;
  onGoToCheckout: () => void;
}

export function WorkspaceCheckoutPendingDialogView({
  canManageBilling,
  onDismiss,
  onGoToCheckout,
}: WorkspaceCheckoutPendingDialogViewProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('workspace.checkoutPendingDialog.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {canManageBilling
              ? t('workspace.checkoutPendingDialog.description')
              : t('workspace.checkoutPendingDialog.memberDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onDismiss}>
            {t('workspace.checkoutPendingDialog.later')}
          </AlertDialogCancel>
          {canManageBilling ? (
            <AlertDialogAction onClick={onGoToCheckout}>
              {t('workspace.checkoutPendingDialog.goToCheckout')}
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

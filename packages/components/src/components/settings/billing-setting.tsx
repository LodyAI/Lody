import { useEffect, useMemo, useRef, useState } from 'react';
import { Spinner } from '@lody/ui/spinner';
import { Button } from '@lody/ui/button';
import { useCloudAction } from '@lody/platform/react';
import { ConvexError } from 'convex/values';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms';
import { sessionMetaCountAtom } from '@/atoms/doc-meta';
import { useAuthenticatedConvex } from '@/hooks/use-authenticated-convex';
import { useCloudQuery } from '@lody/platform/react';
import { isElectronRenderer } from '@/lib/electron';
import { useAppCapability } from '@/lib/app-platform';
import { openExternalUrl } from '@/lib/native-browser';
import { AlertDialog } from '@/ui/dialog';
// Relative: the consuming apps only alias a curated set of `@/` prefixes
// (ui, components, lib, hooks, atoms), and `providers` is not one of them.
import { useAuthClient } from '../../providers/convex-provider';
import {
  OPTIMISTIC_BILLING_OVERVIEW,
  areBillingOverviewsEqual,
  clearBillingOverviewCache,
  readBillingOverviewCache,
  reconcileBillingOverview,
  writeBillingOverviewCache,
} from './billing-overview-cache';
import {
  clearBillingCheckoutReturn,
  isBillingActivationSettled,
  markBillingCheckoutReturn,
  readBillingCheckoutReturn,
} from './billing-checkout-return';
import {
  BillingSettingsView,
  formatDate,
  formatUsd,
  type BillingOverviewData,
  type BillingInterval,
  type BillingInvoice,
  type BillingPendingAction,
  type BillingUpcomingInvoice,
} from './billing-setting-pure';

/** Extract the billing error code from a ConvexError thrown by billing actions. */
function getBillingErrorCode(error: unknown): string | null {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (
      data &&
      typeof data === 'object' &&
      'code' in data &&
      typeof (data as { code: unknown }).code === 'string'
    ) {
      return (data as { code: string }).code;
    }
  }
  return null;
}

const BILLING_ERROR_TOAST_KEYS: Record<string, string> = {
  workspace_already_paid: 'billing.alreadyPaidError',
  checkout_processing: 'billing.checkoutProcessingError',
  checkout_already_completed: 'billing.checkoutProcessingError',
  checkout_superseded: 'billing.checkoutSupersededError',
  // A live gift redemption blocks starting a checkout (and vice versa).
  redemption_in_progress: 'billing.redeemInProgress',
};

/** How long a just-finished checkout may keep polling Stripe for confirmation. */
const CHECKOUT_CONFIRMATION_WINDOW_MS = 2 * 60 * 1000;
const CHECKOUT_CONFIRMATION_INTERVAL_MS = 3_000;

export function BillingSettingsComponent() {
  // Registry-level gating already hides the billing tab without the 'billing'
  // capability (open-source local build); this is a safety net for deep links.
  const billingAvailable = useAppCapability('billing');
  if (!billingAvailable) {
    return null;
  }
  return <CloudBillingSettings />;
}

function CloudBillingSettings() {
  const { t } = useTranslation();
  const { authSessionId } = useAuthenticatedConvex();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const localSessionCount = useAtomValue(sessionMetaCountAtom);
  const fetchedOverview = useCloudQuery(
    cloudOperations.billing.getBillingOverview,
    workspaceId ? { workspaceId } : 'skip'
  );
  const overviewScope = workspaceId && authSessionId ? `${authSessionId}:${workspaceId}` : null;
  const persistedOverview = useMemo(
    () => (workspaceId ? readBillingOverviewCache(workspaceId, authSessionId) : null),
    [authSessionId, workspaceId]
  );
  const cachedOverview = workspaceId ? (persistedOverview ?? OPTIMISTIC_BILLING_OVERVIEW) : null;
  const [resolvedOverview, setResolvedOverview] = useState<{
    scope: string;
    value: BillingOverviewData | null;
  } | null>(null);
  const overviewResolved = overviewScope !== null && resolvedOverview?.scope === overviewScope;
  const overview = overviewResolved ? resolvedOverview.value : cachedOverview;
  // The optimistic fallback reports no permission; only a server-confirmed
  // overview (live or persisted from an earlier confirmed one) may be shown as
  // "you cannot manage billing".
  const canManageBillingKnown = overviewResolved || persistedOverview !== null;

  useEffect(() => {
    if (!workspaceId || !authSessionId || !overviewScope || fetchedOverview === undefined) return;

    const storedOverview = readBillingOverviewCache(workspaceId, authSessionId);
    if (fetchedOverview === null) {
      if (storedOverview) clearBillingOverviewCache(workspaceId);
    } else if (!areBillingOverviewsEqual(storedOverview, fetchedOverview)) {
      writeBillingOverviewCache(workspaceId, authSessionId, fetchedOverview);
    }

    setResolvedOverview((previous) => {
      const current = previous?.scope === overviewScope ? previous.value : cachedOverview;
      const next = reconcileBillingOverview(current, fetchedOverview);
      return next === current ? previous : { scope: overviewScope, value: next };
    });
  }, [authSessionId, cachedOverview, fetchedOverview, overviewScope, workspaceId]);
  // Who a member without billing permission has to ask. The active
  // organization already carries its member list, so this costs no extra read.
  const authClient = useAuthClient();
  const { data: activeOrganization } = authClient.useActiveOrganization();
  const workspaceOwnerName = useMemo(() => {
    if (!workspaceId || activeOrganization?.id !== workspaceId) return null;
    const owner = activeOrganization.members?.find((member) => member.role === 'owner');
    return owner?.user?.name?.trim() || owner?.user?.email?.trim() || null;
  }, [activeOrganization, workspaceId]);
  const createBillingPortalSession = useCloudAction(
    cloudOperations.billing.createBillingPortalSession
  );
  const portalInFlight = useRef(false);
  const createCheckoutSession = useCloudAction(cloudOperations.billing.createCheckoutSession);
  const reconcileWorkspaceCheckout = useCloudAction(
    cloudOperations.billing.reconcileWorkspaceCheckout
  );
  // `useCloudAction` can hand back a new function identity every render; the
  // confirmation loop must survive those renders instead of restarting.
  const reconcileWorkspaceCheckoutRef = useRef(reconcileWorkspaceCheckout);
  reconcileWorkspaceCheckoutRef.current = reconcileWorkspaceCheckout;
  const redeemCode = useCloudAction(cloudOperations.billing.redeemStripePromotionCode);
  const listBillingInvoices = useCloudAction(cloudOperations.billing.listBillingInvoices);
  const setSubscriptionCancelAtPeriodEnd = useCloudAction(
    cloudOperations.billing.setSubscriptionCancelAtPeriodEnd
  );
  const setSubscriptionInterval = useCloudAction(cloudOperations.billing.setSubscriptionInterval);
  const previewSubscriptionIntervalChange = useCloudAction(
    cloudOperations.billing.previewSubscriptionIntervalChange
  );
  const [pendingAction, setPendingAction] = useState<BillingPendingAction>(null);
  const [redeemPending, setRedeemPending] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [switchIntervalDialogOpen, setSwitchIntervalDialogOpen] = useState(false);
  const [switchIntervalPending, setSwitchIntervalPending] = useState(false);
  // undefined = previewing, null = preview failed, object = ready.
  const [intervalPreview, setIntervalPreview] = useState<
    Awaited<ReturnType<typeof previewSubscriptionIntervalChange>> | undefined
  >(undefined);
  const [interval, setInterval] = useState<BillingInterval>('year');
  const [invoices, setInvoices] = useState<BillingInvoice[] | undefined>(undefined);
  const [upcomingInvoice, setUpcomingInvoice] = useState<BillingUpcomingInvoice | null>(null);
  const [invoicesError, setInvoicesError] = useState(false);
  const [invoicesReloadKey, setInvoicesReloadKey] = useState(0);
  const [checkoutSuccessReturn, setCheckoutSuccessReturn] = useState(false);
  // Anchor the confirmation window to when the return was first seen, so a
  // reload inside an already-slow confirmation does not restart the wait.
  const checkoutReturnStartedAtRef = useRef<number | null>(null);
  // Persisted/preloaded data can describe the state before Checkout. Only the
  // live query may prove that the returned payment or gift setup has landed.
  const activationSettled = isBillingActivationSettled(fetchedOverview);
  // Desktop: checkout/portal opened in the system browser; poll until Stripe
  // confirms so the app updates even if the user never clicks "back to Lody".
  const [externalCheckoutPending, setExternalCheckoutPending] = useState(false);
  const [externalCheckoutKind, setExternalCheckoutKind] = useState<'subscription' | 'gift_setup'>(
    'subscription'
  );

  // A pending checkout already picked an interval (e.g. paid-workspace
  // creation): present that plan directly. Keyed on the value so it syncs
  // once per change and the user can still toggle afterwards.
  const checkoutInterval =
    overview?.checkoutPending || overview?.subscriptionSetupPending
      ? (overview.checkoutInterval ?? null)
      : null;
  useEffect(() => {
    if (checkoutInterval) setInterval(checkoutInterval);
  }, [checkoutInterval]);

  // Load Stripe invoice history once the workspace has a billing account and the
  // viewer can manage billing (the query itself also enforces admin access).
  const canLoadInvoices =
    !!workspaceId && !!overview && overview.canManageBilling && !!overview.billingAccountId;
  useEffect(() => {
    if (!canLoadInvoices || !workspaceId) return undefined;
    let cancelled = false;
    setInvoices(undefined);
    setInvoicesError(false);
    listBillingInvoices({ workspaceId })
      .then((result) => {
        if (cancelled) return;
        setInvoices(result.invoices);
        setUpcomingInvoice(result.upcoming);
      })
      .catch((error) => {
        console.error('Failed to load billing invoices:', error);
        if (!cancelled) setInvoicesError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [canLoadInvoices, workspaceId, listBillingInvoices, invoicesReloadKey]);

  // Stripe sends the user back to this route with ?checkout=success|canceled
  // (+ session_id on success). Capture the success return, then strip the
  // params so a refresh doesn't re-trigger the flow. The marker can also arrive
  // without the query (desktop deep-link hand-off, reload after the first
  // parse), so a per-tab intent is what actually drives the confirmation below.
  useEffect(() => {
    if (!workspaceId || typeof window === 'undefined') return;
    const clearReturn = () => {
      clearBillingCheckoutReturn(workspaceId);
      checkoutReturnStartedAtRef.current = null;
      setCheckoutSuccessReturn(false);
    };
    const url = new URL(window.location.href);
    const checkout = url.searchParams.get('checkout');
    if (checkout === 'success') {
      const now = Date.now();
      markBillingCheckoutReturn(workspaceId, now);
      checkoutReturnStartedAtRef.current = now;
      setCheckoutSuccessReturn(true);
    } else if (checkout === 'canceled') {
      clearReturn();
    } else if (checkout === null) {
      // No marker: this is a reload, remount, or desktop hand-off after the
      // first parse, so the per-tab intent is the remaining signal.
      const pendingSince = readBillingCheckoutReturn(workspaceId);
      if (pendingSince !== null) {
        checkoutReturnStartedAtRef.current = pendingSince;
        setCheckoutSuccessReturn(true);
      }
    } else {
      // Unknown marker value: never trust a stale intent.
      clearReturn();
    }
    if (checkout !== null) {
      url.searchParams.delete('checkout');
      url.searchParams.delete('session_id');
      window.history.replaceState(window.history.state, '', url);
    }
  }, [workspaceId]);

  // An ordinary pending checkout gets one background check and keeps its payment
  // entry available. Only a successful return retries transient misses while
  // waiting for the webhook/reconcile write to reach the live overview.
  const shouldReconcile =
    checkoutSuccessReturn ||
    overview?.checkoutPending === true ||
    overview?.subscriptionSetupPending === true;
  useEffect(() => {
    if (!workspaceId || !shouldReconcile || activationSettled) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline =
      (checkoutReturnStartedAtRef.current ?? Date.now()) + CHECKOUT_CONFIRMATION_WINDOW_MS;
    const finish = () => {
      clearBillingCheckoutReturn(workspaceId);
      checkoutReturnStartedAtRef.current = null;
      setCheckoutSuccessReturn(false);
    };
    const tick = async () => {
      try {
        const result = await reconcileWorkspaceCheckoutRef.current({ workspaceId });
        if (cancelled) return;
        if (result.status === 'expired') {
          finish();
          return;
        }
        if (result.status === 'paid') {
          // Keep the return marker and activation banner until the live overview
          // lands, including across a reload between the write and query update.
          if (!checkoutSuccessReturn) {
            const startedAt = Date.now();
            markBillingCheckoutReturn(workspaceId, startedAt);
            checkoutReturnStartedAtRef.current = startedAt;
            setCheckoutSuccessReturn(true);
          }
          return;
        }
      } catch (error) {
        console.error('Failed to reconcile Stripe checkout:', error);
      }
      if (cancelled || !checkoutSuccessReturn) return;
      if (Date.now() >= deadline) {
        finish();
        return;
      }
      timer = setTimeout(() => void tick(), CHECKOUT_CONFIRMATION_INTERVAL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [workspaceId, shouldReconcile, checkoutSuccessReturn, activationSettled]);

  // bfcache: navigating to Stripe and back can restore this page from the
  // back/forward cache with the pending spinner still set. Reset it.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setPendingAction(null);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  // Desktop external checkout: the payment happens in the system browser, so
  // poll the Stripe-backed reconcile until it settles. The deep-link return
  // only focuses the app; this loop is what actually flips the plan (and it
  // works even when the webhook is delayed or the user closes the browser).
  useEffect(() => {
    if (!externalCheckoutPending || !workspaceId) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const tick = async () => {
      if (cancelled) return;
      try {
        const result = await reconcileWorkspaceCheckout({ workspaceId });
        if (cancelled) return;
        if (result.status === 'paid' || result.status === 'expired') {
          setExternalCheckoutPending(false);
          return;
        }
      } catch (error) {
        console.warn('External checkout reconcile poll failed:', error);
      }
      // Stripe checkout sessions live up to 24h, but nobody stares at this
      // banner that long; the cron/webhook take over after we stop.
      if (Date.now() - startedAt > 15 * 60 * 1000) {
        setExternalCheckoutPending(false);
        return;
      }
      timer = setTimeout(() => void tick(), 5000);
    };
    timer = setTimeout(() => void tick(), 5000);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [externalCheckoutPending, workspaceId, reconcileWorkspaceCheckout]);

  // Stop waiting the moment the reactive overview proves the operation
  // completed. A gift member is already Plus before setup starts, so plan tier
  // alone cannot distinguish a stale pre-Checkout overview from completion.
  useEffect(() => {
    const completed =
      externalCheckoutKind === 'gift_setup'
        ? overview?.autoRenewAfterGift === true && overview.checkoutPending === false
        : overview != null && overview.effectivePlanTier !== 'free';
    if (externalCheckoutPending && completed) {
      setExternalCheckoutPending(false);
    }
    // Drop the per-tab return intent once the entitlement lands, so a later
    // remount does not reconcile an already-consumed checkout session.
    if (checkoutSuccessReturn && activationSettled) {
      checkoutReturnStartedAtRef.current = null;
      setCheckoutSuccessReturn(false);
      if (workspaceId) clearBillingCheckoutReturn(workspaceId);
    }
  }, [
    activationSettled,
    checkoutSuccessReturn,
    externalCheckoutKind,
    externalCheckoutPending,
    overview,
    workspaceId,
  ]);

  const returnUrl = (() => {
    if (typeof window === 'undefined') return undefined;
    if (!workspaceSlug) return window.location.href;
    return `${window.location.origin}/${workspaceSlug}/settings/billing`;
  })();

  // In the desktop app, payment must happen in the system browser: the user's
  // password manager and wallet live there, and the embedded window has no
  // browser chrome to judge the Stripe page by. The browser lands on
  // /desktop/checkout-return, which deep-links back to the app.
  const isDesktop = isElectronRenderer();

  const openCheckoutUrl = async (url: string): Promise<'external' | 'in-app'> => {
    if (isDesktop && (await openExternalUrl(url))) {
      return 'external';
    }
    window.location.assign(url);
    return 'in-app';
  };

  const handlePaymentMethod = async () => {
    if (!workspaceId || !overview?.canManageBilling || portalInFlight.current) return;
    portalInFlight.current = true;
    setPendingAction('portal');
    try {
      const result = await createBillingPortalSession({
        workspaceId,
        ...(isDesktop ? { returnTarget: 'desktop' as const } : { returnUrl }),
      });
      await openCheckoutUrl(result.url);
    } catch (error) {
      const code = getBillingErrorCode(error);
      toast.error(t((code && BILLING_ERROR_TOAST_KEYS[code]) || 'billing.paymentMethodError'));
    } finally {
      portalInFlight.current = false;
      setPendingAction(null);
    }
  };

  const handleUpgrade = async () => {
    if (!workspaceId) return;
    setPendingAction('checkout');
    try {
      const result = await createCheckoutSession({
        workspaceId,
        interval,
        ...(isDesktop
          ? { returnTarget: 'desktop' as const }
          : returnUrl
            ? { successUrl: returnUrl, cancelUrl: returnUrl }
            : {}),
      });
      if ((await openCheckoutUrl(result.url)) === 'external') {
        setPendingAction(null);
        // The server decides whether Checkout charges now or only stores a
        // payment method. Using its response avoids stale overview state
        // making desktop polling reconcile the wrong lifecycle.
        setExternalCheckoutKind(
          result.checkoutKind ??
            (overview?.entitlementSource === 'stripe_gift' && !overview.autoRenewAfterGift
              ? 'gift_setup'
              : 'subscription')
        );
        setExternalCheckoutPending(true);
      }
    } catch (error) {
      console.error('Failed to start Stripe checkout:', error);
      const code = getBillingErrorCode(error);
      const toastKey = (code && BILLING_ERROR_TOAST_KEYS[code]) || 'billing.checkoutError';
      toast.error(t(toastKey));
      setPendingAction(null);
    }
  };

  // Switch monthly <-> yearly. Server-side this switches immediately with
  // proration: the new interval's period starts today, the unused portion of
  // the current period is credited, and the net is charged now. The confirm
  // dialog previews that breakdown before the user commits.
  const targetInterval: BillingInterval = overview?.billingInterval === 'month' ? 'year' : 'month';

  // Load the proration preview whenever the dialog opens.
  useEffect(() => {
    if (!switchIntervalDialogOpen || !workspaceId) return undefined;
    let cancelled = false;
    setIntervalPreview(undefined);
    previewSubscriptionIntervalChange({ workspaceId, interval: targetInterval })
      .then((result) => {
        if (!cancelled) setIntervalPreview(result);
      })
      .catch((error) => {
        console.error('Failed to preview interval switch:', error);
        if (!cancelled) setIntervalPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [switchIntervalDialogOpen, workspaceId, targetInterval, previewSubscriptionIntervalChange]);

  // When switching to monthly leaves leftover account credit, estimate the
  // date it runs out: each covered renewal draws one month of the recurring
  // total (subtotalAmount) from the credit, starting after the first period.
  const switchCreditCoverageDate = (() => {
    if (
      targetInterval !== 'month' ||
      !intervalPreview ||
      intervalPreview.remainingCredit <= 0 ||
      intervalPreview.subtotalAmount <= 0 ||
      !intervalPreview.nextRenewalAt
    ) {
      return null;
    }
    const coveredMonths = Math.floor(
      intervalPreview.remainingCredit / intervalPreview.subtotalAmount
    );
    const date = new Date(intervalPreview.nextRenewalAt);
    date.setMonth(date.getMonth() + coveredMonths);
    return date.getTime();
  })();

  // The invoice history + next-charge preview come from an action (not a
  // reactive query), so subscription changes must trigger a reload explicitly.
  const reloadInvoices = () => setInvoicesReloadKey((key) => key + 1);

  const handleSwitchInterval = async () => {
    if (!workspaceId) return;
    setSwitchIntervalPending(true);
    try {
      await setSubscriptionInterval({ workspaceId, interval: targetInterval });
      toast.success(t('billing.switchIntervalSuccess'));
      setSwitchIntervalDialogOpen(false);
      reloadInvoices();
    } catch (error) {
      console.error('Failed to switch billing interval:', error);
      toast.error(t('billing.switchIntervalError'));
    } finally {
      setSwitchIntervalPending(false);
    }
  };

  // Schedule (cancel: true) or undo (cancel: false) a cancel-at-period-end.
  // The reactive overview query picks up the new state from the snapshot the
  // action writes, so no local overview patching is needed.
  const handleSetCancelAtPeriodEnd = async (cancel: boolean) => {
    if (!workspaceId) return;
    setCancelPending(true);
    try {
      await setSubscriptionCancelAtPeriodEnd({ workspaceId, cancel });
      toast.success(
        t(
          cancel && overview?.scheduleManaged
            ? 'billing.cancelGiftTimelineSuccess'
            : cancel
              ? 'billing.cancelSuccess'
              : 'billing.resumeSuccess'
        )
      );
      // Canceling clears the upcoming invoice; resuming restores it.
      reloadInvoices();
    } catch (error) {
      console.error('Failed to update subscription cancellation:', error);
      toast.error(t('billing.cancelError'));
    } finally {
      setCancelPending(false);
    }
  };

  const handleRedeemCode = async (code: string) => {
    if (!workspaceId) return;
    setRedeemPending(true);
    try {
      const result = await redeemCode({
        code,
        workspaceId,
        ...(isDesktop
          ? { returnTarget: 'desktop' as const }
          : returnUrl
            ? { successUrl: returnUrl, cancelUrl: returnUrl }
            : {}),
      });
      if (result.status === 'gift_redeemed') {
        toast.success(t('billing.redeemPlusSuccess', { date: formatDate(result.endsAt) }));
        reloadInvoices();
      } else if (result.status === 'checkout_required') {
        toast.success(t('billing.redeemFounderSuccess'));
        if ((await openCheckoutUrl(result.url)) === 'external') {
          setExternalCheckoutPending(true);
        }
      } else if (result.status === 'rate_limited') {
        toast.error(t('billing.redeemRateLimited'));
      } else if (result.status === 'workspace_already_plus') {
        toast.info(t('billing.redeemWorkspaceAlreadyPlus'));
      } else if (result.status === 'subscription_not_eligible') {
        toast.error(t('billing.redeemSubscriptionNotEligible'));
      } else if (result.status === 'checkout_in_progress') {
        toast.error(t('billing.redeemCheckoutInProgress'));
      } else if (result.status === 'redemption_in_progress') {
        toast.error(t('billing.redeemInProgress'));
      } else {
        toast.error(t('billing.redeemInvalid'));
      }
    } catch (error) {
      console.error('Failed to redeem billing code:', error);
      toast.error(t('billing.redeemInvalid'));
    } finally {
      setRedeemPending(false);
    }
  };

  // Checking an unpaid checkout does not imply that payment was received.
  const paymentProcessing = checkoutSuccessReturn && !activationSettled && overview != null;

  return (
    <>
      <BillingSettingsView
        overview={overview}
        sessionCount={localSessionCount}
        interval={interval}
        pendingAction={pendingAction}
        redeemPending={redeemPending}
        cancelPending={cancelPending}
        invoices={invoices}
        upcomingInvoice={upcomingInvoice}
        invoicesError={invoicesError}
        canManageBillingKnown={canManageBillingKnown}
        workspaceOwnerName={workspaceOwnerName}
        paymentProcessing={paymentProcessing}
        externalCheckoutPending={externalCheckoutPending}
        onIntervalChange={setInterval}
        onPaymentMethod={() => void handlePaymentMethod()}
        onUpgrade={() => void handleUpgrade()}
        onSwitchInterval={() => setSwitchIntervalDialogOpen(true)}
        switchIntervalPending={switchIntervalPending}
        onCancelSubscription={() => setCancelDialogOpen(true)}
        onResumeSubscription={() => void handleSetCancelAtPeriodEnd(false)}
        onRedeemCode={(code) => void handleRedeemCode(code)}
        onRetryInvoices={() => setInvoicesReloadKey((key) => key + 1)}
        onCancelExternalCheckout={() => setExternalCheckoutPending(false)}
      />
      <AlertDialog.Root open={switchIntervalDialogOpen} onOpenChange={setSwitchIntervalDialogOpen}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('billing.switchIntervalDialogTitle')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t(
                targetInterval === 'year'
                  ? 'billing.switchIntervalDialogDescriptionYearly'
                  : 'billing.switchIntervalDialogDescriptionMonthly',
                { date: formatDate(intervalPreview?.nextRenewalAt ?? undefined) }
              )}
            </AlertDialog.Description>
          </AlertDialog.Header>
          {intervalPreview === undefined ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Spinner className="h-4 w-4" />
              {t('billing.historyLoading')}
            </div>
          ) : intervalPreview === null ? (
            <p className="py-2 text-sm text-destructive">{t('billing.switchPreviewError')}</p>
          ) : (
            <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
              {/* Subtotal: seats × unit price */}
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-muted-foreground">
                  {t(
                    targetInterval === 'year'
                      ? 'billing.switchLineSeatsYearly'
                      : 'billing.switchLineSeatsMonthly',
                    {
                      count: intervalPreview.quantity,
                      price: formatUsd(intervalPreview.unitAmount),
                    }
                  )}
                </span>
                <span className="tabular-nums text-foreground">
                  {formatUsd(intervalPreview.subtotalAmount)}
                </span>
              </div>
              {/* Existing subscription discount */}
              {intervalPreview.promoDiscountAmount !== 0 ? (
                <div className="mt-1.5 flex items-baseline justify-between gap-4">
                  <span className="text-primary">{t('billing.upcomingDiscount')}</span>
                  <span className="tabular-nums text-primary">
                    {formatUsd(intervalPreview.promoDiscountAmount)}
                  </span>
                </div>
              ) : null}
              {/* Credit for the unused portion of the current period */}
              {intervalPreview.creditAmount !== 0 ? (
                <div className="mt-1.5 flex items-baseline justify-between gap-4">
                  <span className="text-muted-foreground">{t('billing.switchLineCredit')}</span>
                  <span className="tabular-nums text-foreground">
                    {formatUsd(intervalPreview.creditAmount)}
                  </span>
                </div>
              ) : null}
              {/* Credit that exceeds today's charge, saved to account balance —
                  keeps the lines reconciling to the $0 charged today. */}
              {intervalPreview.deferredToBalanceAmount !== 0 ? (
                <div className="mt-1.5 flex items-baseline justify-between gap-4">
                  <span className="text-muted-foreground">
                    {t('billing.switchLineDeferredCredit')}
                  </span>
                  <span className="tabular-nums text-foreground">
                    {formatUsd(intervalPreview.deferredToBalanceAmount)}
                  </span>
                </div>
              ) : null}
              {/* Net charged today */}
              <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-border/60 pt-2 font-normal">
                <span className="text-foreground">{t('billing.switchLineDueNow')}</span>
                <span className="tabular-nums text-foreground">
                  {formatUsd(intervalPreview.amountDueNow)}
                </span>
              </div>
              {/* When leftover credit remains (e.g. year→month), spell out how
                  long it covers renewals before billing resumes. */}
              {intervalPreview.remainingCredit > 0 ? (
                <p className="mt-2.5 border-t border-border/60 pt-2.5 text-xs text-muted-foreground">
                  {switchCreditCoverageDate
                    ? t('billing.switchCreditCoverageNote', {
                        amount: formatUsd(intervalPreview.remainingCredit),
                        date: formatDate(switchCreditCoverageDate),
                      })
                    : t('billing.switchCreditGenericNote', {
                        amount: formatUsd(intervalPreview.remainingCredit),
                      })}
                </p>
              ) : null}
            </div>
          )}
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={switchIntervalPending}>
              {t('common.cancel')}
            </AlertDialog.Cancel>
            <Button
              disabled={switchIntervalPending || intervalPreview === undefined}
              onClick={() => {
                // Keep the dialog open until the switch resolves (it closes in
                // the handler on success) so the pending state is visible.
                void handleSwitchInterval();
              }}
            >
              {switchIntervalPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
              {t('billing.switchIntervalConfirm')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
      <AlertDialog.Root open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('billing.cancelDialogTitle')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t('billing.cancelDialogDescription', {
                date: formatDate(
                  overview?.giftEndsAt && overview.giftEndsAt > Date.now()
                    ? overview.giftEndsAt
                    : overview?.currentPeriodEnd
                ),
              })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('billing.cancelDialogKeep')}</AlertDialog.Cancel>
            <AlertDialog.Action
              variant="destructive"
              onClick={() => void handleSetCancelAtPeriodEnd(true)}
            >
              {t('billing.cancelDialogConfirm')}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FREE_SESSION_LIMIT_PER_WORKSPACE, FREE_WORKSPACE_MEMBER_LIMIT } from '@lody/shared';
import { ArrowLeftRight, Check, Loader2 } from 'lucide-react';
import { Badge, Button, Card, Input } from '@/ui';
import { Progress } from '@/ui/progress';
import { Skeleton } from '@/ui/skeleton';
import { cn } from '@/lib/utils';
import { PricingPageLink } from '../shared/pricing-page-link';
import { FounderCallLink } from '../shared/founder-call-link';
import { SubscribeConsentNotice } from '../shared/subscribe-consent-notice';
import { settingContainerClass } from '.';

export type BillingInterval = 'month' | 'year';
export type BillingPendingAction = 'checkout' | null;

export interface BillingOverviewData {
  billingAccountId: string | null;
  effectivePlanTier: 'free' | 'plus' | 'enterprise';
  entitlementSource: 'free' | 'stripe' | 'stripe_gift' | 'enterprise';
  offerKey: string | null;
  yearlyEarlyBirdEligible: boolean;
  promotionalEntitlementEndsAt: number | null;
  checkoutPending: boolean;
  /** Interval chosen when the pending paid-workspace checkout was created. */
  checkoutInterval: BillingInterval | null;
  subscriptionStatus: string | null;
  /** Active subscription's billing interval; null while free. */
  billingInterval: BillingInterval | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: number | null;
  seatCount: number;
  canManageBilling: boolean;
  pricing: {
    monthlyAmountCents: number;
    yearlyAmountCents: number;
    monthlyOfferKey: string | null;
    yearlyOfferKey: string | null;
  };
}

export interface BillingInvoice {
  id: string;
  number: string | null;
  status: string;
  amountPaid: number;
  currency: string;
  periodStart: number | null;
  periodEnd: number | null;
  interval: BillingInterval | null;
  kind: 'subscription' | 'gift_redemption';
  giftDurationMonths: number | null;
  createdAt: number;
  hostedInvoiceUrl: string | null;
}

/** Semantic preview of the next invoice: renewal + net seat adjustment. */
export interface BillingUpcomingInvoice {
  amountDue: number;
  currency: string;
  expectedAt: number | null;
  renewal: { amount: number; quantity: number | null } | null;
  discount: { amount: number } | null;
  adjustment: { amount: number } | null;
  creditApplied: { amount: number } | null;
}

export interface BillingSettingsViewProps {
  /** `null` = unavailable; the container supplies cached or optimistic data while refreshing. */
  overview: BillingOverviewData | null;
  /**
   * Sessions counted client-side from Flock metadata (the server keeps no
   * session counter), so it is not part of the cached server overview. `null`
   * while that metadata has not hydrated. The cap it is measured against
   * follows `overview.effectivePlanTier`.
   */
  sessionCount: number | null;
  interval: BillingInterval;
  pendingAction: BillingPendingAction;
  redeemPending: boolean;
  /** Cancel/resume subscription request in flight. */
  cancelPending: boolean;
  /** `undefined` = loading; array (possibly empty) = loaded. */
  invoices: BillingInvoice[] | undefined;
  /** Next-invoice preview (renewal + prorations); null when none. */
  upcomingInvoice?: BillingUpcomingInvoice | null;
  /** Invoice history failed to load; takes precedence over `invoices`. */
  invoicesError: boolean;
  /**
   * `false` while the viewer's billing role is still unconfirmed (the
   * optimistic first-visit overview reports no permission). The upgrade action
   * then stays disabled instead of claiming the viewer lacks permission.
   */
  canManageBillingKnown?: boolean;
  /**
   * Workspace owner's display name, shown to a viewer who cannot manage
   * billing so they know who to ask. `null` when unknown.
   */
  workspaceOwnerName?: string | null;
  /** Checkout completed but the subscription is still being activated. */
  paymentProcessing: boolean;
  /** Desktop only: checkout opened in the system browser; waiting for payment. */
  externalCheckoutPending?: boolean;
  onIntervalChange: (interval: BillingInterval) => void;
  onUpgrade: () => void;
  /** Opens the switch-interval confirmation dialog (container-owned). */
  onSwitchInterval: () => void;
  /** Interval switch request in flight. */
  switchIntervalPending: boolean;
  /** Opens the cancel-at-period-end confirmation dialog (container-owned). */
  onCancelSubscription: () => void;
  /** Undoes a scheduled cancel-at-period-end. */
  onResumeSubscription: () => void;
  onRedeemCode: (code: string) => void;
  onRetryInvoices: () => void;
  onCancelExternalCheckout?: () => void;
}

export function formatUsd(cents: number): string {
  return formatMoney(cents, 'USD');
}

export function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(timestamp));
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function BillingSettingsView({
  overview,
  sessionCount,
  interval,
  pendingAction,
  redeemPending,
  cancelPending,
  invoices,
  upcomingInvoice = null,
  invoicesError,
  canManageBillingKnown = true,
  workspaceOwnerName = null,
  paymentProcessing,
  externalCheckoutPending = false,
  onIntervalChange,
  onUpgrade,
  onSwitchInterval,
  switchIntervalPending,
  onCancelSubscription,
  onResumeSubscription,
  onRedeemCode,
  onRetryInvoices,
  onCancelExternalCheckout,
}: BillingSettingsViewProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');

  if (overview === null) {
    return (
      <div className={settingContainerClass}>
        <Card className="p-6 text-sm text-muted-foreground">{t('billing.unavailable')}</Card>
      </div>
    );
  }

  const isPaid =
    overview.effectivePlanTier === 'plus' || overview.effectivePlanTier === 'enterprise';
  const planName =
    overview.checkoutPending || overview.effectivePlanTier === 'plus'
      ? t('billing.plan.plus')
      : overview.effectivePlanTier === 'enterprise'
        ? t('billing.plan.enterprise')
        : t('billing.plan.free');
  const canManage = overview.canManageBilling;
  // Only claim the viewer lacks permission once the server has confirmed the
  // role; until then the upgrade action stays visible but disabled, so an
  // owner never briefly reads "you can't upgrade this workspace".
  const permissionBlocked = !canManage && canManageBillingKnown;
  const isPastDue = overview.subscriptionStatus === 'past_due';
  const isPromotional = overview.entitlementSource === 'stripe_gift';

  // `null` = unlimited.
  const sessionLimit =
    overview.effectivePlanTier === 'free' ? FREE_SESSION_LIMIT_PER_WORKSPACE : null;
  const nearLimit =
    sessionCount !== null &&
    sessionLimit !== null &&
    sessionLimit > 0 &&
    sessionCount / sessionLimit >= 0.8;

  const monthlyPrice = formatUsd(overview.pricing.monthlyAmountCents);
  const yearlyPerMonthPrice = formatUsd(Math.round(overview.pricing.yearlyAmountCents / 12));
  const yearlyEarlyBirdSelected =
    interval === 'year' && overview.pricing.yearlyOfferKey === 'early_bird_yearly_6000_forever';
  const selectedOfferLabel =
    interval === 'month' && overview.pricing.monthlyOfferKey ? t('billing.founderPrice') : null;

  // Plan status line: the interval label carries the inline switch link right
  // beside it, and the status detail (renewal/cancel date, past-due, pending)
  // follows after a separator.
  const planIntervalLabel =
    isPaid && !overview.checkoutPending && overview.billingInterval
      ? isPromotional
        ? t('billing.promotionalBadge')
        : overview.billingInterval === 'year'
          ? t('billing.yearly')
          : t('billing.monthly')
      : null;
  const showIntervalSwitch =
    isPaid &&
    overview.entitlementSource === 'stripe' &&
    overview.offerKey !== 'founder_monthly_500_forever' &&
    canManage &&
    !overview.cancelAtPeriodEnd &&
    !overview.checkoutPending &&
    !!overview.billingInterval;
  const planStatusDetail = overview.checkoutPending
    ? t('billing.checkoutPendingDescription')
    : isPastDue
      ? t('billing.pastDue')
      : isPromotional && overview.promotionalEntitlementEndsAt
        ? t('billing.promotionalEndsOn', {
            date: formatDate(overview.promotionalEntitlementEndsAt),
          })
        : isPaid && overview.currentPeriodEnd
          ? overview.cancelAtPeriodEnd
            ? t('billing.cancelsOn', { date: formatDate(overview.currentPeriodEnd) })
            : t('billing.renewsOn', { date: formatDate(overview.currentPeriodEnd) })
          : !isPaid
            ? t('billing.freeTagline')
            : null;

  return (
    <div className={settingContainerClass}>
      {/* Desktop: checkout opened in the system browser, awaiting payment */}
      {externalCheckoutPending ? (
        <Card className="flex items-start gap-3 border-primary/30 bg-primary/5 p-4">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              {t('billing.externalCheckoutTitle')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('billing.externalCheckoutDescription')}
            </p>
          </div>
          {onCancelExternalCheckout ? (
            <Button size="sm" variant="ghost" onClick={onCancelExternalCheckout}>
              {t('billing.externalCheckoutDismiss')}
            </Button>
          ) : null}
        </Card>
      ) : null}

      {/* Payment received, activation in flight */}
      {paymentProcessing && !externalCheckoutPending ? (
        <Card className="flex items-start gap-3 border-primary/30 bg-primary/5 p-4">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {t('billing.paymentProcessingTitle')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('billing.paymentProcessingDescription')}
            </p>
          </div>
        </Card>
      ) : null}

      {/* Plan status */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-semibold leading-tight text-foreground">{planName}</span>
          {/* A gift always ends at its schedule boundary; its status line says
              so already, and a cancel badge would read as an error state. */}
          {overview.cancelAtPeriodEnd && !isPromotional ? (
            <Badge variant="outline">{t('billing.cancelAtPeriodEnd')}</Badge>
          ) : null}
          {overview.checkoutPending ? (
            <Badge variant="secondary">{t('billing.checkoutPending')}</Badge>
          ) : null}
          {overview.yearlyEarlyBirdEligible ? (
            <Badge variant="secondary">{t('billing.yearlyPromoPrice')}</Badge>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          {planIntervalLabel ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              {planIntervalLabel}
              {showIntervalSwitch ? (
                <button
                  type="button"
                  disabled={switchIntervalPending || !overview.billingAccountId}
                  onClick={onSwitchInterval}
                  className="inline-flex items-center gap-1 font-medium text-primary transition-colors hover:text-primary/80 disabled:opacity-60"
                >
                  {switchIntervalPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ArrowLeftRight className="h-3 w-3" />
                  )}
                  {overview.billingInterval === 'month'
                    ? t('billing.switchToYearly')
                    : t('billing.switchToMonthly')}
                </button>
              ) : null}
            </span>
          ) : null}
          {planIntervalLabel && planStatusDetail ? (
            <span className="text-muted-foreground/50">·</span>
          ) : null}
          {planStatusDetail ? (
            <span className={isPastDue ? 'text-destructive' : 'text-muted-foreground'}>
              {planStatusDetail}
            </span>
          ) : null}
        </div>
      </Card>

      {/* Session usage */}
      {!overview.checkoutPending ? (
        <Card className="p-5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-foreground">{t('billing.sessions')}</span>
            <div className="text-sm tabular-nums text-muted-foreground">
              {sessionLimit === null ? (
                t('billing.unlimited')
              ) : sessionCount === null ? (
                <Skeleton className="h-4 w-14" />
              ) : (
                <>
                  <span
                    className={cn(
                      'font-medium',
                      nearLimit ? 'text-destructive' : 'text-foreground'
                    )}
                  >
                    {sessionCount}
                  </span>
                  {' / '}
                  {sessionLimit}
                </>
              )}
            </div>
          </div>
          {sessionLimit !== null && sessionCount === null ? (
            <Skeleton className="mt-3 h-2 w-full" />
          ) : sessionLimit !== null && sessionCount !== null ? (
            <Progress
              value={sessionCount}
              max={sessionLimit}
              className={cn('mt-3', nearLimit && '[&>div]:bg-destructive')}
            />
          ) : null}
          {sessionLimit !== null ? (
            <p className="mt-2 text-xs text-muted-foreground">{t('billing.sessionsHelp')}</p>
          ) : null}
          <div className="mt-4 flex items-baseline justify-between gap-2 border-t border-border/60 pt-4">
            <span className="text-sm font-medium text-foreground">{t('billing.members')}</span>
            <span className="text-sm tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">{overview.seatCount}</span>
              {!isPaid ? ` / ${FREE_WORKSPACE_MEMBER_LIMIT}` : null}
            </span>
          </div>
        </Card>
      ) : null}

      {/* Upgrade */}
      {!isPaid ? (
        <Card className="overflow-hidden">
          <div className="border-b border-border/70 bg-muted/30 px-5 py-3">
            <p className="text-sm font-semibold text-foreground">
              {overview.checkoutPending
                ? t('billing.completeCheckoutTitle')
                : t('billing.upgradeTitle')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {overview.checkoutPending
                ? t('billing.checkoutPendingDescription')
                : t('billing.upgradeSubtitle')}
            </p>
          </div>
          <div className="space-y-4 p-5">
            {overview.checkoutPending ? (
              /* Awaiting payment: present the plan the checkout was created
                 for instead of the two-option selector. The small toggle
                 still lets the user switch (which supersedes the stored
                 Stripe session server-side on continue). */
              <div className="flex items-center gap-1">
                <span className="text-sm font-medium text-foreground">
                  {interval === 'year' ? t('billing.yearly') : t('billing.monthly')}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  aria-label={t('billing.switchBillingInterval')}
                  title={t('billing.switchBillingInterval')}
                  onClick={() => onIntervalChange(interval === 'year' ? 'month' : 'year')}
                >
                  <ArrowLeftRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 text-sm">
                {(['year', 'month'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onIntervalChange(value)}
                    className={cn(
                      'rounded-md px-3 py-1 font-medium transition-colors',
                      interval === value
                        ? 'bg-background text-foreground shadow-xs'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {value === 'year' ? t('billing.yearly') : t('billing.monthly')}
                  </button>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-end gap-2">
              <span className="text-3xl font-semibold tracking-tight text-foreground">
                {interval === 'year' ? yearlyPerMonthPrice : monthlyPrice}
              </span>
              <span className="pb-1 text-sm text-muted-foreground">
                {t('billing.perSeatMonth')}
              </span>
              {selectedOfferLabel ? (
                <Badge variant="secondary" className="mb-1">
                  {selectedOfferLabel}
                </Badge>
              ) : null}
            </div>

            <p
              className={cn(
                'text-xs',
                yearlyEarlyBirdSelected ? 'font-medium text-foreground' : 'text-muted-foreground'
              )}
            >
              {yearlyEarlyBirdSelected
                ? overview.yearlyEarlyBirdEligible
                  ? t('billing.yearlyEarlyBirdAlreadyLocked')
                  : t('billing.yearlyEarlyBirdCheckoutPromise')
                : interval === 'year'
                  ? t('billing.billedYearly')
                  : t('billing.billedMonthly')}
            </p>

            {permissionBlocked ? (
              /* The button is gone for members, so its slot has to say why —
                 and who to ask — instead of leaving a silent gap. */
              <div className="rounded-lg border border-border/70 bg-muted/40 p-3">
                <p className="text-sm font-medium text-foreground">
                  {t('billing.permissionBlockedTitle')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {workspaceOwnerName
                    ? t('billing.permissionAskOwner', { owner: workspaceOwnerName })
                    : t('billing.permissionDescription')}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Button
                  className="w-full sm:w-auto"
                  disabled={
                    !canManage ||
                    pendingAction !== null ||
                    paymentProcessing ||
                    externalCheckoutPending
                  }
                  onClick={onUpgrade}
                >
                  {pendingAction === 'checkout' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  {yearlyEarlyBirdSelected
                    ? overview.yearlyEarlyBirdEligible
                      ? t('billing.subscribeLockedEarlyBird')
                      : t('billing.upgradeEarlyBird')
                    : overview.checkoutPending
                      ? t('billing.continueCheckout')
                      : t('billing.upgrade')}
                </Button>
                <SubscribeConsentNotice />
              </div>
            )}

            <ul className="grid gap-1.5 pt-1 text-xs text-muted-foreground sm:grid-cols-2">
              {[
                t('billing.perkUnlimitedSessions'),
                t('billing.perkUnlimitedTurns'),
                t('billing.perkUnlimitedMembers'),
                t('billing.perkSeatBilling'),
              ].map((perk) => (
                <li key={perk} className="flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <span>{perk}</span>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <PricingPageLink />
              <FounderCallLink />
            </div>

            {canManage ? (
              <div className="border-t border-border/60 pt-4">
                <label
                  htmlFor="billing-redemption-code"
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t('billing.redeemLabel')}
                </label>
                <div className="mt-1.5 flex gap-2">
                  <Input
                    id="billing-redemption-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && code.trim() && !redeemPending) {
                        onRedeemCode(code.trim());
                      }
                    }}
                    placeholder={t('billing.redeemPlaceholder')}
                    className="h-8 max-w-[220px]"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={redeemPending || !code.trim()}
                    onClick={() => onRedeemCode(code.trim())}
                  >
                    {redeemPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {t('billing.redeemApply')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {/* Next charge preview: renewal + net seat proration, as its own card
          above the history so admins see the exact next amount right after
          inviting members. */}
      {canManage && overview.entitlementSource === 'stripe' && upcomingInvoice ? (
        <Card className="overflow-hidden">
          <div className="border-b border-border/70 bg-muted/30 px-5 py-3">
            <p className="text-sm font-semibold text-foreground">{t('billing.upcomingTitle')}</p>
          </div>
          <div className="px-5 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              {upcomingInvoice.expectedAt ? (
                <p className="text-xs text-muted-foreground">
                  {t('billing.upcomingChargeOn', {
                    date: formatDate(upcomingInvoice.expectedAt),
                  })}
                </p>
              ) : (
                <span />
              )}
              <span className="text-base font-semibold tabular-nums text-foreground">
                {formatMoney(upcomingInvoice.amountDue, upcomingInvoice.currency)}
              </span>
            </div>
            {upcomingInvoice.adjustment ||
            upcomingInvoice.renewal ||
            upcomingInvoice.discount ||
            upcomingInvoice.creditApplied ? (
              <ul className="mt-3 space-y-1 border-t border-border/60 pt-3">
                {upcomingInvoice.renewal ? (
                  <li className="flex items-baseline justify-between gap-4 text-xs text-muted-foreground">
                    <span className="min-w-0 truncate">
                      {upcomingInvoice.renewal.quantity != null
                        ? t('billing.upcomingRenewalWithSeats', {
                            count: upcomingInvoice.renewal.quantity,
                          })
                        : t('billing.upcomingRenewal')}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {formatMoney(upcomingInvoice.renewal.amount, upcomingInvoice.currency)}
                    </span>
                  </li>
                ) : null}
                {upcomingInvoice.discount ? (
                  <li className="flex items-baseline justify-between gap-4 text-xs text-muted-foreground">
                    {/* The invoice discount line is offer-agnostic; only name the
                        campaign when this account's offer actually is early bird. */}
                    <span className="min-w-0 truncate">
                      {t(
                        overview.offerKey === 'early_bird_yearly_6000_forever'
                          ? 'billing.upcomingDiscountEarlyBird'
                          : 'billing.upcomingDiscount'
                      )}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {formatMoney(upcomingInvoice.discount.amount, upcomingInvoice.currency)}
                    </span>
                  </li>
                ) : null}
                {upcomingInvoice.adjustment ? (
                  <li className="flex items-baseline justify-between gap-4 text-xs text-muted-foreground">
                    <span className="min-w-0 truncate">{t('billing.upcomingAdjustment')}</span>
                    <span className="shrink-0 tabular-nums">
                      {formatMoney(upcomingInvoice.adjustment.amount, upcomingInvoice.currency)}
                    </span>
                  </li>
                ) : null}
                {upcomingInvoice.creditApplied ? (
                  <li className="flex items-baseline justify-between gap-4 text-xs text-muted-foreground">
                    <span className="min-w-0 truncate">{t('billing.upcomingCreditApplied')}</span>
                    <span className="shrink-0 tabular-nums">
                      {formatMoney(upcomingInvoice.creditApplied.amount, upcomingInvoice.currency)}
                    </span>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
        </Card>
      ) : null}

      {/* Billing history */}
      {canManage && overview.billingAccountId ? (
        <Card className="overflow-hidden">
          <div className="border-b border-border/70 bg-muted/30 px-5 py-3">
            <p className="text-sm font-semibold text-foreground">{t('billing.historyTitle')}</p>
          </div>
          <div className="px-5 py-4">
            {invoicesError ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-muted-foreground">{t('billing.historyError')}</p>
                <Button size="sm" variant="outline" onClick={onRetryInvoices}>
                  {t('billing.historyRetry')}
                </Button>
              </div>
            ) : invoices === undefined ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('billing.historyLoading')}
              </div>
            ) : invoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('billing.historyEmpty')}</p>
            ) : (
              // Cap at roughly 6 rows; older invoices scroll.
              <ul className="input-scrollbar max-h-80 divide-y divide-border/60 overflow-y-auto text-sm">
                {invoices.map((invoice) => (
                  <li
                    key={invoice.id}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">
                        {formatDate(invoice.periodStart ?? invoice.createdAt)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {invoice.kind === 'gift_redemption'
                          ? invoice.giftDurationMonths
                            ? t('billing.historyGiftPlusMonths', {
                                count: invoice.giftDurationMonths,
                              })
                            : t('billing.historyGiftPlus')
                          : invoice.interval === 'year'
                            ? t('billing.historyPlanYearly')
                            : invoice.interval === 'month'
                              ? t('billing.historyPlanMonthly')
                              : t('billing.plan.plus')}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-medium tabular-nums text-foreground">
                        {formatMoney(invoice.amountPaid, invoice.currency)}
                      </span>
                      <Badge
                        variant={invoice.status === 'paid' ? 'secondary' : 'outline'}
                        className="capitalize"
                      >
                        {invoice.status}
                      </Badge>
                      {invoice.hostedInvoiceUrl ? (
                        <a
                          href={invoice.hostedInvoiceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          {t('billing.historyView')}
                        </a>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      ) : null}

      {/* Cancel / resume subscription: deliberately low-emphasis, tucked at the
          very bottom of the billing page rather than beside the plan. */}
      {isPaid && canManage && overview.entitlementSource === 'stripe' ? (
        <div className="flex justify-end pt-1">
          {overview.cancelAtPeriodEnd ? (
            <button
              type="button"
              disabled={cancelPending}
              onClick={onResumeSubscription}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
            >
              {cancelPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {t('billing.resumeSubscription')}
            </button>
          ) : (
            <button
              type="button"
              disabled={cancelPending}
              onClick={onCancelSubscription}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-destructive disabled:opacity-60"
            >
              {cancelPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {t('billing.cancelSubscription')}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

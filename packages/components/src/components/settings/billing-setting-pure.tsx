import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { FREE_SESSION_LIMIT_PER_WORKSPACE, FREE_WORKSPACE_MEMBER_LIMIT } from '@lody/shared';
import { ArrowLeftRight, Check } from 'lucide-react';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Progress } from '@lody/ui/progress';
import { Skeleton } from '@lody/ui/skeleton';
import { Spinner } from '@lody/ui/spinner';
import { Tabs } from '@lody/ui/tabs';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { withClassName } from '@/lib/stylex';
import { PricingPageLink } from '../shared/pricing-page-link';
import { FounderCallLink } from '../shared/founder-call-link';
import { SubscribeConsentNotice } from '../shared/subscribe-consent-notice';
import { CompactRow, CompactSection } from './compact-layout';
import { settingsSurface as surface } from './surface';
import { settingContainerClass } from '.';

const WIDE = '@media (min-width: 640px)';

/**
 * Billing is settings cards like every other page: one card rung, one 16px
 * inset shared by every line, a group's name above its card rather than in a
 * band inside it, and records as ruled rows.
 */
const styles = stylex.create({
  /** A line of a card that is not a `CompactRow`: the row's own inset. */
  block: { paddingInline: space[4], paddingBlock: space[3], minWidth: 0 },
  banner: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[3],
    paddingInline: space[4],
    paddingBlock: space[3],
  },
  bannerMark: { marginTop: '2px', color: colors.accent },
  bannerText: { flexGrow: 1, minWidth: 0 },

  planHeading: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  planName: { margin: 0, fontSize: '1.125em', lineHeight: 1.25, color: colors.label },
  statusLine: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[2],
    rowGap: '2px',
    marginTop: space[1],
    fontSize: '0.8em',
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  statusInterval: { display: 'inline-flex', alignItems: 'center', gap: space[1.5] },
  statusDot: { color: colors.tertiaryLabel },
  inlineAction: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.accent,
    fontFamily: 'inherit',
    fontSize: 'inherit',
    cursor: { default: 'pointer', ':disabled': 'default' },
    opacity: { default: 1, ':hover': 0.8, ':disabled': 0.6 },
  },
  glyphSmall: { width: '12px', height: '12px', flexShrink: 0 },
  danger: { color: colors.destructive },

  metric: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space[2],
  },
  metricValue: { color: colors.secondaryLabel, fontVariantNumeric: 'tabular-nums' },
  metricStrong: { color: colors.label },
  meter: { marginTop: space[3] },
  helper: {
    margin: 0,
    marginTop: space[2],
    fontSize: '0.8em',
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  helperFlush: {
    margin: 0,
    fontSize: '0.8em',
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },

  /** The offer: its heading, the strip, the price and the action, one column. */
  offer: { display: 'flex', flexDirection: 'column', gap: space[4], paddingBlock: space[4] },
  offerTitle: { margin: 0, lineHeight: 1.25, color: colors.label },
  strip: { display: 'flex' },
  checkoutInterval: { display: 'flex', alignItems: 'center', gap: space[1] },
  pricePanel: { display: 'flex', flexDirection: 'column', paddingTop: space[2] },
  price: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: space[2] },
  priceValue: {
    fontSize: '2em',
    lineHeight: 1.1,
    letterSpacing: '-0.02em',
    color: colors.label,
    fontVariantNumeric: 'tabular-nums',
  },
  priceUnit: { fontSize: '0.85em', color: colors.secondaryLabel },
  promise: { color: colors.label },
  action: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: space[2] },
  perks: {
    display: 'grid',
    gridTemplateColumns: { default: 'minmax(0, 1fr)', [WIDE]: 'repeat(2, minmax(0, 1fr))' },
    columnGap: space[4],
    rowGap: space[1.5],
    margin: 0,
    padding: 0,
    listStyleType: 'none',
    fontSize: '0.8em',
    color: colors.secondaryLabel,
  },
  perk: { display: 'flex', alignItems: 'center', gap: space[1.5], minWidth: 0 },
  perkMark: { width: '14px', height: '14px', flexShrink: 0, color: colors.accent },
  links: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[4],
    rowGap: space[1],
  },

  redeemField: { width: '220px', maxWidth: '100%' },
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    margin: '-1px',
    padding: 0,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },

  amountDue: { color: colors.label, fontVariantNumeric: 'tabular-nums' },
  breakdown: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
    margin: 0,
    listStyleType: 'none',
  },
  breakdownLine: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space[4],
    fontSize: '0.8em',
    color: colors.secondaryLabel,
  },
  truncate: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tabular: { flexShrink: 0, fontVariantNumeric: 'tabular-nums', color: colors.label },

  inlineRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[3] },
  history: { maxHeight: '320px', overflowY: 'auto', margin: 0, padding: 0, listStyleType: 'none' },
  invoice: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: space[4],
    rowGap: space[1],
  },
  invoiceText: { minWidth: 0 },
  link: {
    fontSize: '0.8em',
    color: colors.accent,
    textDecoration: { default: 'none', ':hover': 'underline' },
  },

  trailing: { display: 'flex', justifyContent: 'flex-end', paddingInline: space[4] },
  quietAction: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    fontFamily: 'inherit',
    fontSize: '0.8em',
    cursor: { default: 'pointer', ':disabled': 'default' },
    opacity: { default: 1, ':disabled': 0.6 },
  },
  quietActionDanger: { color: { default: colors.secondaryLabel, ':hover': colors.destructive } },
});

export type BillingInterval = 'month' | 'year';
export type BillingPendingAction = 'checkout' | 'portal' | null;

export interface BillingOverviewData {
  billingAccountId: string | null;
  /** Backend capability fence for rolling frontend/backend deployments. */
  giftStackingSupported: boolean;
  effectivePlanTier: 'free' | 'plus' | 'enterprise';
  entitlementSource: 'free' | 'stripe' | 'stripe_gift' | 'enterprise';
  offerKey: string | null;
  yearlyEarlyBirdEligible: boolean;
  promotionalEntitlementEndsAt: number | null;
  /** Entire granted gift window, including a gift phase that starts later. */
  giftStartsAt: number | null;
  giftEndsAt: number | null;
  /** First charge after the gift window, when automatic billing is configured. */
  nextBillingAt: number | null;
  autoRenewAfterGift: boolean;
  /** A prior paid phase can be restored without collecting payment again. */
  canResumeAfterGift: boolean;
  scheduledBillingInterval: BillingInterval | null;
  /** True only for the Lody-owned gift Subscription Schedule shape. */
  scheduleManaged: boolean;
  /** A setup Checkout is collecting a payment method for post-gift billing. */
  subscriptionSetupPending: boolean;
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
  /** Opens the Stripe payment-method-only Portal. */
  onPaymentMethod?: () => void;
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
  onPaymentMethod,
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
        <CompactSection>
          <p {...stylex.props(surface.cardNote)}>{t('billing.unavailable')}</p>
        </CompactSection>
      </div>
    );
  }

  const isPaid =
    overview.effectivePlanTier === 'plus' || overview.effectivePlanTier === 'enterprise';
  const checkoutInProgress = overview.checkoutPending || overview.subscriptionSetupPending;
  const paidCheckoutPending = overview.checkoutPending && !overview.subscriptionSetupPending;
  const planName =
    paidCheckoutPending || overview.effectivePlanTier === 'plus'
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
  const giftEnd = overview.giftEndsAt ?? overview.promotionalEntitlementEndsAt;
  const hasGiftTimeline = giftEnd !== null && giftEnd > Date.now();
  const canScheduleAfterGift =
    overview.giftStackingSupported &&
    overview.scheduleManaged &&
    isPromotional &&
    !overview.autoRenewAfterGift &&
    !overview.canResumeAfterGift &&
    overview.effectivePlanTier === 'plus';
  const showSubscriptionOffer = !isPaid || canScheduleAfterGift;

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
    isPaid && !checkoutInProgress && overview.billingInterval
      ? isPromotional
        ? t('billing.promotionalBadge')
        : overview.billingInterval === 'year'
          ? t('billing.yearly')
          : t('billing.monthly')
      : null;
  const showIntervalSwitch =
    isPaid &&
    overview.entitlementSource === 'stripe' &&
    !overview.scheduleManaged &&
    overview.offerKey !== 'founder_monthly_500_forever' &&
    canManage &&
    !overview.cancelAtPeriodEnd &&
    !checkoutInProgress &&
    !!overview.billingInterval;
  const planStatusDetail = overview.subscriptionSetupPending
    ? t('billing.subscriptionSetupPendingDescription')
    : overview.checkoutPending
      ? t('billing.checkoutPendingDescription')
      : isPastDue
        ? t('billing.pastDue')
        : hasGiftTimeline && overview.autoRenewAfterGift && overview.nextBillingAt
          ? t('billing.giftThenBillingOn', {
              date: formatDate(overview.nextBillingAt),
              interval:
                overview.scheduledBillingInterval === 'year'
                  ? t('billing.yearly').toLocaleLowerCase()
                  : t('billing.monthly').toLocaleLowerCase(),
            })
          : hasGiftTimeline && giftEnd
            ? t('billing.promotionalEndsOn', {
                date: formatDate(giftEnd),
              })
            : isPaid && overview.currentPeriodEnd
              ? overview.cancelAtPeriodEnd
                ? t('billing.cancelsOn', { date: formatDate(overview.currentPeriodEnd) })
                : t('billing.renewsOn', { date: formatDate(overview.currentPeriodEnd) })
              : !isPaid
                ? t('billing.freeTagline')
                : null;

  const offerTitle = checkoutInProgress
    ? overview.subscriptionSetupPending
      ? t('billing.completeSubscriptionSetupTitle')
      : t('billing.completeCheckoutTitle')
    : canScheduleAfterGift
      ? t('billing.subscribeAfterGiftTitle')
      : t('billing.upgradeTitle');
  const offerSubtitle = checkoutInProgress
    ? overview.subscriptionSetupPending
      ? t('billing.subscriptionSetupPendingDescription')
      : t('billing.checkoutPendingDescription')
    : canScheduleAfterGift
      ? t('billing.subscribeAfterGiftSubtitle', { date: formatDate(giftEnd) })
      : t('billing.upgradeSubtitle');
  const breakdown = upcomingInvoice
    ? [
        upcomingInvoice.renewal
          ? {
              key: 'renewal',
              label:
                upcomingInvoice.renewal.quantity != null
                  ? t('billing.upcomingRenewalWithSeats', {
                      count: upcomingInvoice.renewal.quantity,
                    })
                  : t('billing.upcomingRenewal'),
              amount: upcomingInvoice.renewal.amount,
            }
          : null,
        upcomingInvoice.discount
          ? {
              key: 'discount',
              // The invoice discount line is offer-agnostic; only name the
              // campaign when this account's offer actually is early bird.
              label: t(
                overview.offerKey === 'early_bird_yearly_6000_forever'
                  ? 'billing.upcomingDiscountEarlyBird'
                  : 'billing.upcomingDiscount'
              ),
              amount: upcomingInvoice.discount.amount,
            }
          : null,
        upcomingInvoice.adjustment
          ? {
              key: 'adjustment',
              label: t('billing.upcomingAdjustment'),
              amount: upcomingInvoice.adjustment.amount,
            }
          : null,
        upcomingInvoice.creditApplied
          ? {
              key: 'credit',
              label: t('billing.upcomingCreditApplied'),
              amount: upcomingInvoice.creditApplied.amount,
            }
          : null,
      ].filter((line) => line !== null)
    : [];

  return (
    <div className={settingContainerClass}>
      {/* Desktop: checkout opened in the system browser, awaiting payment */}
      {externalCheckoutPending ? (
        <CompactSection>
          <div {...stylex.props(styles.banner)}>
            <Spinner size="small" {...stylex.props(styles.bannerMark)} />
            <div {...stylex.props(styles.bannerText)}>
              <p {...stylex.props(surface.rowLabel)}>
                {canScheduleAfterGift || overview.subscriptionSetupPending
                  ? t('billing.externalSetupTitle')
                  : t('billing.externalCheckoutTitle')}
              </p>
              <p {...stylex.props(surface.rowHelper)}>
                {canScheduleAfterGift || overview.subscriptionSetupPending
                  ? t('billing.externalSetupDescription')
                  : t('billing.externalCheckoutDescription')}
              </p>
            </div>
            {onCancelExternalCheckout ? (
              <Button variant="ghost" size="small" onClick={onCancelExternalCheckout}>
                {t('billing.externalCheckoutDismiss')}
              </Button>
            ) : null}
          </div>
        </CompactSection>
      ) : null}

      {/* Payment received, activation in flight */}
      {paymentProcessing && !externalCheckoutPending ? (
        <CompactSection>
          <div {...stylex.props(styles.banner)}>
            <Spinner size="small" {...stylex.props(styles.bannerMark)} />
            <div {...stylex.props(styles.bannerText)}>
              <p {...stylex.props(surface.rowLabel)}>
                {overview.subscriptionSetupPending
                  ? t('billing.subscriptionSetupProcessingTitle')
                  : t('billing.paymentProcessingTitle')}
              </p>
              <p {...stylex.props(surface.rowHelper)}>
                {overview.subscriptionSetupPending
                  ? t('billing.subscriptionSetupProcessingDescription')
                  : t('billing.paymentProcessingDescription')}
              </p>
            </div>
          </div>
        </CompactSection>
      ) : null}

      {/* Plan status */}
      <CompactSection>
        <div {...stylex.props(styles.block)}>
          <div {...stylex.props(styles.planHeading)}>
            <p {...stylex.props(styles.planName)}>{planName}</p>
            {/* A gift always ends at its schedule boundary; its status line says
                so already, and a cancel badge would read as an error state. */}
            {overview.cancelAtPeriodEnd && !isPromotional ? (
              <Badge>{t('billing.cancelAtPeriodEnd')}</Badge>
            ) : null}
            {checkoutInProgress ? <Badge>{t('billing.checkoutPending')}</Badge> : null}
            {hasGiftTimeline && overview.autoRenewAfterGift ? (
              <Badge>{t('billing.postGiftBillingScheduled')}</Badge>
            ) : null}
            {overview.yearlyEarlyBirdEligible ? (
              <Badge>{t('billing.yearlyPromoPrice')}</Badge>
            ) : null}
          </div>
          <div {...stylex.props(styles.statusLine)}>
            {planIntervalLabel ? (
              <span {...stylex.props(styles.statusInterval)}>
                {planIntervalLabel}
                {showIntervalSwitch ? (
                  <button
                    type="button"
                    disabled={switchIntervalPending || !overview.billingAccountId}
                    onClick={onSwitchInterval}
                    {...stylex.props(styles.inlineAction)}
                  >
                    {switchIntervalPending ? (
                      <Spinner size="small" />
                    ) : (
                      <ArrowLeftRight aria-hidden="true" {...stylex.props(styles.glyphSmall)} />
                    )}
                    {overview.billingInterval === 'month'
                      ? t('billing.switchToYearly')
                      : t('billing.switchToMonthly')}
                  </button>
                ) : null}
              </span>
            ) : null}
            {planIntervalLabel && planStatusDetail ? (
              <span aria-hidden="true" {...stylex.props(styles.statusDot)}>
                ·
              </span>
            ) : null}
            {planStatusDetail ? (
              <span {...stylex.props(isPastDue && styles.danger)}>{planStatusDetail}</span>
            ) : null}
          </div>
        </div>
      </CompactSection>

      {/* Session usage */}
      {!paidCheckoutPending ? (
        <CompactSection>
          <div {...stylex.props(styles.block)}>
            <div {...stylex.props(styles.metric)}>
              <p {...stylex.props(surface.rowLabel)}>{t('billing.sessions')}</p>
              <div {...stylex.props(styles.metricValue)}>
                {sessionLimit === null ? (
                  t('billing.unlimited')
                ) : sessionCount === null ? (
                  <Skeleton width="56px" height="16px" />
                ) : (
                  <>
                    <span {...stylex.props(styles.metricStrong, nearLimit && styles.danger)}>
                      {sessionCount}
                    </span>
                    {' / '}
                    {sessionLimit}
                  </>
                )}
              </div>
            </div>
            {sessionLimit !== null ? (
              <div {...stylex.props(styles.meter)}>
                {sessionCount === null ? (
                  <Skeleton width="100%" height="8px" />
                ) : (
                  <Progress
                    value={sessionCount}
                    max={sessionLimit}
                    tone={nearLimit ? 'danger' : 'running'}
                  />
                )}
              </div>
            ) : null}
            {sessionLimit !== null ? (
              <p {...stylex.props(styles.helper)}>{t('billing.sessionsHelp')}</p>
            ) : null}
          </div>
          <div {...stylex.props(styles.block)}>
            <div {...stylex.props(styles.metric)}>
              <p {...stylex.props(surface.rowLabel)}>{t('billing.members')}</p>
              <span {...stylex.props(styles.metricValue)}>
                <span {...stylex.props(styles.metricStrong)}>{overview.seatCount}</span>
                {!isPaid ? ` / ${FREE_WORKSPACE_MEMBER_LIMIT}` : null}
              </span>
            </div>
          </div>
        </CompactSection>
      ) : null}

      {/* Upgrade */}
      {showSubscriptionOffer ? (
        <CompactSection>
          <div {...stylex.props(styles.block, styles.offer)}>
            <div>
              <p {...stylex.props(styles.offerTitle)}>{offerTitle}</p>
              <p {...stylex.props(surface.rowHelper)}>{offerSubtitle}</p>
            </div>

            <Tabs.Root
              value={interval}
              onValueChange={(value) => onIntervalChange(value as BillingInterval)}
            >
              {checkoutInProgress ? (
                /* Awaiting payment: present the plan the checkout was created
                   for instead of the two-option strip. The small toggle still
                   lets the user switch (which supersedes the stored Stripe
                   session server-side on continue). */
                <div {...stylex.props(styles.checkoutInterval)}>
                  <span {...stylex.props(surface.rowLabel)}>
                    {interval === 'year' ? t('billing.yearly') : t('billing.monthly')}
                  </span>
                  <Button
                    variant="ghost"
                    aria-label={t('billing.switchBillingInterval')}
                    title={t('billing.switchBillingInterval')}
                    size="small"
                    icon
                    onClick={() => onIntervalChange(interval === 'year' ? 'month' : 'year')}
                  >
                    <ArrowLeftRight aria-hidden="true" />
                  </Button>
                </div>
              ) : (
                <div {...stylex.props(styles.strip)}>
                  <Tabs.List>
                    <Tabs.Tab value="year">{t('billing.yearly')}</Tabs.Tab>
                    <Tabs.Tab value="month">{t('billing.monthly')}</Tabs.Tab>
                  </Tabs.List>
                </div>
              )}
              <Tabs.Panel value={interval} className={stylex.props(styles.pricePanel).className}>
                <div {...stylex.props(styles.price)}>
                  <span {...stylex.props(styles.priceValue)}>
                    {interval === 'year' ? yearlyPerMonthPrice : monthlyPrice}
                  </span>
                  <span {...stylex.props(styles.priceUnit)}>{t('billing.perSeatMonth')}</span>
                  {selectedOfferLabel ? <Badge>{selectedOfferLabel}</Badge> : null}
                </div>
                <p {...stylex.props(styles.helper, yearlyEarlyBirdSelected && styles.promise)}>
                  {yearlyEarlyBirdSelected
                    ? overview.yearlyEarlyBirdEligible
                      ? t('billing.yearlyEarlyBirdAlreadyLocked')
                      : t('billing.yearlyEarlyBirdCheckoutPromise')
                    : interval === 'year'
                      ? t('billing.billedYearly')
                      : t('billing.billedMonthly')}
                </p>
              </Tabs.Panel>
            </Tabs.Root>

            {permissionBlocked ? (
              /* The button is gone for members, so its slot has to say why —
                 and who to ask — instead of leaving a silent gap. */
              <div {...stylex.props(surface.formBlock)}>
                <p {...stylex.props(surface.rowLabel)}>{t('billing.permissionBlockedTitle')}</p>
                <p {...stylex.props(surface.rowHelper)}>
                  {workspaceOwnerName
                    ? t('billing.permissionAskOwner', { owner: workspaceOwnerName })
                    : t('billing.permissionDescription')}
                </p>
              </div>
            ) : (
              <div {...stylex.props(styles.action)}>
                <Button
                  disabled={
                    !canManage ||
                    pendingAction !== null ||
                    paymentProcessing ||
                    externalCheckoutPending
                  }
                  onClick={onUpgrade}
                >
                  {pendingAction === 'checkout' ? <Spinner size="small" /> : null}
                  {yearlyEarlyBirdSelected
                    ? overview.yearlyEarlyBirdEligible
                      ? t('billing.subscribeLockedEarlyBird')
                      : t('billing.upgradeEarlyBird')
                    : checkoutInProgress
                      ? t('billing.continueCheckout')
                      : canScheduleAfterGift
                        ? t('billing.subscribeAfterGift')
                        : t('billing.upgrade')}
                </Button>
                <SubscribeConsentNotice />
              </div>
            )}

            <ul {...stylex.props(styles.perks)}>
              {[
                t('billing.perkUnlimitedSessions'),
                t('billing.perkUnlimitedTurns'),
                t('billing.perkUnlimitedMembers'),
                t('billing.perkSeatBilling'),
              ].map((perk) => (
                <li key={perk} {...stylex.props(styles.perk)}>
                  <Check aria-hidden="true" {...stylex.props(styles.perkMark)} />
                  <span>{perk}</span>
                </li>
              ))}
            </ul>

            <div {...stylex.props(styles.links)}>
              <PricingPageLink />
              <FounderCallLink />
            </div>
          </div>
        </CompactSection>
      ) : null}

      {/* Gift codes extend both free and paid Plus timelines. Keep redemption
          independent from the upgrade card so paid subscribers can use it. */}
      {canManage &&
      overview.effectivePlanTier !== 'enterprise' &&
      (!isPaid || overview.giftStackingSupported) ? (
        <CompactSection>
          <CompactRow label={t('billing.redeemTitle')} helper={t('billing.redeemSubtitle')}>
            <label htmlFor="billing-redemption-code" {...stylex.props(styles.srOnly)}>
              {t('billing.redeemLabel')}
            </label>
            <div {...stylex.props(styles.redeemField)}>
              <Input
                id="billing-redemption-code"
                size="small"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    code.trim() &&
                    !redeemPending &&
                    !checkoutInProgress
                  ) {
                    onRedeemCode(code.trim());
                  }
                }}
                placeholder={t('billing.redeemPlaceholder')}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <Button
              variant="secondary"
              size="small"
              disabled={redeemPending || checkoutInProgress || !code.trim()}
              onClick={() => onRedeemCode(code.trim())}
            >
              {redeemPending ? <Spinner size="small" /> : null}
              {t('billing.redeemApply')}
            </Button>
          </CompactRow>
        </CompactSection>
      ) : null}

      {/* Next charge preview: renewal + net seat proration, as its own card
          above the history so admins see the exact next amount right after
          inviting members. */}
      {canManage && overview.entitlementSource === 'stripe' && upcomingInvoice ? (
        <CompactSection title={t('billing.upcomingTitle')}>
          <div {...stylex.props(styles.block)}>
            <div {...stylex.props(styles.metric)}>
              <p {...stylex.props(styles.helperFlush)}>
                {upcomingInvoice.expectedAt
                  ? t('billing.upcomingChargeOn', {
                      date: formatDate(upcomingInvoice.expectedAt),
                    })
                  : null}
              </p>
              <span {...stylex.props(styles.amountDue)}>
                {formatMoney(upcomingInvoice.amountDue, upcomingInvoice.currency)}
              </span>
            </div>
          </div>
          {breakdown.length > 0 ? (
            <ul {...stylex.props(styles.block, styles.breakdown)}>
              {breakdown.map((line) => (
                <li key={line.key} {...stylex.props(styles.breakdownLine)}>
                  <span {...stylex.props(styles.truncate)}>{line.label}</span>
                  <span {...stylex.props(styles.tabular)}>
                    {formatMoney(line.amount, upcomingInvoice.currency)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </CompactSection>
      ) : null}

      {/* Billing history */}
      {canManage && overview.billingAccountId ? (
        <CompactSection title={t('billing.historyTitle')}>
          {invoicesError ? (
            <div {...stylex.props(styles.block, styles.inlineRow)}>
              <p {...stylex.props(styles.helperFlush)}>{t('billing.historyError')}</p>
              <Button variant="secondary" size="small" onClick={onRetryInvoices}>
                {t('billing.historyRetry')}
              </Button>
            </div>
          ) : invoices === undefined ? (
            <div {...stylex.props(styles.block, styles.inlineRow)}>
              <Spinner size="small" />
              <p {...stylex.props(styles.helperFlush)}>{t('billing.historyLoading')}</p>
            </div>
          ) : invoices.length === 0 ? (
            <p {...stylex.props(surface.cardNote)}>{t('billing.historyEmpty')}</p>
          ) : (
            // Cap at roughly 6 rows; older invoices scroll.
            <ul {...withClassName(stylex.props(styles.history), 'input-scrollbar')}>
              {invoices.map((invoice, index) => (
                <li
                  key={invoice.id}
                  {...stylex.props(styles.block, styles.invoice, index > 0 && surface.lineRuled)}
                >
                  <div {...stylex.props(styles.invoiceText)}>
                    <p {...stylex.props(surface.rowLabel)}>
                      {formatDate(invoice.periodStart ?? invoice.createdAt)}
                    </p>
                    <p {...stylex.props(surface.rowHelper)}>
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
                  <div {...stylex.props(styles.inlineRow)}>
                    <span {...stylex.props(styles.tabular)}>
                      {formatMoney(invoice.amountPaid, invoice.currency)}
                    </span>
                    <Badge>
                      {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                    </Badge>
                    {invoice.hostedInvoiceUrl ? (
                      <a
                        href={invoice.hostedInvoiceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        {...stylex.props(styles.link)}
                      >
                        {t('billing.historyView')}
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CompactSection>
      ) : null}

      {canManage &&
      overview.billingAccountId &&
      ['stripe', 'stripe_gift'].includes(overview.entitlementSource) &&
      onPaymentMethod ? (
        <CompactSection>
          <CompactRow
            label={t('billing.paymentMethod')}
            helper={t('billing.paymentMethodDescription')}
          >
            <Button
              variant="secondary"
              size="small"
              onClick={onPaymentMethod}
              disabled={
                pendingAction !== null ||
                cancelPending ||
                switchIntervalPending ||
                redeemPending ||
                checkoutInProgress
              }
            >
              {pendingAction === 'portal' ? <Spinner size="small" /> : null}
              {t(
                pendingAction === 'portal'
                  ? 'billing.paymentMethodOpening'
                  : 'billing.changePaymentMethod'
              )}
            </Button>
          </CompactRow>
        </CompactSection>
      ) : null}

      {/* Cancel / resume subscription: deliberately low-emphasis, tucked at the
          very bottom of the billing page rather than beside the plan. */}
      {isPaid &&
      canManage &&
      ((overview.entitlementSource === 'stripe' &&
        (!overview.scheduleManaged || overview.autoRenewAfterGift || overview.cancelAtPeriodEnd)) ||
        (isPromotional && (overview.autoRenewAfterGift || overview.canResumeAfterGift))) ? (
        <div {...stylex.props(styles.trailing)}>
          {overview.cancelAtPeriodEnd ? (
            <button
              type="button"
              disabled={cancelPending}
              onClick={onResumeSubscription}
              {...stylex.props(styles.quietAction)}
            >
              {cancelPending ? <Spinner size="small" /> : null}
              {t('billing.resumeSubscription')}
            </button>
          ) : (
            <button
              type="button"
              disabled={cancelPending}
              onClick={onCancelSubscription}
              {...stylex.props(styles.quietAction, styles.quietActionDanger)}
            >
              {cancelPending ? <Spinner size="small" /> : null}
              {t('billing.cancelSubscription')}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

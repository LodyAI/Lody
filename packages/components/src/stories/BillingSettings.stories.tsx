import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { FREE_SESSION_LIMIT_PER_WORKSPACE } from '@lody/shared';
import {
  BillingSettingsView,
  type BillingInterval,
  type BillingInvoice,
  type BillingOverviewData,
  type BillingUpcomingInvoice,
} from '@/components/settings/billing-setting-pure';

const DAY = 24 * 60 * 60 * 1000;

const mockInvoices: BillingInvoice[] = [
  {
    id: 'in_3',
    number: 'A1B2-0003',
    status: 'paid',
    amountPaid: 1000,
    currency: 'USD',
    periodStart: Date.now() - 30 * DAY,
    periodEnd: Date.now(),
    interval: 'month',
    kind: 'subscription',
    giftDurationMonths: null,
    createdAt: Date.now() - 30 * DAY,
    hostedInvoiceUrl: 'https://invoice.stripe.com/i/example3',
  },
  {
    id: 'in_2',
    number: 'A1B2-0002',
    status: 'paid',
    amountPaid: 1000,
    currency: 'USD',
    periodStart: Date.now() - 60 * DAY,
    periodEnd: Date.now() - 30 * DAY,
    interval: 'month',
    kind: 'subscription',
    giftDurationMonths: null,
    createdAt: Date.now() - 60 * DAY,
    hostedInvoiceUrl: 'https://invoice.stripe.com/i/example2',
  },
  {
    id: 'in_1',
    number: 'A1B2-0001',
    status: 'paid',
    amountPaid: 9600,
    currency: 'USD',
    periodStart: Date.now() - 425 * DAY,
    periodEnd: Date.now() - 60 * DAY,
    interval: 'year',
    kind: 'subscription',
    giftDurationMonths: null,
    createdAt: Date.now() - 425 * DAY,
    hostedInvoiceUrl: null,
  },
];

const freeOverview: BillingOverviewData = {
  billingAccountId: null,
  giftStackingSupported: true,
  effectivePlanTier: 'free',
  entitlementSource: 'free',
  offerKey: null,
  yearlyEarlyBirdEligible: false,
  promotionalEntitlementEndsAt: null,
  giftStartsAt: null,
  giftEndsAt: null,
  nextBillingAt: null,
  autoRenewAfterGift: false,
  canResumeAfterGift: false,
  scheduledBillingInterval: null,
  scheduleManaged: false,
  subscriptionSetupPending: false,
  checkoutPending: false,
  checkoutInterval: null,
  subscriptionStatus: null,
  billingInterval: null,
  cancelAtPeriodEnd: false,
  currentPeriodEnd: null,
  seatCount: 2,
  canManageBilling: true,
  pricing: {
    monthlyAmountCents: 1000,
    yearlyAmountCents: 9600,
    monthlyOfferKey: null,
    yearlyOfferKey: null,
  },
};

const paidOverview: BillingOverviewData = {
  billingAccountId: 'ba_1',
  giftStackingSupported: true,
  effectivePlanTier: 'plus',
  entitlementSource: 'stripe',
  offerKey: null,
  yearlyEarlyBirdEligible: false,
  promotionalEntitlementEndsAt: null,
  giftStartsAt: null,
  giftEndsAt: null,
  nextBillingAt: null,
  autoRenewAfterGift: false,
  canResumeAfterGift: false,
  scheduledBillingInterval: null,
  scheduleManaged: false,
  subscriptionSetupPending: false,
  checkoutPending: false,
  checkoutInterval: null,
  subscriptionStatus: 'active',
  billingInterval: 'month',
  cancelAtPeriodEnd: false,
  currentPeriodEnd: Date.now() + 21 * DAY,
  seatCount: 5,
  canManageBilling: true,
  pricing: {
    monthlyAmountCents: 1000,
    yearlyAmountCents: 9600,
    monthlyOfferKey: null,
    yearlyOfferKey: null,
  },
};

function Harness({
  overview,
  sessionCount = 42,
  invoices,
  upcomingInvoice = null,
  invoicesError = false,
  paymentProcessing = false,
  cancelPending = false,
  switchIntervalPending = false,
  canManageBillingKnown = true,
  workspaceOwnerName = null,
}: {
  overview: BillingOverviewData | null;
  sessionCount?: number | null;
  invoices?: BillingInvoice[];
  upcomingInvoice?: BillingUpcomingInvoice | null;
  invoicesError?: boolean;
  paymentProcessing?: boolean;
  cancelPending?: boolean;
  switchIntervalPending?: boolean;
  canManageBillingKnown?: boolean;
  workspaceOwnerName?: string | null;
}) {
  // Mirror the container: a pending checkout presents the interval it was
  // created with; the user can still toggle it from the awaiting-payment row.
  const [interval, setInterval] = useState<BillingInterval>(
    overview?.checkoutPending || overview?.subscriptionSetupPending
      ? (overview.checkoutInterval ?? 'year')
      : 'year'
  );
  return (
    <BillingSettingsView
      overview={overview}
      sessionCount={sessionCount}
      interval={interval}
      pendingAction={null}
      redeemPending={false}
      cancelPending={cancelPending}
      invoices={invoices}
      upcomingInvoice={upcomingInvoice}
      invoicesError={invoicesError}
      canManageBillingKnown={canManageBillingKnown}
      workspaceOwnerName={workspaceOwnerName}
      paymentProcessing={paymentProcessing}
      onIntervalChange={setInterval}
      onUpgrade={() => {}}
      onSwitchInterval={() => {}}
      switchIntervalPending={switchIntervalPending}
      onPaymentMethod={() => {}}
      onCancelSubscription={() => {}}
      onResumeSubscription={() => {}}
      onRedeemCode={() => {}}
      onRetryInvoices={() => {}}
    />
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Settings/BillingSettings',
  component: Harness,
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj<typeof Harness>;

export const Unavailable: Story = { args: { overview: null } };
export const Free: Story = { args: { overview: freeOverview } };

export const FreeNearLimit: Story = {
  // Above the 0.8 "near limit" threshold whatever the free cap is set to.
  args: { overview: freeOverview, sessionCount: FREE_SESSION_LIMIT_PER_WORKSPACE - 10 },
};

export const FreeSessionUsageLoading: Story = {
  args: { overview: freeOverview, sessionCount: null },
};

/* Awaiting payment: the upgrade card shows the plan the checkout was created
   for (no month/year selector) with a small switch-interval icon button. */
export const CheckoutPending: Story = {
  args: {
    overview: {
      ...freeOverview,
      billingAccountId: 'ba_pending',
      checkoutPending: true,
      checkoutInterval: 'year',
    },
    sessionCount: 0,
  },
};

export const CheckoutPendingMonthly: Story = {
  args: {
    overview: {
      ...freeOverview,
      billingAccountId: 'ba_pending',
      checkoutPending: true,
      checkoutInterval: 'month',
    },
    sessionCount: 0,
  },
};

export const FreeWithOffers: Story = {
  args: {
    overview: {
      ...freeOverview,
      pricing: {
        monthlyAmountCents: 500,
        yearlyAmountCents: 6000,
        monthlyOfferKey: 'founder_monthly_500_forever',
        yearlyOfferKey: 'early_bird_yearly_6000_forever',
      },
    },
  },
};

/* Member without billing permission: the upgrade button is replaced by the
   reason plus the owner to ask. */
export const FreeNoPermission: Story = {
  args: {
    overview: { ...freeOverview, canManageBilling: false },
    workspaceOwnerName: 'Ada Lovelace',
  },
};

/* Same viewer before the server confirms the role: the action stays visible
   but disabled, so an owner never briefly reads the no-permission copy. */
export const FreeRoleUnconfirmed: Story = {
  args: {
    overview: { ...freeOverview, canManageBilling: false },
    canManageBillingKnown: false,
  },
};

/* Paid + admin: monthly plan showing "Switch to yearly" with the
   destructive-tinted "Cancel subscription" button below it. */
export const PaidActive: Story = {
  args: { overview: paidOverview, invoices: mockInvoices },
};

export const PromotionalPlus: Story = {
  args: {
    overview: {
      ...paidOverview,
      entitlementSource: 'stripe_gift',
      promotionalEntitlementEndsAt: Date.now() + 30 * DAY,
      giftStartsAt: Date.now(),
      giftEndsAt: Date.now() + 30 * DAY,
      scheduleManaged: true,
      subscriptionStatus: 'active',
      billingInterval: 'month',
      currentPeriodEnd: Date.now() + 30 * DAY,
    },
    invoices: [
      {
        id: 'in_gift',
        number: 'A1B2-GIFT',
        status: 'paid',
        amountPaid: 0,
        currency: 'USD',
        periodStart: Date.now(),
        periodEnd: Date.now() + 30 * DAY,
        interval: 'month',
        kind: 'gift_redemption',
        giftDurationMonths: 1,
        createdAt: Date.now(),
        hostedInvoiceUrl: 'https://invoice.stripe.com/i/gift-example',
      },
    ],
  },
};

export const PromotionalPlusSetupPending: Story = {
  args: {
    overview: {
      ...paidOverview,
      entitlementSource: 'stripe_gift',
      promotionalEntitlementEndsAt: Date.now() + 30 * DAY,
      giftStartsAt: Date.now(),
      giftEndsAt: Date.now() + 30 * DAY,
      scheduleManaged: true,
      subscriptionSetupPending: true,
      checkoutInterval: 'year',
      currentPeriodEnd: Date.now() + 30 * DAY,
    },
  },
};

export const PromotionalPlusResumableLockedPrice: Story = {
  args: {
    overview: {
      ...paidOverview,
      entitlementSource: 'stripe_gift',
      offerKey: 'founder_monthly_500_forever',
      promotionalEntitlementEndsAt: Date.now() + 30 * DAY,
      giftStartsAt: Date.now() - 10 * DAY,
      giftEndsAt: Date.now() + 30 * DAY,
      scheduleManaged: true,
      canResumeAfterGift: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: Date.now() + 30 * DAY,
    },
  },
};

/* Next-charge preview at the top of the history: renewal for 3 seats plus a
   proration line from a member accepted mid-cycle. */
export const PaidWithUpcomingInvoice: Story = {
  args: {
    overview: paidOverview,
    invoices: mockInvoices,
    upcomingInvoice: {
      amountDue: 3998,
      currency: 'USD',
      expectedAt: Date.now() + 21 * DAY,
      renewal: { amount: 3000, quantity: 3 },
      discount: null,
      adjustment: { amount: 998 },
      creditApplied: null,
    },
  },
};

/* Account credit defers billing: the next charge lands months out, not next
   month at $0. Renewal minus the leftover credit applied at that charge. */
export const PaidWithCreditDeferredCharge: Story = {
  args: {
    overview: { ...paidOverview, billingInterval: 'month' },
    invoices: mockInvoices,
    upcomingInvoice: {
      amountDue: 2000,
      currency: 'USD',
      expectedAt: Date.now() + 250 * DAY,
      renewal: { amount: 2000, quantity: 2 },
      discount: null,
      adjustment: null,
      creditApplied: null,
    },
  },
};

/* Yearly plan: the switch button flips to "Switch to monthly". */
export const PaidYearly: Story = {
  args: {
    overview: { ...paidOverview, billingInterval: 'year' },
    invoices: mockInvoices,
  },
};

export const PaidYearlyEarlyBirdUpcomingInvoice: Story = {
  args: {
    overview: {
      ...paidOverview,
      billingInterval: 'year',
      offerKey: 'early_bird_yearly_6000_forever',
      yearlyEarlyBirdEligible: true,
      pricing: {
        ...paidOverview.pricing,
        yearlyAmountCents: 6000,
        yearlyOfferKey: 'early_bird_yearly_6000_forever',
      },
    },
    invoices: mockInvoices,
    upcomingInvoice: {
      amountDue: 6000,
      currency: 'USD',
      expectedAt: Date.now() + 365 * DAY,
      renewal: { amount: 9600, quantity: 1 },
      discount: { amount: -3600 },
      adjustment: null,
      creditApplied: null,
    },
  },
};

/* Interval switch request in flight. */
export const PaidSwitchIntervalPending: Story = {
  args: { overview: paidOverview, invoices: mockInvoices, switchIntervalPending: true },
};

/* Cancel scheduled: the cancel button is replaced by "Resume subscription"
   and the cancelAtPeriodEnd badge shows on the plan. */
export const PaidCanceling: Story = {
  args: { overview: { ...paidOverview, cancelAtPeriodEnd: true }, invoices: mockInvoices },
};

/* Cancel/resume request in flight: both buttons render disabled with a
   spinner. */
export const PaidCancelPending: Story = {
  args: { overview: paidOverview, invoices: mockInvoices, cancelPending: true },
};

export const PaidPastDue: Story = {
  args: { overview: { ...paidOverview, subscriptionStatus: 'past_due' }, invoices: mockInvoices },
};

export const PaidHistoryLoading: Story = {
  args: { overview: paidOverview, invoices: undefined },
};

export const PaidHistoryEmpty: Story = {
  args: { overview: paidOverview, invoices: [] },
};

export const PaidHistoryError: Story = {
  args: { overview: paidOverview, invoices: undefined, invoicesError: true },
};

/* Returned from a successful Stripe checkout while the subscription is
   still being activated (reconcile in flight / webhook lag). */
export const PaymentProcessing: Story = {
  args: {
    overview: {
      ...freeOverview,
      billingAccountId: 'ba_pending',
      checkoutPending: true,
      checkoutInterval: 'year',
    },
    paymentProcessing: true,
  },
};

export const Enterprise: Story = {
  args: {
    overview: {
      ...paidOverview,
      effectivePlanTier: 'enterprise',
      entitlementSource: 'enterprise',
    },
  },
};

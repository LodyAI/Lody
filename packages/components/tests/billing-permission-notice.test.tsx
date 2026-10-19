// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import {
  BillingSettingsView,
  formatDate,
  type BillingOverviewData,
  type BillingSettingsViewProps,
} from '../src/components/settings/billing-setting-pure';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
  seatCount: 3,
  canManageBilling: true,
  pricing: {
    monthlyAmountCents: 1000,
    yearlyAmountCents: 9600,
    monthlyOfferKey: null,
    yearlyOfferKey: null,
  },
};

describe('BillingSettingsView', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  async function renderView(overrides: Partial<BillingSettingsViewProps>) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const props: BillingSettingsViewProps = {
      overview: freeOverview,
      sessionCount: 2,
      interval: 'year',
      pendingAction: null,
      redeemPending: false,
      cancelPending: false,
      invoices: undefined,
      invoicesError: false,
      paymentProcessing: false,
      onIntervalChange: () => {},
      onUpgrade: () => {},
      onSwitchInterval: () => {},
      switchIntervalPending: false,
      onCancelSubscription: () => {},
      onResumeSubscription: () => {},
      onRedeemCode: () => {},
      onRetryInvoices: () => {},
      ...overrides,
    };

    await act(async () => {
      root?.render(createElement(BillingSettingsView, props));
    });
  }

  function upgradeButton(): HTMLButtonElement | undefined {
    return Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Upgrade now')
    ) as HTMLButtonElement | undefined;
  }

  function planNameText(): string | undefined {
    return Array.from(container?.querySelectorAll('p') ?? [])
      .map((paragraph) => paragraph.textContent?.trim())
      .find((text) => text === 'Free' || text === 'Plus' || text === 'Enterprise');
  }

  it('shows the activating Plus plan instead of falling back to Free after checkout', async () => {
    await renderView({ overview: freeOverview, paymentProcessing: true });

    expect(planNameText()).toBe('Plus');
    expect(container?.textContent).toContain('Payment received');
    // The upgrade offer overlaps the activation banner; it must not offer a
    // second checkout while the first one is still awaiting confirmation.
    expect(upgradeButton()).toBeUndefined();
  });

  it.each([true, false])(
    'gates changing cards on billing permission (%s)',
    async (canManageBilling) => {
      let opened = 0;
      await renderView({
        overview: {
          ...freeOverview,
          billingAccountId: 'billing_1',
          effectivePlanTier: 'plus',
          entitlementSource: 'stripe',
          canManageBilling,
        },
        onPaymentMethod: () => {
          opened += 1;
        },
      });
      const button = Array.from(container!.querySelectorAll('button')).find(
        (item) => item.textContent === 'Change payment method'
      );
      expect(Boolean(button)).toBe(canManageBilling);
      if (button) {
        await act(async () => button.click());
        expect(opened).toBe(1);
      }
    }
  );

  it('disables the payment method action while opening Stripe', async () => {
    await renderView({
      overview: {
        ...freeOverview,
        billingAccountId: 'billing_1',
        effectivePlanTier: 'plus',
        entitlementSource: 'stripe',
      },
      pendingAction: 'portal',
      onPaymentMethod: () => {},
    });
    const button = Array.from(container!.querySelectorAll('button')).find(
      (item) => item.textContent === 'Opening…'
    );
    expect(button?.disabled).toBe(true);
  });

  it.each(['month', 'year'] as const)(
    'shows the same dated plan summary for paid Plus (%s)',
    async (billingInterval) => {
      const currentPeriodEnd = Date.UTC(2030, 0, 25);
      await renderView({
        overview: {
          ...freeOverview,
          billingAccountId: 'billing_paid',
          effectivePlanTier: 'plus',
          entitlementSource: 'stripe',
          billingInterval,
          currentPeriodEnd,
        },
        invoices: [],
      });

      expect(planNameText()).toBe('Plus');
      expect(container?.textContent).toContain('Next renewal');
      expect(container?.textContent).toContain(formatDate(currentPeriodEnd));
      expect(container?.textContent).toContain(billingInterval === 'year' ? 'Yearly' : 'Monthly');
      expect(container?.textContent).not.toContain('Gift access until');
    }
  );

  it('labels a canceled paid plan with its access end date instead of a renewal', async () => {
    const currentPeriodEnd = Date.UTC(2030, 0, 25);
    await renderView({
      overview: {
        ...freeOverview,
        billingAccountId: 'billing_paid',
        effectivePlanTier: 'plus',
        entitlementSource: 'stripe',
        billingInterval: 'month',
        currentPeriodEnd,
        cancelAtPeriodEnd: true,
      },
      invoices: [],
    });

    expect(container?.textContent).toContain('Access ends');
    expect(container?.textContent).toContain(formatDate(currentPeriodEnd));
    expect(container?.textContent).not.toContain('Next renewal');
  });

  it('keeps the free plan on its status message', async () => {
    await renderView({ overview: freeOverview });
    expect(planNameText()).toBe('Free');
    expect(container?.textContent).not.toContain('Next renewal');
  });

  it('keeps a pending paid checkout on its status message', async () => {
    await renderView({
      overview: {
        ...freeOverview,
        billingAccountId: 'billing_pending',
        checkoutPending: true,
        checkoutInterval: 'year',
        currentPeriodEnd: Date.UTC(2030, 0, 25),
      },
      invoices: [],
    });

    expect(planNameText()).toBe('Plus');
    expect(container?.textContent).toContain('Checkout required');
    expect(container?.textContent).not.toContain('Next renewal');
  });

  it('shows the amount and reason for billing scheduled after a gift', async () => {
    const nextBillingAt = Date.UTC(2030, 0, 25);
    await renderView({
      overview: {
        ...freeOverview,
        billingAccountId: 'billing_gift',
        effectivePlanTier: 'plus',
        entitlementSource: 'stripe_gift',
        promotionalEntitlementEndsAt: nextBillingAt,
        giftStartsAt: Date.UTC(2029, 9, 25),
        giftEndsAt: nextBillingAt,
        nextBillingAt,
        autoRenewAfterGift: true,
        scheduledBillingInterval: 'month',
        scheduleManaged: true,
        billingInterval: 'month',
        currentPeriodEnd: nextBillingAt,
        seatCount: 2,
      },
      invoices: [],
      upcomingInvoice: {
        amountDue: 2000,
        currency: 'USD',
        expectedAt: nextBillingAt,
        renewal: { amount: 2000, quantity: 2 },
        discount: null,
        adjustment: null,
        creditApplied: null,
      },
    });

    expect(container?.textContent).toContain('Next charge (estimated)');
    expect(container?.textContent).toContain('First charge after gift');
    expect(container?.textContent).toContain(formatDate(nextBillingAt));
    expect(container?.textContent).toContain('Estimated amount');
    expect(container?.textContent).toContain('$20');
    expect(container?.textContent).toContain('Plus after the gift · monthly · 2 seats');
  });

  it('shows the reliable billing date without guessing an unavailable post-gift amount', async () => {
    const nextBillingAt = Date.UTC(2030, 0, 25);
    await renderView({
      overview: {
        ...freeOverview,
        billingAccountId: 'billing_gift',
        effectivePlanTier: 'plus',
        entitlementSource: 'stripe_gift',
        promotionalEntitlementEndsAt: nextBillingAt,
        giftStartsAt: Date.UTC(2029, 9, 25),
        giftEndsAt: nextBillingAt,
        nextBillingAt,
        autoRenewAfterGift: true,
        scheduledBillingInterval: 'month',
        scheduleManaged: true,
        billingInterval: 'month',
        currentPeriodEnd: nextBillingAt,
      },
      invoices: [],
      upcomingInvoice: null,
    });

    expect(container?.textContent).toContain('First charge after gift');
    expect(container?.textContent).toContain(formatDate(nextBillingAt));
    expect(container?.textContent).toContain('Amount pending');
    expect(container?.textContent).toContain(
      'The first monthly Plus charge starts after the gift period.'
    );
  });

  it('does not present a gift-period $0 invoice as the first paid charge', async () => {
    const nextBillingAt = Date.UTC(2030, 0, 25);
    await renderView({
      overview: {
        ...freeOverview,
        billingAccountId: 'billing_gift',
        effectivePlanTier: 'plus',
        entitlementSource: 'stripe_gift',
        promotionalEntitlementEndsAt: nextBillingAt,
        giftStartsAt: Date.UTC(2029, 9, 25),
        giftEndsAt: nextBillingAt,
        nextBillingAt,
        autoRenewAfterGift: true,
        scheduledBillingInterval: 'month',
        scheduleManaged: true,
      },
      invoices: [],
      upcomingInvoice: {
        amountDue: 0,
        currency: 'USD',
        expectedAt: Date.UTC(2029, 11, 25),
        renewal: { amount: 0, quantity: 2 },
        discount: null,
        adjustment: null,
        creditApplied: null,
      },
    });

    expect(container?.textContent).toContain('First charge after gift');
    expect(container?.textContent).toContain(formatDate(nextBillingAt));
    expect(container?.textContent).toContain('Amount pending');
    expect(container?.textContent).not.toContain('Estimated amount');
    expect(container?.textContent).not.toContain('Plus after the gift · monthly · 2 seats');
  });

  it('does not imply a future charge when post-gift billing is not scheduled', async () => {
    await renderView({
      overview: {
        ...freeOverview,
        billingAccountId: 'billing_gift',
        effectivePlanTier: 'plus',
        entitlementSource: 'stripe_gift',
        promotionalEntitlementEndsAt: Date.UTC(2030, 0, 25),
        giftStartsAt: Date.UTC(2029, 9, 25),
        giftEndsAt: Date.UTC(2030, 0, 25),
        scheduleManaged: true,
      },
      invoices: [],
      upcomingInvoice: null,
    });

    expect(container?.textContent).not.toContain('Next charge (estimated)');
  });

  it('offers the upgrade action to a viewer who can manage billing', async () => {
    await renderView({});

    expect(upgradeButton()?.disabled).toBe(false);
    expect(container?.textContent).not.toContain("You can't upgrade this workspace");
  });

  it('explains why a member cannot upgrade and who to ask', async () => {
    await renderView({
      overview: { ...freeOverview, canManageBilling: false },
      workspaceOwnerName: 'Ada Lovelace',
    });

    expect(upgradeButton()).toBeUndefined();
    expect(container?.textContent).toContain("You can't upgrade this workspace");
    expect(container?.textContent).toContain('Ask Ada Lovelace to upgrade this workspace.');
  });

  it('falls back to the generic reason when the owner is unknown', async () => {
    await renderView({
      overview: { ...freeOverview, canManageBilling: false },
      workspaceOwnerName: null,
    });

    expect(container?.textContent).toContain("You can't upgrade this workspace");
    expect(container?.textContent).toContain(
      'Only workspace owners and admins can manage billing.'
    );
  });

  it('keeps the action disabled instead of denying permission before the role is known', async () => {
    await renderView({
      overview: { ...freeOverview, canManageBilling: false },
      canManageBillingKnown: false,
    });

    expect(upgradeButton()?.disabled).toBe(true);
    expect(container?.textContent).not.toContain("You can't upgrade this workspace");
  });

  it('lets a paid Plus admin apply a gift code', async () => {
    await renderView({
      overview: {
        ...freeOverview,
        billingAccountId: 'billing_1',
        effectivePlanTier: 'plus',
        entitlementSource: 'stripe',
        subscriptionStatus: 'active',
        billingInterval: 'month',
        currentPeriodEnd: Date.now() + 30 * 86400_000,
      },
    });

    expect(container?.textContent).toContain('Apply a Plus gift code');
    expect(container?.querySelector('#billing-redemption-code')).not.toBeNull();
  });

  it('does not expose paid stacking before the backend advertises support', async () => {
    await renderView({
      overview: {
        ...freeOverview,
        billingAccountId: 'billing_1',
        giftStackingSupported: false,
        effectivePlanTier: 'plus',
        entitlementSource: 'stripe',
        subscriptionStatus: 'active',
        billingInterval: 'month',
      },
    });

    expect(container?.textContent).not.toContain('Apply a Plus gift code');
  });

  it('offers deferred billing during an active gift without claiming an immediate charge', async () => {
    const giftEnd = Date.now() + 30 * 86400_000;
    await renderView({
      overview: {
        ...freeOverview,
        billingAccountId: 'billing_1',
        effectivePlanTier: 'plus',
        entitlementSource: 'stripe_gift',
        promotionalEntitlementEndsAt: giftEnd,
        giftStartsAt: Date.now(),
        giftEndsAt: giftEnd,
        scheduleManaged: true,
        subscriptionStatus: 'active',
        billingInterval: 'month',
        currentPeriodEnd: giftEnd,
      },
    });

    expect(container?.textContent).toContain('Keep Plus after the gift ends');
    expect(container?.textContent).toContain('The first charge is on');
    expect(container?.textContent).toContain('Subscribe after gift');
  });

  it('restores a prior paid phase instead of replacing its locked price with Setup', async () => {
    const giftEnd = Date.now() + 30 * 86400_000;
    await renderView({
      overview: {
        ...freeOverview,
        billingAccountId: 'billing_1',
        effectivePlanTier: 'plus',
        entitlementSource: 'stripe_gift',
        promotionalEntitlementEndsAt: giftEnd,
        giftEndsAt: giftEnd,
        scheduleManaged: true,
        canResumeAfterGift: true,
        cancelAtPeriodEnd: true,
        subscriptionStatus: 'active',
        billingInterval: 'month',
        currentPeriodEnd: giftEnd,
      },
    });

    expect(container?.textContent).toContain('Resume subscription');
    expect(container?.textContent).not.toContain('Keep Plus after the gift ends');
    expect(container?.textContent).not.toContain('Subscribe after gift');
  });
});

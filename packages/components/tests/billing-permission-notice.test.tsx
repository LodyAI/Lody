// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import {
  BillingSettingsView,
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

describe('BillingSettingsView upgrade permission', () => {
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

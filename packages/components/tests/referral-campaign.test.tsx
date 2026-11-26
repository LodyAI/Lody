// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReferralPolicyRefresh } from '../src/hooks/use-referral-policy-refresh';
import {
  ReferralOfferNotice,
  ReferralSettingsView,
} from '../src/components/settings/referral-settings-pure';
import { BillingSettingsView } from '../src/components/settings/billing-setting-pure';
import { OPTIMISTIC_BILLING_OVERVIEW } from '../src/components/settings/billing-overview-cache';
import { initI18n } from '../src/i18n';

const clock = vi.hoisted(() => ({ now: 1000 }));
vi.mock('@lody/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lody/shared')>()),
  getServerNow: () => clock.now,
}));
let root: Root, container: HTMLDivElement;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initI18n('en');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  clock.now = 1000;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('campaign checkout display', () => {
  it('compares improved campaign terms with struck-through standard terms and clears them afterward', async () => {
    await initI18n('zh_CN');
    const overview = {
      eligible: true,
      code: null,
      url: null,
      issued: 0,
      spent: 0,
      available: 0,
      frozen: 0,
      adjustment: 0,
      newcomerDiscount: false,
    };
    const render = async (discountPercent: number, rewardPercent: number) => {
      await act(async () =>
        root.render(
          <ReferralSettingsView
            overview={{
              ...overview,
              policy: { campaignId: 'example', discountPercent, rewardPercent },
            }}
            canManage={false}
            onCopy={() => {}}
            onOpenDetails={() => {}}
          />
        )
      );
    };
    await render(20, 25);
    expect(Array.from(container.querySelectorAll('s'), (el) => el.textContent)).toEqual([
      '9 折',
      '20%',
    ]);
    expect(Array.from(container.querySelectorAll('strong'), (el) => el.textContent)).toEqual([
      '8 折',
      '25%',
    ]);
    await render(10, 25);
    expect(Array.from(container.querySelectorAll('s'), (el) => el.textContent)).toEqual(['20%']);
    await render(10, 20);
    expect(container.querySelector('s')).toBeNull();
    expect(container.textContent).toContain('对方首单 9 折，你获得该笔实付的 20% 作为奖励金。');
  });
  it('shows the first annual payment at $76.80 and keeps the regular renewal at $96', async () => {
    await act(async () =>
      root.render(
        <ReferralOfferNotice
          interval="year"
          regularCents={9600}
          policy={{
            campaignId: 'autumn',
            discountPercent: 20,
            rewardPercent: 25,
            startsAt: Date.UTC(2026, 9, 23, 16),
            endsAt: Date.UTC(2026, 9, 28, 16),
          }}
        />
      )
    );
    expect(container.textContent).toContain('20% off');
    expect(container.textContent).toContain('$76.80');
    expect(container.textContent).toContain('then $96/year');
    expect(container.textContent).toContain('Campaign: 10/24/2026–10/28/2026');
    await act(async () => {
      await initI18n('zh_CN');
    });
    expect(container.textContent).toContain('活动时间：2026/10/24 至 2026/10/28');
  });
  it('distinguishes retained checkout pricing from a new order after the campaign', async () => {
    await act(async () =>
      root.render(
        <ReferralOfferNotice
          interval="year"
          regularCents={9600}
          retained={{
            policy: { campaignId: 'autumn', discountPercent: 20, rewardPercent: 25 },
            expiresAt: 10000,
          }}
        />
      )
    );
    expect(container.textContent).toContain('existing checkout keeps 20% off');
    expect(container.textContent).toContain('$86.40');
  });
  it('picks max(promotional, referral) discount on the upgrade card and badges monthly-to-yearly upgrades', async () => {
    const baseProps = {
      sessionCount: 5,
      interval: 'year' as const,
      pendingAction: null,
      redeemPending: false,
      cancelPending: false,
      invoices: [],
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
      referralCreditCents: 2000,
    };
    const promoPolicy = {
      campaignId: 'bf-2026',
      startsAt: Date.UTC(2026, 10, 25, 16),
      endsAt: Date.UTC(2026, 10, 30, 16),
      monthly: { discountPercent: 20 },
      yearly: { discountPercent: 20 },
      upgradeToYearly: true,
      seatExpansion: true,
    };

    // Holiday 20% beats default 10% referral, and suppresses wallet credit on Checkout.
    await act(async () =>
      root.render(
        <BillingSettingsView
          {...baseProps}
          overview={{
            ...OPTIMISTIC_BILLING_OVERVIEW,
            canManageBilling: true,
            pricing: {
              ...OPTIMISTIC_BILLING_OVERVIEW.pricing,
              promo: {
                policy: promoPolicy,
                yearlyDiscountPercent: 20,
                monthlyDiscountPercent: 20,
              },
            },
          }}
          referralOffer={{
            policy: { campaignId: 'standard', discountPercent: 10, rewardPercent: 20 },
            onRemove: () => {},
          }}
        />
      )
    );
    expect(container.textContent).toContain('Promotional discount');
    expect(container.textContent).toContain('$76.80');
    expect(container.textContent).not.toContain('Referral credit applied');

    // Referral 25% campaign beats Holiday 20%.
    await act(async () =>
      root.render(
        <BillingSettingsView
          {...baseProps}
          overview={{
            ...OPTIMISTIC_BILLING_OVERVIEW,
            canManageBilling: true,
            pricing: {
              ...OPTIMISTIC_BILLING_OVERVIEW.pricing,
              promo: {
                policy: promoPolicy,
                yearlyDiscountPercent: 20,
                monthlyDiscountPercent: 20,
              },
            },
          }}
          referralOffer={{
            policy: { campaignId: 'ref-25', discountPercent: 25, rewardPercent: 25 },
            onRemove: () => {},
          }}
        />
      )
    );
    expect(container.textContent).toContain('Referral discount');
    expect(container.textContent).toContain('$72');

    // Active monthly subscriber sees the upgrade discount badge beside Switch to yearly.
    await act(async () =>
      root.render(
        <BillingSettingsView
          {...baseProps}
          overview={{
            ...OPTIMISTIC_BILLING_OVERVIEW,
            billingAccountId: 'ba_1',
            canManageBilling: true,
            effectivePlanTier: 'plus',
            entitlementSource: 'stripe',
            subscriptionStatus: 'active',
            billingInterval: 'month',
            currentPeriodEnd: Date.UTC(2026, 11, 15),
            pricing: {
              ...OPTIMISTIC_BILLING_OVERVIEW.pricing,
              promo: {
                policy: promoPolicy,
                upgradeToYearlyDiscountPercent: 20,
              },
            },
          }}
        />
      )
    );
    expect(container.textContent).toContain('Switch to yearly');
    expect(container.textContent).toContain('20% off');
  });
});

describe('policy boundary refresh', () => {
  function Probe({ next }: { next?: number }) {
    const [generation, refresh] = useState(0);
    useReferralPolicyRefresh(next, refresh);
    return <span>{generation}</span>;
  }
  it('retries when the client clock reached a boundary before the server, and stops after the server changes it', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<Probe next={2000} />));
    clock.now = 2000;
    await act(async () => vi.advanceTimersByTime(1000));
    expect(container.textContent).toBe('1');
    // Server response still has the same deadline; its next clock tick must retry.
    await act(async () => root.render(<Probe next={2000} />));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(container.textContent).toBe('2');
    await act(async () => root.render(<Probe />));
    await act(async () => vi.advanceTimersByTime(5000));
    expect(container.textContent).toBe('2');
  });
  it('revalidates a retained session deadline on focus after suspension and cleans listeners on unmount', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<Probe next={3000} />));
    clock.now = 4000;
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.textContent).toBe('1');
    await act(async () => root.render(<Probe next={Infinity} />));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.textContent).toBe('1');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OPTIMISTIC_BILLING_OVERVIEW,
  readBillingOverviewCache,
  reconcileBillingOverview,
  writeBillingOverviewCache,
} from '../src/components/settings/billing-overview-cache';
import type { BillingOverviewData } from '../src/components/settings/billing-setting-pure';
import {
  clearBillingCheckoutReturn,
  isBillingActivationSettled,
  markBillingCheckoutReturn,
  readBillingCheckoutReturn,
} from '../src/components/settings/billing-checkout-return';

describe('billing-overview-cache', () => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'localStorage'
  );

  function installWindowStorage() {
    const store = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (key) => store.get(key) ?? null,
      key: (index) => Array.from(store.keys())[index] ?? null,
      removeItem: (key) => store.delete(key),
      setItem: (key, value) => store.set(key, value),
    };
    Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  }

  function overview(patch: Partial<BillingOverviewData> = {}): BillingOverviewData {
    return {
      ...OPTIMISTIC_BILLING_OVERVIEW,
      canManageBilling: true,
      ...patch,
      pricing: {
        ...OPTIMISTIC_BILLING_OVERVIEW.pricing,
        ...patch.pricing,
      },
    };
  }

  beforeEach(installWindowStorage);

  afterEach(() => {
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
    if (originalLocalStorageDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorageDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  describe('billing overview cache', () => {
    it('restores a valid snapshot only for the same authenticated session', () => {
      const value = overview({ seatCount: 3 });
      writeBillingOverviewCache('workspace-1', 'session-1', value);

      expect(readBillingOverviewCache('workspace-1', 'session-1')).toEqual(value);
      expect(readBillingOverviewCache('workspace-1', 'session-2')).toBeNull();
      expect(readBillingOverviewCache('workspace-1', null)).toBeNull();
    });

    it('defaults timeline fields when reading a cache written by an older client', () => {
      const legacyOverview = overview();
      const rawOverview = { ...legacyOverview } as Record<string, unknown>;
      for (const field of [
        'giftStackingSupported',
        'referralRewardsSupported',
        'giftStartsAt',
        'giftEndsAt',
        'nextBillingAt',
        'autoRenewAfterGift',
        'canResumeAfterGift',
        'scheduledBillingInterval',
        'scheduleManaged',
        'subscriptionSetupPending',
      ]) {
        delete rawOverview[field];
      }
      // Older clients cached the retired yearly early-bird flag.
      rawOverview.yearlyEarlyBirdEligible = true;
      localStorage.setItem(
        'lody:billingOverview',
        JSON.stringify({
          'workspace-1': { authSessionId: 'session-1', overview: rawOverview },
        })
      );

      expect(readBillingOverviewCache('workspace-1', 'session-1')).toMatchObject({
        giftStackingSupported: false,
        referralRewardsSupported: false,
        giftStartsAt: null,
        giftEndsAt: null,
        nextBillingAt: null,
        autoRenewAfterGift: false,
        canResumeAfterGift: false,
        scheduledBillingInterval: null,
        scheduleManaged: false,
        subscriptionSetupPending: false,
      });
      expect(readBillingOverviewCache('workspace-1', 'session-1')).not.toHaveProperty(
        'yearlyEarlyBirdEligible'
      );
    });
  });

  describe('billing overview reconciliation', () => {
    it('refreshes server referral availability even when all other billing fields match', () => {
      const current = overview({ referralRewardsSupported: false });
      const enabled = overview({ referralRewardsSupported: true });
      expect(reconcileBillingOverview(current, enabled)).toBe(enabled);
      writeBillingOverviewCache('workspace-1', 'session-1', enabled);
      expect(readBillingOverviewCache('workspace-1', 'session-1')?.referralRewardsSupported).toBe(
        true
      );
    });

    it('keeps first-visit billing actions disabled until permissions are confirmed', () => {
      expect(OPTIMISTIC_BILLING_OVERVIEW.canManageBilling).toBe(false);
    });
  });
});

describe('billing-checkout-return', () => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

  function installWindowSessionStorage() {
    const store = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (key) => store.get(key) ?? null,
      key: (index) => Array.from(store.keys())[index] ?? null,
      removeItem: (key) => store.delete(key),
      setItem: (key, value) => store.set(key, value),
    };
    Object.defineProperty(globalThis, 'window', {
      value: { sessionStorage: storage },
      configurable: true,
    });
  }

  beforeEach(installWindowSessionStorage);

  afterEach(() => {
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  describe('billing checkout return marker', () => {
    it('keeps a marker per workspace and clears it explicitly', () => {
      markBillingCheckoutReturn('workspace-1', 1_000);
      expect(readBillingCheckoutReturn('workspace-1', 2_000)).toBe(1_000);
      expect(readBillingCheckoutReturn('workspace-2', 2_000)).toBeNull();

      clearBillingCheckoutReturn('workspace-1');
      expect(readBillingCheckoutReturn('workspace-1', 2_000)).toBeNull();
    });

    it('drops a marker older than the Stripe session lifetime instead of confirming forever', () => {
      const now = 100 * 24 * 60 * 60 * 1000;
      markBillingCheckoutReturn('workspace-1', now - 25 * 60 * 60 * 1000);

      expect(readBillingCheckoutReturn('workspace-1', now)).toBeNull();
      // The stale entry is removed, not just hidden.
      expect(readBillingCheckoutReturn('workspace-1', now - 24 * 60 * 60 * 1000 + 1)).toBeNull();
    });
  });

  describe('billing activation settlement', () => {
    const base = {
      effectivePlanTier: 'free' as const,
      entitlementSource: 'free' as const,
      checkoutPending: false,
      subscriptionSetupPending: false,
      autoRenewAfterGift: false,
    };

    it('stays pending for a free workspace and until gift setup lands', () => {
      expect(isBillingActivationSettled(base)).toBe(false);
      expect(
        isBillingActivationSettled({
          ...base,
          effectivePlanTier: 'plus',
          entitlementSource: 'stripe_gift',
        })
      ).toBe(false);
      expect(
        isBillingActivationSettled({
          ...base,
          effectivePlanTier: 'plus',
          entitlementSource: 'stripe_gift',
          autoRenewAfterGift: true,
          checkoutPending: true,
        })
      ).toBe(false);
      expect(isBillingActivationSettled({ ...base, effectivePlanTier: 'plus' })).toBe(true);
      // A gift member keeps Plus the whole time, so the tier alone cannot settle it.
      expect(
        isBillingActivationSettled({
          ...base,
          effectivePlanTier: 'plus',
          subscriptionSetupPending: true,
        })
      ).toBe(false);
    });

    it('settles once the scheduled renewal exists or a paid tier lands', () => {
      expect(
        isBillingActivationSettled({
          ...base,
          effectivePlanTier: 'plus',
          entitlementSource: 'stripe_gift',
          autoRenewAfterGift: true,
        })
      ).toBe(true);
      expect(isBillingActivationSettled({ ...base, effectivePlanTier: 'enterprise' })).toBe(true);
      expect(isBillingActivationSettled(null)).toBe(false);
    });
  });
});

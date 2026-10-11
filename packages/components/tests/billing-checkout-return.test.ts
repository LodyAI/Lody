import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearBillingCheckoutReturn,
  isBillingActivationSettled,
  markBillingCheckoutReturn,
  readBillingCheckoutReturn,
} from '../src/components/settings/billing-checkout-return';

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

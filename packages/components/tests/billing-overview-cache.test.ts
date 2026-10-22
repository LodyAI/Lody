import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OPTIMISTIC_BILLING_OVERVIEW,
  readBillingOverviewCache,
  reconcileBillingOverview,
  writeBillingOverviewCache,
} from '../src/components/settings/billing-overview-cache';
import type { BillingOverviewData } from '../src/components/settings/billing-setting-pure';

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

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

  it('rejects malformed persisted data instead of rendering it', () => {
    localStorage.setItem(
      'lody:billingOverview',
      JSON.stringify({
        'workspace-1': {
          authSessionId: 'session-1',
          overview: { effectivePlanTier: 'enterprise' },
        },
      })
    );

    expect(readBillingOverviewCache('workspace-1', 'session-1')).toBeNull();
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
  });
});

describe('billing overview reconciliation', () => {
  it('keeps the displayed object stable when the fetched value is unchanged', () => {
    const current = overview({ seatCount: 3 });
    const equalFetch = overview({ seatCount: 3 });

    expect(reconcileBillingOverview(current, equalFetch)).toBe(current);
  });

  it('uses the fetched value when a field changed', () => {
    const current = overview({ seatCount: 3 });
    const changedFetch = overview({ seatCount: 4 });

    expect(reconcileBillingOverview(current, changedFetch)).toBe(changedFetch);
  });

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

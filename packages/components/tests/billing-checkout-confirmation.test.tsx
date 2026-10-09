// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, Provider as JotaiProvider } from 'jotai';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  createStaticStore,
  type PlatformProvider,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({ authSessionId: 'session-1' }),
}));

vi.mock('@/providers/convex-provider', () => ({
  useAuthClient: () => ({ useActiveOrganization: () => ({ data: null }) }),
}));
vi.mock('../src/providers/convex-provider', () => ({
  useAuthClient: () => ({ useActiveOrganization: () => ({ data: null }) }),
}));

vi.mock('@/lib/electron', () => ({ isElectronRenderer: () => false }));
vi.mock('@/lib/native-browser', () => ({ openExternalUrl: vi.fn(async () => true) }));
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms';
import {
  markBillingCheckoutReturn,
  readBillingCheckoutReturn,
} from '../src/components/settings/billing-checkout-return';
import {
  OPTIMISTIC_BILLING_OVERVIEW,
  writeBillingOverviewCache,
} from '../src/components/settings/billing-overview-cache';
import { BillingSettingsComponent } from '../src/components/settings/billing-setting';
import type { BillingOverviewData } from '../src/components/settings/billing-setting-pure';
import { initI18n } from '../src/i18n';

function overview(patch: Partial<BillingOverviewData> = {}): BillingOverviewData {
  return {
    ...OPTIMISTIC_BILLING_OVERVIEW,
    canManageBilling: true,
    ...patch,
    pricing: { ...OPTIMISTIC_BILLING_OVERVIEW.pricing, ...patch.pricing },
  };
}

type OverviewRef = { current: BillingOverviewData | undefined };
type Reconcile = () => Promise<{ status: 'none' | 'pending' | 'paid' | 'expired' }>;

function createPlatform(overviewRef: OverviewRef, reconcile: Reconcile): PlatformProvider {
  return {
    kind: 'cloud',
    identity: {
      session: createStaticStore({ status: 'unauthenticated' }),
      signOut: async () => {},
    },
    workspaces: {
      state: createStaticStore({
        status: 'ready' as const,
        workspaces: [],
        activeWorkspaceId: null,
      }),
      setActive: async () => {},
    },
    capabilities: CLOUD_PLATFORM_CAPABILITIES,
    cloudApi: {
      useQuery: (operation: { name: string }) =>
        operation.name === 'billing:getBillingOverview' ? overviewRef.current : undefined,
      useAction: (operation: { name: string }) => {
        if (operation.name === 'billing:reconcileWorkspaceCheckout') {
          return reconcile;
        }
        if (operation.name === 'billing:listBillingInvoices') {
          return async () => ({ invoices: [], upcoming: null });
        }
        return async () => null;
      },
      useMutation: () => async () => null,
    } as unknown as PlatformProvider['cloudApi'],
    sync: { mode: 'cloud' },
  };
}

describe('billing checkout return confirmation', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/acme/settings/billing');
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.useRealTimers();
  });

  async function renderBilling(
    overviewRef: OverviewRef,
    reconcile: Reconcile = async () => ({ status: 'pending' })
  ) {
    const platform = createPlatform(overviewRef, reconcile);
    const store = createStore();
    store.set(currentWorkspaceIdAtom, 'workspace-1');
    store.set(currentWorkspaceSlugAtom, 'acme');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const rerender = async () =>
      act(async () => {
        root?.render(
          createElement(
            JotaiProvider,
            { store },
            createElement(
              PlatformContext.Provider,
              { value: platform },
              createElement(BillingSettingsComponent)
            )
          )
        );
      });
    await rerender();
    return rerender;
  }

  it('keeps the activating Plus state across a transient reconcile miss, then settles', async () => {
    window.history.replaceState({}, '', '/acme/settings/billing?checkout=success');
    const live: OverviewRef = { current: overview() };
    let linked = false;
    const rerender = await renderBilling(live, async () => {
      if (!linked) return { status: 'none' };
      live.current = overview({ effectivePlanTier: 'plus', entitlementSource: 'stripe' });
      return { status: 'paid' };
    });

    // First immediate reconcile misses; the page must stay on the activation
    // state instead of dropping to the pre-checkout free overview.
    expect(container!.textContent).toContain('Plus');
    expect(container!.textContent).toContain('Payment received');

    // The retry lands a paid subscription.
    linked = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    await rerender();
    expect(container!.textContent).not.toContain('Payment received');
    expect(container!.textContent).toContain('Plus');
    expect(readBillingCheckoutReturn('workspace-1')).toBeNull();
  });

  it('pretends nothing happened when the return says the checkout was canceled', async () => {
    markBillingCheckoutReturn('workspace-1', Date.now());
    window.history.replaceState({}, '', '/acme/settings/billing?checkout=canceled');
    await renderBilling({ current: overview() });

    expect(container!.textContent).not.toContain('Payment received');
    expect(readBillingCheckoutReturn('workspace-1')).toBeNull();
  });

  it('keeps unpaid checkout available during and after the background check, including remount', async () => {
    let resolve!: (result: { status: 'pending' }) => void;
    await renderBilling(
      { current: overview({ checkoutPending: true }) },
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const expectCheckoutAvailable = () => {
      const button = Array.from(container!.querySelectorAll('button')).find((item) =>
        item.textContent?.includes('Continue checkout')
      );
      expect(button).toBeDefined();
      expect(button!.disabled).toBe(false);
      expect(container!.textContent).not.toContain('Payment received');
    };
    expectCheckoutAvailable();
    await act(async () => resolve({ status: 'pending' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expectCheckoutAvailable();
    await act(async () => root!.unmount());
    container!.remove();
    await renderBilling({ current: overview({ checkoutPending: true }) });
    expectCheckoutAvailable();
  });

  it('confirms gift renewal through stale Plus cache and delayed live setup state', async () => {
    const gift = overview({
      effectivePlanTier: 'plus',
      entitlementSource: 'stripe_gift',
      giftStackingSupported: true,
      scheduleManaged: true,
    });
    writeBillingOverviewCache('workspace-1', 'session-1', gift);
    window.history.replaceState({}, '', '/acme/settings/billing?checkout=success');
    const live: OverviewRef = { current: undefined };
    let paid = false;
    const rerender = await renderBilling(live, async () => ({ status: paid ? 'paid' : 'pending' }));
    expect(readBillingCheckoutReturn('workspace-1')).not.toBeNull();
    expect(container!.textContent).toContain('Payment received');

    // Even a live pre-setup gift is already Plus; it does not prove renewal.
    live.current = gift;
    await rerender();
    expect(readBillingCheckoutReturn('workspace-1')).not.toBeNull();
    live.current = { ...gift, subscriptionSetupPending: true };
    await rerender();
    paid = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(container!.textContent).toContain('Payment method saved');
    expect(readBillingCheckoutReturn('workspace-1')).not.toBeNull();

    live.current = { ...gift, autoRenewAfterGift: true };
    await rerender();
    expect(container!.textContent).not.toContain('Payment method saved');
    expect(readBillingCheckoutReturn('workspace-1')).toBeNull();
  });

  it('preserves confirmed payment across remount until the live overview lands', async () => {
    const live: OverviewRef = { current: overview({ checkoutPending: true }) };
    await renderBilling(live, async () => ({ status: 'paid' }));
    expect(container!.textContent).toContain('Payment received');
    expect(readBillingCheckoutReturn('workspace-1')).not.toBeNull();
    await act(async () => root!.unmount());
    container!.remove();
    const rerender = await renderBilling(live, async () => ({ status: 'none' }));
    expect(container!.textContent).toContain('Payment received');
    live.current = overview({ effectivePlanTier: 'plus', entitlementSource: 'stripe' });
    await rerender();
    expect(container!.textContent).not.toContain('Payment received');
    expect(readBillingCheckoutReturn('workspace-1')).toBeNull();
  });

  it.each(['expired', 'pending', 'error'] as const)(
    'releases an unsuccessful return after %s',
    async (status) => {
      window.history.replaceState({}, '', '/acme/settings/billing?checkout=success');
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await renderBilling({ current: overview({ checkoutPending: true }) }, async () => {
          if (status === 'error') throw new Error('temporary failure');
          return { status };
        });
        if (status !== 'expired') {
          expect(container!.textContent).toContain('Payment received');
          await act(async () => {
            await vi.advanceTimersByTimeAsync(120_000);
          });
        }
        expect(container!.textContent).not.toContain('Payment received');
        expect(container!.textContent).toContain('Continue checkout');
        expect(readBillingCheckoutReturn('workspace-1')).toBeNull();
      } finally {
        errorLog.mockRestore();
      }
    }
  );
});

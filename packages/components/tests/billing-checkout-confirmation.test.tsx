// @vitest-environment jsdom
import { ConvexError } from 'convex/values';

import { act, createElement, StrictMode } from 'react';
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
const analytics = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('@posthog/react', () => ({ usePostHog: () => analytics }));

vi.mock('@/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({ authSessionId: 'session-1' }),
}));

vi.mock('@/providers/convex-provider', () => ({
  useAuthClient: () => ({ useActiveOrganization: () => ({ data: null }) }),
}));
vi.mock('../src/providers/convex-provider', () => ({
  useAuthClient: () => ({ useActiveOrganization: () => ({ data: null }) }),
}));

vi.mock('@/lib/electron', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/electron')>()),
  isElectronRenderer: () => false,
}));
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

function createPlatform(
  overviewRef: OverviewRef,
  reconcile: Reconcile,
  actions: Record<string, (...args: never[]) => Promise<unknown>> = {}
): PlatformProvider {
  const emptyInvoices = async () => ({ invoices: [], upcoming: null });
  const noop = async () => null;
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
        if (actions[operation.name]) return actions[operation.name];
        if (operation.name === 'billing:reconcileWorkspaceCheckout') {
          return reconcile;
        }
        if (operation.name === 'billing:listBillingInvoices') {
          return emptyInvoices;
        }
        return noop;
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
    analytics.capture.mockClear();
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
    reconcile: Reconcile = async () => ({ status: 'pending' }),
    actions: Record<string, (...args: never[]) => Promise<unknown>> = {}
  ) {
    const platform = createPlatform(overviewRef, reconcile, actions);
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
              createElement(StrictMode, null, createElement(BillingSettingsComponent))
            )
          )
        );
      });
    await rerender();
    return Object.assign(rerender, { store });
  }

  it('recovers an already switched interval and refreshes only through the read-only payment endpoint', async () => {
    vi.useRealTimers();
    const read = vi.fn().mockResolvedValue({
      billingInterval: 'month',
      effectiveAt: null,
      payment: { status: 'checking' },
    });
    const write = vi.fn();
    const rerender = await renderBilling(
      {
        current: overview({
          effectivePlanTier: 'plus',
          planTier: 'plus',
          billingAccountId: 'a',
          entitlementSource: 'stripe',
          billingInterval: 'year',
          subscriptionStatus: 'active',
        }),
      },
      undefined,
      {
        'billing:previewSubscriptionIntervalChange': async () => {
          throw new ConvexError({ code: 'interval_already_current' });
        },
        'billing:getSubscriptionPaymentStatus': read,
        'billing:setSubscriptionInterval': write,
      }
    );
    const button = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent?.trim() === text
      )!;
    await act(async () => button('Switch to monthly').click());
    expect(document.body.textContent).toContain('Billing interval updated');
    const reads = read.mock.calls.length;
    read.mockRejectedValueOnce(new Error('offline'));
    await act(async () => button('Check payment status').click());
    expect(read).toHaveBeenCalledTimes(reads + 1);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Unable to refresh');
    expect(write).not.toHaveBeenCalled();
    await act(async () => rerender.store.set(currentWorkspaceIdAtom, 'workspace-2'));
    await rerender();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('opens the specific outstanding invoice without relying on a truncated history page', async () => {
    vi.useRealTimers();
    const invoice = {
      id: 'in_current',
      number: 'OLD-1',
      status: 'open',
      amountPaid: 0,
      amountRemaining: 100,
      currency: 'usd',
      periodStart: null,
      periodEnd: null,
      interval: 'month',
      kind: 'subscription',
      giftDurationMonths: null,
      createdAt: 1,
      hostedInvoiceUrl: null,
    };
    let firstInvoicePaid = false;
    const detail = vi.fn().mockResolvedValue({ invoice, lines: [], canCancel: false });
    await renderBilling(
      {
        current: overview({
          effectivePlanTier: 'plus',
          planTier: 'plus',
          billingAccountId: 'a',
          entitlementSource: 'stripe',
          billingInterval: 'year',
          subscriptionStatus: 'active',
        }),
      },
      undefined,
      {
        'billing:previewSubscriptionIntervalChange': async () => {
          throw new ConvexError({ code: 'interval_already_current' });
        },
        'billing:getSubscriptionPaymentStatus': async () => ({
          billingInterval: 'month',
          effectiveAt: null,
          payment: {
            status: 'required',
            amountRemaining: 100,
            currency: 'usd',
            outstandingInvoices: [
              {
                id: firstInvoicePaid ? 'in_current' : 'in_old',
                amountRemaining: 100,
                currency: 'usd',
                invoiceUrl: null,
              },
            ],
          },
        }),
        'billing:getBillingInvoice': detail,
      }
    );
    const button = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent?.trim() === text
      )!;
    await act(async () => button('Switch to monthly').click());
    firstInvoicePaid = true;
    await act(async () => button('View outstanding invoice').click());
    expect(detail).toHaveBeenCalledWith({ workspaceId: 'workspace-1', invoiceId: 'in_current' });
    expect(document.body.textContent).toContain('Plus invoice');
    expect(document.body.textContent).toContain('Amount due$1');
  });

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

  it('still reconciles a checkout return when analytics throws', async () => {
    analytics.capture
      .mockImplementationOnce(() => {
        throw new Error('capture failed');
      })
      .mockImplementationOnce(() => {
        throw new Error('capture failed');
      });
    window.history.replaceState(
      {},
      '',
      '/acme/settings/billing?checkout=success&session_id=secret'
    );
    await renderBilling({ current: overview() });
    expect(readBillingCheckoutReturn('workspace-1')).not.toBeNull();
    expect(window.location.search).toBe('');
    expect(container!.textContent).toContain('Payment received');
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

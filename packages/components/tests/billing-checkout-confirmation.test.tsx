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

const reconcileCalls = vi.hoisted(() => ({ count: 0 }));

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
import { OPTIMISTIC_BILLING_OVERVIEW } from '../src/components/settings/billing-overview-cache';
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

function createPlatform(overviewRef: { current: BillingOverviewData }): PlatformProvider {
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
          return async () => {
            reconcileCalls.count += 1;
            // First poll misses the not-yet-linked Stripe session; the retry
            // must still confirm the payment instead of showing Free.
            if (reconcileCalls.count === 1) return { status: 'none' };
            overviewRef.current = overview({
              effectivePlanTier: 'plus',
              entitlementSource: 'stripe',
            });
            return { status: 'paid' };
          };
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
    reconcileCalls.count = 0;
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
    vi.useRealTimers();
  });

  async function renderBilling(overviewRef: { current: BillingOverviewData }) {
    const platform = createPlatform(overviewRef);
    const store = createStore();
    store.set(currentWorkspaceIdAtom, 'workspace-1');
    store.set(currentWorkspaceSlugAtom, 'acme');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
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
  }

  it('keeps the activating Plus state across a transient reconcile miss, then settles', async () => {
    window.history.replaceState({}, '', '/acme/settings/billing?checkout=success');
    await renderBilling({ current: overview() });

    // First immediate reconcile misses; the page must stay on the activation
    // state instead of dropping to the pre-checkout free overview.
    expect(container!.textContent).toContain('Plus');
    expect(container!.textContent).toContain('Payment received');
    expect(reconcileCalls.count).toBe(1);

    // The retry lands a paid subscription.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(reconcileCalls.count).toBeGreaterThanOrEqual(2);
    expect(container!.textContent).toContain('Plus');
    expect(window.sessionStorage.length).toBe(0);
  });

  it('pretends nothing happened when the return says the checkout was canceled', async () => {
    markBillingCheckoutReturn('workspace-1', Date.now());
    window.history.replaceState({}, '', '/acme/settings/billing?checkout=canceled');
    await renderBilling({ current: overview() });

    expect(container!.textContent).not.toContain('Payment received');
    expect(reconcileCalls.count).toBe(0);
    expect(readBillingCheckoutReturn('workspace-1')).toBeNull();
  });
});

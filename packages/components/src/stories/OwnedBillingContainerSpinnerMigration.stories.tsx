import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useMemo, useState } from 'react';
import { Provider, createStore } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import type { CloudApi } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type { WorkspaceId } from '@lody/shared';
import { BillingSettingsComponent } from '@/components/settings/billing-setting';
import type { BillingOverviewData } from '@/components/settings/billing-setting-pure';
import { AuthenticatedConvexContext } from '@/hooks/use-authenticated-convex';
import { setWorkspaceContextAtom } from '@/atoms/workspace-context';
import { TEST_CLOUD_PLATFORM } from '../../tests/test-platform';
import { SettingsStoryProviders } from './settings-story-shell';

const styles = stylex.create({ root: { minHeight: '100dvh' } });
const workspaceId = 'settings-story-workspace' as WorkspaceId;
const overview: BillingOverviewData = {
  billingAccountId: 'synthetic-billing-account',
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
  currentPeriodEnd: Date.parse('2026-11-22T09:00:00.000Z'),
  seatCount: 2,
  canManageBilling: true,
  referralRewardsSupported: false,
  pricing: {
    monthlyAmountCents: 1000,
    yearlyAmountCents: 9600,
    monthlyOfferKey: null,
    yearlyOfferKey: null,
  },
};
const preview = {
  currency: 'usd',
  interval: 'year' as const,
  quantity: 2,
  unitAmount: 9600,
  subtotalAmount: 19200,
  promoDiscountAmount: 0,
  creditAmount: 500,
  deferredToBalanceAmount: 0,
  amountDueNow: 18700,
  remainingCredit: 0,
  nextRenewalAt: Date.parse('2027-10-22T09:00:00.000Z'),
  promoApplied: false,
};
const invoices = { invoices: [], upcoming: null };
const waitForFixture = () => new Promise<never>(() => undefined);

function Fixture({
  previewPending = false,
  scoped = false,
}: {
  previewPending?: boolean;
  scoped?: boolean;
}) {
  const [stage, setStage] = useState('ready');
  const [store] = useState(() => {
    const next = createStore();
    next.set(setWorkspaceContextAtom, { workspaceId, slug: 'lody' });
    return next;
  });
  useLayoutEffect(() => {
    if (!scoped) return undefined;
    const root = document.documentElement;
    const previous = root.style.getPropertyValue('--spacing');
    root.style.setProperty('--spacing', '5px');
    return () => {
      if (previous) root.style.setProperty('--spacing', previous);
      else root.style.removeProperty('--spacing');
    };
  }, [scoped]);
  const cloudApi = useMemo<CloudApi>(() => {
    const actions = {
      'billing:listBillingInvoices': async () => invoices,
      'billing:previewSubscriptionIntervalChange': async () => {
        setStage('preview-requested');
        return previewPending ? waitForFixture() : preview;
      },
      'billing:setSubscriptionInterval': async () => {
        setStage('switch-requested');
        return waitForFixture();
      },
    };
    return {
      useQuery: (operation, args) => {
        if (args === 'skip') return undefined;
        if (operation.name === 'billing:getBillingOverview') return overview as never;
        throw new Error(`Unexpected synthetic billing query: ${operation.name}`);
      },
      useMutation: (operation) => () =>
        Promise.reject(new Error(`Unexpected synthetic billing mutation: ${operation.name}`)),
      useAction: (operation) => {
        const action = actions[operation.name as keyof typeof actions];
        if (action) return action as never;
        return () =>
          Promise.reject(new Error(`Unexpected synthetic billing action: ${operation.name}`));
      },
    };
  }, [previewPending]);

  return (
    <Provider store={store}>
      <SettingsStoryProviders>
        <PlatformContext.Provider value={{ ...TEST_CLOUD_PLATFORM, cloudApi }}>
          <AuthenticatedConvexContext.Provider
            value={{
              authSessionId: `synthetic-billing-spinner-${previewPending ? 'preview' : 'switch'}`,
              isAuthenticated: true,
              isLoading: false,
              isRecovering: false,
              confirmedUnauthenticated: false,
              claimAutomaticCommand: () => false,
              requestAuthRecovery: () => undefined,
            }}
          >
            <main
              {...stylex.props(styles.root)}
              data-billing-container-spinner
              data-stage={stage}
              data-preview-pending={previewPending}
              data-scoped={scoped}
            >
              <BillingSettingsComponent />
            </main>
          </AuthenticatedConvexContext.Provider>
        </PlatformContext.Provider>
      </SettingsStoryProviders>
    </Provider>
  );
}

const meta = {
  title: 'Migration/BillingContainerSpinner',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PreviewPending: Story = { args: { previewPending: true } };
export const SwitchPending: Story = {};
export const PreviewPendingRootSpacing: Story = { args: { previewPending: true, scoped: true } };
export const SwitchPendingRootSpacing: Story = { args: { scoped: true } };

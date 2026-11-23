// @vitest-environment jsdom
import { unexpectedE2eeWorkspaceOperation } from './fixtures/e2ee-workspaces';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformContext } from '@lody/platform/react';
import type { CloudApi, PlatformProvider } from '@lody/platform';
import { TEST_CLOUD_PLATFORM } from './test-platform';

const mocks = vi.hoisted(() => {
  const noop = async () => undefined;
  const organization = (contentMode: 'e2ee' | 'plaintext') => ({
    activeOrganization: { id: 'workspace-1', name: 'Paid', contentMode, members: [] },
    organizations: [{ id: 'encrypted', contentMode: 'e2ee' }, { id: 'ordinary' }],
    loading: false,
    role: 'owner',
    hasAdminPermission: true,
    deleteOrganization: noop,
    leaveOrganization: noop,
    updateOrganization: noop,
    refetchActiveOrganization: noop,
  });
  return {
    noop,
    // Hooks answer stable values, as their real providers do between renders.
    organizations: { e2ee: organization('e2ee'), plaintext: organization('plaintext') },
    contentMode: 'e2ee' as 'e2ee' | 'plaintext',
    router: { options: { context: {} }, navigate: noop },
    authClient: {
      organization: { listInvitations: async () => ({ data: [] }), delete: vi.fn() },
      deleteUser: vi.fn(),
    },
    session: { data: { user: { id: 'owner-user' } }, rawData: null, refetch: noop },
    i18n: { t: (key: string) => key },
    guards: [] as unknown[],
  };
});

vi.mock('@tanstack/react-router', () => ({ useRouter: () => mocks.router }));
vi.mock('react-i18next', () => ({ useTranslation: () => mocks.i18n }));
vi.mock('../src/lib/app-platform', () => ({ useAppCapability: () => true }));
vi.mock('../src/hooks/use-legacy-workspace-query', () => ({
  useLegacyWorkspaceMutation: () => mocks.noop,
}));
vi.mock('../src/providers/convex-provider', () => ({
  useAuthClient: () => mocks.authClient,
  useAuthSignOut: () => mocks.noop,
}));
vi.mock('../src/hooks/useStableSession', () => ({ useStableSession: () => mocks.session }));
vi.mock('../src/hooks/useOrganization', () => ({
  useOrganization: () => mocks.organizations[mocks.contentMode],
}));
vi.mock('../src/components/settings/account-setting-pure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/components/settings/account-setting-pure')>()),
  AccountSettingsPure: (props: {
    deleteBillingGuard?: unknown;
    onDeleteAccount: () => Promise<void>;
  }) => {
    mocks.guards.push(props.deleteBillingGuard ?? null);
    return <button onClick={props.onDeleteAccount}>Delete account</button>;
  },
}));

import { AccountSettingsComponent } from '../src/components/settings/account-setting';
import { deriveWorkspaceDeleteBillingGuard } from '../src/components/settings/account-setting-pure';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.UTC(2026, 10, 1);
const overview = {
  effectivePlanTier: 'team',
  entitlementSource: 'stripe_subscription',
  autoRenewAfterGift: false,
  cancelAtPeriodEnd: false,
  giftEndsAt: null,
  currentPeriodEnd: NOW + 86_400_000,
};

describe('workspace deletion billing guard', () => {
  it('blocks a live subscription, warns before a scheduled cancellation and ignores free or gifted plans', () => {
    expect(deriveWorkspaceDeleteBillingGuard(undefined, NOW)).toBeNull();
    expect(
      deriveWorkspaceDeleteBillingGuard({ ...overview, effectivePlanTier: 'free' }, NOW)
    ).toBeNull();
    expect(
      deriveWorkspaceDeleteBillingGuard({ ...overview, entitlementSource: 'stripe_gift' }, NOW)
    ).toBeNull();
    expect(deriveWorkspaceDeleteBillingGuard(overview, NOW)).toEqual({
      kind: 'active-subscription',
    });
    expect(
      deriveWorkspaceDeleteBillingGuard({ ...overview, cancelAtPeriodEnd: true }, NOW)
    ).toMatchObject({ kind: 'cancel-scheduled', formattedPeriodEnd: expect.any(String) });
  });
});

describe('account settings', () => {
  let root: Root | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    mocks.guards.length = 0;
  });

  it('waits for both deletion services and continues account deletion after a refusal', async () => {
    const encrypted = Promise.withResolvers<{ workspaceId: string; deleted: true }>();
    const remaining = new Set(['account', 'encrypted', 'ordinary']);
    const deleteWorkspace = vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      const result = await encrypted.promise;
      remaining.delete(workspaceId);
      return result;
    });
    mocks.authClient.organization.delete.mockRejectedValueOnce(new Error('not owner'));
    mocks.authClient.deleteUser.mockImplementationOnce(async () => {
      expect([...remaining]).toEqual(['account', 'ordinary']);
      remaining.delete('account');
      return { error: null };
    });
    const platform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      e2eeWorkspaces: {
        create: unexpectedE2eeWorkspaceOperation,
        describe: unexpectedE2eeWorkspaceOperation,
        history: unexpectedE2eeWorkspaceOperation,
        deleteWorkspace,
      },
      cloudApi: {
        ...TEST_CLOUD_PLATFORM.cloudApi!,
        useQuery: () => undefined,
        useMutation: () => unexpectedE2eeWorkspaceOperation,
        useAction: () => unexpectedE2eeWorkspaceOperation,
      },
    };
    const container = document.createElement('div');
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <PlatformContext.Provider value={platform}>
          <AccountSettingsComponent surface="account" />
        </PlatformContext.Provider>
      )
    );
    await act(async () => container.querySelector('button')!.click());
    expect(deleteWorkspace).toHaveBeenCalledWith({ workspaceId: 'encrypted' });
    expect(mocks.authClient.organization.delete.mock.calls).toEqual([
      [{ organizationId: 'ordinary' }],
    ]);
    expect(remaining.has('account')).toBe(true);
    await act(async () => encrypted.resolve({ workspaceId: 'encrypted', deleted: true }));
    expect(remaining).toEqual(new Set(['ordinary']));
    expect(mocks.authClient.deleteUser).toHaveBeenCalledWith({});
  });

  it.each(['e2ee', 'plaintext'] as const)(
    'guards deleting a paid %s workspace by its billing overview',
    async (contentMode) => {
      mocks.contentMode = contentMode;
      const cloudApi: CloudApi = {
        ...TEST_CLOUD_PLATFORM.cloudApi!,
        useQuery: ((operation: { name: string }, args: unknown) =>
          operation.name === 'billing:getBillingOverview' &&
          (args as { workspaceId?: string }).workspaceId === 'workspace-1'
            ? overview
            : undefined) as CloudApi['useQuery'],
        useMutation: (() => mocks.noop) as CloudApi['useMutation'],
        useAction: (() => mocks.noop) as CloudApi['useAction'],
      };
      const platform: PlatformProvider = { ...TEST_CLOUD_PLATFORM, cloudApi };
      const container = document.createElement('div');
      root = createRoot(container);
      await act(async () =>
        root!.render(
          <PlatformContext.Provider value={platform}>
            <AccountSettingsComponent surface="workspace" />
          </PlatformContext.Provider>
        )
      );
      expect(mocks.guards.at(-1)).toEqual({ kind: 'active-subscription' });
    }
  );
});

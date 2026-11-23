// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  createStaticStore,
  type PlatformProvider,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { useWorkspaceDeleteBillingGuard } from '../src/components/settings/workspace-delete-billing-guard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A cloud platform whose only answer is the billing overview of `paid-encrypted`. */
const platformWith = (overview: Record<string, unknown> | null): PlatformProvider => ({
  kind: 'cloud',
  identity: {
    session: createStaticStore({ status: 'unauthenticated' }),
    signOut: async () => {},
  },
  workspaces: {
    state: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
    setActive: async () => {},
  },
  capabilities: CLOUD_PLATFORM_CAPABILITIES,
  cloudApi: {
    useQuery: (operation: { name: string }, args: unknown) =>
      operation.name === 'billing:getBillingOverview' &&
      args !== 'skip' &&
      (args as { workspaceId?: string }).workspaceId === 'paid-encrypted'
        ? overview
        : undefined,
    useAction: () => async () => null,
    useMutation: () => async () => null,
  } as unknown as PlatformProvider['cloudApi'],
  sync: { mode: 'cloud' },
});

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

const guardFor = (overview: Record<string, unknown> | null, workspaceId?: string) => {
  let seen: ReturnType<typeof useWorkspaceDeleteBillingGuard> | 'unrendered' = 'unrendered';
  const Probe = () => {
    seen = useWorkspaceDeleteBillingGuard(workspaceId);
    return null;
  };
  root = createRoot(document.createElement('div'));
  act(() =>
    root!.render(
      <PlatformContext.Provider value={platformWith(overview)}>
        <Probe />
      </PlatformContext.Provider>
    )
  );
  return seen;
};

describe('workspace delete billing guard', () => {
  it('blocks deleting a paid encrypted workspace with a live subscription', () => {
    expect(
      guardFor(
        { effectivePlanTier: 'pro', entitlementSource: 'stripe', cancelAtPeriodEnd: false },
        'paid-encrypted'
      )
    ).toEqual({ kind: 'active-subscription' });
  });

  it('warns instead of blocking when the subscription is already cancel-scheduled', () => {
    const guard = guardFor(
      {
        effectivePlanTier: 'pro',
        entitlementSource: 'stripe',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: Date.UTC(2030, 0, 15),
      },
      'paid-encrypted'
    );
    expect(guard).toMatchObject({ kind: 'cancel-scheduled' });
    expect(guard && 'formattedPeriodEnd' in guard && guard.formattedPeriodEnd).toBeTruthy();
  });

  it('adds no guard for a free workspace, an absent overview, or no workspace', () => {
    expect(
      guardFor({ effectivePlanTier: 'free', cancelAtPeriodEnd: false }, 'paid-encrypted')
    ).toBeNull();
    expect(guardFor(null, 'paid-encrypted')).toBeNull();
    expect(guardFor({ effectivePlanTier: 'pro', cancelAtPeriodEnd: false }, undefined)).toBeNull();
  });
});

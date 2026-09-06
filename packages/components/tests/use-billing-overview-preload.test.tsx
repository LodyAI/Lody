// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OPTIMISTIC_BILLING_OVERVIEW,
  readBillingOverviewCache,
  writeBillingOverviewCache,
} from '../src/components/settings/billing-overview-cache';

const useCloudQuery = vi.fn();
const useAppCapability = vi.fn();
const useAuthenticatedConvex = vi.fn();

vi.mock('@lody/platform/react', () => ({
  useCloudQuery,
}));

vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex,
}));

vi.mock('../src/lib/app-platform', () => ({
  useAppCapability,
}));

const { useBillingOverviewPreload } = await import('../src/hooks/use-billing-overview-preload');

function Probe({ workspaceId }: { workspaceId: string | null }) {
  useBillingOverviewPreload(workspaceId);
  return null;
}

describe('useBillingOverviewPreload', () => {
  let container: HTMLDivElement;
  let root: Root;
  let currentAuthSessionId: string | null;

  beforeEach(() => {
    localStorage.clear();
    useCloudQuery.mockReset();
    useAppCapability.mockReset();
    useAuthenticatedConvex.mockReset();
    currentAuthSessionId = 'session-1';
    useAuthenticatedConvex.mockImplementation(() => ({ authSessionId: currentAuthSessionId }));
    useCloudQuery.mockReturnValue(undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('clears cached billing data when billing is unavailable for the workspace', async () => {
    writeBillingOverviewCache('workspace-1', 'session-1', {
      ...OPTIMISTIC_BILLING_OVERVIEW,
      effectivePlanTier: 'plus',
    });
    expect(readBillingOverviewCache('workspace-1', 'session-1')).toMatchObject({
      effectivePlanTier: 'plus',
    });

    useAppCapability.mockReturnValue(false);
    await act(async () => {
      root.render(createElement(Probe, { workspaceId: 'workspace-1' }));
    });

    expect(readBillingOverviewCache('workspace-1', 'session-1')).toBeNull();
  });

  it('clears the workspace cache when the authenticated session changes', async () => {
    useAppCapability.mockReturnValue(true);
    writeBillingOverviewCache('workspace-1', 'session-1', OPTIMISTIC_BILLING_OVERVIEW);

    await act(async () => {
      root.render(createElement(Probe, { workspaceId: 'workspace-1' }));
    });
    expect(readBillingOverviewCache('workspace-1', 'session-1')).toMatchObject(
      OPTIMISTIC_BILLING_OVERVIEW
    );

    currentAuthSessionId = 'session-2';
    await act(async () => {
      root.render(createElement(Probe, { workspaceId: 'workspace-1' }));
    });

    expect(readBillingOverviewCache('workspace-1', 'session-1')).toBeNull();
    expect(readBillingOverviewCache('workspace-1', 'session-2')).toBeNull();
  });

  it('clears the previous workspace cache when the session changes during a workspace switch', async () => {
    useAppCapability.mockReturnValue(true);
    writeBillingOverviewCache('workspace-1', 'session-1', OPTIMISTIC_BILLING_OVERVIEW);

    await act(async () => {
      root.render(createElement(Probe, { workspaceId: 'workspace-1' }));
    });
    expect(readBillingOverviewCache('workspace-1', 'session-1')).toMatchObject(
      OPTIMISTIC_BILLING_OVERVIEW
    );

    currentAuthSessionId = 'session-2';
    await act(async () => {
      root.render(createElement(Probe, { workspaceId: 'workspace-2' }));
    });

    expect(readBillingOverviewCache('workspace-1', 'session-1')).toBeNull();
  });
});

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

  beforeEach(() => {
    localStorage.clear();
    useCloudQuery.mockReset();
    useAppCapability.mockReset();
    useAuthenticatedConvex.mockReset();
    useAuthenticatedConvex.mockReturnValue({ authSessionId: 'session-1' });
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
});

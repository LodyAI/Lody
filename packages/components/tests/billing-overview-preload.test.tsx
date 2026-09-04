// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authSessionId: 'session-1' as string | null,
  queryResult: undefined as unknown,
  useQuery: vi.fn(),
}));

vi.mock('../src/hooks/use-recoverable-convex-query', () => ({
  usePublicConvexQuery: () => undefined,
  useRecoverableConvexQuery: (...args: unknown[]) => {
    mocks.useQuery(...args);
    return mocks.queryResult;
  },
}));

vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({ authSessionId: mocks.authSessionId }),
}));

import {
  OPTIMISTIC_BILLING_OVERVIEW,
  readBillingOverviewCache,
  writeBillingOverviewCache,
} from '../src/components/settings/billing-overview-cache';
import { useBillingOverviewPreload } from '../src/hooks/use-billing-overview-preload';
import { TestCloudPlatformProvider } from './test-platform';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ workspaceId }: { workspaceId: string | null }) {
  useBillingOverviewPreload(workspaceId);
  return null;
}

function TestRoot({ children }: { children: ReactNode }) {
  return <TestCloudPlatformProvider>{children}</TestCloudPlatformProvider>;
}

describe('billing overview preload', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    localStorage.clear();
    mocks.authSessionId = 'session-1';
    mocks.queryResult = undefined;
    mocks.useQuery.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('fetches alongside resolved user data and warms the existing cache', async () => {
    const overview = {
      ...OPTIMISTIC_BILLING_OVERVIEW,
      effectivePlanTier: 'plus' as const,
      canManageBilling: true,
    };
    mocks.queryResult = overview;

    await act(async () => {
      root.render(
        <TestRoot>
          <Probe workspaceId="workspace-1" />
        </TestRoot>
      );
    });

    expect(mocks.useQuery).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: 'workspace-1',
    });
    expect(readBillingOverviewCache('workspace-1', 'session-1')).toEqual(overview);
  });

  it('waits until both the user session and workspace are resolved', async () => {
    mocks.authSessionId = null;

    await act(async () => {
      root.render(
        <TestRoot>
          <Probe workspaceId="workspace-1" />
        </TestRoot>
      );
    });

    expect(mocks.useQuery).toHaveBeenCalledWith(expect.anything(), 'skip');
  });

  it('clears a stale cache when the overview is unavailable', async () => {
    writeBillingOverviewCache('workspace-1', 'session-1', OPTIMISTIC_BILLING_OVERVIEW);
    mocks.queryResult = null;

    await act(async () => {
      root.render(
        <TestRoot>
          <Probe workspaceId="workspace-1" />
        </TestRoot>
      );
    });

    expect(readBillingOverviewCache('workspace-1', 'session-1')).toBeNull();
  });
});

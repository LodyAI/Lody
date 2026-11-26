/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LodyAuthClient } from '../src/lib/auth';

const mocks = vi.hoisted(() => ({
  currentAuth: null as null | {
    fetchAccessToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>;
  },
  currentUseAuth: null as null | (() => unknown),
}));

vi.mock('convex/react', () => ({
  ConvexReactClient: class ConvexReactClient {},
  ConvexProviderWithAuth: ({
    children,
    useAuth,
  }: {
    children: React.ReactNode;
    useAuth: () => {
      fetchAccessToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>;
    };
  }) => {
    mocks.currentUseAuth = useAuth;
    mocks.currentAuth = useAuth();
    return children;
  },
}));

import { ConvexProvider, useRestartConvexAuth } from '../src/providers/convex-provider';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('ConvexProvider auth recovery', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.currentAuth = null;
    mocks.currentUseAuth = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('reconfigures Convex and fetches a fresh JWT without changing the Better Auth session', async () => {
    const token = vi
      .fn()
      .mockResolvedValueOnce({ data: { token: 'jwt-1' } })
      .mockResolvedValueOnce({ data: { token: 'jwt-2' } });
    const authSession = {
      get: () => ({
        data: { session: { id: 'same-session', token: 'better-auth-token' } },
        isPending: false,
        isRefetching: false,
        error: null,
        refetch: vi.fn(),
      }),
      listen: () => () => {},
    };
    const authClient = {
      $store: { atoms: { session: authSession } },
      convex: { token },
      crossDomain: { oneTimeToken: { verify: vi.fn() } },
      getSession: vi.fn(),
      updateSession: vi.fn(),
      signOut: vi.fn(),
    } as unknown as LodyAuthClient;
    let restartConvexAuth: (() => void) | null = null;

    function Consumer() {
      restartConvexAuth = useRestartConvexAuth();
      return null;
    }

    await act(async () => {
      root.render(
        <ConvexProvider authClient={authClient}>
          <Consumer />
        </ConvexProvider>
      );
    });

    const initialUseAuth = mocks.currentUseAuth;
    await act(async () => {
      await expect(mocks.currentAuth!.fetchAccessToken({ forceRefreshToken: false })).resolves.toBe(
        null
      );
      await expect(mocks.currentAuth!.fetchAccessToken({ forceRefreshToken: true })).resolves.toBe(
        'jwt-1'
      );
    });

    await act(async () => restartConvexAuth!());

    expect(mocks.currentUseAuth).not.toBe(initialUseAuth);
    await act(async () => {
      await expect(mocks.currentAuth!.fetchAccessToken({ forceRefreshToken: false })).resolves.toBe(
        null
      );
      await expect(mocks.currentAuth!.fetchAccessToken({ forceRefreshToken: true })).resolves.toBe(
        'jwt-2'
      );
    });
    expect(token).toHaveBeenCalledTimes(2);
  });

  it('does not let an older auth generation overwrite the recovered token', async () => {
    let resolveFirstToken!: (value: { data: { token: string } }) => void;
    const firstToken = new Promise<{ data: { token: string } }>((resolve) => {
      resolveFirstToken = resolve;
    });
    const token = vi
      .fn()
      .mockReturnValueOnce(firstToken)
      .mockResolvedValueOnce({ data: { token: 'jwt-recovered' } });
    const authSession = {
      get: () => ({
        data: { session: { id: 'same-session', token: 'better-auth-token' } },
        isPending: false,
        isRefetching: false,
        error: null,
        refetch: vi.fn(),
      }),
      listen: () => () => {},
    };
    const authClient = {
      $store: { atoms: { session: authSession } },
      convex: { token },
      crossDomain: { oneTimeToken: { verify: vi.fn() } },
      getSession: vi.fn(),
      updateSession: vi.fn(),
      signOut: vi.fn(),
    } as unknown as LodyAuthClient;
    let restartConvexAuth: (() => void) | null = null;

    function Consumer() {
      restartConvexAuth = useRestartConvexAuth();
      return null;
    }

    await act(async () => {
      root.render(
        <ConvexProvider authClient={authClient}>
          <Consumer />
        </ConvexProvider>
      );
    });

    const staleRequest = mocks.currentAuth!.fetchAccessToken({ forceRefreshToken: true });
    await act(async () => restartConvexAuth!());
    await act(async () => {
      await expect(mocks.currentAuth!.fetchAccessToken({ forceRefreshToken: false })).resolves.toBe(
        null
      );
      await expect(mocks.currentAuth!.fetchAccessToken({ forceRefreshToken: true })).resolves.toBe(
        'jwt-recovered'
      );
    });

    resolveFirstToken({ data: { token: 'jwt-stale' } });
    await act(async () => {
      await expect(staleRequest).resolves.toBeNull();
    });
    await expect(mocks.currentAuth!.fetchAccessToken({ forceRefreshToken: false })).resolves.toBe(
      'jwt-recovered'
    );
    expect(token).toHaveBeenCalledTimes(2);
  });
});

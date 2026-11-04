/** @vitest-environment jsdom */

/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConvexReactClient } from 'convex/react';
import { signOutWithoutRedirect, type LodyAuthClient } from '../src/lib/auth';
import { requestCurrentConvexJwt } from '../src/lib/convex-jwt';

const providerMocks = vi.hoisted(() => ({
  auth: null as null | {
    fetchAccessToken: (options?: { forceRefreshToken?: boolean }) => Promise<string | null>;
  },
}));

vi.mock('convex/react', () => ({
  ConvexReactClient: class ConvexReactClient {},
  ConvexProviderWithAuth: ({
    children,
    useAuth,
  }: {
    children: React.ReactNode;
    useAuth: () => NonNullable<typeof providerMocks.auth>;
  }) => {
    providerMocks.auth = useAuth();
    return children;
  },
}));

import { RecoverableConvexBetterAuthProvider } from '../src/providers/recoverable-convex-better-auth-provider';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('RecoverableConvexBetterAuthProvider one-time token flow', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.history.replaceState({}, '', '/?ott=test-ott');
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState({}, '', '/');
    vi.restoreAllMocks();
    providerMocks.auth = null;
  });

  it('shares one JWT request between Convex refresh and GitHub token recovery', async () => {
    window.history.replaceState({}, '', '/');
    let sessionId = 'session-a';
    let resolveToken!: (value: { data: { token: string } }) => void;
    const token = vi.fn().mockReturnValueOnce(
      new Promise<{ data: { token: string } }>((resolve) => {
        resolveToken = resolve;
      })
    );
    const authClient = {
      useSession: () => ({
        data: { session: { id: sessionId, token: `better-auth-${sessionId}` } },
        isPending: false,
      }),
      convex: { token },
      crossDomain: { oneTimeToken: { verify: vi.fn() } },
      getSession: vi.fn(),
      updateSession: vi.fn(),
      signOut: vi.fn(),
    } as unknown as LodyAuthClient;
    const renderProvider = () => (
      <RecoverableConvexBetterAuthProvider
        authClient={authClient}
        client={{} as ConvexReactClient}
        recoveryGeneration={0}
      >
        <div />
      </RecoverableConvexBetterAuthProvider>
    );
    await act(async () => {
      root.render(renderProvider());
    });

    const recovery = requestCurrentConvexJwt(authClient);
    const refresh = providerMocks.auth!.fetchAccessToken({ forceRefreshToken: true });
    resolveToken({ data: { token: 'jwt-a' } });
    await act(async () => {
      await expect(refresh).resolves.toBe('jwt-a');
    });
    await expect(recovery).resolves.toBe('jwt-a');
    expect(token).toHaveBeenCalledTimes(1);

    // A recovery that outlives its session never hands back the old session's JWT.
    let resolveStale!: (value: { data: { token: string } }) => void;
    token.mockReset().mockReturnValueOnce(
      new Promise<{ data: { token: string } }>((resolve) => {
        resolveStale = resolve;
      })
    );
    const staleRecovery = requestCurrentConvexJwt(authClient);
    sessionId = 'session-b';
    await act(async () => {
      root.render(renderProvider());
    });
    resolveStale({ data: { token: 'jwt-a-late' } });
    await expect(staleRecovery).resolves.toBeNull();
  });

  it('keeps a recovery JWT when Convex auth restarts for the same session', async () => {
    window.history.replaceState({}, '', '/');
    let resolveToken!: (value: { data: { token: string } }) => void;
    const token = vi.fn().mockReturnValueOnce(
      new Promise<{ data: { token: string } }>((resolve) => {
        resolveToken = resolve;
      })
    );
    const authClient = {
      useSession: () => ({
        data: { session: { id: 'session-a', token: 'better-auth-session-a' } },
        isPending: false,
      }),
      convex: { token },
      crossDomain: { oneTimeToken: { verify: vi.fn() } },
      getSession: vi.fn(),
      updateSession: vi.fn(),
      signOut: vi.fn(),
    } as unknown as LodyAuthClient;
    const renderProvider = (recoveryGeneration: number) => (
      <RecoverableConvexBetterAuthProvider
        authClient={authClient}
        client={{} as ConvexReactClient}
        recoveryGeneration={recoveryGeneration}
      >
        <div />
      </RecoverableConvexBetterAuthProvider>
    );
    await act(async () => {
      root.render(renderProvider(0));
    });
    const recovery = requestCurrentConvexJwt(authClient);
    // Convex auth recovery restarts the provider while GitHub recovery waits.
    await act(async () => {
      root.render(renderProvider(1));
    });
    resolveToken({ data: { token: 'jwt-a' } });
    await expect(recovery).resolves.toBe('jwt-a');
    expect(token).toHaveBeenCalledTimes(1);
  });

  it('does not share a pending token request across Better Auth sessions', async () => {
    window.history.replaceState({}, '', '/');
    let sessionId = 'session-a';
    let resolveSessionA!: (value: { data: { token: string } }) => void;
    const sessionAToken = new Promise<{ data: { token: string } }>((resolve) => {
      resolveSessionA = resolve;
    });
    const token = vi
      .fn()
      .mockReturnValueOnce(sessionAToken)
      .mockResolvedValueOnce({ data: { token: 'jwt-b' } });
    const authClient = {
      useSession: () => ({
        data: { session: { id: sessionId, token: `better-auth-${sessionId}` } },
        isPending: false,
      }),
      convex: { token },
      crossDomain: { oneTimeToken: { verify: vi.fn() } },
      getSession: vi.fn(),
      updateSession: vi.fn(),
      signOut: vi.fn(),
    } as unknown as LodyAuthClient;
    const renderProvider = () => (
      <RecoverableConvexBetterAuthProvider
        authClient={authClient}
        client={{} as ConvexReactClient}
        recoveryGeneration={0}
      >
        <div />
      </RecoverableConvexBetterAuthProvider>
    );

    await act(async () => {
      root.render(renderProvider());
    });
    const staleRequest = providerMocks.auth!.fetchAccessToken({ forceRefreshToken: true });

    sessionId = 'session-b';
    await act(async () => {
      root.render(renderProvider());
    });
    await act(async () => {
      await expect(providerMocks.auth!.fetchAccessToken({ forceRefreshToken: true })).resolves.toBe(
        'jwt-b'
      );
    });

    resolveSessionA({ data: { token: 'jwt-a' } });
    await act(async () => {
      await expect(staleRequest).resolves.toBeNull();
    });
    await expect(providerMocks.auth!.fetchAccessToken()).resolves.toBe('jwt-b');
    expect(token).toHaveBeenCalledTimes(2);
  });

  it('does not return a pending session token after logout', async () => {
    window.history.replaceState({}, '', '/');
    let sessionId: string | null = 'session-a';
    let resolveToken!: (value: { data: { token: string } }) => void;
    const tokenRequest = new Promise<{ data: { token: string } }>((resolve) => {
      resolveToken = resolve;
    });
    const authClient = {
      useSession: () => ({
        data: sessionId ? { session: { id: sessionId, token: 'better-auth-token' } } : null,
        isPending: false,
      }),
      convex: { token: vi.fn(() => tokenRequest) },
      crossDomain: { oneTimeToken: { verify: vi.fn() } },
      getSession: vi.fn(),
      updateSession: vi.fn(),
      signOut: vi.fn(),
    } as unknown as LodyAuthClient;
    const renderProvider = () => (
      <RecoverableConvexBetterAuthProvider
        authClient={authClient}
        client={{} as ConvexReactClient}
        recoveryGeneration={0}
      >
        <div />
      </RecoverableConvexBetterAuthProvider>
    );

    await act(async () => {
      root.render(renderProvider());
    });
    const staleRequest = providerMocks.auth!.fetchAccessToken({ forceRefreshToken: true });

    sessionId = null;
    await act(async () => {
      root.render(renderProvider());
    });
    resolveToken({ data: { token: 'jwt-a' } });

    await act(async () => {
      await expect(staleRequest).resolves.toBeNull();
    });
    await expect(providerMocks.auth!.fetchAccessToken()).resolves.toBeNull();
  });

  it('fences a pending token as soon as logout starts', async () => {
    window.history.replaceState({}, '', '/');
    let resolveToken!: (value: { data: { token: string } }) => void;
    let resolveSignOut!: () => void;
    const tokenRequest = new Promise<{ data: { token: string } }>((resolve) => {
      resolveToken = resolve;
    });
    const signOutRequest = new Promise<void>((resolve) => {
      resolveSignOut = resolve;
    });
    const authClient = {
      useSession: () => ({
        data: { session: { id: 'session-a', token: 'better-auth-token' } },
        isPending: false,
      }),
      convex: { token: vi.fn(() => tokenRequest) },
      crossDomain: { oneTimeToken: { verify: vi.fn() } },
      getSession: vi.fn(),
      updateSession: vi.fn(),
      signOut: vi.fn(() => signOutRequest),
    } as unknown as LodyAuthClient;

    await act(async () => {
      root.render(
        <RecoverableConvexBetterAuthProvider
          authClient={authClient}
          client={{} as ConvexReactClient}
          recoveryGeneration={0}
        >
          <div />
        </RecoverableConvexBetterAuthProvider>
      );
    });
    const staleRequest = providerMocks.auth!.fetchAccessToken({ forceRefreshToken: true });

    const logout = signOutWithoutRedirect(authClient);
    resolveToken({ data: { token: 'jwt-a' } });
    await expect(staleRequest).resolves.toBeNull();
    await expect(providerMocks.auth!.fetchAccessToken()).resolves.toBeNull();

    resolveSignOut();
    await logout;
  });
});

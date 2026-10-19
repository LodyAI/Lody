/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  convexAuth: { isAuthenticated: false, isLoading: false },
  refetch: vi.fn(),
  restartConvexAuth: vi.fn(),
  session: {
    hasLocalToken: true,
    hasRawUser: true,
    isPending: false,
    isRetrying: false,
    confirmedUnauthenticated: false,
    rawData: { session: { id: 'session-1' } } as { session: { id: string } } | null,
  },
}));

vi.mock('../src/components/auth-recovery-error', () => ({
  AuthRecoveryError: ({ onRetry }: { onRetry: () => void }) => (
    <div role="alert">
      <span>Authentication recovery failed</span>
      <button onClick={onRetry}>Retry</button>
    </div>
  ),
}));

vi.mock('convex/react', () => ({
  useConvexAuth: () => mocks.convexAuth,
}));

vi.mock('../src/hooks/useStableSession', () => ({
  useStableSession: () => ({ ...mocks.session, refetch: mocks.refetch }),
}));

vi.mock('../src/providers/convex-provider', () => ({
  useRestartConvexAuth: () => mocks.restartConvexAuth,
}));

import {
  useAuthenticatedConvex,
  type AuthenticatedConvexContextValue,
} from '../src/hooks/use-authenticated-convex';
import {
  CONVEX_AUTH_RECOVERY_DELAYS_MS,
  CONVEX_AUTH_RECOVERY_TIMEOUT_MS,
} from '../src/lib/authed-convex-query';
import { AuthenticatedConvexProvider } from '../src/providers/authenticated-convex-provider';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('AuthenticatedConvexProvider', () => {
  let container: HTMLDivElement;
  let root: Root;
  let current: AuthenticatedConvexContextValue | null;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    mocks.convexAuth.isAuthenticated = false;
    mocks.convexAuth.isLoading = false;
    mocks.session.hasRawUser = true;
    mocks.session.confirmedUnauthenticated = false;
    mocks.session.rawData = { session: { id: 'session-1' } };
    mocks.refetch.mockReset();
    mocks.restartConvexAuth.mockReset();
    current = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function Consumer() {
    current = useAuthenticatedConvex();
    return <div>{current.isLoading ? 'recovering' : 'ready'}</div>;
  }

  it('coalesces recovery while the Better Auth and Convex states disagree', async () => {
    let resolveRefetch!: () => void;
    const pendingRefetch = new Promise<void>((resolve) => {
      resolveRefetch = resolve;
    });
    mocks.refetch.mockReturnValue(pendingRefetch);

    await act(async () => {
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      );
    });

    expect(container.textContent).toBe('recovering');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(mocks.refetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      current!.requestAuthRecovery();
      current!.requestAuthRecovery();
    });
    expect(mocks.refetch).toHaveBeenCalledTimes(1);

    resolveRefetch();
    await act(async () => {
      await pendingRefetch;
    });
    expect(mocks.restartConvexAuth).toHaveBeenCalledTimes(1);
    await act(async () => {
      current!.requestAuthRecovery();
    });
    expect(mocks.refetch).toHaveBeenCalledTimes(1);

    mocks.convexAuth.isLoading = true;
    await act(async () => {
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      );
    });
    mocks.convexAuth.isAuthenticated = true;
    mocks.convexAuth.isLoading = false;
    await act(async () => {
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      );
    });
    expect(container.textContent).toBe('ready');
    expect(current?.isAuthenticated).toBe(true);
    expect(current?.isRecovering).toBe(false);
  });

  it('deduplicates automatic commands for one Better Auth session', async () => {
    mocks.convexAuth.isAuthenticated = true;

    await act(async () => {
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      );
    });

    expect(current!.claimAutomaticCommand('github-profile-refresh:workspace-1')).toBe(true);
    expect(current!.claimAutomaticCommand('github-profile-refresh:workspace-1')).toBe(false);

    mocks.session.rawData = { session: { id: 'session-2' } };
    await act(async () => {
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      );
    });

    expect(current!.claimAutomaticCommand('github-profile-refresh:workspace-1')).toBe(true);
  });

  it('keeps retrying a reported auth failure after Convex rejects refreshed auth', async () => {
    mocks.convexAuth.isAuthenticated = true;
    mocks.refetch.mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      );
    });

    expect(container.textContent).toBe('ready');
    await act(async () => {
      current!.requestAuthRecovery();
    });
    expect(container.textContent).toBe('recovering');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(mocks.restartConvexAuth).toHaveBeenCalledTimes(1);

    mocks.convexAuth.isLoading = true;
    await act(async () => {
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      );
    });
    mocks.convexAuth.isAuthenticated = false;
    mocks.convexAuth.isLoading = false;
    await act(async () => {
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mocks.refetch).toHaveBeenCalledTimes(2);
    expect(mocks.restartConvexAuth).toHaveBeenCalledTimes(2);
  });
  async function renderProvider() {
    await act(async () =>
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      )
    );
  }

  async function rejectAttempt(delay: number) {
    await act(async () => vi.advanceTimersByTimeAsync(delay));
    mocks.convexAuth.isLoading = true;
    await renderProvider();
    mocks.convexAuth.isLoading = false;
    mocks.convexAuth.isAuthenticated = false;
    await renderProvider();
  }

  it('stops after six rejected refreshes, keeps children mounted, and retries only on user action', async () => {
    mocks.refetch.mockResolvedValue(undefined);
    await renderProvider();
    const child = container.firstChild;
    for (const delay of CONVEX_AUTH_RECOVERY_DELAYS_MS) await rejectAttempt(delay);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Authentication recovery failed'
    );
    expect(container.firstChild).toBe(child);
    expect(current?.isLoading).toBe(false);
    expect(current?.isAuthenticated).toBe(false);
    expect(current?.isRecovering).toBe(false);
    const requests = mocks.refetch.mock.calls.length;
    expect(requests).toBe(6);
    await act(async () => {
      current!.requestAuthRecovery();
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.refetch).toHaveBeenCalledTimes(requests);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(current?.isRecovering).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(mocks.refetch).toHaveBeenCalledTimes(requests + 1);
  });

  it('bounds hung session requests and ignores their late completion', async () => {
    let resolve!: () => void;
    mocks.refetch.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      })
    );
    await renderProvider();
    for (const delay of CONVEX_AUTH_RECOVERY_DELAYS_MS) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
      await act(async () => vi.advanceTimersByTimeAsync(CONVEX_AUTH_RECOVERY_TIMEOUT_MS));
    }
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(mocks.refetch).toHaveBeenCalledTimes(6);
    await act(async () => resolve());
    expect(mocks.restartConvexAuth).not.toHaveBeenCalled();
  });

  it('bounds a Convex refresh that never emits a loading transition', async () => {
    mocks.refetch.mockResolvedValue(undefined);
    await renderProvider();
    for (const delay of CONVEX_AUTH_RECOVERY_DELAYS_MS) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
      await act(async () => vi.advanceTimersByTimeAsync(CONVEX_AUTH_RECOVERY_TIMEOUT_MS));
    }
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(mocks.restartConvexAuth).toHaveBeenCalledTimes(6);
  });

  it('retires old in-flight work and gives a new session its own budget', async () => {
    let resolve!: () => void;
    mocks.refetch.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done;
      })
    );
    await renderProvider();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    mocks.session.rawData = { session: { id: 'session-2' } };
    await renderProvider();
    await act(async () => resolve());
    expect(mocks.restartConvexAuth).not.toHaveBeenCalled();
    for (const delay of CONVEX_AUTH_RECOVERY_DELAYS_MS) await rejectAttempt(delay);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(mocks.refetch).toHaveBeenCalledTimes(7);
  });

  it('stops without a recovery error when the session is confirmed invalid', async () => {
    mocks.refetch.mockReturnValue(new Promise(() => {}));
    await renderProvider();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    mocks.session.confirmedUnauthenticated = true;
    await renderProvider();
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(current?.isRecovering).toBe(false);
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it('does not forgive a refresh followed immediately by another protected-query rejection', async () => {
    mocks.convexAuth.isAuthenticated = true;
    mocks.refetch.mockResolvedValue(undefined);
    await renderProvider();
    for (const delay of CONVEX_AUTH_RECOVERY_DELAYS_MS) {
      await act(async () => current!.requestAuthRecovery());
      await act(async () => vi.advanceTimersByTimeAsync(delay));
      mocks.convexAuth.isLoading = true;
      await renderProvider();
      mocks.convexAuth.isLoading = false;
      await renderProvider();
      expect(current?.isAuthenticated).toBe(true);
    }
    await act(async () => current!.requestAuthRecovery());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.refetch).toHaveBeenCalledTimes(6);
  });

  it('pauses offline without resetting attempts or double-counting an in-flight request', async () => {
    mocks.refetch.mockResolvedValue(undefined);
    await renderProvider();
    await rejectAttempt(250);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await act(async () => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      window.dispatchEvent(new Event('offline'));
    });
    mocks.convexAuth.isLoading = true;
    await renderProvider();
    mocks.convexAuth.isLoading = false;
    await renderProvider();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.refetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });
    for (const delay of CONVEX_AUTH_RECOVERY_DELAYS_MS.slice(2)) await rejectAttempt(delay);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(mocks.refetch).toHaveBeenCalledTimes(6);
  });
  it('does not replenish the budget when raw session data disappears during each refresh', async () => {
    mocks.refetch.mockResolvedValue(undefined);
    await renderProvider();
    for (const delay of CONVEX_AUTH_RECOVERY_DELAYS_MS) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
      mocks.session.rawData = null;
      mocks.session.hasRawUser = false;
      mocks.convexAuth.isLoading = true;
      await renderProvider();
      mocks.session.rawData = { session: { id: 'session-1' } };
      mocks.session.hasRawUser = true;
      mocks.convexAuth.isLoading = false;
      await renderProvider();
    }
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(mocks.refetch).toHaveBeenCalledTimes(6);
  });

  it('replenishes the budget after sustained healthy authentication', async () => {
    mocks.refetch.mockResolvedValue(undefined);
    await renderProvider();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    mocks.convexAuth.isLoading = true;
    await renderProvider();
    mocks.convexAuth.isLoading = false;
    mocks.convexAuth.isAuthenticated = true;
    await renderProvider();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    await act(async () => current!.requestAuthRecovery());
    for (const delay of CONVEX_AUTH_RECOVERY_DELAYS_MS) await rejectAttempt(delay);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(mocks.refetch).toHaveBeenCalledTimes(7);
  });
});

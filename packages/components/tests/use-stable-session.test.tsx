/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  localToken: 'stored-session-token' as string | null,
  session: {
    data: {
      session: { id: 'stale-session' },
      user: { id: 'user-1' },
    } as unknown,
    error: null as Error | null,
    isPending: false,
    refetch: vi.fn(),
  },
  getSession: vi.fn(),
}));

vi.mock('../src/providers/convex-provider', () => ({
  useAuthClient: () => ({ useSession: () => mocks.session, getSession: mocks.getSession }),
}));

vi.mock('../src/lib/auth-bootstrap', () => ({
  readAuthBootstrapSnapshot: () => null,
  readStoredAuthToken: () => mocks.localToken,
}));

import { useStableSessionInternal, type StableSessionValue } from '../src/hooks/useStableSession';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('useStableSessionInternal', () => {
  let container: HTMLDivElement;
  let root: Root;
  let current: StableSessionValue | null;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.localToken = 'stored-session-token';
    mocks.session.data = {
      session: { id: 'stale-session' },
      user: { id: 'user-1' },
    };
    mocks.session.error = null;
    mocks.session.isPending = false;
    mocks.session.refetch.mockReset();
    mocks.session.refetch.mockResolvedValue(undefined);
    mocks.getSession.mockReset();
    mocks.getSession.mockResolvedValue({ error: { status: 401 } });
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
    current = useStableSessionInternal();
    return null;
  }

  it('rejects stale cached user data after the current credential also returns 401', async () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), { status: 401 });
    mocks.session.error = unauthorized;

    await act(async () => root.render(<Consumer />));

    expect(current?.confirmedUnauthenticated).toBe(true);
    expect(current?.isRetrying).toBe(false);
    expect(current?.data).toBeNull();
    expect(current?.error).toBe(unauthorized);
    expect(mocks.session.refetch).not.toHaveBeenCalled();
  });

  it('keeps retrying transient session transport failures', async () => {
    const disconnected = Object.assign(new Error('Client disconnected'), { status: 500 });
    mocks.session.error = disconnected;

    await act(async () => root.render(<Consumer />));

    expect(current?.confirmedUnauthenticated).toBe(false);
    expect(current?.isRetrying).toBe(true);
    expect(current?.data).toEqual(mocks.session.data);
    expect(current?.error).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(300));

    expect(mocks.session.refetch).toHaveBeenCalledTimes(1);
  });

  it('does not accept a stale 401 after the current credential succeeds', async () => {
    mocks.session.error = Object.assign(new Error('Unauthorized'), { status: 401 });
    mocks.getSession.mockResolvedValue({ data: mocks.session.data, error: null });

    await act(async () => root.render(<Consumer />));

    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(current?.confirmedUnauthenticated).toBe(false);
    expect(current?.data).toEqual(mocks.session.data);
    expect(current?.error).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(300));

    expect(mocks.session.refetch).toHaveBeenCalledTimes(1);
  });

  it('forces one refresh when verification disproves a stale 401 after retries are exhausted', async () => {
    mocks.session.error = Object.assign(new Error('Client disconnected'), { status: 500 });

    await act(async () => root.render(<Consumer />));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(mocks.session.refetch).toHaveBeenCalledTimes(2);

    mocks.session.error = Object.assign(new Error('Unauthorized'), { status: 401 });
    mocks.getSession.mockResolvedValue({ data: mocks.session.data, error: null });
    await act(async () => root.render(<Consumer />));

    expect(current?.confirmedUnauthenticated).toBe(false);
    expect(current?.error).toMatchObject({ status: 401 });
    expect(mocks.session.refetch).toHaveBeenCalledTimes(3);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));

    expect(mocks.session.refetch).toHaveBeenCalledTimes(3);
  });

  it('bounds retries when unauthorized verification hits a transport failure', async () => {
    mocks.session.error = Object.assign(new Error('Client disconnected'), { status: 500 });

    await act(async () => root.render(<Consumer />));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(mocks.session.refetch).toHaveBeenCalledTimes(2);

    const unauthorized = Object.assign(new Error('Unauthorized'), { status: 401 });
    mocks.session.error = unauthorized;
    mocks.getSession.mockRejectedValue(new Error('Client disconnected'));
    await act(async () => root.render(<Consumer />));

    expect(current?.confirmedUnauthenticated).toBe(false);
    expect(current?.isRetrying).toBe(false);
    expect(current?.error).toBe(unauthorized);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));

    expect(mocks.session.refetch).toHaveBeenCalledTimes(2);
  });

  it('cancels a queued transport retry when the session changes to unauthorized', async () => {
    mocks.session.error = Object.assign(new Error('Client disconnected'), { status: 500 });

    await act(async () => root.render(<Consumer />));
    expect(current?.isRetrying).toBe(true);

    mocks.session.error = Object.assign(new Error('Unauthorized'), { status: 401 });
    await act(async () => root.render(<Consumer />));

    expect(current?.confirmedUnauthenticated).toBe(true);
    expect(current?.isRetrying).toBe(false);

    await act(async () => vi.advanceTimersByTimeAsync(300));

    expect(mocks.session.refetch).not.toHaveBeenCalled();
  });
});

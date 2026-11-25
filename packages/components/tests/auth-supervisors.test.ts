/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  token: 'token',
  listeners: new Set<() => void>(),
  boot: null as unknown,
}));

vi.mock('../src/lib/auth', () => ({
  subscribeLocalAuthStateCleared: (listener: () => void) => {
    authMocks.listeners.add(listener);
    return () => authMocks.listeners.delete(listener);
  },
}));
vi.mock('../src/lib/auth-bootstrap', () => ({
  readAuthBootstrapSnapshot: () => authMocks.boot,
  readStoredAuthToken: () => authMocks.token,
}));
vi.mock('@lody/shared', () => ({ isConvexError: () => false }), { virtual: true });

import { acquireAuthRecoverySupervisor } from '../src/lib/auth-recovery-supervisor';
import {
  acquireStableSessionSupervisor,
  createStableSessionSupervisor,
} from '../src/lib/stable-session-supervisor';

function makeAuthClient() {
  let snapshot = {
    data: { session: { id: 's1' }, user: { id: 'u1' } },
    error: null as unknown,
    isPending: false,
    isRefetching: false,
    refetch: vi.fn(async () => {}),
  };
  const listeners = new Set<(value: typeof snapshot) => void>();
  let atomSubscriptions = 0;
  let atomUnsubscriptions = 0;
  const atom = {
    get: () => snapshot,
    listen: (listener: (value: typeof snapshot) => void) => {
      atomSubscriptions += 1;
      listeners.add(listener);
      return () => {
        atomUnsubscriptions += 1;
        listeners.delete(listener);
      };
    },
  };
  const client = {
    $store: { atoms: { session: atom } },
    getSession: vi.fn(async () => ({ error: null })),
  } as never;
  return {
    client,
    listeners,
    get snapshot() {
      return snapshot;
    },
    setSnapshot(next: Partial<typeof snapshot>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of [...listeners]) listener(snapshot);
    },
    counts: () => ({ atomSubscriptions, atomUnsubscriptions }),
  };
}

describe('external auth supervisors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    authMocks.listeners.clear();
    authMocks.token = 'token';
  });
  afterEach(() => vi.useRealTimers());

  it('shares one Better Auth atom subscription and keeps retry state external', async () => {
    const auth = makeAuthClient();
    const first = acquireStableSessionSupervisor(auth.client, { maxRetries: 1 });
    const second = acquireStableSessionSupervisor(auth.client, { maxRetries: 1 });
    expect(first.supervisor).toBe(second.supervisor);
    expect(auth.counts()).toEqual({ atomSubscriptions: 1, atomUnsubscriptions: 0 });

    const changes: unknown[] = [];
    const off = first.supervisor.subscribe(() => changes.push(first.supervisor.getSnapshot()));
    auth.setSnapshot({ error: Object.assign(new Error('offline'), { status: 500 }) });
    expect(first.supervisor.getSnapshot().isRetrying).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(auth.snapshot.refetch).toHaveBeenCalledTimes(1);
    expect(changes.length).toBeGreaterThan(0);

    off();
    first.release();
    second.release();
    expect(auth.counts()).toEqual({ atomSubscriptions: 1, atomUnsubscriptions: 1 });
  });

  it('keeps Convex recovery budget and reset handshake outside React', async () => {
    const auth = makeAuthClient();
    const session = createStableSessionSupervisor(auth.client);
    session.start();
    const restart = vi.fn();
    const first = acquireAuthRecoverySupervisor(session, restart);
    const second = acquireAuthRecoverySupervisor(session, restart);
    expect(first.supervisor).toBe(second.supervisor);
    const recovery = first.supervisor;
    recovery.updateConvexAuth({ isAuthenticated: false, isLoading: false });
    expect(recovery.getSnapshot().isRecovering).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(auth.snapshot.refetch).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(1);

    recovery.updateConvexAuth({ isAuthenticated: false, isLoading: true });
    recovery.updateConvexAuth({ isAuthenticated: true, isLoading: false });
    expect(recovery.getSnapshot().isRecovering).toBe(false);
    expect(recovery.getSnapshot().isAuthenticated).toBe(true);
    first.release();
    second.release();
    auth.setSnapshot({ data: { session: { id: 's2' }, user: { id: 'u2' } } });
    const third = acquireAuthRecoverySupervisor(session, restart);
    expect(third.supervisor.getSnapshot().authSessionId).toBe('s2');
    third.release();
    session.stop();
  });
});

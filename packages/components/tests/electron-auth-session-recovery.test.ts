import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../../apps/electron/src/main/services/auth-service';
import {
  isUnauthorizedSessionError,
  shouldConfirmUnauthenticated,
} from '../src/hooks/stable-session-state';

const client = vi.hoisted(() => ({
  getSession: vi.fn(),
  getCookie: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('../../../apps/electron/src/main/auth', () => ({ authClient: client }));
vi.mock('electron', () => ({ app: {}, safeStorage: {}, shell: {} }));
vi.mock('../../../apps/electron/src/main/posthog-error-reporting', () => ({
  captureElectronMainException: vi.fn(),
}));
vi.mock('../../../apps/electron/src/main/platform', () => ({
  isLocalPlatform: () => false,
  desktopInstallationProfile: { releaseChannel: 'stable' },
}));
vi.mock('../../../apps/electron/src/main/services/desktop-login', () => ({
  DesktopLogin: class {
    cancel() {}
  },
  DesktopLoginFailure: Error,
}));
vi.mock('@lody/shared/electron-ipc', () => ({
  ElectronAuthCallbackSessionSchema: {},
  isDevEmailPasswordLoginEnabled: () => false,
}));

const staleBearer = {
  fetchOptions: { headers: { Authorization: 'Bearer synthetic-stale' } },
};
const unauthorized = { data: null, error: { status: 401 } };
const session = {
  data: { session: { token: 'synthetic-current' }, user: { id: 'synthetic-user' } },
  error: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  client.getCookie.mockReturnValue('better-auth.session_token=synthetic-current');
  client.signOut.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('desktop session recovery with a stale renderer bearer', () => {
  it.each([0, 429, 500, 503])(
    'preserves fallback status %s across repeated verification',
    async (status) => {
      const service = new AuthService();
      const unavailable = { data: null, error: { status } };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        client.getSession.mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(unavailable);
        const result = await service.getSession(staleBearer);
        expect(result).toEqual(unavailable);
        expect(
          shouldConfirmUnauthenticated({
            hasLocalToken: true,
            hasRawUser: false,
            isPending: false,
            shouldRetry: false,
            hasFinalError: true,
            isSessionUnauthorized: isUnauthorizedSessionError((result as typeof unavailable).error),
            preserveUntilMs: null,
            now: 0,
          })
        ).toBe(false);
      }
      // The failure did not poison subsequent recovery with the durable credential.
      client.getSession.mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(session);
      expect(await service.getSession(staleBearer)).toEqual(session);
    }
  );

  it('propagates a fallback transport failure on cold start instead of returning 401', async () => {
    const service = new AuthService();
    const offline = new Error('synthetic offline');
    client.getSession.mockResolvedValueOnce(unauthorized).mockRejectedValueOnce(offline);
    await expect(service.getSession(staleBearer)).rejects.toBe(offline);
  });

  it('does not treat a rejected cookie as proof that a temporarily unavailable bearer is invalid', async () => {
    const service = new AuthService();
    client.getSession.mockResolvedValueOnce(session);
    await service.getSession();
    const unavailable = { data: null, error: { status: 503 } };
    client.getSession.mockResolvedValueOnce(unavailable).mockResolvedValueOnce(unauthorized);
    expect(await service.getSession(staleBearer)).toEqual(unavailable);
    client.getSession.mockRejectedValueOnce(new Error('synthetic offline'));
    expect(await service.getSession()).toEqual(session);
  });

  it('bounds a hanging cookie check without converting the timeout into 401', async () => {
    vi.useFakeTimers();
    const service = new AuthService();
    client.getSession
      .mockResolvedValueOnce(unauthorized)
      .mockImplementationOnce(() => new Promise(() => {}));
    const result = expect(service.getSession(staleBearer)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
  });

  it('preserves a resolved identity through transport failure, but clears it after confirmed rejection', async () => {
    const service = new AuthService();
    client.getSession.mockResolvedValueOnce(session);
    expect(await service.getSession()).toEqual(session);
    client.getSession
      .mockResolvedValueOnce(unauthorized)
      .mockRejectedValueOnce(new Error('synthetic offline'));
    expect(await service.getSession(staleBearer)).toEqual(session);

    client.getSession.mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(unauthorized);
    expect(await service.getSession(staleBearer)).toEqual(unauthorized);
    const offline = new Error('synthetic offline after rejection');
    client.getSession.mockRejectedValueOnce(offline);
    await expect(service.getSession()).rejects.toBe(offline);
  });

  it('returns an authoritative empty fallback instead of the stale bearer rejection', async () => {
    const service = new AuthService();
    const empty = { data: null, error: null };
    client.getSession.mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(empty);
    expect(await service.getSession(staleBearer)).toEqual(empty);
  });

  it('does not restore cached identity when an in-flight fallback fails after sign-out', async () => {
    const service = new AuthService();
    client.getSession.mockResolvedValueOnce(session);
    await service.getSession();
    let rejectFallback!: (error: Error) => void;
    let started!: () => void;
    const fallbackStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    client.getSession.mockResolvedValueOnce(unauthorized).mockImplementationOnce(() => {
      started();
      return new Promise((_resolve, reject) => {
        rejectFallback = reject;
      });
    });
    const offline = new Error('synthetic late failure');
    const result = expect(service.getSession(staleBearer)).rejects.toBe(offline);
    await fallbackStarted;
    await service.signOut();
    rejectFallback(offline);
    await result;
    client.getSession.mockRejectedValueOnce(offline);
    await expect(service.getSession()).rejects.toBe(offline);
  });

  function deferredSession() {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('keeps a session that resolves after the startup check timed out', async () => {
    vi.useFakeTimers();
    const service = new AuthService();
    const slow = deferredSession();
    client.getSession.mockReturnValueOnce(slow.promise);
    const timedOut = expect(service.getSession()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5_000);
    await timedOut;

    slow.resolve(session);
    await vi.advanceTimersByTimeAsync(0);
    client.getSession.mockRejectedValueOnce(new Error('synthetic offline'));
    expect(await service.getSession()).toEqual(session);
  });

  it('discards a late session that resolves after sign-out', async () => {
    vi.useFakeTimers();
    const service = new AuthService();
    const slow = deferredSession();
    client.getSession.mockReturnValueOnce(slow.promise);
    const timedOut = expect(service.getSession()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5_000);
    await timedOut;

    await service.signOut();
    slow.resolve(session);
    await vi.advanceTimersByTimeAsync(0);
    const offline = new Error('synthetic offline');
    client.getSession.mockRejectedValueOnce(offline);
    await expect(service.getSession()).rejects.toBe(offline);
  });

  it('discards a late session that resolves after a definitive rejection', async () => {
    vi.useFakeTimers();
    const service = new AuthService();
    const slow = deferredSession();
    client.getSession.mockReturnValueOnce(slow.promise);
    const timedOut = expect(service.getSession()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5_000);
    await timedOut;

    // Both the renderer bearer and the durable cookie are definitively rejected.
    client.getSession.mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(unauthorized);
    expect(await service.getSession(staleBearer)).toEqual(unauthorized);
    slow.resolve(session);
    await vi.advanceTimersByTimeAsync(0);
    const offline = new Error('synthetic offline');
    client.getSession.mockRejectedValueOnce(offline);
    await expect(service.getSession()).rejects.toBe(offline);
  });

  it('authorizes requests with the durable cookie when session verification is unreachable', async () => {
    const service = new AuthService();
    client.getSession.mockRejectedValueOnce(new Error('synthetic offline'));
    expect(await service.getSessionToken(staleBearer)).toBe('synthetic-current');

    client.getCookie.mockReturnValue('');
    client.getSession.mockRejectedValueOnce(new Error('synthetic offline'));
    expect(await service.getSessionToken(staleBearer)).toBe('synthetic-stale');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installGitHubTokenPort } from '../src/lib/github-token-port';

const mockAction = vi.fn();

vi.mock('@lody/cloud-api', () => ({
  api: {
    github: {
      getAccessTokenByRepoNameForClient: 'getAccessTokenByRepoNameForClient',
      getOperationAccessTokenByRepoNameForClient: 'getOperationAccessTokenByRepoNameForClient',
    },
  },
}));

vi.mock('../src/providers/convex-provider', () => ({
  convexClient: {
    action: (...args: unknown[]) => mockAction(...args),
  },
}));

// Dynamic import so mocks are in place before the module initializes
const {
  getGitHubRepoToken,
  getGitHubOperationToken,
  invalidateGitHubRepoToken,
  invalidateGitHubOperationToken,
  invalidateGitHubTokensForWorkspace,
  withGitHubOperationTokenRetry,
  withGitHubTokenRetry,
} = await import('../src/lib/github-token');

// Re-export GitHubAuthError for test assertions
const { GitHubAuthError } = await import('@lody/shared');

let uninstallGitHubTokenPort: (() => void) | undefined;

beforeEach(() => {
  uninstallGitHubTokenPort = installGitHubTokenPort({
    getRepoToken: (input) => mockAction('getAccessTokenByRepoNameForClient', input),
    getOperationToken: (input) => mockAction('getOperationAccessTokenByRepoNameForClient', input),
  });
});

afterEach(() => {
  uninstallGitHubTokenPort?.();
  uninstallGitHubTokenPort = undefined;
});

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (!resolve) {
    throw new Error('Failed to create deferred promise');
  }
  return { promise, resolve };
}

describe('getGitHubRepoToken', () => {
  beforeEach(() => {
    mockAction.mockReset();
    // Clear module-level token cache between tests
    invalidateGitHubRepoToken('ws-1', 'owner/repo');
    invalidateGitHubOperationToken('ws-1', 'owner/repo', 'write');
  });

  it('fetches a token from the backend', async () => {
    mockAction.mockResolvedValueOnce({
      success: true,
      token: 'ghs_abc123',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const token = await getGitHubRepoToken('ws-1', 'owner/repo');
    expect(token).toBe('ghs_abc123');
    expect(mockAction).toHaveBeenCalledTimes(1);
  });

  it('returns cached token on subsequent calls', async () => {
    mockAction.mockResolvedValueOnce({
      success: true,
      token: 'ghs_cached',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await getGitHubRepoToken('ws-1', 'owner/repo');
    const second = await getGitHubRepoToken('ws-1', 'owner/repo');

    expect(second).toBe('ghs_cached');
    expect(mockAction).toHaveBeenCalledTimes(1);
  });

  it('throws on backend error', async () => {
    mockAction.mockResolvedValueOnce({
      success: false,
      errorCode: 'repo_not_linked',
      errorMessage: 'Not linked',
    });

    await expect(getGitHubRepoToken('ws-1', 'owner/repo')).rejects.toThrow('Not linked');
  });
});

describe('withGitHubTokenRetry', () => {
  beforeEach(() => {
    mockAction.mockReset();
    invalidateGitHubRepoToken('ws-1', 'owner/repo');
    invalidateGitHubOperationToken('ws-1', 'owner/repo', 'write');
  });

  it('passes through on success', async () => {
    mockAction.mockResolvedValueOnce({
      success: true,
      token: 'ghs_ok',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const result = await withGitHubTokenRetry('ws-1', 'owner/repo', async (token) => {
      return `result-${token}`;
    });

    expect(result).toBe('result-ghs_ok');
    expect(mockAction).toHaveBeenCalledTimes(1);
  });

  it('retries once on GitHubAuthError with a fresh token', async () => {
    // First call: returns initial token
    mockAction.mockResolvedValueOnce({
      success: true,
      token: 'ghs_stale',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    // Second call (after invalidation): returns fresh token
    mockAction.mockResolvedValueOnce({
      success: true,
      token: 'ghs_fresh',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    let callCount = 0;
    const result = await withGitHubTokenRetry('ws-1', 'owner/repo', async (token) => {
      callCount++;
      if (callCount === 1) {
        expect(token).toBe('ghs_stale');
        throw new GitHubAuthError();
      }
      expect(token).toBe('ghs_fresh');
      return 'recovered';
    });

    expect(result).toBe('recovered');
    expect(callCount).toBe(2);
    expect(mockAction).toHaveBeenCalledTimes(2);
  });

  it('propagates non-401 errors without retry', async () => {
    mockAction.mockResolvedValueOnce({
      success: true,
      token: 'ghs_ok',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await expect(
      withGitHubTokenRetry('ws-1', 'owner/repo', async () => {
        throw new Error('GitHub API error: 403 Forbidden');
      })
    ).rejects.toThrow('403 Forbidden');

    // Should NOT have requested a second token
    expect(mockAction).toHaveBeenCalledTimes(1);
  });

  it('propagates GitHubAuthError on retry failure', async () => {
    mockAction.mockResolvedValueOnce({
      success: true,
      token: 'ghs_stale',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    mockAction.mockResolvedValueOnce({
      success: true,
      token: 'ghs_also_stale',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await expect(
      withGitHubTokenRetry('ws-1', 'owner/repo', async () => {
        throw new GitHubAuthError();
      })
    ).rejects.toThrow(GitHubAuthError);

    // Two backend calls: original + retry
    expect(mockAction).toHaveBeenCalledTimes(2);
  });
});

describe('withGitHubOperationTokenRetry', () => {
  beforeEach(() => {
    mockAction.mockReset();
    invalidateGitHubOperationToken('ws-1', 'owner/repo', 'write');
  });

  it('uses the personal operation token on success', async () => {
    mockAction.mockResolvedValueOnce({
      success: true,
      token: 'ghu_personal',
      tokenSource: 'personal',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const result = await withGitHubOperationTokenRetry(
      'ws-1',
      'owner/repo',
      'write',
      async (token) => `result-${token}`
    );

    expect(result).toBe('result-ghu_personal');
    expect(mockAction).toHaveBeenCalledTimes(1);
  });

  it('caches personal operation tokens for the same repo and operation', async () => {
    mockAction.mockResolvedValueOnce({
      success: true,
      token: 'ghu_cached_personal',
      tokenSource: 'personal',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const first = await getGitHubOperationToken('ws-1', 'owner/repo', 'write');
    const second = await getGitHubOperationToken('ws-1', 'owner/repo', 'write');

    expect(first.token).toBe('ghu_cached_personal');
    expect(second.token).toBe('ghu_cached_personal');
    expect(mockAction).toHaveBeenCalledTimes(1);
  });

  it('retries token minting once when Convex reconnects before returning the action result', async () => {
    mockAction
      .mockRejectedValueOnce(new Error('Connection lost while action was in flight'))
      .mockResolvedValueOnce({
        success: true,
        token: 'ghu_reconnected',
        tokenSource: 'personal',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });

    await expect(getGitHubOperationToken('ws-1', 'owner/repo', 'write')).resolves.toMatchObject({
      token: 'ghu_reconnected',
    });
    expect(mockAction).toHaveBeenCalledTimes(2);
  });

  it('stops after one reconnect retry when the token action keeps disconnecting', async () => {
    const error = new Error('Connection lost while action was in flight');
    mockAction.mockRejectedValue(error);

    await expect(getGitHubOperationToken('ws-1', 'owner/repo', 'write')).rejects.toBe(error);
    expect(mockAction).toHaveBeenCalledTimes(2);
  });

  it('invalidates all cached tokens for a workspace after personal identity changes', async () => {
    mockAction
      .mockResolvedValueOnce({
        success: true,
        token: 'ghs_cached_app',
        tokenSource: 'app',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      })
      .mockResolvedValueOnce({
        success: true,
        token: 'ghu_personal_after_toggle',
        tokenSource: 'personal',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });

    await expect(getGitHubOperationToken('ws-1', 'owner/repo', 'write')).resolves.toMatchObject({
      token: 'ghs_cached_app',
      tokenSource: 'app',
    });

    invalidateGitHubTokensForWorkspace('ws-1');

    await expect(getGitHubOperationToken('ws-1', 'owner/repo', 'write')).resolves.toMatchObject({
      token: 'ghu_personal_after_toggle',
      tokenSource: 'personal',
    });
    expect(mockAction).toHaveBeenCalledTimes(2);
  });

  it('does not cache an in-flight app token after workspace token invalidation', async () => {
    const pendingApp = deferred<{
      success: true;
      token: string;
      tokenSource: 'app';
      expiresAt: string;
    }>();
    mockAction.mockReturnValueOnce(pendingApp.promise).mockResolvedValueOnce({
      success: true,
      token: 'ghu_personal_after_inflight',
      tokenSource: 'personal',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const first = getGitHubOperationToken('ws-1', 'owner/repo', 'write');
    invalidateGitHubTokensForWorkspace('ws-1');
    pendingApp.resolve({
      success: true,
      token: 'ghs_inflight_app',
      tokenSource: 'app',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await expect(first).resolves.toMatchObject({ token: 'ghs_inflight_app' });
    await expect(getGitHubOperationToken('ws-1', 'owner/repo', 'write')).resolves.toMatchObject({
      token: 'ghu_personal_after_inflight',
      tokenSource: 'personal',
    });
    expect(mockAction).toHaveBeenCalledTimes(2);
  });

  it('surfaces an actionable personal identity error on 403 without falling back', async () => {
    mockAction.mockResolvedValueOnce({
      success: true,
      token: 'ghu_personal',
      tokenSource: 'personal',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await expect(
      withGitHubOperationTokenRetry('ws-1', 'owner/repo', 'write', async (token) => {
        expect(token).toBe('ghu_personal');
        throw new Error('GitHub API error: 403 Forbidden');
      })
    ).rejects.toThrow('Your personal GitHub identity cannot write to owner/repo');

    expect(mockAction).toHaveBeenCalledTimes(1);
  });

  it('retries a personal operation token on 401 without forcing app fallback', async () => {
    mockAction.mockResolvedValueOnce({
      success: true,
      token: 'ghu_personal_stale',
      tokenSource: 'personal',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    mockAction.mockResolvedValueOnce({
      success: true,
      token: 'ghu_personal_fresh',
      tokenSource: 'personal',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    let callCount = 0;
    const result = await withGitHubOperationTokenRetry(
      'ws-1',
      'owner/repo',
      'write',
      async (token) => {
        callCount++;
        if (callCount === 1) {
          expect(token).toBe('ghu_personal_stale');
          throw new GitHubAuthError();
        }
        expect(token).toBe('ghu_personal_fresh');
        return 'recovered';
      }
    );

    expect(result).toBe('recovered');
    expect(callCount).toBe(2);
    expect(mockAction).toHaveBeenCalledTimes(2);
    expect(mockAction.mock.calls[1]?.[1]).toMatchObject({
      invalidatedPersonalToken: 'ghu_personal_stale',
    });
    expect(mockAction.mock.calls[1]?.[1]).not.toMatchObject({ forceAppFallback: true });
  });

  it('falls back to an app token when personal refresh is unavailable after a 401', async () => {
    mockAction.mockResolvedValueOnce({
      success: true,
      token: 'ghu_personal',
      tokenSource: 'personal',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    mockAction.mockResolvedValueOnce({
      success: true,
      token: 'ghs_app_fallback',
      tokenSource: 'app',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    let callCount = 0;
    const result = await withGitHubOperationTokenRetry(
      'ws-1',
      'owner/repo',
      'write',
      async (token) => {
        callCount++;
        if (callCount === 1) {
          expect(token).toBe('ghu_personal');
          throw new GitHubAuthError();
        }
        expect(token).toBe('ghs_app_fallback');
        return 'recovered-with-app';
      }
    );

    expect(result).toBe('recovered-with-app');
    expect(callCount).toBe(2);
    expect(mockAction).toHaveBeenCalledTimes(2);
    expect(mockAction.mock.calls[1]?.[1]).toMatchObject({
      invalidatedPersonalToken: 'ghu_personal',
    });
    expect(mockAction.mock.calls[1]?.[1]).not.toMatchObject({ forceAppFallback: true });
  });
});

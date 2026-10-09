import { beforeEach, describe, expect, it, vi } from 'vitest';

const actionMock = vi.fn();

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    action = actionMock;
  },
}));

vi.mock('@lody/cloud-api', () => ({
  api: {
    github: {
      getAccessTokenByRepoNameForCli: 'github.getAccessTokenByRepoNameForCli',
      getOperationAccessTokenByRepoNameForCli: 'github.getOperationAccessTokenByRepoNameForCli',
    },
  },
}));

import { GitHubTokenManager, GitHubTokenFetchError } from '../lib/github-token-manager';

describe('GitHubTokenManager', () => {
  beforeEach(() => {
    actionMock.mockReset();
    vi.useRealTimers();
  });

  it('isolates short-lived candidates by owner and source and honors invalidation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
    let generation = 0;
    actionMock.mockImplementation(async (_rpc, args) => ({
      success: true,
      token: `${args.requesterUserId}:${args.credentialSource}:${++generation}`,
      tokenSource: args.credentialSource,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }));
    const manager = new GitHubTokenManager({
      serverUrl: 'http://example.test',
      cliToken: 'cli',
      workspaceId: 'ws',
    });
    const context = { requesterUserId: 'owner', machineId: 'machine' };
    const first = await manager.getCredentialCandidate('org/repo', context, 'personal');
    expect(await manager.getCredentialCandidate('ORG/REPO', context, 'personal')).toEqual(first);
    expect(
      await manager.getCredentialCandidate(
        'org/repo',
        { ...context, requesterUserId: 'other' },
        'personal'
      )
    ).not.toEqual(first);
    expect(await manager.getCredentialCandidate('org/repo', context, 'app')).toMatchObject({
      tokenSource: 'app',
    });
    vi.advanceTimersByTime(60001);
    const expired = await manager.getCredentialCandidate('org/repo', context, 'personal');
    expect(expired).not.toEqual(first);
    manager.invalidate('org/repo', { requesterUserId: 'owner' });
    expect(await manager.getCredentialCandidate('org/repo', context, 'personal')).not.toEqual(
      expired
    );
    await manager.shutdown();
    vi.useRealTimers();
  });
  it('returns tokens even for public repos when a token is issued', async () => {
    actionMock.mockResolvedValueOnce({
      success: true,
      token: 'token-1',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const manager = new GitHubTokenManager({
      serverUrl: 'http://example.test',
      cliToken: 'cli',
      workspaceId: 'ws',
    });
    await expect(manager.getAppTokenForRepo('Owner/Repo')).resolves.toBe('token-1');
    expect(actionMock.mock.calls[0]?.[0]).toBe('github.getAccessTokenByRepoNameForCli');
  });

  it('returns the backend reason when the personal candidate is unavailable', async () => {
    actionMock.mockResolvedValueOnce({
      success: false,
      errorCode: 'personal_unavailable',
      errorMessage: 'personal_token_refresh_failed',
    });
    const manager = new GitHubTokenManager({
      serverUrl: 'http://example.test',
      cliToken: 'cli',
      workspaceId: 'ws',
    });
    await expect(
      manager.getCredentialCandidate(
        'Owner/Repo',
        { requesterUserId: 'user', machineId: 'machine' },
        'personal'
      )
    ).resolves.toEqual({ available: false, reason: 'personal_token_refresh_failed' });
  });

  it('caches by repo (not by owner) for repo-scoped tokens', async () => {
    actionMock
      .mockResolvedValueOnce({
        success: true,
        token: 'token-2a',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        success: true,
        token: 'token-2b',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

    const manager = new GitHubTokenManager({
      serverUrl: 'http://example.test',
      cliToken: 'cli',
      workspaceId: 'ws',
    });

    // First repo gets its own token
    await expect(manager.getAppTokenForRepo('owner/repo-a')).resolves.toBe('token-2a');
    expect(actionMock).toHaveBeenCalledTimes(1);

    // Second repo from same owner gets a different token (repo-scoped)
    await expect(manager.getAppTokenForRepo('owner/repo-b')).resolves.toBe('token-2b');
    expect(actionMock).toHaveBeenCalledTimes(2);

    // Same repo reuses cached token
    await expect(manager.getAppTokenForRepo('owner/repo-a')).resolves.toBe('token-2a');
    expect(actionMock).toHaveBeenCalledTimes(2); // No new call
  });

  it('refreshes when the cached token is expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    actionMock
      .mockResolvedValueOnce({
        success: true,
        token: 'token-3',
        expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        success: true,
        token: 'token-4',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

    const manager = new GitHubTokenManager({
      serverUrl: 'http://example.test',
      cliToken: 'cli',
      workspaceId: 'ws',
    });
    await expect(manager.getAppTokenForRepo('owner/repo-a')).resolves.toBe('token-3');
    vi.advanceTimersByTime(2 * 60 * 1000);
    await expect(manager.getAppTokenForRepo('owner/repo-a')).resolves.toBe('token-4');

    expect(actionMock).toHaveBeenCalledTimes(2);
  });

  it('throws GitHubTokenFetchError on backend error response', async () => {
    actionMock.mockResolvedValueOnce({
      success: false,
      errorCode: 'repo_not_linked',
      errorMessage: 'Repository is not linked to your workspace',
    });

    const manager = new GitHubTokenManager({
      serverUrl: 'http://example.test',
      cliToken: 'cli',
      workspaceId: 'ws',
    });
    const promise = manager.getAppTokenForRepo('owner/repo');
    await expect(promise).rejects.toThrow(GitHubTokenFetchError);
    await expect(promise).rejects.toMatchObject({
      code: 'repo_not_linked',
      message: 'Repository is not linked to your workspace',
    });
  });

  it('caches personal tokens even when GitHub omits an explicit expiry', async () => {
    actionMock.mockResolvedValueOnce({
      success: true,
      token: 'personal-token',
      tokenSource: 'personal',
      rateLimitScope: 'github:user:12345',
    });

    const manager = new GitHubTokenManager({
      serverUrl: 'http://example.test',
      cliToken: 'cli',
      workspaceId: 'ws',
    });

    const context = { requesterUserId: 'user-1', machineId: 'machine-1' };
    await expect(manager.getWriteTokenInfoForRepo('owner/repo', context)).resolves.toEqual({
      token: 'personal-token',
      tokenSource: 'personal',
      rateLimitScope: 'github:user:12345',
    });
    await expect(manager.getWriteTokenForRepo('owner/repo', context)).resolves.toBe(
      'personal-token'
    );
    expect(actionMock).toHaveBeenCalledTimes(1);
    expect(actionMock.mock.calls[0]?.[1]).toMatchObject({
      operation: 'write',
      requesterUserId: 'user-1',
      machineId: 'machine-1',
    });
  });

  it('keeps app and requester write tokens in separate cache entries', async () => {
    actionMock
      .mockResolvedValueOnce({
        success: true,
        token: 'read-token',
        tokenSource: 'app',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        success: true,
        token: 'write-token',
        tokenSource: 'personal',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

    const manager = new GitHubTokenManager({
      serverUrl: 'http://example.test',
      cliToken: 'cli',
      workspaceId: 'ws',
    });

    await expect(manager.getAppTokenForRepo('owner/repo')).resolves.toBe('read-token');
    await expect(
      manager.getWriteTokenForRepo('owner/repo', {
        requesterUserId: 'user-1',
        machineId: 'machine-1',
      })
    ).resolves.toBe('write-token');
    await expect(manager.getAppTokenForRepo('owner/repo')).resolves.toBe('read-token');

    expect(actionMock).toHaveBeenCalledTimes(2);
    expect(actionMock.mock.calls[0]?.[0]).toBe('github.getAccessTokenByRepoNameForCli');
    expect(actionMock.mock.calls[1]?.[1]).toMatchObject({
      operation: 'write',
      requesterUserId: 'user-1',
    });
  });

  it('keeps write tokens for different requesters in separate cache entries', async () => {
    actionMock
      .mockResolvedValueOnce({
        success: true,
        token: 'alice-token',
        tokenSource: 'personal',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        success: true,
        token: 'bob-token',
        tokenSource: 'personal',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

    const manager = new GitHubTokenManager({
      serverUrl: 'http://example.test',
      cliToken: 'cli',
      workspaceId: 'ws',
    });

    await expect(
      manager.getWriteTokenForRepo('owner/repo', {
        requesterUserId: 'alice',
        machineId: 'machine-1',
      })
    ).resolves.toBe('alice-token');
    await expect(
      manager.getWriteTokenForRepo('owner/repo', {
        requesterUserId: 'bob',
        machineId: 'machine-1',
      })
    ).resolves.toBe('bob-token');
    await expect(
      manager.getWriteTokenForRepo('owner/repo', {
        requesterUserId: 'alice',
        machineId: 'machine-1',
      })
    ).resolves.toBe('alice-token');

    expect(actionMock).toHaveBeenCalledTimes(2);
    expect(actionMock.mock.calls[0]?.[1]).toMatchObject({ requesterUserId: 'alice' });
    expect(actionMock.mock.calls[1]?.[1]).toMatchObject({ requesterUserId: 'bob' });
  });

  it('uses a conservative fallback cache duration when an app token omits expiry', async () => {
    actionMock.mockResolvedValueOnce({
      success: true,
      token: 'app-token-without-expiry',
      tokenSource: 'app',
    });

    const manager = new GitHubTokenManager({
      serverUrl: 'http://example.test',
      cliToken: 'cli',
      workspaceId: 'ws',
    });

    await expect(manager.getAppTokenForRepo('owner/repo')).resolves.toBe(
      'app-token-without-expiry'
    );
    await expect(manager.getAppTokenForRepo('owner/repo')).resolves.toBe(
      'app-token-without-expiry'
    );
    expect(actionMock).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached token for a specific repo', async () => {
    actionMock
      .mockResolvedValueOnce({
        success: true,
        token: 'token-old',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        success: true,
        token: 'token-new',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

    const manager = new GitHubTokenManager({
      serverUrl: 'http://example.test',
      cliToken: 'cli',
      workspaceId: 'ws',
    });

    // Get initial token
    await expect(manager.getAppTokenForRepo('owner/repo')).resolves.toBe('token-old');
    expect(actionMock).toHaveBeenCalledTimes(1);

    // Invalidate and get fresh token
    manager.invalidate('owner/repo');
    await expect(manager.getAppTokenForRepo('owner/repo')).resolves.toBe('token-new');
    expect(actionMock).toHaveBeenCalledTimes(2);
  });

  it('passes rejected personal tokens to the backend on the next write-token fetch', async () => {
    actionMock
      .mockResolvedValueOnce({
        success: true,
        token: 'personal-old',
        tokenSource: 'personal',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        success: true,
        token: 'personal-new',
        tokenSource: 'personal',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

    const manager = new GitHubTokenManager({
      serverUrl: 'http://example.test',
      cliToken: 'cli',
      workspaceId: 'ws',
    });

    const context = { requesterUserId: 'user-1', machineId: 'machine-1' };
    await expect(manager.getWriteTokenForRepo('owner/repo', context)).resolves.toBe('personal-old');
    manager.invalidate('owner/repo', {
      requesterUserId: 'user-1',
      invalidatedToken: 'personal-old',
    });
    await expect(manager.getWriteTokenForRepo('owner/repo', context)).resolves.toBe('personal-new');

    expect(actionMock).toHaveBeenCalledTimes(2);
    expect(actionMock.mock.calls[1]?.[1]).toMatchObject({
      operation: 'write',
      invalidatedPersonalToken: 'personal-old',
    });
  });

  it('rejects backend responses that return the same invalidated personal token', async () => {
    actionMock
      .mockResolvedValueOnce({
        success: true,
        token: 'personal-old',
        tokenSource: 'personal',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        success: true,
        token: 'personal-old',
        tokenSource: 'personal',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

    const manager = new GitHubTokenManager({
      serverUrl: 'http://example.test',
      cliToken: 'cli',
      workspaceId: 'ws',
    });

    const context = { requesterUserId: 'user-1', machineId: 'machine-1' };
    await expect(manager.getWriteTokenForRepo('owner/repo', context)).resolves.toBe('personal-old');
    manager.invalidate('owner/repo', {
      requesterUserId: 'user-1',
      invalidatedToken: 'personal-old',
    });
    await expect(manager.getWriteTokenForRepo('owner/repo', context)).rejects.toThrow(
      'Backend returned an invalidated personal GitHub token'
    );
  });
});

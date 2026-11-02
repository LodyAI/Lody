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

import {
  GitHubTokenManager,
  GitHubTokenFetchError,
  GITHUB_CANDIDATE_FAILURE_REUSE_MAX_MS,
  GITHUB_TOKEN_FAILURE_BACKOFF_MAX_MS,
  createSharedGitHubTokenManagers,
  withRequestDeadline,
} from '../lib/github-token-manager';
import {
  GITHUB_BROKER_TOKEN_TIMEOUT_MS,
  GITHUB_TOKEN_CLOUD_TIMEOUT_MS,
} from '../lib/github-credential-runtime';

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

  describe('request sharing and failure backoff', () => {
    const context = { requesterUserId: 'owner', machineId: 'machine' };
    const hourFromNow = (nowMs: number) => new Date(nowMs + 3600_000).toISOString();
    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const createManager = () => {
      const clock = { nowMs: Date.parse('2026-10-20T00:00:00Z') };
      const manager = new GitHubTokenManager({
        serverUrl: 'http://example.test',
        cliToken: 'cli',
        workspaceId: 'ws',
        now: () => clock.nowMs,
      });
      return { clock, manager };
    };

    it('shares one cloud request among concurrent candidate lookups', async () => {
      const { clock, manager } = createManager();
      const answer = deferred<unknown>();
      actionMock.mockReturnValueOnce(answer.promise);
      const lookups = Array.from({ length: 20 }, () =>
        manager.getCredentialCandidate('org/repo', context, 'personal')
      );
      answer.resolve({
        success: true,
        token: 'personal-1',
        tokenSource: 'personal',
        expiresAt: hourFromNow(clock.nowMs),
      });
      const results = await Promise.all(lookups);
      expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
      expect(results[0]).toEqual({ token: 'personal-1', tokenSource: 'personal' });
      expect(actionMock).toHaveBeenCalledTimes(1);
    });

    it('reuses an unavailable personal answer only within one command burst', async () => {
      const { clock, manager } = createManager();
      actionMock.mockResolvedValue({
        success: false,
        errorCode: 'personal_unavailable',
        errorMessage: 'personal_auth_missing',
      });
      for (let index = 0; index < 20; index++)
        await expect(
          manager.getCredentialCandidate('org/repo', context, 'personal')
        ).resolves.toEqual({ available: false, reason: 'personal_auth_missing' });
      expect(actionMock).toHaveBeenCalledTimes(1);

      // A reauthorization sends the CLI no signal: the next command a few seconds
      // later must ask again instead of falling back to another identity.
      clock.nowMs += GITHUB_CANDIDATE_FAILURE_REUSE_MAX_MS;
      actionMock.mockResolvedValueOnce({
        success: true,
        token: 'personal-reauthorized',
        tokenSource: 'personal',
        expiresAt: hourFromNow(clock.nowMs),
      });
      await expect(
        manager.getCredentialCandidate('org/repo', context, 'personal')
      ).resolves.toEqual({ token: 'personal-reauthorized', tokenSource: 'personal' });
      expect(actionMock).toHaveBeenCalledTimes(2);

      // Invalidation after a rejected token ends reuse of the cached answer.
      manager.invalidate('org/repo', { requesterUserId: 'owner' });
      await manager.getCredentialCandidate('org/repo', context, 'personal');
      expect(actionMock).toHaveBeenCalledTimes(3);
    });

    it('keeps backoff per repository, requester and source', async () => {
      const { manager } = createManager();
      actionMock.mockImplementation(async (_rpc, args) =>
        args.repoFullName === 'org/unlinked'
          ? { success: false, errorCode: 'repo_not_linked', errorMessage: 'not linked' }
          : {
              success: true,
              token: `${args.requesterUserId}:${args.credentialSource}`,
              tokenSource: args.credentialSource,
            }
      );
      await expect(manager.getCredentialCandidate('org/unlinked', context, 'app')).resolves.toBe(
        null
      );
      await expect(manager.getCredentialCandidate('org/unlinked', context, 'app')).resolves.toBe(
        null
      );
      await expect(manager.getCredentialCandidate('org/linked', context, 'app')).resolves.toEqual({
        token: 'owner:app',
        tokenSource: 'app',
      });
      await expect(
        manager.getCredentialCandidate('org/linked', { ...context, requesterUserId: 'b' }, 'app')
      ).resolves.toEqual({ token: 'b:app', tokenSource: 'app' });
      expect(actionMock).toHaveBeenCalledTimes(3);
    });

    it('backs off service failures exponentially from their completion', async () => {
      const { clock, manager } = createManager();
      actionMock.mockRejectedValue(new Error('fetch failed'));
      const attempt = () => manager.getCredentialCandidate('org/repo', context, 'app');
      await expect(attempt()).rejects.toThrow('fetch failed');
      await expect(attempt()).rejects.toThrow('fetch failed');
      expect(actionMock).toHaveBeenCalledTimes(1);
      clock.nowMs += 1_000;
      await expect(attempt()).rejects.toThrow('fetch failed');
      expect(actionMock).toHaveBeenCalledTimes(2);
      clock.nowMs += 1_999;
      await expect(attempt()).rejects.toThrow('fetch failed');
      expect(actionMock).toHaveBeenCalledTimes(2);
      clock.nowMs += 1;
      actionMock.mockResolvedValueOnce({ success: true, token: 'app-1', tokenSource: 'app' });
      await expect(attempt()).resolves.toEqual({ token: 'app-1', tokenSource: 'app' });
      expect(actionMock).toHaveBeenCalledTimes(3);
    });

    it('never reuses an expired CLI login failure', async () => {
      const { manager } = createManager();
      actionMock.mockResolvedValue({
        success: false,
        errorCode: 'unauthorized',
        errorMessage: 'expired',
      });
      await expect(manager.getCredentialCandidate('org/repo', context, 'app')).rejects.toThrow(
        'expired'
      );
      await expect(manager.getCredentialCandidate('org/repo', context, 'app')).rejects.toThrow(
        'expired'
      );
      expect(actionMock).toHaveBeenCalledTimes(2);
    });

    it('refreshes a rejected personal candidate once and ignores a late rejection', async () => {
      const { clock, manager } = createManager();
      actionMock.mockResolvedValueOnce({
        success: true,
        token: 'personal-old',
        tokenSource: 'personal',
        expiresAt: hourFromNow(clock.nowMs),
      });
      await manager.getCredentialCandidate('org/repo', context, 'personal');
      const refreshed = deferred<unknown>();
      actionMock.mockReturnValueOnce(refreshed.promise);
      const rejections = Array.from({ length: 20 }, () =>
        manager.getCredentialCandidate('org/repo', context, 'personal', 'personal-old')
      );
      refreshed.resolve({
        success: true,
        token: 'personal-new',
        tokenSource: 'personal',
        expiresAt: hourFromNow(clock.nowMs),
      });
      for (const result of await Promise.all(rejections))
        expect(result).toEqual({ token: 'personal-new', tokenSource: 'personal' });
      expect(actionMock).toHaveBeenCalledTimes(2);
      expect(actionMock.mock.calls[1]?.[1]).toMatchObject({
        invalidatedPersonalToken: 'personal-old',
      });

      // An old command's rejection arrives after the new candidate was published.
      manager.invalidate('org/repo', {
        requesterUserId: 'owner',
        invalidatedToken: 'personal-old',
      });
      await expect(
        manager.getCredentialCandidate('org/repo', context, 'personal', 'personal-old')
      ).resolves.toEqual({ token: 'personal-new', tokenSource: 'personal' });
      expect(actionMock).toHaveBeenCalledTimes(2);
    });

    it('asks again when a shared flight returns the token a waiter rejected', async () => {
      const { clock, manager } = createManager();
      const first = deferred<unknown>();
      actionMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce({
        success: true,
        token: 'personal-new',
        tokenSource: 'personal',
        expiresAt: hourFromNow(clock.nowMs),
      });
      const plain = manager.getCredentialCandidate('org/repo', context, 'personal');
      const rejecting = manager.getCredentialCandidate(
        'org/repo',
        context,
        'personal',
        'personal-old'
      );
      first.resolve({
        success: true,
        token: 'personal-old',
        tokenSource: 'personal',
        expiresAt: hourFromNow(clock.nowMs),
      });
      await expect(plain).resolves.toEqual({ token: 'personal-old', tokenSource: 'personal' });
      await expect(rejecting).resolves.toEqual({ token: 'personal-new', tokenSource: 'personal' });
      expect(actionMock.mock.calls[1]?.[1]).toMatchObject({
        invalidatedPersonalToken: 'personal-old',
      });
    });

    it('does not publish a candidate fetched before invalidation', async () => {
      const { clock, manager } = createManager();
      const stale = deferred<unknown>();
      actionMock.mockReturnValueOnce(stale.promise).mockResolvedValueOnce({
        success: true,
        token: 'app-after',
        tokenSource: 'app',
        expiresAt: hourFromNow(clock.nowMs),
      });
      const before = manager.getCredentialCandidate('org/repo', context, 'app');
      manager.invalidate('org/repo');
      stale.resolve({
        success: true,
        token: 'app-before',
        tokenSource: 'app',
        expiresAt: hourFromNow(clock.nowMs),
      });
      await expect(before).resolves.toMatchObject({ token: 'app-before' });
      await expect(manager.getCredentialCandidate('org/repo', context, 'app')).resolves.toEqual({
        token: 'app-after',
        tokenSource: 'app',
      });
    });

    it('backs off a failed managed write token instead of asking on every poll', async () => {
      const { clock, manager } = createManager();
      actionMock.mockResolvedValue({
        success: false,
        errorCode: 'repo_not_linked',
        errorMessage: 'Repository is not linked',
      });
      for (let index = 0; index < 20; index++)
        await expect(manager.getWriteTokenInfoForRepo('org/repo', context)).rejects.toMatchObject({
          code: 'repo_not_linked',
        });
      expect(actionMock).toHaveBeenCalledTimes(1);
      // Background polling keeps the longer window.
      clock.nowMs += GITHUB_CANDIDATE_FAILURE_REUSE_MAX_MS;
      await expect(manager.getWriteTokenInfoForRepo('org/repo', context)).rejects.toMatchObject({
        code: 'repo_not_linked',
      });
      expect(actionMock).toHaveBeenCalledTimes(1);
      clock.nowMs += GITHUB_TOKEN_FAILURE_BACKOFF_MAX_MS - GITHUB_CANDIDATE_FAILURE_REUSE_MAX_MS;
      actionMock.mockResolvedValueOnce({
        success: true,
        token: 'app-linked',
        tokenSource: 'app',
        expiresAt: hourFromNow(clock.nowMs),
      });
      await expect(manager.getWriteTokenForRepo('org/repo', context)).resolves.toBe('app-linked');
      expect(actionMock).toHaveBeenCalledTimes(2);
    });

    it('keeps a newer write token when an old request reports its rejection late', async () => {
      const { clock, manager } = createManager();
      actionMock
        .mockResolvedValueOnce({
          success: true,
          token: 'personal-old',
          tokenSource: 'personal',
          expiresAt: hourFromNow(clock.nowMs),
        })
        .mockResolvedValueOnce({
          success: true,
          token: 'personal-new',
          tokenSource: 'personal',
          expiresAt: hourFromNow(clock.nowMs),
        });
      await manager.getWriteTokenForRepo('org/repo', context);
      manager.invalidate('org/repo', {
        requesterUserId: 'owner',
        invalidatedToken: 'personal-old',
      });
      await expect(manager.getWriteTokenForRepo('org/repo', context)).resolves.toBe('personal-new');
      manager.invalidate('org/repo', {
        requesterUserId: 'owner',
        invalidatedToken: 'personal-old',
      });
      await expect(manager.getWriteTokenForRepo('org/repo', context)).resolves.toBe('personal-new');
      expect(actionMock).toHaveBeenCalledTimes(2);
    });

    it('does not adopt a write token fetched before invalidation', async () => {
      const { clock, manager } = createManager();
      const stale = deferred<unknown>();
      actionMock.mockReturnValueOnce(stale.promise).mockResolvedValueOnce({
        success: true,
        token: 'app-after',
        tokenSource: 'app',
        expiresAt: hourFromNow(clock.nowMs),
      });
      const before = manager.getWriteTokenForRepo('org/repo', context);
      manager.invalidateAll();
      stale.resolve({
        success: true,
        token: 'app-before',
        tokenSource: 'app',
        expiresAt: hourFromNow(clock.nowMs),
      });
      await expect(before).resolves.toBe('app-after');
      await expect(manager.getWriteTokenForRepo('org/repo', context)).resolves.toBe('app-after');
      expect(actionMock).toHaveBeenCalledTimes(2);
    });
  });

  it('shares one workspace manager between borrowers and releases it with the last lease', async () => {
    actionMock.mockImplementation(async (_rpc, args) => ({
      success: true,
      token: `${args.workspaceId}:token`,
      tokenSource: 'app',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }));
    const managers = createSharedGitHubTokenManagers(
      (workspaceId) =>
        new GitHubTokenManager({ serverUrl: 'http://example.test', cliToken: 'cli', workspaceId })
    );
    const context = { requesterUserId: 'owner', machineId: 'machine' };
    const session = managers.acquire('ws');
    const poller = managers.acquire('ws');
    const other = managers.acquire('ws-2');
    await expect(session.getWriteTokenForRepo('org/repo', context)).resolves.toBe('ws:token');
    await expect(poller.getWriteTokenForRepo('org/repo', context)).resolves.toBe('ws:token');
    await expect(other.getWriteTokenForRepo('org/repo', context)).resolves.toBe('ws-2:token');
    expect(actionMock).toHaveBeenCalledTimes(2);

    await session.shutdown();
    await session.shutdown();
    await poller.getWriteTokenForRepo('org/repo', context);
    expect(actionMock).toHaveBeenCalledTimes(2);

    await poller.shutdown();
    await managers.acquire('ws').getWriteTokenForRepo('org/repo', context);
    expect(actionMock).toHaveBeenCalledTimes(3);
    await managers.shutdownAll();
  });

  describe('cloud request deadline', () => {
    // Answers after `delayMs` unless its signal aborts first, like a slow backend.
    const slowFetch =
      (delayMs: number): typeof fetch =>
      (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          const timer = setTimeout(() => resolve(new Response('ok')), delayMs);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason);
          });
        });

    it('lets a token request that outlasts the old 2.5 s deadline succeed', async () => {
      vi.useFakeTimers();
      const request = withRequestDeadline(
        GITHUB_TOKEN_CLOUD_TIMEOUT_MS,
        slowFetch(10_000)
      )('http://example.test');
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(request.then((response) => response.text())).resolves.toBe('ok');
    });

    it('aborts a hung request at the deadline, before the helper stops waiting', async () => {
      vi.useFakeTimers();
      const request = withRequestDeadline(
        GITHUB_TOKEN_CLOUD_TIMEOUT_MS,
        slowFetch(60_000)
      )('http://example.test');
      let outcome: unknown = 'pending';
      void request.then(
        () => (outcome = 'resolved'),
        (error: unknown) => (outcome = error)
      );
      await vi.advanceTimersByTimeAsync(GITHUB_TOKEN_CLOUD_TIMEOUT_MS - 1);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toMatchObject({ name: 'TimeoutError' });
      expect(GITHUB_TOKEN_CLOUD_TIMEOUT_MS).toBeLessThan(GITHUB_BROKER_TOKEN_TIMEOUT_MS);
    });

    it('still honors a caller abort before the deadline', async () => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const request = withRequestDeadline(GITHUB_TOKEN_CLOUD_TIMEOUT_MS, slowFetch(60_000))(
        'http://example.test',
        { signal: caller.signal }
      );
      caller.abort(new Error('caller cancelled'));
      await expect(request).rejects.toThrow('caller cancelled');
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/utils/logger';
import type { GitHubTokenManager } from '@/lib/github-token-manager';
import { GitHubCredentialResolver } from './github-credential-resolver';

function createTestLogger(): Logger {
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(() => logger),
    close: vi.fn(async () => {}),
  };
  return logger;
}

const CONTEXT = { requesterUserId: 'user-1', machineId: 'machine-1' };

type TokenManagerStub = Pick<GitHubTokenManager, 'getWriteTokenInfoForRepo' | 'invalidate'> & {
  getWriteTokenInfoForRepo: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
};

function makeTokenManager(token = 'managed-token'): TokenManagerStub {
  return {
    getWriteTokenInfoForRepo: vi.fn(async () => ({
      token,
      tokenSource: 'app' as const,
      rateLimitScope: 'github:installation:123',
    })),
    invalidate: vi.fn(),
  };
}

function makeResolver(overrides: {
  tokenManager?: TokenManagerStub | null;
  harvestGhToken?: () => Promise<
    { outcome: 'token'; token: string } | { outcome: 'gh-missing' } | { outcome: 'not-authed' }
  >;
  fetchGhUserId?: () => Promise<string | null>;
  nowMs?: () => number;
}) {
  const logger = createTestLogger();
  const resolver = new GitHubCredentialResolver({
    tokenManager:
      overrides.tokenManager === undefined ? makeTokenManager() : overrides.tokenManager,
    writeTokenContext: CONTEXT,
    workspaceId: 'workspace-1',
    nowMs: overrides.nowMs,
    logger,
    ...(overrides.harvestGhToken ? { harvestGhToken: overrides.harvestGhToken } : {}),
    ...(overrides.fetchGhUserId ? { fetchGhUserId: overrides.fetchGhUserId } : {}),
  });
  return { resolver, logger };
}

describe('GitHubCredentialResolver', () => {
  it('prefers the managed workspace token over ambient gh auth', async () => {
    const harvestGhToken = vi.fn(async () => ({ outcome: 'token' as const, token: 'gh-token' }));
    const tokenManager = makeTokenManager('managed-token');
    const { resolver } = makeResolver({ tokenManager, harvestGhToken });

    const credential = await resolver.resolve('owner/repo');

    expect(credential?.source).toBe('managed');
    expect(credential?.token).toBe('managed-token');
    expect(credential?.credentialScope).toBe('github:installation:123');
    expect(tokenManager.getWriteTokenInfoForRepo).toHaveBeenCalledWith('owner/repo', CONTEXT);
    // gh fallback is never consulted while the managed tier works.
    expect(harvestGhToken).not.toHaveBeenCalled();
  });

  it('falls back to a harvested gh token when the managed tier fails', async () => {
    const tokenManager = makeTokenManager();
    tokenManager.getWriteTokenInfoForRepo.mockRejectedValue(new Error('repo_not_authorized'));
    const { resolver } = makeResolver({
      tokenManager,
      harvestGhToken: async () => ({ outcome: 'token', token: 'gh-token' }),
      fetchGhUserId: async () => '456',
    });

    const credential = await resolver.resolve('owner/repo');

    expect(credential?.source).toBe('gh');
    expect(credential?.token).toBe('gh-token');
    expect(credential?.credentialScope).toBe('github:user:456');
  });

  it('keeps the managed scope stable when the backend rotates the token', async () => {
    const tokenManager = makeTokenManager('token-a');
    tokenManager.getWriteTokenInfoForRepo
      .mockResolvedValueOnce({
        token: 'token-a',
        tokenSource: 'app',
        rateLimitScope: 'github:installation:123',
      })
      .mockResolvedValueOnce({
        token: 'token-b',
        tokenSource: 'app',
        rateLimitScope: 'github:installation:123',
      });
    const { resolver } = makeResolver({ tokenManager });

    const first = await resolver.resolve('owner/repo');
    const second = await resolver.resolve('owner/repo');

    expect(first?.token).not.toBe(second?.token);
    expect(first?.credentialScope).toBe('github:installation:123');
    expect(second?.credentialScope).toBe(first?.credentialScope);
  });

  it('allows installation credentials without a /user identity under a conservative quota', async () => {
    const { resolver } = makeResolver({
      tokenManager: null,
      harvestGhToken: async () => ({ outcome: 'token', token: 'installation-token' }),
      fetchGhUserId: async () => null,
    });
    expect(await resolver.resolve('owner/repo')).toEqual({
      token: 'installation-token',
      source: 'gh',
      credentialScope: 'github:ambient:github.com',
    });
  });

  it('recovers after login and observes rotation and logout without restarting', async () => {
    let now = 0;
    let token: string | null = null;
    const { resolver } = makeResolver({
      tokenManager: null,
      nowMs: () => now,
      harvestGhToken: async () => (token ? { outcome: 'token', token } : { outcome: 'not-authed' }),
      fetchGhUserId: async () => '456',
    });
    expect(await resolver.resolve('owner/repo')).toBeNull();
    token = 'first';
    expect(await resolver.resolve('owner/repo')).toBeNull();
    now = 60_000;
    const first = await resolver.resolve('owner/repo');
    expect(first).toEqual({ token: 'first', source: 'gh', credentialScope: 'github:user:456' });
    token = 'rotated';
    expect(await resolver.resolve('owner/repo')).toEqual(first);
    now += 60_000;
    expect(await resolver.resolve('owner/repo')).toEqual({ ...first, token: 'rotated' });
    token = null;
    now += 60_000;
    expect(await resolver.resolve('owner/repo')).toBeNull();
  });

  it('gh-missing disables only the harvest fallback (logged once)', async () => {
    const harvestGhToken = vi.fn(async () => ({ outcome: 'gh-missing' as const }));
    const { resolver, logger } = makeResolver({ tokenManager: null, harvestGhToken });

    expect(await resolver.resolve('owner/a')).toBeNull();
    expect(await resolver.resolve('owner/b')).toBeNull();
    expect(harvestGhToken).toHaveBeenCalledTimes(1);
    expect(
      (logger.debug as ReturnType<typeof vi.fn>).mock.calls.filter((args) =>
        String(args[0]).includes('gh CLI not found')
      )
    ).toHaveLength(1);
  });

  it('gh-not-authed disables the ambient credential scope (logged once)', async () => {
    const harvestGhToken = vi.fn(async () => ({ outcome: 'not-authed' as const }));
    const { resolver, logger } = makeResolver({ tokenManager: null, harvestGhToken });

    expect(await resolver.resolve('owner/a')).toBeNull();
    expect(await resolver.resolve('owner/b')).toBeNull();
    expect(
      (logger.debug as ReturnType<typeof vi.fn>).mock.calls.filter((args) =>
        String(args[0]).includes('not authenticated')
      )
    ).toHaveLength(1);
  });

  it('invalidate() drops a managed token through the token manager', async () => {
    const tokenManager = makeTokenManager('managed-token');
    tokenManager.invalidate.mockImplementation(() => {
      tokenManager.getWriteTokenInfoForRepo.mockResolvedValue({
        token: 'replacement',
        tokenSource: 'app',
        rateLimitScope: 'github:installation:123',
      });
    });
    const { resolver } = makeResolver({ tokenManager });

    const credential = await resolver.resolve('owner/repo');
    if (!credential) throw new Error('expected a credential');
    resolver.invalidate('owner/repo', credential);

    expect(tokenManager.invalidate).toHaveBeenCalledWith('owner/repo', {
      requesterUserId: CONTEXT.requesterUserId,
      invalidatedToken: 'managed-token',
    });
    expect(await resolver.resolve('owner/repo')).toEqual({ ...credential, token: 'replacement' });
  });

  it('invalidate() clears the gh cache so the next resolve re-harvests', async () => {
    const harvestGhToken = vi.fn(async () => ({ outcome: 'token' as const, token: 'gh-token' }));
    const fetchGhUserId = vi.fn(async () => '456');
    const { resolver } = makeResolver({ tokenManager: null, harvestGhToken, fetchGhUserId });

    const credential = await resolver.resolve('owner/repo');
    if (!credential) throw new Error('expected a credential');
    resolver.invalidate('owner/repo', credential);
    harvestGhToken.mockResolvedValue({ outcome: 'token', token: 'replacement' });
    expect(await resolver.resolve('owner/repo')).toEqual({ ...credential, token: 'replacement' });
  });
});

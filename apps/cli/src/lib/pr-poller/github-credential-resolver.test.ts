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
    trace: vi.fn(),
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
  it('uses ambient credentials for local members even when managed tokens exist', async () => {
    const { resolver } = makeResolver({
      harvestGhToken: async () => ({ outcome: 'token', token: 'native-token' }),
      fetchGhUserId: async () => '7',
    });
    expect((await resolver.resolve('owner/local', true))?.token).toBe('native-token');
    expect((await resolver.resolve('owner/managed', false))?.token).toBe('managed-token');
    const missing = makeResolver({ harvestGhToken: async () => ({ outcome: 'not-authed' }) });
    expect(await missing.resolver.resolve('owner/local', true)).toBeNull();
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
});

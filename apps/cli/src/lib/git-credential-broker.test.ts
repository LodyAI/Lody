import { describe, expect, it, vi } from 'vitest';
import {
  createGitCredentialBrokerHandler,
  GitCredentialBroker,
  type GitCredentialBrokerSessionContext,
} from './git-credential-broker';
import type { GitHubTokenManager } from './github-token-manager';
import type { Logger } from '../utils/logger';

describe('GitCredentialBroker', () => {
  it('distinguishes upstream policy failure from an invalid session context', async () => {
    const handler = createGitCredentialBrokerHandler({
      authToken: 'bearer',
      ownerUserId: 'owner',
      logger: { debug: vi.fn() } as unknown as Logger,
      tokenManager: {
        getCredentialPolicy: async () => {
          throw new Error('offline');
        },
      } as unknown as GitHubTokenManager,
      resolveContext: () => ({ sessionId: 's1', requesterUserId: 'owner', machineId: 'm1' }),
    });
    const res = makeRes();
    handler(
      makeReq({
        url: '/github-auth-context',
        auth: 'Bearer bearer',
        body: { contextToken: 'valid' },
      }),
      res
    );
    await res.finished;
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'policy_unavailable' });
    expect(JSON.parse(res.body)).not.toHaveProperty('allowLocalAuth');
  });
  it.each(['policy', 'candidate'] as const)(
    'fences a pending %s response when the requester context rotates',
    async (kind) => {
      let resolvePending!: (value: unknown) => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = new Promise((resolve) => {
        resolvePending = resolve;
      });
      const lookup = vi.fn(() => {
        started();
        return pending;
      });
      let current: GitCredentialBrokerSessionContext | null = {
        sessionId: 's1',
        requesterUserId: 'owner',
        machineId: 'm1',
      };
      const handler = createGitCredentialBrokerHandler({
        authToken: 'bearer',
        ownerUserId: 'owner',
        logger: { debug: vi.fn() } as unknown as Logger,
        tokenManager: {
          getCredentialPolicy: lookup,
          getCredentialCandidate: lookup,
        } as unknown as GitHubTokenManager,
        resolveContext: () => current,
      });
      const res = makeRes();
      handler(
        makeReq({
          url: kind === 'policy' ? '/github-auth-context' : '/github-token',
          auth: 'Bearer bearer',
          body: { contextToken: 'old', repoFullName: 'org/repo', source: 'personal' },
        }),
        res
      );
      await entered;
      current = null;
      resolvePending(
        kind === 'policy'
          ? { personalEnabled: false }
          : { token: 'secret', tokenSource: 'personal' }
      );
      await res.finished;
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('secret');
      expect(res.body).not.toContain('allowLocalAuth');
    }
  );
  it('returns 404 with error body when no token is available', async () => {
    const tokenManager = {
      getWriteTokenForRepo: vi.fn().mockResolvedValue(''),
    } as unknown as GitHubTokenManager;

    const logger = { debug: vi.fn() } as unknown as Logger;
    const handler = createGitCredentialBrokerHandler({
      authToken: 'auth-token',
      tokenManager,
      logger,
      resolveContext: () => ({ sessionId: 's1', requesterUserId: 'owner', machineId: 'm1' }),
    });

    const req = makeReq({
      url: '/github-token',
      auth: 'Bearer auth-token',
      body: { repoFullName: 'owner/repo', contextToken: 'context' },
    });
    const res = makeRes();

    handler(req, res);
    await res.finished;

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: 'no_token',
      message: 'No token available for the requested repository.',
    });
  });

  it('forwards the personal fallback reason without token material', async () => {
    const tokenManager = {
      getCredentialCandidate: vi
        .fn()
        .mockResolvedValue({ available: false, reason: 'personal_token_refresh_failed' }),
    } as unknown as GitHubTokenManager;
    const handler = createGitCredentialBrokerHandler({
      authToken: 'auth-token',
      tokenManager,
      logger: { debug: vi.fn() } as unknown as Logger,
      resolveContext: () => ({ sessionId: 's1', requesterUserId: 'owner', machineId: 'm1' }),
    });
    const res = makeRes();
    handler(
      makeReq({
        url: '/github-token',
        auth: 'Bearer auth-token',
        body: { repoFullName: 'owner/repo', contextToken: 'context', source: 'personal' },
      }),
      res
    );
    await res.finished;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      available: false,
      reason: 'personal_token_refresh_failed',
    });
  });

  it('rejects missing requester context even with a valid workspace bearer', async () => {
    const tokenManager = {
      getAppTokenForRepo: vi.fn().mockResolvedValue('app-token'),
    } as unknown as GitHubTokenManager;

    const logger = { debug: vi.fn() } as unknown as Logger;
    const handler = createGitCredentialBrokerHandler({
      authToken: 'auth-token',
      tokenManager,
      logger,
    });

    const req = makeReq({
      url: '/github-token',
      auth: 'Bearer auth-token',
      body: { repoFullName: 'owner/repo' },
    });
    const res = makeRes();

    handler(req, res);
    await res.finished;

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('invalid_context');
    expect(tokenManager.getAppTokenForRepo).not.toHaveBeenCalled();
  });

  it('returns requester-bound write token when a valid context is provided', async () => {
    const tokenManager = {
      getWriteTokenForRepo: vi.fn().mockResolvedValue('write-token'),
    } as unknown as GitHubTokenManager;

    const logger = { debug: vi.fn() } as unknown as Logger;
    const handler = createGitCredentialBrokerHandler({
      authToken: 'auth-token',
      tokenManager,
      logger,
      resolveContext: (contextToken) =>
        contextToken === 'context-token'
          ? { sessionId: 's1', requesterUserId: 'user-2', machineId: 'machine-1' }
          : null,
    });

    const req = makeReq({
      url: '/git-credential',
      auth: 'Bearer auth-token',
      body: { repoFullName: 'owner/repo', contextToken: 'context-token' },
    });
    const res = makeRes();

    handler(req, res);
    await res.finished;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      username: 'x-access-token',
      password: 'write-token',
    });
    expect(tokenManager.getWriteTokenForRepo).toHaveBeenCalledWith('owner/repo', {
      requesterUserId: 'user-2',
      machineId: 'machine-1',
    });
  });

  it('rejects unknown requester contexts instead of falling back to app identity', async () => {
    const tokenManager = {
      getAppTokenForRepo: vi.fn().mockResolvedValue('app-token'),
      getWriteTokenForRepo: vi.fn().mockResolvedValue('write-token'),
    } as unknown as GitHubTokenManager;

    const logger = { debug: vi.fn() } as unknown as Logger;
    const handler = createGitCredentialBrokerHandler({
      authToken: 'auth-token',
      tokenManager,
      logger,
      resolveContext: () => null,
    });

    const req = makeReq({
      url: '/github-token',
      auth: 'Bearer auth-token',
      body: { repoFullName: 'owner/repo', contextToken: 'bad-context' },
    });
    const res = makeRes();

    handler(req, res);
    await res.finished;

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_context',
      message: 'Invalid or expired GitHub credential context.',
    });
    expect(tokenManager.getAppTokenForRepo).not.toHaveBeenCalled();
    expect(tokenManager.getWriteTokenForRepo).not.toHaveBeenCalled();
  });

  it('records rejected personal tokens from credential clients', async () => {
    const tokenManager = {
      invalidate: vi.fn(),
    } as unknown as GitHubTokenManager;

    const logger = { debug: vi.fn() } as unknown as Logger;
    const handler = createGitCredentialBrokerHandler({
      authToken: 'auth-token',
      tokenManager,
      logger,
      resolveContext: (contextToken) =>
        contextToken === 'context-token'
          ? { sessionId: 's1', requesterUserId: 'user-2', machineId: 'machine-1' }
          : null,
    });

    const req = makeReq({
      url: '/git-credential/reject',
      auth: 'Bearer auth-token',
      body: {
        repoFullName: 'owner/repo',
        contextToken: 'context-token',
        invalidatedToken: 'ghu_revoked',
      },
    });
    const res = makeRes();

    handler(req, res);
    await res.finished;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(tokenManager.invalidate).toHaveBeenCalledWith('owner/repo', {
      requesterUserId: 'user-2',
      invalidatedToken: 'ghu_revoked',
    });
  });

  describe('activateSessionContext', () => {
    const makeBroker = () => {
      const tokenManager = {} as GitHubTokenManager;
      const logger = { debug: vi.fn() } as unknown as Logger;
      return new GitCredentialBroker({ tokenManager, logger });
    };

    // Access private contexts map to assert invalidation — verifying the
    // internal invariant that a stale contextToken can no longer resolve to
    // any requester after rotation is the core of the security guarantee.
    const peekContexts = (broker: GitCredentialBroker) =>
      (broker as unknown as { contexts: Map<string, GitCredentialBrokerSessionContext> }).contexts;

    it('returns the same token for repeated activations with identical context', () => {
      const broker = makeBroker();
      const first = broker.activateSessionContext({
        sessionId: 's1',
        requesterUserId: 'u1',
        machineId: 'm1',
      });
      const second = broker.activateSessionContext({
        sessionId: 's1',
        requesterUserId: 'u1',
        machineId: 'm1',
      });
      expect(second).toBe(first);
    });

    it('rotates the contextToken and invalidates the previous one when the requester changes', () => {
      const broker = makeBroker();
      const first = broker.activateSessionContext({
        sessionId: 's1',
        requesterUserId: 'u1',
        machineId: 'm1',
      });
      const second = broker.activateSessionContext({
        sessionId: 's1',
        requesterUserId: 'u2',
        machineId: 'm1',
      });

      expect(second).not.toBe(first);
      const contexts = peekContexts(broker);
      expect(contexts.has(first)).toBe(false);
      expect(contexts.get(second)).toEqual({
        sessionId: 's1',
        requesterUserId: 'u2',
        machineId: 'm1',
      });
    });

    it('rotates the contextToken and invalidates the previous one when the machine changes', () => {
      const broker = makeBroker();
      const first = broker.activateSessionContext({
        sessionId: 's1',
        requesterUserId: 'u1',
        machineId: 'm1',
      });
      const second = broker.activateSessionContext({
        sessionId: 's1',
        requesterUserId: 'u1',
        machineId: 'm2',
      });

      expect(second).not.toBe(first);
      const contexts = peekContexts(broker);
      expect(contexts.has(first)).toBe(false);
    });

    it('does not restore an old token when the original context is re-activated after a rotation', () => {
      const broker = makeBroker();
      const original = broker.activateSessionContext({
        sessionId: 's1',
        requesterUserId: 'u1',
        machineId: 'm1',
      });
      broker.activateSessionContext({
        sessionId: 's1',
        requesterUserId: 'u2',
        machineId: 'm1',
      });
      const reactivated = broker.activateSessionContext({
        sessionId: 's1',
        requesterUserId: 'u1',
        machineId: 'm1',
      });

      expect(reactivated).not.toBe(original);
      expect(peekContexts(broker).has(original)).toBe(false);
    });

    it('uses independent contextTokens for different sessions', () => {
      const broker = makeBroker();
      const tokenA = broker.activateSessionContext({
        sessionId: 's1',
        requesterUserId: 'u1',
        machineId: 'm1',
      });
      const tokenB = broker.activateSessionContext({
        sessionId: 's2',
        requesterUserId: 'u1',
        machineId: 'm1',
      });
      expect(tokenA).not.toBe(tokenB);
      const contexts = peekContexts(broker);
      expect(contexts.get(tokenA)?.sessionId).toBe('s1');
      expect(contexts.get(tokenB)?.sessionId).toBe('s2');
    });

    it('preserves context resolution after broker recovery', async () => {
      const tokenManager = {
        getWriteTokenForRepo: vi.fn().mockResolvedValue('write-token-after-recovery'),
      } as unknown as GitHubTokenManager;
      const logger = { debug: vi.fn(), error: vi.fn() } as unknown as Logger;
      const broker = new GitCredentialBroker({ tokenManager, logger });
      const initialEnv = await broker.ensureStarted();
      const contextToken = broker.activateSessionContext({
        sessionId: 's1',
        requesterUserId: 'u1',
        machineId: 'm1',
      });

      try {
        await (broker as unknown as { recover(): Promise<void> }).recover();
        const env = (broker as unknown as { env: typeof initialEnv | null }).env ?? initialEnv;
        const response = await fetch(`${env.url}/github-token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.token}`,
          },
          body: JSON.stringify({
            repoFullName: 'owner/repo',
            contextToken,
          }),
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ token: 'write-token-after-recovery' });
        expect(tokenManager.getWriteTokenForRepo).toHaveBeenCalledWith('owner/repo', {
          requesterUserId: 'u1',
          machineId: 'm1',
        });
      } finally {
        await broker.shutdown();
      }
    });
  });

  it('returns 404 for unknown endpoints', async () => {
    const tokenManager = {
      getAppTokenForRepo: vi.fn().mockResolvedValue('token'),
    } as unknown as GitHubTokenManager;

    const logger = { debug: vi.fn() } as unknown as Logger;
    const handler = createGitCredentialBrokerHandler({
      authToken: 'auth-token',
      tokenManager,
      logger,
    });

    const req = makeReq({
      url: '/github-user-token',
      auth: 'Bearer auth-token',
      body: { repoFullName: 'owner/repo', sessionId: 's1' },
    });
    const res = makeRes();

    handler(req, res);
    await res.finished;

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: 'not_found',
      message: 'Endpoint not found.',
    });
  });
});

type MockReqOptions = {
  url: string;
  auth: string;
  body: unknown;
};

const makeReq = (options: MockReqOptions): any => {
  const payload = Buffer.from(JSON.stringify(options.body), 'utf8');
  return {
    method: 'POST',
    url: options.url,
    headers: { authorization: options.auth },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  };
};

const makeRes = (): any => {
  let resolveFinished: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    finished,
    writeHead(statusCode: number, headers?: Record<string, string>) {
      this.statusCode = statusCode;
      if (headers) {
        this.headers = { ...this.headers, ...headers };
      }
    },
    end(chunk?: string | Buffer) {
      if (typeof chunk === 'string') {
        this.body += chunk;
      } else if (chunk) {
        this.body += chunk.toString('utf8');
      }
      resolveFinished();
    },
  };
};

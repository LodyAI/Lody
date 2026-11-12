import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Effect, Exit, Scope } from 'effect';
import { it as effectIt } from '@effect/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGitCredentialBrokerHandler,
  GitCredentialBroker,
  type GitCredentialBrokerSessionContext,
} from './git-credential-broker';
import type { GitHubTokenManager } from './github-token-manager';
import type { Logger } from '../utils/logger';

describe('GitCredentialBroker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('binds only loopback and publishes owner-only broker state without opening a real socket', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-security-'));
    vi.stubEnv('LODY_DATA_DIR', root);
    vi.resetModules();
    const { GitCredentialBroker: IsolatedBroker } = await import('./git-credential-broker');
    const server = http.createServer();
    let bound: { address: string; family: string; port: number } | null = null;
    vi.spyOn(server, 'listen').mockImplementation(((
      port: number,
      host: string,
      ready: () => void
    ) => {
      bound = { address: host, family: 'IPv4', port: port || 12345 };
      ready();
      return server;
    }) as typeof server.listen);
    vi.spyOn(server, 'address').mockImplementation(() => bound);
    vi.spyOn(server, 'close').mockImplementation(((done: () => void) => {
      bound = null;
      done();
      return server;
    }) as typeof server.close);
    vi.spyOn(http, 'createServer').mockReturnValue(server);
    const broker = new IsolatedBroker({
      workspaceId: 'synthetic-workspace',
      logger: { debug: vi.fn() } as unknown as Logger,
      tokenManager: {} as GitHubTokenManager,
    });
    const statePath = broker.getStateFilePath() as string;
    fs.writeFileSync(statePath, '{}', { mode: 0o644 });
    try {
      const env = await broker.ensureStarted();
      // The actual start path's resulting bind state must exclude LAN interfaces.
      expect(server.address()).toEqual({ address: '127.0.0.1', family: 'IPv4', port: env.port });
      expect(env.url).toBe(`http://127.0.0.1:${env.port}`);
      for (const file of [statePath, path.join(root, 'broker.json')]) {
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(env);
        if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
    } finally {
      await broker.shutdown();
      expect(server.address()).toBeNull();
      expect(fs.readdirSync(root)).toEqual([]);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['', 'Bearer wrong', 'Bearer beareX', 'Bearer bearer extra'])(
    'requires the exact bearer for health and credentials: %s',
    async (auth) => {
      const handler = createGitCredentialBrokerHandler({
        authToken: 'bearer',
        logger: { debug: vi.fn() } as unknown as Logger,
        tokenManager: {} as GitHubTokenManager,
      });
      for (const [url, method] of [
        ['/health', 'GET'],
        ['/github-token', 'POST'],
      ]) {
        const res = makeRes();
        handler(makeReq({ url, method, auth, body: {} }), res);
        await res.finished;
        expect(res.statusCode).toBe(401);
        expect(res.body).not.toContain('timestamp');
      }
    }
  );

  it('returns only liveness to an authenticated health probe', async () => {
    const handler = createGitCredentialBrokerHandler({
      authToken: 'bearer',
      logger: { debug: vi.fn() } as unknown as Logger,
      tokenManager: {} as GitHubTokenManager,
    });
    const res = makeRes();
    handler(makeReq({ url: '/health', method: 'GET', auth: 'Bearer bearer', body: {} }), res);
    await res.finished;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('serves legacy context locally even when cloud policy is unavailable', async () => {
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
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ personalEnabled: true, allowLocalAuth: true });
  });
  it('fences a pending candidate response when the owner context rotates', async () => {
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
        url: '/github-token',
        auth: 'Bearer bearer',
        body: { contextToken: 'old', repoFullName: 'org/repo', source: 'personal' },
      }),
      res
    );
    await entered;
    current = null;
    resolvePending({ token: 'secret', tokenSource: 'personal' });
    await res.finished;
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('secret');
    expect(res.body).not.toContain('allowLocalAuth');
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

  effectIt.effect(
    'owns distinct generations and rejects released authority without revoking its replacement',
    () =>
      Effect.gen(function* () {
        const broker = new GitCredentialBroker({
          tokenManager: {
            getWriteTokenForRepo: async (_repo: string, identity: { requesterUserId: string }) =>
              identity.requesterUserId,
          } as unknown as GitHubTokenManager,
          logger: { debug: vi.fn(), error: vi.fn() } as unknown as Logger,
        });
        const firstScope = yield* Scope.make();
        const secondScope = yield* Scope.make();
        const context = {
          sessionId: 's1',
          requesterUserId: 'u1',
          machineId: 'm1',
          nativeRepositories: ['owner/local'],
        };
        const first = yield* Scope.provide(broker.acquireContext(context), firstScope);
        const second = yield* Scope.provide(broker.acquireContext(context), secondScope);
        expect(second.contextToken).not.toBe(first.contextToken);
        context.nativeRepositories.push('owner/late');
        expect(first.context.nativeRepositories).toEqual(['owner/local']);
        expect(second.context.nativeRepositories).toEqual(['owner/local']);
        const handler = (
          broker as unknown as {
            createHandler(auth: string): ReturnType<typeof createGitCredentialBrokerHandler>;
          }
        ).createHandler('bearer');
        const request = (token: string) => {
          const res = makeRes();
          handler(
            makeReq({
              url: '/github-token',
              auth: 'Bearer bearer',
              body: { repoFullName: 'owner/repo', contextToken: token },
            }),
            res
          );
          return res;
        };
        yield* Scope.close(firstScope, Exit.void);
        yield* Scope.close(firstScope, Exit.void);
        expect(first.active).toBe(false);
        expect(second.active).toBe(true);
        const stale = request(first.contextToken);
        yield* Effect.promise(() => stale.finished);
        expect(stale.statusCode).toBe(403);
        const live = request(second.contextToken);
        yield* Effect.promise(() => live.finished);
        expect(live.statusCode).toBe(200);
        expect(JSON.parse(live.body)).toEqual({ token: 'u1' });
        yield* Scope.close(secondScope, Exit.void);
        const closed = request(second.contextToken);
        yield* Effect.promise(() => closed.finished);
        expect(closed.statusCode).toBe(403);
      })
  );
});

type MockReqOptions = {
  url: string;
  auth: string;
  body: unknown;
  method?: string;
};

const makeReq = (options: MockReqOptions): any => {
  const payload = Buffer.from(JSON.stringify(options.body), 'utf8');
  return {
    method: options.method ?? 'POST',
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

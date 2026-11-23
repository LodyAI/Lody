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
import {
  createSessionPullRequestLinks,
  type SessionPullRequestLinkStore,
} from './session-pr-links';
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

describe('pull request report endpoint', () => {
  const machineId = 'machine-1';
  function store(metas: Record<string, Record<string, unknown> | { deleted: true }>) {
    const writes: Array<{ roomId: string; patch: Record<string, unknown> }> = [];
    const value: SessionPullRequestLinkStore = {
      getDocMeta: async (roomId) => {
        const meta = metas[roomId];
        if (!meta) return undefined;
        return 'deleted' in meta ? { meta: {}, exists: false } : { meta };
      },
      upsertDocMeta: async (roomId, patch) => {
        writes.push({ roomId, patch });
        metas[roomId] = { ...(metas[roomId] as Record<string, unknown>), ...patch };
      },
    };
    return { value, writes, metas };
  }
  function handler(
    links: ReturnType<typeof createSessionPullRequestLinks>,
    contexts: Record<string, GitCredentialBrokerSessionContext>
  ) {
    return createGitCredentialBrokerHandler({
      authToken: 'bearer',
      logger: { debug: vi.fn() } as unknown as Logger,
      tokenManager: {} as GitHubTokenManager,
      resolveContext: (token) => contexts[token] ?? null,
      reportPullRequest: (context, url) => links.link(context.sessionId, url, 'shim'),
    });
  }
  async function report(h: http.RequestListener, body: Record<string, unknown>) {
    const res = makeRes();
    h(makeReq({ url: '/pull-request/report', auth: 'Bearer bearer', body }), res);
    await res.finished;
    return {
      status: res.statusCode as number,
      body: JSON.parse(res.body) as Record<string, unknown>,
    };
  }

  it("links the PR to the reporting context's owner Session, never to an environment-chosen one", async () => {
    const s = store({
      'session-owner': { machineId, userId: 'u' },
      'session-child': { machineId, userId: 'u', parentSessionId: 'owner' },
      'session-other': { machineId, userId: 'u' },
    });
    const links = createSessionPullRequestLinks({ store: s.value, machineId, nowMs: () => 5_000 });
    const h = handler(links, { ctx: { sessionId: 'child', requesterUserId: 'u', machineId } });
    const url = 'https://github.com/LodyAI/Lody/pull/3019';
    expect(await report(h, { contextToken: 'ctx', url, sessionId: 'other' })).toEqual({
      status: 200,
      body: { linked: true, sessionId: 'owner', url },
    });
    expect(s.metas['session-owner']?.['prLink:https://github.com/lodyai/lody/pull/3019']).toEqual({
      k: 'l',
      o: 's',
      t: 5_000,
    });
    expect(s.writes.map((write) => write.roomId)).toEqual(['session-owner']);
    expect(await links.list('child')).toMatchObject([
      { kind: 'pending', url: 'https://github.com/lodyai/lody/pull/3019', reason: 'checking' },
    ]);
  });

  it('refuses unknown contexts, other machines, deleted Sessions and unsupported URLs without writing', async () => {
    const s = store({
      'session-moved': { machineId: 'machine-2', userId: 'u' },
      'session-gone': { deleted: true },
      'session-ok': { machineId, userId: 'u' },
      'session-archived': { machineId, userId: 'u', isArchived: true },
    });
    const links = createSessionPullRequestLinks({ store: s.value, machineId, nowMs: () => 1 });
    const contexts = Object.fromEntries(
      ['moved', 'gone', 'ok', 'archived'].map((id) => [
        id,
        { sessionId: id, requesterUserId: 'u', machineId },
      ])
    );
    const h = handler(links, contexts);
    const url = 'https://github.com/o/r/pull/1';
    expect((await report(h, { contextToken: 'nope', url })).body).toEqual({
      linked: false,
      reason: 'invalid_context',
    });
    expect((await report(h, { contextToken: 'moved', url })).body).toEqual({
      linked: false,
      reason: 'not_this_machine',
    });
    expect((await report(h, { contextToken: 'gone', url })).body).toEqual({
      linked: false,
      reason: 'session_not_found',
    });
    expect((await report(h, { contextToken: 'archived', url })).body).toEqual({
      linked: false,
      reason: 'session_archived',
    });
    expect(
      (await report(h, { contextToken: 'ok', url: 'https://gitlab.com/o/r/-/merge_requests/1' }))
        .body
    ).toEqual({ linked: false, reason: 'unsupported' });
    expect(s.writes).toEqual([]);
  });

  it('unlinks and relinks for one Session', async () => {
    const s = store({ 'session-ok': { machineId, userId: 'u' } });
    let now = 10;
    const links = createSessionPullRequestLinks({ store: s.value, machineId, nowMs: () => now });
    const url = 'https://github.com/o/r/pull/1';
    expect(await links.unlink('ok', url, 'agent')).toMatchObject({ linked: false, unlinked: true });
    now = 5; // An earlier clock never lets the newer intent lose.
    expect(await links.link('ok', url, 'agent')).toMatchObject({ linked: true });
    expect(s.metas['session-ok']?.['prLink:https://github.com/o/r/pull/1']).toEqual({
      k: 'l',
      o: 'a',
      t: 11,
    });
  });
});

import { mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServerId, WorkspaceId, WorkspaceMcpServerMeta } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { WorkspaceMcpCredentialStore } from './workspace-mcp-credential-store';
import { WorkspaceMcpAuthService } from './workspace-mcp-auth-service';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const entry = (providerId: 'linear' | 'posthog' | 'feishu'): WorkspaceMcpServerMeta => ({
  id: `${providerId}-entry` as McpServerId,
  name: providerId,
  transport: 'http',
  source: {
    kind: 'builtin',
    providerId,
    presetVersion: 1,
    accessProfile: providerId === 'feishu' ? 'provider_selected' : 'readonly',
  },
  createdAt: 1,
  updatedAt: 1,
});

describe('WorkspaceMcpAuthService', () => {
  it('validates and stores Feishu secret URLs without returning the URL', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-workspace-mcp-auth-'));
    roots.push(rootDir);
    const service = new WorkspaceMcpAuthService('workspace' as WorkspaceId, 'user-1', logger, {
      store: new WorkspaceMcpCredentialStore({ rootDir }),
      now: () => 100,
    });
    await expect(
      service.setSecretUrl(entry('feishu'), 'https://mcp.feishu.cn/connect/a-secret')
    ).resolves.toMatchObject({ state: 'connected', connectedAt: 100 });
    await expect(service.resolveConnection(entry('feishu'))).resolves.toEqual({
      transport: 'http',
      url: 'https://mcp.feishu.cn/connect/a-secret',
    });
    await expect(
      service.setSecretUrl(entry('feishu'), 'https://example.com/connect/a-secret')
    ).resolves.toMatchObject({
      type: 'workspace-mcp/connection-error',
      code: 'invalid_secret_url',
    });
  });

  it('completes OAuth authorization-code + PKCE through the loopback callback', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-workspace-mcp-auth-'));
    roots.push(rootDir);
    let registeredRedirect = '';
    let now = 1_000;
    let tokenRequestCount = 0;
    let blockRefresh = false;
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.href === 'https://mcp.linear.app/.well-known/oauth-protected-resource') {
        return Response.json({
          resource: 'https://mcp.linear.app/mcp/readonly',
          authorization_servers: ['https://mcp.linear.app'],
        });
      }
      if (url.href === 'https://mcp.linear.app/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer: 'https://mcp.linear.app',
          authorization_endpoint: 'https://mcp.linear.app/authorize',
          token_endpoint: 'https://mcp.linear.app/token',
          registration_endpoint: 'https://mcp.linear.app/register',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (url.href === 'https://mcp.linear.app/register') {
        const body = JSON.parse(String(init?.body)) as { redirect_uris: string[] };
        registeredRedirect = body.redirect_uris[0] ?? '';
        return Response.json({
          client_id: 'dynamic-client',
          redirect_uris: body.redirect_uris,
          token_endpoint_auth_method: 'none',
        });
      }
      if (url.href === 'https://mcp.linear.app/token') {
        tokenRequestCount += 1;
        const body = new URLSearchParams(String(init?.body));
        if (body.get('grant_type') === 'refresh_token') {
          if (blockRefresh) {
            markRefreshStarted();
            await refreshGate;
          }
          return Response.json({
            access_token: 'refreshed-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
          });
        }
        return Response.json({
          access_token: 'machine-access-token',
          refresh_token: 'machine-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      if (url.hostname === 'mcp.linear.app') {
        return new Response('unauthorized', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource"',
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url.href}`);
    });
    const store = new WorkspaceMcpCredentialStore({ rootDir });
    const service = new WorkspaceMcpAuthService('workspace' as WorkspaceId, 'user-1', logger, {
      store,
      fetch: fetchMock as typeof fetch,
      now: () => now,
    });

    const started = await service.startOAuth(entry('linear'));
    if (started.type === 'workspace-mcp/connection-error') {
      throw new Error(JSON.stringify(started));
    }
    expect(started).toMatchObject({ type: 'workspace-mcp/oauth-started' });
    if (started.type !== 'workspace-mcp/oauth-started') throw new Error('OAuth did not start');
    expect(started.authorizationUrl).toContain('https://mcp.linear.app/authorize');
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(registeredRedirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);

    const wrongStateCallback = new URL(registeredRedirect);
    wrongStateCallback.searchParams.set('code', 'attacker-code');
    wrongStateCallback.searchParams.set('state', 'wrong-state');
    await expect(fetch(wrongStateCallback)).resolves.toMatchObject({ status: 400 });
    await expect(service.status(entry('linear'))).resolves.toMatchObject({ state: 'authorizing' });

    const callback = new URL(registeredRedirect);
    callback.searchParams.set('code', 'authorization-code');
    callback.searchParams.set('state', authorizationUrl.searchParams.get('state') ?? '');
    const callbackResponse = await fetch(callback);
    expect(callbackResponse.status).toBe(200);

    await expect(service.status(entry('linear'))).resolves.toMatchObject({ state: 'connected' });
    await expect(service.resolveConnection(entry('linear'))).resolves.toEqual({
      transport: 'http',
      url: 'https://mcp.linear.app/mcp/readonly',
      headers: { Authorization: 'Bearer machine-access-token' },
    });
    const changedProfile = {
      ...entry('linear'),
      source: {
        ...entry('linear').source!,
        accessProfile: 'read_write' as const,
      },
    };
    await expect(service.resolveConnection(changedProfile)).resolves.toBeNull();
    await expect(service.status(changedProfile)).resolves.toMatchObject({
      state: 'not_connected',
    });

    now = 3_700_000;
    const refreshed = await Promise.all([
      service.resolveConnection(entry('linear')),
      service.resolveConnection(entry('linear')),
    ]);
    expect(refreshed).toEqual([
      {
        transport: 'http',
        url: 'https://mcp.linear.app/mcp/readonly',
        headers: { Authorization: 'Bearer refreshed-access-token' },
      },
      {
        transport: 'http',
        url: 'https://mcp.linear.app/mcp/readonly',
        headers: { Authorization: 'Bearer refreshed-access-token' },
      },
    ]);
    expect(tokenRequestCount).toBe(2);

    blockRefresh = true;
    now = 7_400_000;
    const resolving = service.resolveConnection(entry('linear'));
    const resolution = expect(resolving).rejects.toThrow('authorization service is disposed');
    await refreshStarted;
    const disposed = service.dispose();
    releaseRefresh();
    await resolution;
    await disposed;
    await expect(store.get('user-1:workspace:linear-entry')).resolves.toMatchObject({
      kind: 'oauth',
      tokens: { access_token: 'refreshed-access-token' },
    });
  });

  it('rejects OAuth metadata outside the provider allowlist', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-workspace-mcp-auth-'));
    roots.push(rootDir);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname.includes('oauth-authorization-server')) {
        return Response.json({
          issuer: 'https://mcp.linear.app',
          authorization_endpoint: 'https://mcp.linear.app/authorize',
          token_endpoint: 'https://mcp.linear.app/token',
          registration_endpoint: 'https://mcp.linear.app/register',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      return new Response('unauthorized', {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer resource_metadata="http://127.0.0.1:9999/oauth-protected-resource"',
        },
      });
    });
    const service = new WorkspaceMcpAuthService('workspace' as WorkspaceId, 'user-1', logger, {
      store: new WorkspaceMcpCredentialStore({ rootDir }),
      fetch: fetchMock as typeof fetch,
    });

    await expect(service.startOAuth(entry('linear'))).resolves.toMatchObject({
      type: 'workspace-mcp/connection-error',
      code: 'provider_error',
    });
    expect(fetchMock).toHaveBeenCalled();
    for (const [input] of fetchMock.mock.calls) {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      expect(url.origin).toBe('https://mcp.linear.app');
      expect(url.pathname).not.toContain('oauth-authorization-server');
    }
  });

  it('does not fall back after protected-resource policy validation fails', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-workspace-mcp-auth-'));
    roots.push(rootDir);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname.includes('oauth-protected-resource')) {
        return Response.json({
          resource: 'https://mcp.linear.app/mcp',
          authorization_servers: ['https://mcp.linear.app'],
        });
      }
      if (url.pathname.includes('oauth-authorization-server')) {
        return Response.json({
          issuer: 'https://mcp.linear.app',
          authorization_endpoint: 'https://mcp.linear.app/authorize',
          token_endpoint: 'https://mcp.linear.app/token',
          registration_endpoint: 'https://mcp.linear.app/register',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      return new Response('unauthorized', {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource"',
        },
      });
    });
    const service = new WorkspaceMcpAuthService('workspace' as WorkspaceId, 'user-1', logger, {
      store: new WorkspaceMcpCredentialStore({ rootDir }),
      fetch: fetchMock as typeof fetch,
    });

    await expect(service.startOAuth(entry('linear'))).resolves.toMatchObject({
      type: 'workspace-mcp/connection-error',
      code: 'provider_error',
    });
    expect(
      fetchMock.mock.calls.some(([input]) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        return url.pathname.includes('oauth-authorization-server');
      })
    ).toBe(false);
  });

  it('accepts PostHog base OAuth resource metadata for a query-pinned endpoint', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-workspace-mcp-auth-'));
    roots.push(rootDir);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.href === 'https://mcp.posthog.com/.well-known/oauth-protected-resource/mcp') {
        return Response.json({
          resource: 'https://mcp.posthog.com/mcp',
          authorization_servers: ['https://oauth.posthog.com'],
          scopes_supported: [
            'openid',
            'profile',
            'email',
            'query:read',
            'insight:read',
            'insight:write',
            'feature_flag:write',
          ],
        });
      }
      if (url.href === 'https://oauth.posthog.com/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer: 'https://oauth.posthog.com',
          authorization_endpoint: 'https://oauth.posthog.com/oauth/authorize/',
          token_endpoint: 'https://oauth.posthog.com/oauth/token/',
          registration_endpoint: 'https://oauth.posthog.com/oauth/register/',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (url.href === 'https://oauth.posthog.com/oauth/register/') {
        const body = JSON.parse(String(init?.body)) as { redirect_uris: string[] };
        return Response.json({
          client_id: 'posthog-dynamic-client',
          redirect_uris: body.redirect_uris,
          token_endpoint_auth_method: 'none',
        });
      }
      if (url.origin === 'https://mcp.posthog.com') {
        return new Response('unauthorized', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer resource_metadata="https://mcp.posthog.com/.well-known/oauth-protected-resource/mcp"',
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url.href}`);
    });
    const service = new WorkspaceMcpAuthService('workspace' as WorkspaceId, 'user-1', logger, {
      store: new WorkspaceMcpCredentialStore({ rootDir }),
      fetch: fetchMock as typeof fetch,
    });

    const started = await service.startOAuth(entry('posthog'));
    expect(started).toMatchObject({
      type: 'workspace-mcp/oauth-started',
      providerId: 'posthog',
    });
    if (started.type !== 'workspace-mcp/oauth-started') throw new Error('OAuth did not start');
    const requestedScopes = new URL(started.authorizationUrl).searchParams.get('scope')?.split(' ');
    expect(requestedScopes).toEqual(['openid', 'profile', 'email', 'query:read', 'insight:read']);
    expect(requestedScopes?.some((scope) => scope.endsWith(':write'))).toBe(false);
    expect(
      fetchMock.mock.calls.some(([input]) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        return url.href === 'https://mcp.posthog.com/mcp?mode=cli&readonly=true';
      })
    ).toBe(true);
    await service.dispose();
  });

  it('bounds provider requests so OAuth setup cannot hang startup', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-workspace-mcp-auth-'));
    roots.push(rootDir);
    const controller = new AbortController();
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          markFetchStarted();
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        })
    );
    const service = new WorkspaceMcpAuthService('workspace' as WorkspaceId, 'user-1', logger, {
      store: new WorkspaceMcpCredentialStore({ rootDir }),
      fetch: fetchMock as typeof fetch,
      providerRequestSignal: () => controller.signal,
    });

    const started = service.startOAuth(entry('linear'));
    await fetchStarted;
    controller.abort(new Error('provider request timed out'));
    await expect(started).resolves.toMatchObject({
      type: 'workspace-mcp/connection-error',
      code: 'provider_error',
    });
  });

  it('drains an in-flight OAuth start and rejects work after disposal', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-workspace-mcp-auth-'));
    roots.push(rootDir);
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchMock = vi.fn(async () => {
      markFetchStarted();
      await fetchGate;
      return new Response('unauthorized', {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource"',
        },
      });
    });
    const service = new WorkspaceMcpAuthService('workspace' as WorkspaceId, 'user-1', logger, {
      store: new WorkspaceMcpCredentialStore({ rootDir }),
      fetch: fetchMock as typeof fetch,
    });

    const started = service.startOAuth(entry('linear'));
    const startResult = expect(started).rejects.toThrow('authorization service is disposed');
    await fetchStarted;
    const disposed = service.dispose();
    releaseFetch();

    await startResult;
    await disposed;
    await expect(service.startOAuth(entry('linear'))).rejects.toThrow(
      'authorization service is disposed'
    );
    await expect(service.resolveConnection(entry('linear'))).rejects.toThrow(
      'authorization service is disposed'
    );
  });

  it.each(['disconnect', 'orphan cleanup'] as const)(
    'does not restore credentials when %s wins a callback race',
    async (cleanupKind) => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-workspace-mcp-auth-'));
      roots.push(rootDir);
      let registeredRedirect = '';
      let markTokenStarted!: () => void;
      const tokenStarted = new Promise<void>((resolve) => {
        markTokenStarted = resolve;
      });
      let releaseToken!: () => void;
      const tokenGate = new Promise<void>((resolve) => {
        releaseToken = resolve;
      });
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.href === 'https://mcp.linear.app/.well-known/oauth-protected-resource') {
          return Response.json({
            resource: 'https://mcp.linear.app/mcp/readonly',
            authorization_servers: ['https://mcp.linear.app'],
          });
        }
        if (url.href === 'https://mcp.linear.app/.well-known/oauth-authorization-server') {
          return Response.json({
            issuer: 'https://mcp.linear.app',
            authorization_endpoint: 'https://mcp.linear.app/authorize',
            token_endpoint: 'https://mcp.linear.app/token',
            registration_endpoint: 'https://mcp.linear.app/register',
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
          });
        }
        if (url.href === 'https://mcp.linear.app/register') {
          const body = JSON.parse(String(init?.body)) as { redirect_uris: string[] };
          registeredRedirect = body.redirect_uris[0] ?? '';
          return Response.json({
            client_id: 'dynamic-client',
            redirect_uris: body.redirect_uris,
            token_endpoint_auth_method: 'none',
          });
        }
        if (url.href === 'https://mcp.linear.app/token') {
          markTokenStarted();
          await tokenGate;
          return Response.json({
            access_token: 'late-access-token',
            refresh_token: 'late-refresh-token',
            token_type: 'Bearer',
            expires_in: 3600,
          });
        }
        if (url.hostname === 'mcp.linear.app') {
          return new Response('unauthorized', {
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource"',
            },
          });
        }
        throw new Error(`Unexpected fetch: ${url.href}`);
      });
      const service = new WorkspaceMcpAuthService('workspace' as WorkspaceId, 'user-1', logger, {
        store: new WorkspaceMcpCredentialStore({ rootDir }),
        fetch: fetchMock as typeof fetch,
      });
      const started = await service.startOAuth(entry('linear'));
      if (started.type !== 'workspace-mcp/oauth-started') throw new Error('OAuth did not start');
      const authorizationUrl = new URL(started.authorizationUrl);
      const callback = new URL(registeredRedirect);
      callback.searchParams.set('code', 'authorization-code');
      callback.searchParams.set('state', authorizationUrl.searchParams.get('state') ?? '');
      const callbackPromise = fetch(callback);
      await tokenStarted;
      const cleanupPromise =
        cleanupKind === 'disconnect'
          ? service.disconnect(entry('linear'))
          : service.removeOrphanedBindings(new Set());
      await Promise.resolve();
      releaseToken();

      if (cleanupKind === 'disconnect') {
        await expect(cleanupPromise).resolves.toMatchObject({ state: 'not_connected' });
      } else {
        await expect(cleanupPromise).resolves.toBeUndefined();
      }
      await expect(callbackPromise).resolves.toMatchObject({ status: 500 });
      if (cleanupKind === 'disconnect') {
        await expect(service.resolveConnection(entry('linear'))).resolves.toBeNull();
      } else {
        await expect(service.resolveConnection(entry('linear'))).rejects.toThrow(
          'no longer in the catalog'
        );
      }
    }
  );

  it('aborts and drains an in-flight connection test during disposal', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-workspace-mcp-auth-'));
    roots.push(rootDir);
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          markFetchStarted();
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        })
    );
    const service = new WorkspaceMcpAuthService('workspace' as WorkspaceId, 'user-1', logger, {
      store: new WorkspaceMcpCredentialStore({ rootDir }),
      fetch: fetchMock as typeof fetch,
    });
    await service.setSecretUrl(entry('feishu'), 'https://mcp.feishu.cn/connect/test-secret');

    const testing = service.test(entry('feishu'));
    const testResult = expect(testing).rejects.toThrow('authorization service is disposed');
    await fetchStarted;
    const disposed = service.dispose();

    await testResult;
    await disposed;
  });

  it('aborts and drains an in-flight connection test during orphan cleanup', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-workspace-mcp-auth-'));
    roots.push(rootDir);
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          markFetchStarted();
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        })
    );
    const service = new WorkspaceMcpAuthService('workspace' as WorkspaceId, 'user-1', logger, {
      store: new WorkspaceMcpCredentialStore({ rootDir }),
      fetch: fetchMock as typeof fetch,
    });
    await service.setSecretUrl(entry('feishu'), 'https://mcp.feishu.cn/connect/test-secret');

    const testing = service.test(entry('feishu'));
    const testResult = expect(testing).rejects.toThrow('no longer in the catalog');
    await fetchStarted;
    const cleanup = service.removeOrphanedBindings(new Set());

    await testResult;
    await cleanup;
  });

  it('aborts and drains an in-flight connection test during disconnect', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-workspace-mcp-auth-'));
    roots.push(rootDir);
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          markFetchStarted();
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        })
    );
    const service = new WorkspaceMcpAuthService('workspace' as WorkspaceId, 'user-1', logger, {
      store: new WorkspaceMcpCredentialStore({ rootDir }),
      fetch: fetchMock as typeof fetch,
    });
    const feishuEntry = entry('feishu');
    await service.setSecretUrl(feishuEntry, 'https://mcp.feishu.cn/connect/test-secret');

    const testing = service.test(feishuEntry);
    const testResult = expect(testing).rejects.toThrow('being disconnected');
    await fetchStarted;
    const disconnected = service.disconnect(feishuEntry);

    await testResult;
    await expect(disconnected).resolves.toMatchObject({ state: 'not_connected' });
    await expect(service.resolveConnection(feishuEntry)).resolves.toBeNull();
  });

  it('blocks a late refresh after orphan cleanup has taken its snapshot', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'lody-workspace-mcp-auth-'));
    roots.push(rootDir);
    const store = new WorkspaceMcpCredentialStore({ rootDir });
    await store.set('user-1:workspace:linear-entry', {
      kind: 'oauth',
      tokens: {
        access_token: 'expired-access-token',
        refresh_token: 'refresh-token',
        token_type: 'Bearer',
        expires_in: 1,
      },
      redirectUrl: 'http://127.0.0.1:12345/oauth/callback',
      authorizationFingerprint: JSON.stringify({
        providerId: 'linear',
        presetVersion: 1,
        accessProfile: 'readonly',
        publicOptions: {},
        endpoint: 'https://mcp.linear.app/mcp/readonly',
        oauthResource: 'https://mcp.linear.app/mcp/readonly',
        issuer: 'https://mcp.linear.app',
      }),
      credentialId: 'old-credential',
      savedAt: 1,
      connectedAt: 1,
    });
    let markDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => {
      markDeleteStarted = resolve;
    });
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const realDelete = store.delete.bind(store);
    vi.spyOn(store, 'delete').mockImplementation(async (key) => {
      markDeleteStarted();
      await deleteGate;
      await realDelete(key);
    });
    const fetchMock = vi.fn(async () => {
      throw new Error('A tombstoned connector must not refresh.');
    });
    const service = new WorkspaceMcpAuthService('workspace' as WorkspaceId, 'user-1', logger, {
      store,
      fetch: fetchMock as typeof fetch,
      now: () => 100_000,
    });

    const cleanup = service.removeOrphanedBindings(new Set());
    await deleteStarted;
    await expect(service.resolveConnection(entry('linear'))).rejects.toThrow(
      'no longer in the catalog'
    );
    expect(fetchMock).not.toHaveBeenCalled();
    releaseDelete();
    await cleanup;
    await expect(store.get('user-1:workspace:linear-entry')).resolves.toBeUndefined();
  });
});

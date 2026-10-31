import { PassThrough, Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Effect, ManagedRuntime } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { McpAuthenticationLegacy } from './legacy';
import type { WorkspaceMcpServerMeta } from '@lody/shared';
import { McpAuthentication, mcpAuthenticationLayer, type McpCredentialStore } from './service';
import {
  boundedMcpFetch,
  makeMcpAuthenticationIO,
  type McpCallback,
  type McpRelayRequest,
} from './io';

const entry: WorkspaceMcpServerMeta = {
  id: 'synthetic' as WorkspaceMcpServerMeta['id'],
  name: 'Synthetic',
  transport: 'http',
  connection: { transport: 'http', url: 'https://resource.example/mcp', authentication: 'local' },
  createdAt: 1,
  updatedAt: 1,
};
const challenge = () =>
  new Response(null, {
    status: 401,
    headers: {
      'WWW-Authenticate':
        'Bearer resource_metadata="https://resource.example/.well-known/oauth-protected-resource/mcp"',
    },
  });

function fixture() {
  const records = new Map<string, string>();
  const saved = Promise.withResolvers<void>();
  const callback = Promise.withResolvers<McpCallback>();
  const callbackWaiting = Promise.withResolvers<void>();
  const remoteHeaders: Headers[] = [];
  const refreshed = new Set<string>();
  let offer: ((job: McpRelayRequest) => boolean) | undefined;
  let closedCallbacks = 0;
  let closedRelays = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(init?.redirect).toBe('error');
    expect(init?.credentials).toBe('omit');
    if (url.pathname.includes('oauth-protected-resource'))
      return Response.json({
        resource: 'https://resource.example/mcp',
        authorization_servers: ['https://issuer.example'],
        scopes_supported: ['tools'],
      });
    if (url.pathname.includes('oauth-authorization-server'))
      return Response.json({
        issuer: 'https://issuer.example',
        authorization_endpoint: 'https://issuer.example/authorize',
        token_endpoint: 'https://issuer.example/token',
        registration_endpoint: 'https://issuer.example/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (url.pathname === '/register')
      return Response.json({ ...JSON.parse(String(init?.body)), client_id: 'synthetic-client' });
    if (url.pathname === '/token') {
      const body = new URLSearchParams(String(init?.body));
      if (body.get('grant_type') === 'refresh_token') {
        const token = body.get('refresh_token') ?? '';
        if (refreshed.has(token)) throw new Error('Refresh token reused');
        refreshed.add(token);
        return Response.json({
          access_token: 'rotated-access',
          token_type: 'Bearer',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
        });
      }
      expect(body.get('code')).toBe('synthetic-code');
      expect(body.get('code_verifier')?.length).toBeGreaterThanOrEqual(43);
      expect(body.get('resource')).toBe('https://resource.example/mcp');
      return Response.json({
        access_token: 'private-access',
        token_type: 'Bearer',
        refresh_token: 'private-refresh',
        expires_in: 0,
      });
    }
    remoteHeaders.push(new Headers(init?.headers));
    return Response.json({ tools: ['synthetic_tool'] });
  };
  const store: McpCredentialStore = {
    read: (key) => Effect.sync(() => records.get(key)),
    write: (key, value) =>
      Effect.sync(() => {
        records.set(key, value);
        saved.resolve();
      }),
    remove: (key) =>
      Effect.sync(() => {
        records.delete(key);
      }),
  };
  const io = {
    ...makeMcpAuthenticationIO(fetcher),
    callback: async () => ({
      redirectUrl: 'http://127.0.0.1:12345/callback',
      wait: (signal: AbortSignal) => {
        callbackWaiting.resolve();
        return new Promise<McpCallback>((resolve, reject) => {
          const abort = () => reject(new Error('cancelled'));
          signal.addEventListener('abort', abort, { once: true });
          callback.promise
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', abort));
          if (signal.aborted) abort();
        });
      },
      close: async () => {
        closedCallbacks++;
      },
    }),
    relay: async (accept: (job: McpRelayRequest) => boolean) => {
      offer = accept;
      return {
        url: 'http://127.0.0.1:12346/mcp',
        capability: 'session-capability',
        close: async () => {
          closedRelays++;
        },
      };
    },
  };
  const runtime = ManagedRuntime.make(
    mcpAuthenticationLayer({ namespace: 'owner/machine/workspace', userId: 'owner', store, io })
  );
  const run = <A>(f: (service: McpAuthentication['Service']) => Effect.Effect<A, unknown>) =>
    runtime.runPromise(Effect.flatMap(McpAuthentication, f));
  const grant = async () => {
    const waiting = await run((service) => service.authorize(entry));
    await callbackWaiting.promise;
    const url = new URL(waiting.authorizationUrl ?? '');
    expect(url.origin).toBe('https://issuer.example');
    expect(url.searchParams.get('state')?.length).toBeGreaterThanOrEqual(32);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    callback.resolve({ code: 'synthetic-code' });
    await saved.promise;
    return run((service) => service.headers(entry));
  };
  return {
    records,
    saved,
    callback,
    callbackWaiting,
    remoteHeaders,
    refreshed,
    store,
    io,
    runtime,
    run,
    grant,
    closedCallbacks: () => closedCallbacks,
    closedRelays: () => closedRelays,
    offer: (job: McpRelayRequest) => offer?.(job),
  };
}

describe('local MCP authentication', () => {
  it('binds local credentials to the expanded destination when an environment reference changes', async () => {
    const f = fixture();
    const facade = new McpAuthenticationLegacy({
      machineId: 'machine',
      workspaceId: 'workspace',
      userId: 'owner',
      store: f.store,
      io: f.io,
    });
    const authored = {
      ...entry,
      connection: {
        transport: 'http' as const,
        url: 'https://${MCP_HOST}/mcp',
        authentication: 'local' as const,
      },
    };
    try {
      vi.stubEnv('MCP_HOST', 'resource.example');
      await facade.request({
        machineId: 'machine',
        workspaceId: 'workspace',
        method: 'mcp/authentication',
        params: {
          server: authored,
          requesterUserId: 'owner',
          action: 'configure',
          authentication: { mode: 'manual', bearerToken: 'private-token' },
        },
      });
      vi.stubEnv('MCP_HOST', 'other.example');
      expect(await facade.status(authored)).toMatchObject({
        hasCredentials: false,
        status: 'required',
      });
      await expect(
        facade.prepare(
          authored,
          { type: 'http', name: authored.name, url: 'https://other.example/mcp', headers: [] },
          'runtime',
          'owner'
        )
      ).rejects.toThrow('oauth_required');
      expect(f.remoteHeaders).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await facade.close();
      await f.runtime.dispose();
    }
  });
  it('rejects another UI account before reading or configuring the daemon account’s vault', async () => {
    const f = fixture();
    const facade = new McpAuthenticationLegacy({
      machineId: 'machine',
      workspaceId: 'workspace',
      userId: 'owner',
      store: f.store,
      io: f.io,
    });
    try {
      await expect(
        facade.request({
          machineId: 'machine',
          workspaceId: 'workspace',
          method: 'mcp/authentication',
          params: { server: entry, requesterUserId: 'other', action: 'status' },
        })
      ).rejects.toThrow('account mismatch');
      await expect(facade.listTools(entry, 'other')).rejects.toThrow('account mismatch');
      expect(f.records.size).toBe(0);
    } finally {
      await facade.close();
      await f.runtime.dispose();
    }
  });
  it('requires a validated OAuth challenge and does not turn a plain 401 or 403 into a login prompt', async () => {
    const f = fixture();
    const anonymous = {
      ...entry,
      connection: { transport: 'http' as const, url: 'https://resource.example/mcp' },
    };
    try {
      for (const response of [
        new Response(null, { status: 401 }),
        new Response(null, { status: 403 }),
      ]) {
        await f.run((service) => service.observe(anonymous, response));
        expect(await f.run((service) => service.status(anonymous))).toMatchObject({
          status: 'unknown',
        });
      }
      await f.run((service) => service.observe(anonymous, challenge()));
      expect(await f.run((service) => service.status(anonymous))).toMatchObject({
        status: 'required',
        reason: 'oauth_required',
      });
      expect(f.records.size).toBe(0);
    } finally {
      await f.runtime.dispose();
    }
  });

  it('exchanges the real SDK PKCE flow and serializes rotated refresh tokens before reuse', async () => {
    const f = fixture();
    try {
      await f.grant();
      const headers = await Promise.all([
        f.run((service) => service.headers(entry)),
        f.run((service) => service.headers(entry)),
      ]);
      expect(headers).toEqual([
        { authorization: 'Bearer rotated-access' },
        { authorization: 'Bearer rotated-access' },
      ]);
      expect([...f.refreshed]).toEqual(['private-refresh']);
      expect(
        [...f.records.values()].map((value) => JSON.parse(value).tokens.refresh_token)
      ).toEqual(['rotated-refresh']);
      expect(await f.run((service) => service.status(entry))).toMatchObject({
        status: 'authorized',
        hasCredentials: true,
      });
      expect(f.closedCallbacks()).toBe(1);
    } finally {
      await f.runtime.dispose();
    }
  });

  it('joins cancellation and discards a callback delivered after cancellation', async () => {
    const f = fixture();
    try {
      const waiting = await f.run((service) => service.authorize(entry));
      await f.callbackWaiting.promise;
      await f.run((service) => service.cancel(entry, waiting.attemptId));
      f.callback.resolve({ code: 'synthetic-code' });
      expect(f.records.size).toBe(0);
      expect(f.closedCallbacks()).toBe(1);
      expect(await f.run((service) => service.status(entry))).toMatchObject({
        status: 'required',
        reason: 'cancelled',
      });
    } finally {
      await f.runtime.dispose();
    }
  });

  it('keeps an earlier local sign-in when a replacement authorization is cancelled', async () => {
    const f = fixture();
    try {
      await f.run((service) =>
        service.configure(entry, { mode: 'manual', bearerToken: 'earlier-private-token' })
      );
      const waiting = await f.run((service) => service.authorize(entry));
      await f.run((service) => service.cancel(entry, waiting.attemptId));
      expect(await f.run((service) => service.headers(entry))).toEqual({
        authorization: 'Bearer earlier-private-token',
      });
      expect(await f.run((service) => service.status(entry))).toMatchObject({
        status: 'authorized',
        hasCredentials: true,
        mode: 'manual',
      });
    } finally {
      await f.runtime.dispose();
    }
  });

  it('discards token exchange results that arrive after an attempt was cancelled', async () => {
    const f = fixture();
    const exchanging = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Awaited<ReturnType<typeof f.io.authorize>>>();
    const authorize = f.io.authorize;
    f.io.authorize = async (record, options) => {
      if (!options.code) return authorize(record, options);
      exchanging.resolve();
      return late.promise;
    };
    try {
      const waiting = await f.run((service) => service.authorize(entry));
      f.callback.resolve({ code: 'synthetic-code' });
      await exchanging.promise;
      await f.run((service) => service.cancel(entry, waiting.attemptId));
      late.resolve({
        record: {
          target: JSON.stringify(entry.connection),
          settings: { mode: 'oauth' },
          tokens: { access_token: 'late-private-token', token_type: 'Bearer' },
        },
      });
      await late.promise;
      expect(await f.run((service) => service.status(entry))).toMatchObject({
        status: 'required',
        hasCredentials: false,
      });
      expect(f.records.size).toBe(0);
      expect(f.closedCallbacks()).toBe(1);
    } finally {
      await f.runtime.dispose();
    }
  });

  it('isolates destinations and principals, and revokes session connections on sign-out', async () => {
    const f = fixture();
    try {
      await f.run((service) =>
        service.configure(entry, { mode: 'manual', bearerToken: 'private-token' })
      );
      const resolved = {
        type: 'http' as const,
        name: entry.name,
        url: 'https://resource.example/mcp',
        headers: [],
      };
      const connection = await f.run((service) =>
        service.prepare(entry, resolved, 'session-instance', 'owner')
      );
      expect(JSON.stringify(connection)).not.toContain('private-token');
      await expect(
        f.run((service) => service.prepare(entry, resolved, 'foreign-session', 'another-user'))
      ).rejects.toThrow('oauth_required');
      const changed = {
        ...entry,
        connection: {
          transport: 'http' as const,
          url: 'https://other.example/mcp',
          authentication: 'local' as const,
        },
      };
      await expect(f.run((service) => service.headers(changed))).rejects.toThrow('oauth_required');
      const other = ManagedRuntime.make(
        mcpAuthenticationLayer({
          namespace: 'other/machine/workspace',
          userId: 'other',
          store: f.store,
          io: f.io,
        })
      );
      try {
        expect(
          await other.runPromise(
            Effect.flatMap(McpAuthentication, (service) => service.status(entry))
          )
        ).toMatchObject({ status: 'required', hasCredentials: false });
      } finally {
        await other.dispose();
      }

      const request = Object.assign(Readable.from(['{}']), {
        method: 'POST',
        headers: {
          authorization: 'Bearer session-capability',
          'content-type': 'application/json',
          cookie: 'private-cookie',
        },
      }) as unknown as IncomingMessage;
      const response = Object.assign(new PassThrough(), {
        headersSent: false,
        writeHead: () => response,
      }) as unknown as ServerResponse;
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      const finished = Promise.withResolvers<void>();
      response.once('finish', () => finished.resolve());
      expect(f.offer({ request, response })).toBe(true);
      await finished.promise;
      expect(Buffer.concat(chunks).toString()).toContain('synthetic_tool');
      expect(f.remoteHeaders[0]?.get('authorization')).toBe('Bearer private-token');
      expect(f.remoteHeaders[0]?.get('cookie')).toBeNull();
      await f.run((service) => service.signout(entry));
      expect(f.closedRelays()).toBe(1);
      expect(f.records.size).toBe(0);
      await f.run((service) => service.release('session-instance'));
      await expect(
        f.run((service) => service.prepare(entry, resolved, 'session-instance', 'owner'))
      ).rejects.toThrow('cancelled');
    } finally {
      await f.runtime.dispose();
    }
  });

  it('refuses credential-bearing redirects and insecure authorization endpoints', async () => {
    const visited: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      visited.push(String(input));
      expect(init?.redirect).toBe('error');
      return new Response(null, { status: 302, headers: { location: 'https://other.example' } });
    };
    const fetchBounded = boundedMcpFetch(fetcher, new AbortController().signal);
    await expect(fetchBounded('http://issuer.example/token')).rejects.toThrow('requires HTTPS');
    await expect(fetchBounded('https://user:secret@issuer.example/token')).rejects.toThrow(
      'requires HTTPS'
    );
    expect((await fetchBounded('https://issuer.example/token')).status).toBe(302);
    expect(visited).toEqual(['https://issuer.example/token']);
  });

  it('does not send a pre-registered client secret or refresh token to a changed issuer', async () => {
    const f = fixture();
    const sent: string[] = [];
    const io = makeMcpAuthenticationIO(async (input, init) => {
      sent.push(String(input) + String(init?.body ?? ''));
      return f.io.fetch(input, init);
    });
    try {
      await expect(
        io.authorize(
          {
            target: 'synthetic',
            settings: {
              mode: 'oauth',
              clientId: 'synthetic-client',
              clientSecret: 'private-client-secret',
            },
            client: { client_id: 'synthetic-client', issuer: 'https://old-issuer.example' },
            tokens: {
              access_token: 'private-access',
              token_type: 'Bearer',
              refresh_token: 'private-refresh',
              issuer: 'https://old-issuer.example',
            },
          },
          { url: 'https://resource.example/mcp', signal: new AbortController().signal }
        )
      ).rejects.toThrow('authorization server changed');
      expect(sent.join('\n')).not.toContain('private-client-secret');
      expect(sent.join('\n')).not.toContain('private-refresh');
    } finally {
      await f.runtime.dispose();
    }
  });
});

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  auth,
  checkResourceAllowed,
  resourceUrlFromServerUrl,
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthServerInfo,
} from '@modelcontextprotocol/client';
import { McpLocalAuthenticationSchema } from '@lody/shared';
import { z } from 'zod';
import { canReadProcNetTcp, lookupLoopbackPeerUid } from '../loopback-peer-uid';

export const McpStoredAuthenticationSchema = z.object({
  target: z.string(),
  settings: McpLocalAuthenticationSchema,
  client: z
    .object({
      client_id: z.string(),
      client_secret: z.string().optional(),
      issuer: z.string().optional(),
      client_secret_expires_at: z.number().optional(),
    })
    .optional(),
  tokens: z
    .object({
      access_token: z.string(),
      token_type: z.string().refine((type) => type.toLowerCase() === 'bearer'),
      refresh_token: z.string().optional(),
      expires_in: z.number().nonnegative().optional(),
      scope: z.string().optional(),
      issuer: z.string().optional(),
    })
    .optional(),
  expiresAt: z.number().optional(),
});
export type McpStoredAuthentication = z.infer<typeof McpStoredAuthenticationSchema>;
export type McpCallback = { code: string; iss?: string };
export type McpCallbackEndpoint = {
  redirectUrl: string;
  wait(signal: AbortSignal): Promise<McpCallback>;
  close(): Promise<void>;
};
export type McpRelayRequest = { request: IncomingMessage; response: ServerResponse; body?: Buffer };
export type McpRelayEndpoint = { url: string; capability: string; close(): Promise<void> };

export interface McpAuthenticationIO {
  fetch: typeof fetch;
  discover(
    url: string,
    resourceMetadataUrl: URL | undefined,
    signal: AbortSignal
  ): Promise<OAuthServerInfo>;
  callback(state: string): Promise<McpCallbackEndpoint>;
  authorize(
    record: McpStoredAuthentication,
    options: {
      url: string;
      redirectUrl?: string;
      state?: string;
      verifier?: string;
      discovery?: OAuthDiscoveryState;
      code?: string;
      iss?: string;
      signal: AbortSignal;
    }
  ): Promise<{
    record: McpStoredAuthentication;
    url?: string;
    verifier?: string;
    discovery?: OAuthDiscoveryState;
  }>;
  relay(offer: (request: McpRelayRequest) => boolean): Promise<McpRelayEndpoint>;
  forward(
    job: McpRelayRequest,
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal
  ): Promise<Response | undefined>;
}

/** OAuth and MCP redirects must never carry credentials to a different destination. */
export function boundedMcpFetch(forward: typeof fetch, signal: AbortSignal): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    ) {
      return Promise.reject(new Error('MCP authorization requires HTTPS or a loopback endpoint.'));
    }
    return forward(input, {
      ...init,
      redirect: 'error',
      credentials: 'omit',
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    });
  };
}

const listen = (server: ReturnType<typeof createServer>) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string')
        return reject(new Error('MCP listener could not start.'));
      resolve(address.port);
    });
  });
const closeServer = (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) =>
      error ? reject(new Error('MCP listener cleanup failed.')) : resolve()
    );
    server.closeAllConnections();
  });

async function callbackEndpoint(state: string): Promise<McpCallbackEndpoint> {
  let deliver: (value: McpCallback) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const result = new Promise<McpCallback>((resolve, reject) => {
    deliver = resolve;
    fail = reject;
  });
  void result.catch(() => undefined);
  let claimed = false;
  let port = 0;
  const server = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    if (request.method !== 'GET' || request.headers.host !== `127.0.0.1:${port}`) {
      response.writeHead(400).end('Invalid authorization callback.');
      return;
    }
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    const code = url.searchParams.get('code');
    if (url.pathname !== '/callback' || url.searchParams.get('state') !== state || claimed) {
      response.writeHead(400).end('Authorization was not completed. Return to Lody to continue.');
      return;
    }
    if (url.searchParams.has('error')) {
      claimed = true;
      fail(new Error('MCP authorization was declined.'));
      response.end('Authorization was not completed. Return to Lody to continue.');
      return;
    }
    if (!code || code.length > 4096) {
      response.writeHead(400).end('Invalid authorization callback.');
      return;
    }
    claimed = true;
    const iss = url.searchParams.get('iss');
    deliver({ code, ...(iss && iss.length <= 2048 ? { iss } : {}) });
    response.end('Authorization received. You can return to Lody.');
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  try {
    port = await listen(server);
  } catch {
    await closeServer(server).catch(() => undefined);
    throw new Error('MCP authorization callback could not start.');
  }
  let closing: Promise<void> | undefined;
  return {
    redirectUrl: `http://127.0.0.1:${port}/callback`,
    wait: (signal) =>
      new Promise((resolve, reject) => {
        const abort = () => reject(new Error('MCP authorization cancelled.'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        result.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      }),
    close: () => {
      if (closing) return closing;
      fail(new Error('MCP authorization ended.'));
      closing = closeServer(server);
      return closing;
    },
  };
}

async function relayEndpoint(offer: (job: McpRelayRequest) => boolean): Promise<McpRelayEndpoint> {
  if (process.platform === 'linux' && (!process.getuid || !canReadProcNetTcp()))
    throw new Error('MCP local connection cannot verify process ownership.');
  const capability = randomBytes(32).toString('base64url');
  const expected = Buffer.from(`Bearer ${capability}`);
  let port = 0;
  const server = createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (
      request.headers.origin ||
      request.headers.host !== `127.0.0.1:${port}` ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.url !== '/mcp' || !['POST', 'GET', 'DELETE'].includes(request.method ?? '')) {
      response.writeHead(405).end();
      return;
    }
    const accept = async () => {
      if (process.platform === 'linux') {
        const socket = request.socket;
        const { remoteAddress, remotePort, localAddress, localPort } = socket;
        if (!remoteAddress || !remotePort || !localAddress || !localPort) {
          response.writeHead(403).end();
          return;
        }
        const uid = await lookupLoopbackPeerUid({
          peerAddress: remoteAddress,
          peerPort: remotePort,
          serverAddress: localAddress,
          serverPort: localPort,
        });
        if (uid === null || uid !== process.getuid?.()) {
          response.writeHead(403).end();
          return;
        }
      }
      if (!response.destroyed && !offer({ request, response }))
        response.writeHead(503).end('MCP connection is busy.');
    };
    void accept().catch(() => {
      if (!response.destroyed) response.writeHead(403).end();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxHeadersCount = 40;
  try {
    port = await listen(server);
  } catch {
    await closeServer(server).catch(() => undefined);
    throw new Error('MCP connection could not start.');
  }
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    capability,
    close: () => (closing ??= closeServer(server)),
  };
}

export function makeMcpAuthenticationIO(forward: typeof fetch = fetch): McpAuthenticationIO {
  return {
    fetch: forward,
    discover: async (url, resourceMetadataUrl, signal) => {
      const info = await discoverOAuthServerInfo(url, {
        resourceMetadataUrl,
        fetchFn: boundedMcpFetch(forward, AbortSignal.any([signal, AbortSignal.timeout(15_000)])),
      });
      if (
        info.resourceMetadata &&
        !checkResourceAllowed({
          requestedResource: resourceUrlFromServerUrl(url),
          configuredResource: info.resourceMetadata.resource,
        })
      )
        throw new Error('MCP resource metadata does not match this service.');
      return info;
    },
    callback: callbackEndpoint,
    relay: relayEndpoint,
    authorize: async (source, options) => {
      const record = structuredClone(source);
      let redirect: string | undefined;
      let verifier = options.verifier;
      let discovery = options.discovery;
      const provider: OAuthClientProvider = {
        redirectUrl: options.redirectUrl,
        clientMetadata: {
          client_name: 'Lody',
          redirect_uris: options.redirectUrl ? [options.redirectUrl] : [],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: record.settings.clientSecret ? 'client_secret_post' : 'none',
        },
        state: () => options.state ?? '',
        clientInformation: (context) => {
          if (
            context &&
            [source.client?.issuer, source.tokens?.issuer].some(
              (issuer) => issuer !== undefined && issuer !== context.issuer
            )
          )
            throw new Error('MCP authorization server changed. Configure authorization again.');
          if (record.settings.clientId)
            return (record.client = {
              client_id: record.settings.clientId,
              ...(record.settings.clientSecret
                ? { client_secret: record.settings.clientSecret }
                : {}),
              ...(context ? { issuer: context.issuer } : {}),
            });
          if (context && record.client?.issuer !== context.issuer && !options.redirectUrl)
            throw new Error('MCP authorization is required.');
          return !context || record.client?.issuer === context.issuer ? record.client : undefined;
        },
        saveClientInformation: (client) => {
          record.client = client;
        },
        tokens: (context) =>
          !context || record.tokens?.issuer === context.issuer ? record.tokens : undefined,
        saveTokens: (tokens) => {
          record.tokens = {
            ...tokens,
            ...(!tokens.refresh_token && !options.redirectUrl && record.tokens?.refresh_token
              ? { refresh_token: record.tokens.refresh_token }
              : {}),
          };
        },
        ...(!options.redirectUrl
          ? {
              prepareTokenRequest: () => {
                if (!record.tokens?.refresh_token)
                  throw new Error('MCP authorization is required.');
                return new URLSearchParams({
                  grant_type: 'refresh_token',
                  refresh_token: record.tokens.refresh_token,
                });
              },
            }
          : {}),
        redirectToAuthorization: (url) => {
          if (!options.redirectUrl) throw new Error('MCP authorization is required.');
          redirect = url.toString();
        },
        saveCodeVerifier: (value) => {
          verifier = value;
        },
        codeVerifier: () => {
          if (!verifier) throw new Error('MCP authorization attempt has ended.');
          return verifier;
        },
        discoveryState: () => discovery,
        saveDiscoveryState: (value) => {
          discovery = value;
        },
        invalidateCredentials: (scope) => {
          if (scope === 'all' || scope === 'client') record.client = undefined;
          if (scope === 'all' || scope === 'tokens') record.tokens = undefined;
          if (scope === 'all' || scope === 'verifier') verifier = undefined;
          if (scope === 'all' || scope === 'discovery') discovery = undefined;
        },
      };
      await auth(provider, {
        serverUrl: options.url,
        ...(options.code ? { authorizationCode: options.code, iss: options.iss } : {}),
        fetchFn: boundedMcpFetch(
          forward,
          AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
        ),
      });
      return { record, url: redirect, verifier, discovery };
    },
    forward: async (job, url, credentials, signal) => {
      const { request, response } = job;
      const disconnected = new AbortController();
      const abort = () => disconnected.abort();
      response.once('close', abort);
      const headers = new Headers(credentials);
      for (const name of [
        'accept',
        'content-type',
        'mcp-session-id',
        'mcp-protocol-version',
        'last-event-id',
      ]) {
        const value = request.headers[name];
        if (typeof value === 'string' && value.length <= 8192) headers.set(name, value);
      }
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        if (request.method === 'POST' && job.body === undefined)
          for await (const chunk of request) {
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += part.length;
            if (bytes > 8 * 1024 * 1024) throw new Error('MCP request is too large.');
            chunks.push(part);
          }
        if (request.method === 'POST' && job.body === undefined) job.body = Buffer.concat(chunks);
        const result = await forward(url, {
          method: request.method,
          headers,
          ...(job.body ? { body: new Uint8Array(job.body).buffer } : {}),
          signal: AbortSignal.any([signal, disconnected.signal]),
          redirect: 'error',
          credentials: 'omit',
        });
        if (!result.ok) {
          await result.body?.cancel();
          return result;
        }
        const outgoing = new Headers({ 'cache-control': 'no-store' });
        for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version']) {
          const value = result.headers.get(name);
          if (value) outgoing.set(name, value);
        }
        response.writeHead(result.status, Object.fromEntries(outgoing));
        if (result.body)
          await pipeline(Readable.fromWeb(result.body as never), response, {
            signal: AbortSignal.any([signal, disconnected.signal]),
          });
        else response.end();
        return undefined;
      } finally {
        response.removeListener('close', abort);
      }
    },
  };
}

export const mcpOAuthChallenge = (response: Response): URL | undefined => {
  if (response.status !== 401 || !/^Bearer\s/i.test(response.headers.get('www-authenticate') ?? ''))
    return undefined;
  return extractWWWAuthenticateParams(response).resourceMetadataUrl;
};

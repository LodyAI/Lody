import http, { type AddressInfo } from 'node:http';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  DEFAULT_PREVIEW_RESOURCE_LIMITS,
  type PreviewResourceLimits,
  type PreviewTarget,
  type SessionId,
} from '@lody/shared';
import { LocalPreviewProxyManager } from './local-preview-proxy';
import { verifyPreviewTunnelRoundTrip } from './preview-tunnel-readiness';

const createLogger = () => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  setDebug: () => {},
  child: () => createLogger(),
  close: () => {},
});

const listenHtmlServer = async (
  checkFetchMetadata = false
): Promise<{
  server: http.Server;
  target: PreviewTarget;
  requestUrls: string[];
  styleReferers: Array<string | undefined>;
}> => {
  const requestUrls: string[] = [];
  const styleReferers: Array<string | undefined> = [];
  const server = http.createServer((request, response) => {
    requestUrls.push(request.url ?? '');
    // Astro's dev server permits navigations but rejects cross-site subresources.
    if (
      checkFetchMetadata &&
      request.headers['sec-fetch-site'] === 'cross-site' &&
      !['navigate', 'nested-navigate', 'websocket'].includes(
        String(request.headers['sec-fetch-mode'])
      )
    ) {
      response.writeHead(403, { 'content-type': 'text/plain' });
      response.end('Cross-origin request blocked');
      return;
    }
    if (request.url?.startsWith('/external-redirect')) {
      response.writeHead(302, { location: 'https://example.com/outside' });
      response.end();
      return;
    }
    if (request.url?.startsWith('/@tanstack-start/styles.css')) {
      styleReferers.push(request.headers.referer);
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      response.end('body { color: rgb(1, 2, 3); }');
      return;
    }
    if (request.url?.startsWith('/@react-refresh')) {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      response.end('export const RefreshRuntime = {};');
      return;
    }
    if (request.url?.startsWith('/DownloadPage.vue')) {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      response.end('.download { display: block; }');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<html><body><button data-testid="cta">Review</button></body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected HTTP server to listen on a TCP port');
  }
  return {
    server,
    target: {
      protocol: 'http',
      host: '127.0.0.1',
      port: (address as AddressInfo).port,
    },
    requestUrls,
    styleReferers,
  };
};

type ObservedClose = { code: number; reason: string };

const listenWebSocketServer = async (
  protocol?: string
): Promise<{
  server: http.Server;
  target: PreviewTarget;
  nextUpstreamSocket: () => Promise<WebSocket>;
}> => {
  const upstreamSockets: WebSocket[] = [];
  const pendingSockets: Array<(socket: WebSocket) => void> = [];
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<html><body>socket</body></html>');
  });
  const webSocketServer = new WebSocketServer({
    server,
    handleProtocols: protocol ? () => protocol : undefined,
  });
  webSocketServer.on('connection', (socket) => {
    upstreamSockets.push(socket);
    pendingSockets.shift()?.(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    target: { protocol: 'http', host: '127.0.0.1', port: address.port },
    nextUpstreamSocket: () =>
      new Promise<WebSocket>((resolve) => {
        const existing = upstreamSockets[0];
        if (existing) {
          resolve(existing);
          return;
        }
        pendingSockets.push(resolve);
      }),
  };
};

const openBrowserSocket = async (viewerUrl: string, protocols?: string[]): Promise<WebSocket> => {
  const socketUrl = new URL(viewerUrl);
  socketUrl.protocol = 'ws:';
  socketUrl.pathname = '/socket';
  const socket = new WebSocket(socketUrl, protocols);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
};

const observeClose = (socket: WebSocket): Promise<ObservedClose> =>
  new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
  });

describe('LocalPreviewProxyManager', () => {
  const servers: http.Server[] = [];
  const managers: LocalPreviewProxyManager[] = [];

  afterEach(async () => {
    await Promise.allSettled(managers.splice(0).map((manager) => manager.closeAll('test cleanup')));
    await Promise.allSettled(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      )
    );
  });

  async function fixture(
    listener: http.RequestListener,
    limits: Partial<PreviewResourceLimits> = {}
  ) {
    const server = http.createServer(listener);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const manager = new LocalPreviewProxyManager({ logger: createLogger() });
    managers.push(manager);
    return manager.acquire({
      sessionId: 'session-http-boundary' as SessionId,
      target: { protocol: 'http', host: '127.0.0.1', port: address.port },
      resourceLimits: { ...DEFAULT_PREVIEW_RESOURCE_LIMITS, ...limits },
    });
  }

  it.each([
    ['gzip', 'text/html'],
    ['br', 'application/json'],
  ])('decodes actual %s %s responses without stale encoding or length', async (encoding, type) => {
    const html = type === 'text/html';
    const original = html ? '<html><body>compressed preview</body></html>' : '{"value":"preview"}';
    const compressed = (encoding === 'gzip' ? gzipSync : brotliCompressSync)(original);
    let upstreamHeaders: http.IncomingHttpHeaders | undefined;
    const endpoint = await fixture((request, response) => {
      upstreamHeaders = request.headers;
      response.writeHead(200, {
        'content-type': type,
        'content-encoding': encoding,
        'content-length': compressed.length,
        etag: '"before-injection"',
      });
      response.end(compressed);
    });
    const response = await fetch(endpoint.viewerUrl, {
      headers: {
        'accept-encoding': 'gzip, br',
        'if-none-match': '"cached"',
        'if-modified-since': 'Tue, 05 May 2026 00:00:00 GMT',
        referer: 'https://attacker.example/app',
      },
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(upstreamHeaders?.['accept-encoding']).toBe('identity');
    expect(upstreamHeaders?.['if-none-match']).toBeUndefined();
    expect(upstreamHeaders?.['if-modified-since']).toBeUndefined();
    expect(upstreamHeaders?.referer).toBeUndefined();
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    if (html) {
      expect(body).toContain('compressed preview');
      expect(body).toContain('data-lody-visual-annotation-runtime="true"');
      expect(response.headers.get('etag')).toBeNull();
      expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
    } else {
      expect(body).toBe(original);
      expect(response.headers.get('content-length')).toBeNull();
    }
  });

  it.each([
    ['HEAD', 200],
    ['GET', 304],
  ] as const)(
    'preserves bodyless %s/%s responses without injecting HTML',
    async (method, status) => {
      let upstreamMethod: string | undefined;
      const endpoint = await fixture((request, response) => {
        upstreamMethod = request.method;
        response.writeHead(status, {
          'content-type': 'text/html',
          'content-length': '123',
          etag: '"unchanged"',
        });
        response.end();
      });
      const response = await fetch(endpoint.viewerUrl, { method });
      expect(upstreamMethod).toBe(method);
      expect(response.status).toBe(status);
      expect(await response.text()).toBe('');
      expect(response.headers.get('x-lody-preview-runtime')).toBeNull();
      expect(response.headers.get('etag')).toBe('"unchanged"');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  );

  it('forwards a binary upload at the limit and explicitly rejects an oversized upload before the origin', async () => {
    const received: Buffer[] = [];
    const endpoint = await fixture(
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const body = Buffer.concat(chunks);
          received.push(body);
          response.writeHead(200, { 'content-type': 'application/octet-stream' });
          response.end(body);
        });
      },
      { maxRequestBodyBytes: 3 }
    );
    const bytes = Buffer.from([0, 128, 255]);
    const accepted = await fetch(endpoint.viewerUrl, { method: 'POST', body: bytes });
    expect(accepted.status).toBe(200);
    expect(Buffer.from(await accepted.arrayBuffer())).toEqual(bytes);
    const rejected = await fetch(endpoint.viewerUrl, {
      method: 'POST',
      body: Buffer.from([0, 128, 255, 1]),
    });
    expect(rejected.status).toBe(502);
    expect(await rejected.text()).toContain('Preview request body exceeds 3 byte limit');
    expect(received).toEqual([bytes]);
  });

  it('cancels an unfinished origin response when its streamed body exceeds the limit', async () => {
    let overflow: () => void = () => {
      throw new Error('Origin has not started');
    };
    let originClosed: () => void = () => {
      throw new Error('Fixture not initialized');
    };
    const closed = new Promise<void>((resolve) => {
      originClosed = resolve;
    });
    const endpoint = await fixture(
      (_request, response) => {
        response.on('close', originClosed);
        overflow = () => {
          response.write(Buffer.from([255]));
        };
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.write(Buffer.from([0, 1, 128]));
        // Stay open: rejecting the viewer must cancel upstream, not wait for EOF.
      },
      { maxResponseBodyBytes: 3 }
    );
    const response = await fetch(endpoint.viewerUrl);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing streaming body');
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value).toEqual(Uint8Array.from([0, 1, 128]));
    overflow();
    await expect(reader.read()).rejects.toThrow();
    await closed;
  });

  it.each(['navigate', 'nested-navigate', 'cors', 'no-cors'])(
    'preserves dev-server navigation access and subresource rejection for %s',
    async (mode) => {
      const { server, target, requestUrls } = await listenHtmlServer(true);
      servers.push(server);
      const manager = new LocalPreviewProxyManager({ logger: createLogger() });
      managers.push(manager);
      const endpoint = await manager.acquire({
        sessionId: 'session-fetch-metadata' as SessionId,
        target,
      });
      // fetch() cannot simulate browser navigation: it overwrites Sec-Fetch-Mode.
      const request = (url: string) =>
        new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
          http
            .get(
              url,
              {
                headers: {
                  'Sec-Fetch-Site': 'cross-site',
                  'Sec-Fetch-Mode': mode,
                  'Sec-Fetch-Dest': 'iframe',
                },
              },
              (response) => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', (chunk: string) => {
                  body += chunk;
                });
                response.on('error', reject);
                response.on('end', () => resolve({ status: response.statusCode, body }));
              }
            )
            .on('error', reject);
        });

      const unauthorized = await request(new URL('/', endpoint.viewerUrl).toString());
      expect(unauthorized.status).toBe(403);
      expect(unauthorized.body).toContain('token is missing or invalid');
      expect(requestUrls).toEqual([]);

      const result = await request(endpoint.viewerUrl);
      if (mode === 'navigate' || mode === 'nested-navigate') {
        expect(result.status).toBe(200);
        expect(result.body).toContain('data-testid="cta"');
      } else {
        expect(result.status).toBe(403);
        expect(result.body).toBe('Cross-origin request blocked');
      }
    }
  );

  it('maps only the bound viewer Origin while preserving upstream HTTP and WS cross-site rejection', async () => {
    let localOrigin = '';
    const server = http.createServer((request, response) => {
      response.writeHead(request.headers.origin === localOrigin ? 200 : 403);
      response.end(JSON.stringify({ origin: request.headers.origin ?? null }));
    });
    servers.push(server);
    const websocketServer = new WebSocketServer({
      server,
      verifyClient: (info) => info.origin === localOrigin,
    });
    server.on('close', () => websocketServer.close());
    websocketServer.on('connection', (socket) => socket.close());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    localOrigin = `http://127.0.0.1:${address.port}`;
    const manager = new LocalPreviewProxyManager({ logger: createLogger() });
    managers.push(manager);
    const sessionId = 'session-bound-origin' as SessionId;
    const endpoint = await manager.acquire({
      sessionId,
      target: { protocol: 'http', host: '127.0.0.1', port: address.port },
      remote: true,
    });
    const viewerOrigin = 'https://origin-fixture.trycloudflare.com';
    manager.bindViewerOrigin(sessionId, viewerOrigin);
    for (const origin of [
      viewerOrigin,
      'https://other.trycloudflare.com',
      `${viewerOrigin}.evil.test`,
      'null',
      undefined,
    ]) {
      const headers = origin ? { origin } : {};
      const response = await fetch(endpoint.viewerUrl, { method: 'POST', headers });
      expect(response.status, origin).toBe(origin === viewerOrigin ? 200 : 403);
      expect(await response.json()).toEqual({
        origin: origin === viewerOrigin ? localOrigin : (origin ?? null),
      });
      const url = new URL(endpoint.viewerUrl);
      url.protocol = 'ws:';
      const socket = new WebSocket(url, { headers });
      const opened = await new Promise<boolean>((resolve) => {
        socket.once('open', () => resolve(true));
        socket.once('error', () => resolve(false));
      });
      expect(opened, origin).toBe(origin === viewerOrigin);
      socket.terminate();
    }
  });

  it('serves local preview HTML through an annotated ephemeral proxy endpoint', async () => {
    const { server, target, requestUrls, styleReferers } = await listenHtmlServer();
    servers.push(server);
    const manager = new LocalPreviewProxyManager({
      logger: createLogger(),
      now: () => 1_714_438_400_000,
    });
    managers.push(manager);

    const endpoint = await manager.acquire({
      sessionId: 'session-preview-proxy' as SessionId,
      target,
      shareUrl: 'https://session-preview.mylody.app',
    });

    expect(endpoint.kind).toBe('local-proxy');
    expect(endpoint.shareUrl).toBe('https://session-preview.mylody.app');
    expect(endpoint.capabilities).toEqual({ visualAnnotation: true, shareable: true });

    const assetUrl = new URL(
      '/@tanstack-start/styles.css?routes=__root__%2C%2F',
      endpoint.viewerUrl
    );
    const lockedAssetResponse = await fetch(assetUrl, {
      headers: {
        referer: new URL('/src/main.tsx', endpoint.viewerUrl).toString(),
      },
    });
    expect(lockedAssetResponse.status).toBe(403);

    const response = await fetch(endpoint.viewerUrl);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('data-lody-visual-annotation-runtime="true"');
    expect(html).toContain('window.__lodyVisualCommentInspector');

    const unauthenticatedAssetResponse = await fetch(assetUrl);
    expect(unauthenticatedAssetResponse.status).toBe(403);

    const referer = new URL(endpoint.viewerUrl);
    referer.pathname = '/DownloadPage.vue';
    referer.search = `?vue&type=style&index=0&lang.css&${referer.search.slice(1)}`;
    referer.hash = 'section';
    const refererAuthorizedAssetResponse = await fetch(assetUrl, {
      headers: {
        referer: referer.href,
      },
    });
    expect(refererAuthorizedAssetResponse.status).toBe(200);
    expect(await refererAuthorizedAssetResponse.text()).toContain('rgb(1, 2, 3)');
    expect(styleReferers).toEqual([
      `http://127.0.0.1:${target.port}/DownloadPage.vue?vue&type=style&index=0&lang.css#section`,
    ]);

    // Validate the actual forwarding marker on an unannotated response, not a
    // synthetic header fixture. The same check guards cloud tunnel readiness.
    await expect(
      verifyPreviewTunnelRoundTrip({
        publicUrl: endpoint.viewerUrl,
        target: { ...target, path: '/@tanstack-start/styles.css?routes=__root__%2C%2F' },
      })
    ).resolves.toBeUndefined();

    const reactRefreshUrl = new URL('/@react-refresh', endpoint.viewerUrl);
    const moduleChainAssetResponse = await fetch(reactRefreshUrl, {
      headers: {
        referer: new URL('/src/main.tsx', endpoint.viewerUrl).toString(),
      },
    });
    expect(moduleChainAssetResponse.status).toBe(403);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toBeTruthy();
    const cookieAuthorizedAsset = await fetch(reactRefreshUrl, {
      headers: { cookie: cookie ?? '' },
    });
    expect(cookieAuthorizedAsset.status).toBe(200);
    expect(await cookieAuthorizedAsset.text()).toContain('RefreshRuntime');

    const viteStyleUrl = new URL(
      '/DownloadPage.vue?vue&type=style&index=0&lang.css',
      endpoint.viewerUrl
    );
    const viteStyleResponse = await fetch(viteStyleUrl, {
      headers: { referer: endpoint.viewerUrl },
    });
    expect(viteStyleResponse.status).toBe(200);
    expect(await viteStyleResponse.text()).toContain('.download');
    expect(requestUrls).toContain('/DownloadPage.vue?vue&type=style&index=0&lang.css');

    const crossSiteAssetResponse = await fetch(reactRefreshUrl, {
      headers: {
        referer: 'https://attacker.example/app',
      },
    });
    expect(crossSiteAssetResponse.status).toBe(403);

    await manager.release('session-preview-proxy' as SessionId, endpoint.endpointId);
    await expect(fetch(endpoint.viewerUrl)).rejects.toThrow();
  });

  it('keeps one session-owned proxy endpoint until it is explicitly released', async () => {
    const { server, target } = await listenHtmlServer();
    servers.push(server);
    const manager = new LocalPreviewProxyManager({ logger: createLogger() });
    managers.push(manager);
    const sessionId = 'session-preview-navigation' as SessionId;

    const first = await manager.acquire({ sessionId, target: { ...target, path: '/first' } });
    const second = await manager.acquire({
      sessionId,
      target: {
        ...target,
        path: '/DownloadPage.vue?vue&type=style&index=0&lang.css#members',
      },
    });

    expect(second.endpointId).toBe(first.endpointId);
    const secondViewerUrl = new URL(second.viewerUrl);
    const localToken = secondViewerUrl.searchParams.get('__lody_preview_token');
    expect(localToken).not.toBeNull();
    expect(secondViewerUrl).toMatchObject({
      pathname: '/DownloadPage.vue',
      search: `?vue&type=style&index=0&lang.css&__lody_preview_token=${localToken}`,
      hash: '#members',
    });

    await manager.release(sessionId, first.endpointId);
    await expect(fetch(second.viewerUrl)).rejects.toThrow();
  });

  it('rejects redirects that leave the bound target origin', async () => {
    const { server, target } = await listenHtmlServer();
    servers.push(server);
    const manager = new LocalPreviewProxyManager({ logger: createLogger() });
    managers.push(manager);

    const endpoint = await manager.acquire({
      sessionId: 'session-preview-external-redirect' as SessionId,
      target: { ...target, path: '/external-redirect' },
    });
    const response = await fetch(endpoint.viewerUrl, { redirect: 'manual' });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain('Preview proxy error');
  });

  it('isolates local and remote capabilities and never trusts a bare matching origin', async () => {
    const { server, target, requestUrls } = await listenHtmlServer();
    servers.push(server);
    server.prependListener('request', (_request, response) => {
      response.setHeader('set-cookie', ['app_session=private', 'app_other=private']);
      response.setHeader('x-preview-values', ['first', 'second']);
    });
    const local = new LocalPreviewProxyManager({ logger: createLogger() });
    const remote = new LocalPreviewProxyManager({ logger: createLogger() });
    managers.push(local, remote);
    const sessionId = 'session-isolation' as SessionId;
    const localEndpoint = await local.acquire({ sessionId, target });
    const remoteEndpoint = await remote.acquire({ sessionId, target, remote: true });
    const publicEndpoint = remote.bindViewerOrigin(
      sessionId,
      'https://test-preview.trycloudflare.com'
    );
    const response = await fetch(remoteEndpoint.viewerUrl);
    expect(response.status).toBe(200);
    await response.text();
    expect(response.headers.get('set-cookie')).toContain('Secure; SameSite=None; Partitioned');
    expect(response.headers.getSetCookie()).toHaveLength(1);
    expect(response.headers.get('set-cookie')).not.toContain('private');
    expect(response.headers.get('x-preview-values')).toBe('first, second');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const bare = new URL('/', remoteEndpoint.viewerUrl);
    for (const headers of [
      { origin: new URL(publicEndpoint.viewerUrl).origin },
      { referer: new URL('/module.js', publicEndpoint.viewerUrl).href },
      { referer: localEndpoint.viewerUrl },
      { cookie: 'lody_preview=%ZZ' },
    ]) {
      const denied = await fetch(bare, { headers });
      expect(denied.status).toBe(403);
      await denied.text();
    }
    const crossed = new URL(remoteEndpoint.viewerUrl);
    crossed.search = new URL(localEndpoint.viewerUrl).search;
    expect((await fetch(crossed)).status).toBe(403);
    expect(requestUrls).toEqual(['/']);
    const asset = await fetch(new URL('/asset.js', remoteEndpoint.viewerUrl), {
      headers: { referer: publicEndpoint.viewerUrl },
    });
    expect(asset.status).toBe(200);
    await asset.text();
    await remote.closeSession(sessionId, 'revoked');
    const stillLocal = await fetch(localEndpoint.viewerUrl);
    expect(stillLocal.status).toBe(200);
    await stillLocal.text();
  });

  it('streams the first response chunk before EOF and cancels the upstream when the viewer leaves', async () => {
    let upstreamClosed: () => void = () => {
      throw new Error('Fixture not initialized');
    };
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const server = http.createServer((_request, response) => {
      response.on('close', upstreamClosed);
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('first chunk');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const manager = new LocalPreviewProxyManager({ logger: createLogger() });
    managers.push(manager);
    const endpoint = await manager.acquire({
      sessionId: 'session-streaming' as SessionId,
      target: { protocol: 'http', host: '127.0.0.1', port: address.port },
    });
    const response = await fetch(endpoint.viewerUrl);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing streaming response');
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('first chunk');
    expect(first.done).toBe(false);
    await reader.cancel();
    await closed;
  });
});

describe('LocalPreviewProxyManager WebSocket close forwarding', () => {
  const servers: http.Server[] = [];
  const managers: LocalPreviewProxyManager[] = [];
  const sockets: WebSocket[] = [];
  const uncaught: unknown[] = [];
  // An unsendable close code makes `ws` throw from a TCP callback, which crashes the CLI
  // rather than failing any single call. Capture that here so the tests below can fail on
  // the real error instead of waiting out a timeout for a close that never arrives.
  let failOnUncaught: Promise<never>;
  let rejectOnUncaught: (error: unknown) => void;
  const recordUncaught = (error: unknown) => {
    uncaught.push(error);
    rejectOnUncaught(error);
  };

  beforeEach(() => {
    uncaught.length = 0;
    failOnUncaught = new Promise<never>((_resolve, reject) => {
      rejectOnUncaught = reject;
    });
    failOnUncaught.catch(() => {});
    process.on('uncaughtException', recordUncaught);
  });

  afterEach(async () => {
    process.off('uncaughtException', recordUncaught);
    // A socket left open by a failing test would otherwise keep its server from closing.
    for (const socket of sockets.splice(0)) {
      socket.terminate();
    }
    await Promise.allSettled(managers.splice(0).map((manager) => manager.closeAll('test cleanup')));
    await Promise.allSettled(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      )
    );
    expect(uncaught).toEqual([]);
  });

  const acquireProxiedSocket = async (sessionId: string) => {
    const upstream = await listenWebSocketServer();
    servers.push(upstream.server);
    const manager = new LocalPreviewProxyManager({ logger: createLogger() });
    managers.push(manager);
    const endpoint = await manager.acquire({
      sessionId: sessionId as SessionId,
      target: upstream.target,
    });
    const browserSocket = await openBrowserSocket(endpoint.viewerUrl);
    const upstreamSocket = await upstream.nextUpstreamSocket();
    sockets.push(browserSocket, upstreamSocket);
    return { browserSocket, upstreamSocket };
  };

  const awaitClose = (socket: WebSocket): Promise<ObservedClose> =>
    Promise.race([observeClose(socket), failOnUncaught]);

  it('keeps the upstream subprotocol and text/binary frame shape, then revokes both sockets', async () => {
    const upstream = await listenWebSocketServer('second');
    servers.push(upstream.server);
    const manager = new LocalPreviewProxyManager({ logger: createLogger() });
    managers.push(manager);
    const sessionId = 'session-ws-protocol' as SessionId;
    const endpoint = await manager.acquire({ sessionId, target: upstream.target });
    const browser = await openBrowserSocket(endpoint.viewerUrl, ['first', 'second']);
    const local = await upstream.nextUpstreamSocket();
    sockets.push(browser, local);
    expect(browser.protocol).toBe('second');
    expect(local.protocol).toBe('second');
    for (const binary of [false, true]) {
      const received = new Promise<{ bytes: Buffer; binary: boolean }>((resolve) => {
        local.once('message', (bytes, isBinary) => {
          if (!Buffer.isBuffer(bytes)) throw new Error('Expected binaryType=nodebuffer');
          resolve({ bytes, binary: isBinary });
        });
      });
      const bytes = binary ? Buffer.from([0, 255, 128, 1]) : Buffer.from('text');
      browser.send(bytes, { binary });
      expect(await received).toEqual({ bytes, binary });
    }
    const browserClosed = awaitClose(browser);
    const localClosed = awaitClose(local);
    await manager.release(sessionId, endpoint.endpointId);
    expect(await browserClosed).toEqual({ code: 1006, reason: '' });
    expect(await localClosed).toEqual({ code: 1006, reason: '' });
  });

  it('rejects an unauthenticated WS handshake after an authenticated page visit', async () => {
    const upstream = await listenWebSocketServer();
    servers.push(upstream.server);
    const manager = new LocalPreviewProxyManager({ logger: createLogger() });
    managers.push(manager);
    const endpoint = await manager.acquire({
      sessionId: 'session-ws-auth' as SessionId,
      target: upstream.target,
    });
    const page = await fetch(endpoint.viewerUrl);
    expect(page.status).toBe(200);
    await page.text();
    const address = new URL(endpoint.viewerUrl);
    address.search = '';
    address.protocol = 'ws:';
    const denied = new WebSocket(address, {
      headers: { origin: new URL(endpoint.viewerUrl).origin },
    });
    sockets.push(denied);
    const error = await new Promise<Error>((resolve) => denied.once('error', resolve));
    expect(error.message).toContain('403');
  });

  it('mirrors an abnormal upstream close to the browser instead of throwing', async () => {
    const { browserSocket, upstreamSocket } = await acquireProxiedSocket(
      'session-preview-ws-upstream-abnormal'
    );
    const browserClosed = awaitClose(browserSocket);

    // Destroys the TCP connection without sending a Close frame, so the proxy observes 1006.
    upstreamSocket.terminate();

    expect(await browserClosed).toEqual({ code: 1006, reason: '' });
  });

  it('mirrors a status-less upstream close to the browser', async () => {
    const { browserSocket, upstreamSocket } = await acquireProxiedSocket(
      'session-preview-ws-upstream-no-status'
    );
    const browserClosed = awaitClose(browserSocket);

    // An empty Close frame, so the proxy observes 1005.
    upstreamSocket.close();

    expect(await browserClosed).toEqual({ code: 1005, reason: '' });
  });

  it('mirrors an abnormal browser close to the upstream socket instead of throwing', async () => {
    const { browserSocket, upstreamSocket } = await acquireProxiedSocket(
      'session-preview-ws-browser-abnormal'
    );
    const upstreamClosed = awaitClose(upstreamSocket);

    browserSocket.terminate();

    expect(await upstreamClosed).toEqual({ code: 1006, reason: '' });
  });

  it('mirrors a status-less browser close to the upstream socket', async () => {
    const { browserSocket, upstreamSocket } = await acquireProxiedSocket(
      'session-preview-ws-browser-no-status'
    );
    const upstreamClosed = awaitClose(upstreamSocket);

    browserSocket.close();

    expect(await upstreamClosed).toEqual({ code: 1005, reason: '' });
  });

  it('forwards a sendable close code and reason in both directions', async () => {
    const fromUpstream = await acquireProxiedSocket('session-preview-ws-code-upstream');
    const browserClosed = awaitClose(fromUpstream.browserSocket);
    fromUpstream.upstreamSocket.close(4001, 'upstream done');
    expect(await browserClosed).toEqual({ code: 4001, reason: 'upstream done' });

    const fromBrowser = await acquireProxiedSocket('session-preview-ws-code-browser');
    const upstreamClosed = awaitClose(fromBrowser.upstreamSocket);
    fromBrowser.browserSocket.close(4002, 'browser done');
    expect(await upstreamClosed).toEqual({ code: 4002, reason: 'browser done' });
  });
});

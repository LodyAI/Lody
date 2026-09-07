import http, { type AddressInfo } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { PreviewTarget, SessionId } from '@lody/shared';
import { LocalPreviewProxyManager } from './local-preview-proxy';

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

const listenHtmlServer = async (): Promise<{
  server: http.Server;
  target: PreviewTarget;
  requestUrls: string[];
  styleReferers: Array<string | undefined>;
}> => {
  const requestUrls: string[] = [];
  const styleReferers: Array<string | undefined> = [];
  const server = http.createServer((request, response) => {
    requestUrls.push(request.url ?? '');
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

const listenWebSocketServer = async (): Promise<{
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
  const webSocketServer = new WebSocketServer({ server });
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

const openBrowserSocket = async (viewerUrl: string): Promise<WebSocket> => {
  const socketUrl = new URL(viewerUrl);
  socketUrl.protocol = 'ws:';
  socketUrl.pathname = '/socket';
  const socket = new WebSocket(socketUrl);
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

    const refererAuthorizedAssetResponse = await fetch(assetUrl, {
      headers: {
        referer: endpoint.viewerUrl,
      },
    });
    expect(refererAuthorizedAssetResponse.status).toBe(200);
    expect(await refererAuthorizedAssetResponse.text()).toContain('rgb(1, 2, 3)');
    expect(styleReferers).toEqual([`http://127.0.0.1:${target.port}/`]);

    const reactRefreshUrl = new URL('/@react-refresh', endpoint.viewerUrl);
    const moduleChainAssetResponse = await fetch(reactRefreshUrl, {
      headers: {
        referer: new URL('/src/main.tsx', endpoint.viewerUrl).toString(),
      },
    });
    expect(moduleChainAssetResponse.status).toBe(200);
    expect(await moduleChainAssetResponse.text()).toContain('RefreshRuntime');

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
    const localToken = secondViewerUrl.searchParams.get('__lody_local_preview_token');
    expect(localToken).not.toBeNull();
    expect(secondViewerUrl).toMatchObject({
      pathname: '/DownloadPage.vue',
      search: `?vue&type=style&index=0&lang.css&__lody_local_preview_token=${localToken}`,
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

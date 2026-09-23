import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'http';
import { Buffer } from 'buffer';
import { randomBytes, randomUUID } from 'crypto';
import type { Socket } from 'net';
import type { Duplex } from 'stream';
import {
  DEFAULT_PREVIEW_RESOURCE_LIMITS,
  PREVIEW_ACCESS_TOKEN_QUERY_PARAM,
  PREVIEW_ACCESS_TOKEN_COOKIE,
  applyPreviewEmbeddingHeaders,
  getServerNow,
  removePreviewQueryParamFromSearch,
  sanitizePreviewProxyResponseHeaders,
  setPreviewQueryParamInUrl,
  type HeaderEntry,
  type PreviewResourceLimits,
  type PreviewTarget,
  type SessionId,
  type SessionPreviewEndpoint,
} from '@lody/shared';
import { WebSocket as LocalWebSocket, WebSocketServer, type RawData } from 'ws';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { PREVIEW_PROBE_HEADER } from './preview-tunnel-readiness';
import { createPreviewTargetTransport, fetchPreviewTarget } from './preview-target-transport';
import {
  buildInjectedHtmlHeaders,
  buildLocalPreviewRequestHeaders,
  buildLocalWebSocketUrl,
  headersToEntries,
  maybeInjectVisualAnnotationRuntime,
  stripLocalWebSocketHeaders,
  assertRelativePreviewPath,
} from './preview-http';

type LocalPreviewProxyRecord = {
  transport: ReturnType<typeof createPreviewTargetTransport>;
  endpoint: SessionPreviewEndpoint;
  token: string;
  active: boolean;
  remote: boolean;
  onActivity?: (renew: boolean) => boolean;
  sockets: Set<Socket>;
  requests: Set<AbortController>;
  upstreamSockets: Set<LocalWebSocket>;
  proxyOrigin: URL;
  localOrigin: URL;
  server: http.Server;
  webSocketServer: WebSocketServer;
};

type LocalPreviewProxyManagerDeps = {
  logger: Logger;
  now?: () => number;
};

type AcquireLocalPreviewEndpointOptions = {
  sessionId: SessionId;
  target: PreviewTarget;
  connectionAddress?: string;
  shareUrl?: string;
  resourceLimits?: PreviewResourceLimits;
  remote?: boolean;
  onActivity?: (renew: boolean) => boolean;
};

const LOCAL_PREVIEW_TOKEN_QUERY_PARAM = PREVIEW_ACCESS_TOKEN_QUERY_PARAM;
const LOCAL_PREVIEW_TOKEN_COOKIE = PREVIEW_ACCESS_TOKEN_COOKIE;

const toUrlHost = (host: string): string => (host.includes(':') ? `[${host}]` : host);

const buildLocalOrigin = (target: PreviewTarget): URL =>
  new URL(`${target.protocol}://${toUrlHost(target.host)}:${target.port}`);

const buildLocalViewerUrl = (path: string | undefined, proxyOrigin: URL, token: string): string =>
  setPreviewQueryParamInUrl(
    new URL(path ?? '/', proxyOrigin),
    LOCAL_PREVIEW_TOKEN_QUERY_PARAM,
    token
  ).toString();

const resolveResourceLimits = (
  limits: PreviewResourceLimits | undefined
): PreviewResourceLimits => ({
  ...DEFAULT_PREVIEW_RESOURCE_LIMITS,
  ...(limits ?? {}),
});

const sameTargetOrigin = (left: PreviewTarget, right: PreviewTarget): boolean =>
  left.protocol === right.protocol && left.host === right.host && left.port === right.port;

const incomingHeadersToEntries = (headers: IncomingHttpHeaders): HeaderEntry[] => {
  const entries: HeaderEntry[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      entries.push([name, value]);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        entries.push([name, item]);
      }
    }
  }
  return entries;
};

const parseCookieHeader = (value: string | undefined): Map<string, string> => {
  const cookies = new Map<string, string>();
  if (!value) {
    return cookies;
  }
  for (const part of value.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const rawValue = part.slice(index + 1).trim();
    if (!name) {
      continue;
    }
    cookies.set(name, rawValue);
  }
  return cookies;
};

const rawDataToBuffer = (value: RawData): Buffer => {
  if (Array.isArray(value)) return Buffer.concat(value.map((chunk) => Buffer.from(chunk)));
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
};

const WEBSOCKET_CLOSE_CODE_NO_STATUS = 1005;
const WEBSOCKET_CLOSE_CODE_ABNORMAL = 1006;

const isSendableWebSocketCloseCode = (code: number): boolean =>
  (code >= 1000 &&
    code <= 1014 &&
    code !== 1004 &&
    code !== WEBSOCKET_CLOSE_CODE_NO_STATUS &&
    code !== WEBSOCKET_CLOSE_CODE_ABNORMAL) ||
  (code >= 3000 && code <= 4999);

/**
 * Mirrors a close observed on one side of the proxy onto the other side.
 *
 * RFC 6455 section 7.4.1 reserves 1005 and 1006 for local observation, so neither may
 * appear in a Close frame; `ws` throws synchronously when asked to send one, which
 * would take down the whole CLI from a TCP callback. Reproduce the observed shape
 * instead of a status code: an empty Close frame makes the peer observe 1005, and
 * destroying the connection makes it observe 1006.
 */
const mirrorWebSocketClose = (peer: LocalWebSocket, code: number, reason: Buffer): void => {
  if (peer.readyState === LocalWebSocket.CLOSING || peer.readyState === LocalWebSocket.CLOSED) {
    return;
  }
  if (code === WEBSOCKET_CLOSE_CODE_ABNORMAL) {
    peer.terminate();
    return;
  }
  if (code === WEBSOCKET_CLOSE_CODE_NO_STATUS) {
    peer.close();
    return;
  }
  if (!isSendableWebSocketCloseCode(code)) {
    peer.close(1011, 'Local preview WebSocket closed with an unsendable status code');
    return;
  }
  peer.close(code, reason.toString('utf8'));
};

export class LocalPreviewProxyManager {
  private readonly records = new Map<SessionId, LocalPreviewProxyRecord>();

  constructor(private readonly deps: LocalPreviewProxyManagerDeps) {}

  bindViewerOrigin(sessionId: SessionId, origin: string): SessionPreviewEndpoint {
    const record = this.records.get(sessionId);
    if (!record || !record.active || !record.remote) {
      throw new Error('Remote preview endpoint is not active.');
    }
    const viewer = new URL(origin);
    if (
      viewer.protocol !== 'https:' ||
      viewer.username ||
      viewer.password ||
      viewer.port ||
      !/^[a-z0-9-]+\.trycloudflare\.com$/.test(viewer.hostname) ||
      viewer.pathname !== '/' ||
      viewer.search ||
      viewer.hash
    ) {
      throw new Error('Invalid Quick Tunnel origin.');
    }
    record.proxyOrigin = viewer;
    record.endpoint = {
      ...record.endpoint,
      kind: 'quick-tunnel',
      viewerUrl: buildLocalViewerUrl(record.endpoint.target?.path, viewer, record.token),
    };
    return record.endpoint;
  }

  async acquire(options: AcquireLocalPreviewEndpointOptions): Promise<SessionPreviewEndpoint> {
    const existing = this.records.get(options.sessionId);
    if (
      existing &&
      existing.endpoint.target &&
      sameTargetOrigin(existing.endpoint.target, options.target)
    ) {
      existing.endpoint = {
        ...existing.endpoint,
        viewerUrl: buildLocalViewerUrl(options.target.path, existing.proxyOrigin, existing.token),
        target: options.target,
        shareUrl: options.shareUrl ?? existing.endpoint.shareUrl,
        capabilities: {
          ...existing.endpoint.capabilities,
          shareable: Boolean(options.shareUrl ?? existing.endpoint.shareUrl),
        },
      };
      return existing.endpoint;
    }
    if (existing) {
      await this.closeRecord(options.sessionId, existing, 'Preview target changed');
    }

    const record = await this.createRecord(options);
    this.records.set(options.sessionId, record);
    return record.endpoint;
  }

  async release(sessionId: SessionId, endpointId: string): Promise<void> {
    const record = this.records.get(sessionId);
    if (!record || record.endpoint.endpointId !== endpointId) {
      return;
    }
    await this.closeRecord(sessionId, record, 'Preview endpoint released');
  }

  async closeSession(sessionId: SessionId, reason: string): Promise<void> {
    const record = this.records.get(sessionId);
    if (record) {
      await this.closeRecord(sessionId, record, reason);
    }
  }

  async closeAll(reason: string): Promise<void> {
    const entries = [...this.records.entries()];
    const results = await Promise.allSettled(
      entries.map(async ([sessionId, record]) => {
        await this.closeRecord(sessionId, record, reason);
      })
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Preview cleanup failed'
      );
  }

  private async createRecord(
    options: AcquireLocalPreviewEndpointOptions
  ): Promise<LocalPreviewProxyRecord> {
    const endpointId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const localOrigin = buildLocalOrigin(options.target);
    const transport = createPreviewTargetTransport(options.target, options.connectionAddress);
    const resourceLimits = resolveResourceLimits(options.resourceLimits);
    const server = http.createServer();
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: resourceLimits.maxRequestBodyBytes,
    });
    const sockets = new Set<Socket>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    const recordRef: { current: LocalPreviewProxyRecord | null } = { current: null };

    server.on('request', (request, response) => {
      for (const [name, value] of applyPreviewEmbeddingHeaders(new Headers()))
        response.setHeader(name, value);
      response.setHeader('cache-control', 'no-store');
      const record = recordRef.current;
      if (!record) {
        response.writeHead(503).end('Preview endpoint is not ready.');
        return;
      }
      void this.handleHttpRequest(record, resourceLimits, request, response).catch((error) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(`Preview proxy error: ${formatErrorMessage(error)}`);
      });
    });

    server.on('upgrade', (request, socket, head) => {
      const record = recordRef.current;
      if (!record) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      void this.handleWebSocketUpgrade(record, resourceLimits, request, socket, head).catch(
        (error) => {
          this.deps.logger.debug(`Preview WebSocket upgrade failed: ${formatErrorMessage(error)}`);
          socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        }
      );
    });

    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Local preview proxy did not bind to a TCP port.'));
          return;
        }
        resolve(address.port);
      });
    }).catch(async (error: unknown) => {
      webSocketServer.close();
      await transport.dispatcher.destroy();
      throw error;
    });

    const proxyOrigin = new URL(`http://127.0.0.1:${port}`);
    const now = Math.round(this.deps.now?.() ?? getServerNow());
    const endpoint: SessionPreviewEndpoint = {
      endpointId,
      kind: 'local-proxy',
      viewerUrl: buildLocalViewerUrl(options.target.path, proxyOrigin, token),
      ...(options.shareUrl ? { shareUrl: options.shareUrl } : {}),
      target: options.target,
      capabilities: {
        visualAnnotation: true,
        shareable: Boolean(options.shareUrl),
      },
      createdAt: now,
    };
    const record: LocalPreviewProxyRecord = {
      transport,
      endpoint,
      token,
      active: true,
      remote: options.remote ?? false,
      onActivity: options.onActivity,
      sockets,
      requests: new Set(),
      upstreamSockets: new Set(),
      proxyOrigin,
      localOrigin,
      server,
      webSocketServer,
    };
    recordRef.current = record;
    return record;
  }

  private async handleHttpRequest(
    record: LocalPreviewProxyRecord,
    resourceLimits: PreviewResourceLimits,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const authorizedByQuery = this.isAuthorized(record, request, { queryOnly: true });
    if (
      (!authorizedByQuery && !this.isAuthorized(record, request)) ||
      record.onActivity?.(request.headers[PREVIEW_PROBE_HEADER] !== '1') === false
    ) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Preview endpoint token is missing or invalid.');
      return;
    }

    const requestUrl = this.resolveProxyRequestUrl(record, request);
    if (record.requests.size + record.upstreamSockets.size >= 200) {
      response.writeHead(429).end('Preview concurrent request limit exceeded.');
      return;
    }
    const headers = buildLocalPreviewRequestHeaders(incomingHeadersToEntries(request.headers), {
      localOrigin: record.localOrigin,
      previewOrigin: record.proxyOrigin,
      localPreviewTokenQueryParam: LOCAL_PREVIEW_TOKEN_QUERY_PARAM,
    });
    const method = request.method ?? 'GET';
    const controller = new AbortController();
    record.requests.add(controller);
    const cancel = () => {
      if (!response.writableFinished) controller.abort(new Error('Preview viewer disconnected'));
    };
    response.once('close', cancel);
    const timeout = setTimeout(
      () => controller.abort(new Error('Local preview proxy request timed out')),
      resourceLimits.maxRequestDurationMs
    );
    timeout.unref?.();
    const abortRequest = () => request.destroy();
    controller.signal.addEventListener('abort', abortRequest, { once: true });
    try {
      const body =
        method === 'GET' || method === 'HEAD'
          ? undefined
          : await this.readRequestBody(request, resourceLimits.maxRequestBodyBytes);
      const requestBody = body === undefined ? undefined : Uint8Array.from(body);
      const localResponse = await fetchPreviewTarget(requestUrl, {
        method,
        headers: [...headers.entries()],
        body: requestBody,
        redirect: 'manual',
        signal: controller.signal,
        dispatcher: record.transport.dispatcher,
      });
      if (
        record.remote &&
        localResponse.headers.get('content-type')?.toLowerCase().includes('text/event-stream')
      ) {
        await localResponse.body?.cancel();
        throw new Error(
          'Quick Tunnels do not support Server-Sent Events. Use local preview for this endpoint.'
        );
      }
      const injectedHtml = await maybeInjectVisualAnnotationRuntime(
        localResponse,
        method,
        resourceLimits.maxResponseBodyBytes
      );
      if (injectedHtml) {
        const responseHeaders = this.buildResponseHeaders(
          record,
          headersToEntries(
            buildInjectedHtmlHeaders(
              localResponse.headers,
              injectedHtml.body.byteLength,
              injectedHtml.runtimeInjected
            ),
            {
              localOrigin: record.localOrigin,
              previewOrigin: record.proxyOrigin,
            }
          ),
          authorizedByQuery
        );
        response.writeHead(localResponse.status, localResponse.statusText, responseHeaders);
        response.end(injectedHtml.body);
        return;
      }

      const responseHeaders = this.buildResponseHeaders(
        record,
        headersToEntries(localResponse.headers, {
          localOrigin: record.localOrigin,
          previewOrigin: record.proxyOrigin,
        }),
        authorizedByQuery
      );
      response.writeHead(localResponse.status, localResponse.statusText, responseHeaders);
      await this.writeResponseBody(response, localResponse, resourceLimits.maxResponseBodyBytes);
    } finally {
      clearTimeout(timeout);
      record.requests.delete(controller);
      controller.signal.removeEventListener('abort', abortRequest);
      response.off('close', cancel);
    }
  }

  private async handleWebSocketUpgrade(
    record: LocalPreviewProxyRecord,
    limits: PreviewResourceLimits,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    if (!this.isAuthorized(record, request) || record.onActivity?.(true) === false) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const targetUrl = this.resolveProxyRequestUrl(record, request);
    if (record.requests.size + record.upstreamSockets.size >= 200) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return;
    }
    const headers = buildLocalPreviewRequestHeaders(incomingHeadersToEntries(request.headers), {
      localOrigin: record.localOrigin,
      previewOrigin: record.proxyOrigin,
      localPreviewTokenQueryParam: LOCAL_PREVIEW_TOKEN_QUERY_PARAM,
    });
    const upstream = new LocalWebSocket(
      buildLocalWebSocketUrl(record.localOrigin, `${targetUrl.pathname}${targetUrl.search}`),
      this.getWebSocketProtocols(request),
      {
        lookup: record.transport.lookup,
        headers: Object.fromEntries(stripLocalWebSocketHeaders([...headers.entries()])),
        maxPayload: limits.maxResponseBodyBytes,
        handshakeTimeout: Math.min(limits.maxRequestDurationMs, 10_000),
      }
    );
    record.upstreamSockets.add(upstream);
    upstream.once('close', () => record.upstreamSockets.delete(upstream));
    const cancel = () => upstream.terminate();
    socket.once('close', cancel);
    // Do not acknowledge the viewer before the actual upstream accepts its protocol.
    // Pause the upstream while awaiting the browser handshake so early frames are not lost.
    await new Promise<void>((resolve, reject) => {
      upstream.once('open', () => {
        upstream.pause();
        resolve();
      });
      upstream.on('error', reject);
      upstream.once('close', () => reject(new Error('Preview WebSocket closed during handshake')));
    });
    if (!record.active || socket.destroyed) {
      upstream.terminate();
      return;
    }
    if (upstream.protocol) request.headers['sec-websocket-protocol'] = upstream.protocol;
    else delete request.headers['sec-websocket-protocol'];
    record.webSocketServer.handleUpgrade(request, socket, head, (browser) => {
      socket.off('close', cancel);
      const forward = (source: LocalWebSocket, peer: LocalWebSocket) => {
        source.on('message', (data, isBinary) => {
          if (record.onActivity?.(true) === false) {
            source.terminate();
            peer.terminate();
            return;
          }
          if (peer.readyState !== LocalWebSocket.OPEN) return;
          source.pause();
          peer.send(rawDataToBuffer(data), { binary: isBinary }, (error) => {
            if (error) {
              source.terminate();
              peer.terminate();
            } else if (source.readyState === LocalWebSocket.OPEN) source.resume();
          });
        });
        source.on('close', (code, reason) => mirrorWebSocketClose(peer, code, reason));
        // ws emits close after error; close owns propagation of 1005/1006.
        source.on('error', (error) => {
          this.deps.logger.debug(`Preview WebSocket failed: ${formatErrorMessage(error)}`);
        });
      };
      forward(browser, upstream);
      forward(upstream, browser);
      upstream.resume();
    });
  }

  private resolveProxyRequestUrl(record: LocalPreviewProxyRecord, request: IncomingMessage): URL {
    assertRelativePreviewPath(request.url ?? '/');
    const incoming = new URL(request.url ?? '/', record.proxyOrigin);
    incoming.search = removePreviewQueryParamFromSearch(
      incoming.search,
      LOCAL_PREVIEW_TOKEN_QUERY_PARAM
    );
    return new URL(`${incoming.pathname}${incoming.search}${incoming.hash}`, record.localOrigin);
  }

  private isAuthorized(
    record: LocalPreviewProxyRecord,
    request: IncomingMessage,
    options?: { queryOnly?: boolean }
  ): boolean {
    if (!record.active) return false;
    const incoming = new URL(request.url ?? '/', record.proxyOrigin);
    if (incoming.searchParams.get(LOCAL_PREVIEW_TOKEN_QUERY_PARAM) === record.token) {
      return true;
    }
    if (options?.queryOnly) {
      return false;
    }
    if (
      parseCookieHeader(request.headers.cookie).get(LOCAL_PREVIEW_TOKEN_COOKIE) === record.token
    ) {
      return true;
    }
    if (this.isAuthorizedByTokenReferer(record, request)) {
      return true;
    }
    return false;
  }

  private isAuthorizedByTokenReferer(
    record: LocalPreviewProxyRecord,
    request: IncomingMessage
  ): boolean {
    const referer = request.headers.referer;
    if (typeof referer !== 'string') {
      return false;
    }

    try {
      const refererUrl = new URL(referer);
      return (
        refererUrl.origin === record.proxyOrigin.origin &&
        refererUrl.searchParams.get(LOCAL_PREVIEW_TOKEN_QUERY_PARAM) === record.token
      );
    } catch {
      return false;
    }
  }

  private buildResponseHeaders(
    record: LocalPreviewProxyRecord,
    headers: HeaderEntry[],
    setTokenCookie: boolean
  ): Record<string, string> {
    const sanitized = sanitizePreviewProxyResponseHeaders(headers).filter(
      ([name]) =>
        !['cache-control', 'cross-origin-embedder-policy', 'cross-origin-resource-policy'].includes(
          name.toLowerCase()
        )
    );
    sanitized.push(['cache-control', 'no-store']);
    sanitized.push(...applyPreviewEmbeddingHeaders(new Headers()).entries());
    if (setTokenCookie) {
      sanitized.push([
        'set-cookie',
        `${LOCAL_PREVIEW_TOKEN_COOKIE}=${encodeURIComponent(
          record.token
        )}; Path=/; HttpOnly; ${record.remote ? 'Secure; SameSite=None; Partitioned' : 'SameSite=Lax'}`,
      ]);
    }
    // Fetch Headers already combined repeated names; upstream cookies were
    // stripped by headersToEntries, and only our capability cookie is added here.
    return Object.fromEntries(sanitized);
  }

  private async readRequestBody(
    request: IncomingMessage,
    maxRequestBodyBytes: number
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxRequestBodyBytes) {
        throw new Error(`Preview request body exceeds ${maxRequestBodyBytes} byte limit`);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
  }

  private async writeResponseBody(
    response: ServerResponse,
    localResponse: Response,
    maxResponseBodyBytes: number
  ): Promise<void> {
    const reader = localResponse.body?.getReader();
    if (!reader) {
      response.end();
      return;
    }
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        total += value.byteLength;
        if (total > maxResponseBodyBytes) {
          throw new Error(`Preview response exceeds ${maxResponseBodyBytes} byte limit`);
        }
        await new Promise<void>((resolve) => {
          response.write(Buffer.from(value), () => {
            resolve();
          });
        });
      }
      response.end();
    } catch (error) {
      // Releasing the reader lock does not stop the origin. A size-limit failure
      // must cancel the body before the outer boundary closes the viewer socket.
      await reader.cancel(error);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  private getWebSocketProtocols(request: IncomingMessage): string[] {
    const raw = request.headers['sec-websocket-protocol'];
    if (typeof raw !== 'string') {
      return [];
    }
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private async closeRecord(
    sessionId: SessionId,
    record: LocalPreviewProxyRecord,
    reason: string
  ): Promise<void> {
    this.records.delete(sessionId);
    record.active = false;
    for (const controller of record.requests)
      controller.abort(new Error(`Preview endpoint closed: ${reason}`));
    for (const socket of record.upstreamSockets) socket.terminate();
    for (const client of record.webSocketServer.clients) {
      client.terminate();
    }
    for (const socket of record.sockets) socket.destroy();
    record.webSocketServer.close();
    await Promise.all([
      record.transport.dispatcher.destroy(),
      new Promise<void>((resolve, reject) => {
        record.server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    ]);
  }
}

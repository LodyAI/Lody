import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'http';
import { Buffer } from 'buffer';
import { randomUUID } from 'crypto';
import type { Duplex } from 'stream';
import {
  DEFAULT_PREVIEW_RESOURCE_LIMITS,
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
import {
  buildInjectedHtmlHeaders,
  buildLocalPreviewRequestHeaders,
  buildLocalWebSocketUrl,
  headersToEntries,
  headersToNodeRecord,
  maybeInjectVisualAnnotationRuntime,
  stripLocalWebSocketHeaders,
} from './preview-tunnel-client';

type LocalPreviewProxyRecord = {
  endpoint: SessionPreviewEndpoint;
  token: string;
  unlocked: boolean;
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
  shareUrl?: string;
  resourceLimits?: PreviewResourceLimits;
};

const LOCAL_PREVIEW_TOKEN_QUERY_PARAM = '__lody_local_preview_token';
const LOCAL_PREVIEW_TOKEN_COOKIE = '__lody_local_preview';

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

const headersToNodeResponseHeaders = (
  entries: HeaderEntry[]
): Record<string, string | string[]> => {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of entries) {
    const existing = result[name];
    if (existing === undefined) {
      result[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      result[name] = [existing, value];
    }
  }
  return result;
};

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
    cookies.set(name, decodeURIComponent(rawValue));
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
    await Promise.allSettled(
      entries.map(async ([sessionId, record]) => {
        await this.closeRecord(sessionId, record, reason);
      })
    );
  }

  private async createRecord(
    options: AcquireLocalPreviewEndpointOptions
  ): Promise<LocalPreviewProxyRecord> {
    const endpointId = randomUUID();
    const token = randomUUID();
    const localOrigin = buildLocalOrigin(options.target);
    const resourceLimits = resolveResourceLimits(options.resourceLimits);
    const server = http.createServer();
    const webSocketServer = new WebSocketServer({ noServer: true });
    const recordRef: { current: LocalPreviewProxyRecord | null } = { current: null };

    server.on('request', (request, response) => {
      const record = recordRef.current;
      if (!record) {
        response.writeHead(503).end('Preview endpoint is not ready.');
        return;
      }
      void this.handleHttpRequest(record, resourceLimits, request, response).catch((error) => {
        if (!response.headersSent) {
          response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        }
        response.end(`Preview proxy error: ${formatErrorMessage(error)}`);
      });
    });

    server.on('upgrade', (request, socket, head) => {
      const record = recordRef.current;
      if (!record || !this.isAuthorized(record, request)) {
        socket.destroy();
        return;
      }
      this.handleWebSocketUpgrade(record, request, socket, head);
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
      endpoint,
      token,
      unlocked: false,
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
    if (!authorizedByQuery && !this.isAuthorized(record, request)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Preview endpoint token is missing or invalid.');
      return;
    }

    const requestUrl = this.resolveProxyRequestUrl(record, request);
    const headers = buildLocalPreviewRequestHeaders(incomingHeadersToEntries(request.headers), {
      localOrigin: record.localOrigin,
      previewOrigin: record.proxyOrigin,
      localPreviewTokenQueryParam: LOCAL_PREVIEW_TOKEN_QUERY_PARAM,
    });
    const method = request.method ?? 'GET';
    const body =
      method === 'GET' || method === 'HEAD'
        ? undefined
        : await this.readRequestBody(request, resourceLimits.maxRequestBodyBytes);
    const requestBody = body === undefined ? undefined : Uint8Array.from(body);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('Local preview proxy request timed out')),
      resourceLimits.maxRequestDurationMs
    );
    timeout.unref?.();
    try {
      const localResponse = await fetch(requestUrl, {
        method,
        headers,
        body: requestBody,
        redirect: 'manual',
        signal: controller.signal,
      });
      const injectedHtml = await maybeInjectVisualAnnotationRuntime(
        localResponse,
        method,
        resourceLimits.maxResponseBodyBytes
      );
      if (injectedHtml) {
        const responseHeaders = this.buildResponseHeaders(
          record,
          headersToEntries(
            buildInjectedHtmlHeaders(localResponse.headers, injectedHtml.byteLength),
            {
              localOrigin: record.localOrigin,
              previewOrigin: record.proxyOrigin,
            }
          ),
          authorizedByQuery
        );
        response.writeHead(localResponse.status, localResponse.statusText, responseHeaders);
        response.end(injectedHtml);
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
    }
  }

  private handleWebSocketUpgrade(
    record: LocalPreviewProxyRecord,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void {
    record.webSocketServer.handleUpgrade(request, socket, head, (browserSocket) => {
      this.connectLocalWebSocket(record, request, browserSocket);
    });
  }

  private connectLocalWebSocket(
    record: LocalPreviewProxyRecord,
    request: IncomingMessage,
    browserSocket: LocalWebSocket
  ): void {
    const targetUrl = this.resolveProxyRequestUrl(record, request);
    const protocols = this.getWebSocketProtocols(request);
    const localSocket = new LocalWebSocket(
      buildLocalWebSocketUrl(record.localOrigin, `${targetUrl.pathname}${targetUrl.search}`),
      protocols,
      {
        headers: headersToNodeRecord(
          stripLocalWebSocketHeaders(incomingHeadersToEntries(request.headers))
        ),
      }
    );
    const queuedBrowserFrames: Array<{ data: RawData; isBinary: boolean }> = [];
    let localOpen = false;

    browserSocket.on('message', (data, isBinary) => {
      if (localOpen && localSocket.readyState === LocalWebSocket.OPEN) {
        localSocket.send(rawDataToBuffer(data), { binary: isBinary });
      } else {
        queuedBrowserFrames.push({ data, isBinary });
      }
    });
    browserSocket.on('close', (code, reason) => {
      mirrorWebSocketClose(localSocket, code, reason);
    });
    browserSocket.on('error', () => {
      localSocket.terminate();
    });

    localSocket.once('open', () => {
      localOpen = true;
      for (const frame of queuedBrowserFrames.splice(0)) {
        localSocket.send(rawDataToBuffer(frame.data), { binary: frame.isBinary });
      }
    });
    localSocket.on('message', (data, isBinary) => {
      if (browserSocket.readyState === LocalWebSocket.OPEN) {
        browserSocket.send(rawDataToBuffer(data), { binary: isBinary });
      }
    });
    localSocket.on('close', (code, reason) => {
      mirrorWebSocketClose(browserSocket, code, reason);
    });
    localSocket.on('error', (error) => {
      this.deps.logger.debug(`Local preview WebSocket failed: ${formatErrorMessage(error)}`);
      if (localOpen) {
        // `ws` always follows an error on an established connection with a close event,
        // and that close carries what the browser should observe. Reporting 1011 here
        // would replace an abnormal close with a clean one.
        return;
      }
      if (browserSocket.readyState === LocalWebSocket.OPEN) {
        browserSocket.close(1011, 'Local preview WebSocket failed');
      }
    });
  }

  private resolveProxyRequestUrl(record: LocalPreviewProxyRecord, request: IncomingMessage): URL {
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
    const incoming = new URL(request.url ?? '/', record.proxyOrigin);
    if (incoming.searchParams.get(LOCAL_PREVIEW_TOKEN_QUERY_PARAM) === record.token) {
      record.unlocked = true;
      return true;
    }
    if (options?.queryOnly) {
      return false;
    }
    if (
      parseCookieHeader(request.headers.cookie).get(LOCAL_PREVIEW_TOKEN_COOKIE) === record.token
    ) {
      record.unlocked = true;
      return true;
    }
    if (this.isAuthorizedByTokenReferer(record, request)) {
      record.unlocked = true;
      return true;
    }
    return record.unlocked && this.isSameProxyOriginNavigation(record, request);
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

  private isSameProxyOriginNavigation(
    record: LocalPreviewProxyRecord,
    request: IncomingMessage
  ): boolean {
    return (
      this.isSameProxyOriginUrl(record, request.headers.referer) ||
      this.isSameProxyOriginUrl(record, request.headers.origin)
    );
  }

  private isSameProxyOriginUrl(
    record: LocalPreviewProxyRecord,
    value: string | string[] | undefined
  ): boolean {
    if (typeof value !== 'string') {
      return false;
    }

    try {
      return new URL(value).origin === record.proxyOrigin.origin;
    } catch {
      return false;
    }
  }

  private buildResponseHeaders(
    record: LocalPreviewProxyRecord,
    headers: HeaderEntry[],
    setTokenCookie: boolean
  ): Record<string, string | string[]> {
    const sanitized = sanitizePreviewProxyResponseHeaders(headers);
    if (setTokenCookie) {
      sanitized.push([
        'set-cookie',
        `${LOCAL_PREVIEW_TOKEN_COOKIE}=${encodeURIComponent(
          record.token
        )}; Path=/; HttpOnly; SameSite=Lax`,
      ]);
    }
    return headersToNodeResponseHeaders(sanitized);
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
    for (const client of record.webSocketServer.clients) {
      client.close(1001, reason);
    }
    record.webSocketServer.close();
    await new Promise<void>((resolve) => {
      record.server.close((error) => {
        if (error) {
          this.deps.logger.debug(
            `Failed to close local preview proxy: ${formatErrorMessage(error)}`
          );
        }
        resolve();
      });
    });
  }
}

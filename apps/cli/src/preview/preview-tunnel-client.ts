import type { IncomingMessage } from 'node:http';
import { Buffer } from 'node:buffer';
import {
  PREVIEW_TUNNEL_BINARY_PAYLOAD_CAPABILITY,
  PREVIEW_TUNNEL_CAPABILITIES,
  PREVIEW_TUNNEL_HTTP_BODY_BATCH_BYTES,
  PREVIEW_TUNNEL_PROTOCOL_VERSION,
  PREVIEW_TUNNEL_RESPONSE_BODY_CREDIT_CAPABILITY,
  PREVIEW_TUNNEL_SOCKET_BACKPRESSURE_HIGH_WATERMARK_BYTES,
  PREVIEW_TUNNEL_SOCKET_BACKPRESSURE_LOW_WATERMARK_BYTES,
  PREVIEW_TUNNELS_API_PATH,
  VISUAL_ANNOTATION_INSPECTOR_BROWSER_SCRIPT,
  DEFAULT_PREVIEW_RESOURCE_LIMITS,
  buildPreviewTunnelRefreshPath,
  buildPreviewTunnelRevokePath,
  isPreviewTunnelCreateResponse,
  isPreviewTunnelRefreshResponse,
  parsePreviewTunnelServerMessage,
  removePreviewQueryParamFromSearch,
  type HeaderEntry,
  type PreviewTarget,
  type PreviewResourceLimits,
  type PreviewTunnelBinaryPayloadMessage,
  type PreviewTunnelClientMessage,
  type PreviewTunnelCreateRequest,
  type PreviewTunnelCreateResponse,
  type PreviewTunnelRefreshResponse,
  type PreviewTunnelRequestStartMessage,
  type PreviewTunnelWebSocketConnectMessage,
} from '@lody/shared';
import {
  WebSocket as LocalWebSocket,
  type ErrorEvent as LocalWebSocketErrorEvent,
  type MessageEvent as LocalWebSocketMessageEvent,
  type RawData,
} from 'ws';
import {
  verifyPreviewTunnelRoundTrip,
  PREVIEW_PROXY_RESPONSE_HEADER,
  PREVIEW_PROXY_RESPONSE_VERSION,
  VISUAL_ANNOTATION_RUNTIME_RESPONSE_HEADER,
  VISUAL_ANNOTATION_RUNTIME_RESPONSE_VERSION,
} from './preview-tunnel-readiness';

type RequestInitWithDuplex = RequestInit & {
  duplex?: 'half';
};

type LocalPreviewRequestHeaderOptions = {
  localOrigin: URL;
  previewOrigin: URL;
  localPreviewTokenQueryParam: string;
};

type LocalRequestContext = {
  startedAt: number;
  abortController: AbortController;
  cancelled: boolean;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  writeChain: Promise<void>;
  requestBodyBytes: number;
  responseBodyBytes: number;
  responseErrorSent: boolean;
  timeoutId: ReturnType<typeof setTimeout> | null;
  responseBodyCreditBytes: number;
  responseBodyCreditWaiters: Array<() => void>;
};

type LocalWebSocketContext = {
  socket: LocalWebSocket;
  opened: boolean;
  remoteClosed: boolean;
  handshakeSettled: boolean;
  useBinaryPayload: boolean;
};

type ConnectionOutcome = { kind: 'interrupted' } | { kind: 'disconnected'; message: string };

export type PreviewTunnelHandle = {
  tunnelId: string;
  publicUrl: string;
  resourceLimits?: PreviewResourceLimits;
  close: (reason?: string) => Promise<void>;
  closed: Promise<void>;
};

export type StartPreviewTunnelOptions = {
  gatewayUrl: string;
  authToken: string;
  createRequest: PreviewTunnelCreateRequest;
  target: PreviewTarget;
  onClosed?: (error: Error | null) => void | Promise<void>;
};

const HTTP_HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'cookie',
  'authorization',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'cf-connecting-ip',
]);

const LOCAL_WEBSOCKET_HEADER_EXCLUSIONS = new Set([
  ...HTTP_HOP_BY_HOP_HEADERS,
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
]);

const LOCAL_PREVIEW_REQUEST_HEADER_EXCLUSIONS = new Set([
  ...HTTP_HOP_BY_HOP_HEADERS,
  'if-modified-since',
  'if-none-match',
  'referer',
]);

const LOCAL_RESPONSE_HEADER_EXCLUSIONS = new Set([
  ...HTTP_HOP_BY_HOP_HEADERS,
  'set-cookie',
  'set-cookie2',
]);

const DEFAULT_WEBSOCKET_CLOSE_CODE = 1011;
const TUNNEL_REPLACED_CLOSE_CODE = 1012;
const SESSION_REFRESH_INTERVAL_MS = 5 * 60_000;
const SESSION_REFRESH_RETRY_MS = 30_000;
const TUNNEL_READY_TIMEOUT_MS = 15_000;
const TUNNEL_SOCKET_BACKPRESSURE_POLL_MS = 4;
const RECONNECT_BACKOFF_INITIAL_MS = 1_000;
const RECONNECT_BACKOFF_MAX_MS = 30_000;
const INVALID_RESPONSE_BODY_SNIPPET_MAX_CHARS = 400;
const VISUAL_ANNOTATION_INJECTED_MARKER = 'data-lody-visual-annotation-runtime';
const LOCAL_PREVIEW_ACCEPT_ENCODING = 'identity';

const normalizeGatewayUrl = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Preview gateway URL must be an http or https URL.');
  }
  return url.toString();
};

const delay = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const resolveResourceLimits = (
  limits: PreviewResourceLimits | undefined
): PreviewResourceLimits => ({
  ...DEFAULT_PREVIEW_RESOURCE_LIMITS,
  ...(limits ?? {}),
});

const buildCreateTunnelUrl = (gatewayUrl: string): string => {
  const url = new URL(PREVIEW_TUNNELS_API_PATH, gatewayUrl);
  url.search = '';
  return url.toString();
};

const requestJson = async <T>(args: {
  url: string;
  init: RequestInit;
  parse: (value: unknown) => value is T;
  invalidMessage: string;
}): Promise<T> => {
  const response = await fetch(args.url, args.init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(parseErrorMessage(text) ?? `Preview gateway returned HTTP ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(buildInvalidJsonResponseMessage(args.invalidMessage, response, text));
  }
  if (!args.parse(parsed)) {
    throw new Error(buildInvalidJsonResponseMessage(args.invalidMessage, response, text));
  }
  return parsed;
};

const createTunnel = async (
  gatewayUrl: string,
  authToken: string,
  request: PreviewTunnelCreateRequest
): Promise<PreviewTunnelCreateResponse> =>
  await requestJson({
    url: buildCreateTunnelUrl(gatewayUrl),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(request),
    },
    parse: isPreviewTunnelCreateResponse,
    invalidMessage: 'Received an invalid preview tunnel create response.',
  });

const refreshTunnel = async (
  gatewayUrl: string,
  tunnelId: string,
  sessionToken: string
): Promise<PreviewTunnelRefreshResponse> =>
  await requestJson({
    url: new URL(buildPreviewTunnelRefreshPath(tunnelId), gatewayUrl).toString(),
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    },
    parse: isPreviewTunnelRefreshResponse,
    invalidMessage: 'Received an invalid preview tunnel refresh response.',
  });

const revokeTunnel = async (
  gatewayUrl: string,
  tunnelId: string,
  sessionToken: string
): Promise<void> => {
  await fetch(new URL(buildPreviewTunnelRevokePath(tunnelId), gatewayUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
  }).catch(() => {});
};

const buildLocalOrigin = (target: PreviewTarget): URL => {
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  return new URL(`${target.protocol}://${host}:${target.port}`);
};

const containsControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
};

const containsUnsafePathSegment = (value: string): boolean => {
  const pathOnly = value.split(/[?#]/, 1)[0] ?? '';
  for (const segment of pathOnly.split('/')) {
    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (
      decodedSegment === '..' ||
      decodedSegment.includes('/') ||
      decodedSegment.includes('\\') ||
      containsControlCharacter(decodedSegment)
    ) {
      return true;
    }
  }
  return false;
};

const containsUnsafeDecodedCharacters = (value: string): boolean => {
  try {
    return containsControlCharacter(decodeURIComponent(value));
  } catch {
    return true;
  }
};

const assertRelativeTunnelPath = (value: string): void => {
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    containsControlCharacter(value) ||
    containsUnsafeDecodedCharacters(value) ||
    containsUnsafePathSegment(value) ||
    /^https?:\/\//i.test(value)
  ) {
    throw new Error('Preview tunnel rejected a non-relative request URL.');
  }
};

const assertBoundLocalUrl = (url: URL, localOrigin: URL): void => {
  if (
    url.protocol !== localOrigin.protocol ||
    url.hostname !== localOrigin.hostname ||
    url.port !== localOrigin.port
  ) {
    throw new Error('Preview tunnel rejected a request outside the bound local origin.');
  }
};

export async function startPreviewTunnel(
  options: StartPreviewTunnelOptions
): Promise<PreviewTunnelHandle> {
  const gatewayUrl = normalizeGatewayUrl(options.gatewayUrl);
  let tunnel = await createTunnel(gatewayUrl, options.authToken, options.createRequest);
  let interrupted = false;
  let activeSocket: LocalWebSocket | null = null;
  let refreshPromise: Promise<void> | null = null;
  const stopSessionRefreshLoopRef: { current: (() => void) | null } = { current: null };
  let ready = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let closeResolve!: () => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const closed = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  const isInterrupted = (): boolean => interrupted;

  const refreshSession = async (): Promise<void> => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = refreshTunnel(gatewayUrl, tunnel.tunnelId, tunnel.sessionToken)
      .then((refreshedSession) => {
        tunnel = { ...tunnel, ...refreshedSession };
      })
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  };

  const close = async (reason = 'Preview tunnel closed'): Promise<void> => {
    interrupted = true;
    stopSessionRefreshLoopRef.current?.();
    stopSessionRefreshLoopRef.current = null;
    if (
      activeSocket &&
      (activeSocket.readyState === LocalWebSocket.OPEN ||
        activeSocket.readyState === LocalWebSocket.CONNECTING)
    ) {
      activeSocket.close(1000, reason);
    }
    await revokeTunnel(gatewayUrl, tunnel.tunnelId, tunnel.sessionToken);
    closeResolve();
  };

  const localOrigin = buildLocalOrigin(options.target);
  const previewOrigin = new URL(tunnel.publicUrl);
  previewOrigin.search = '';
  previewOrigin.hash = '';
  const resourceLimits = resolveResourceLimits(tunnel.resourceLimits);
  const firstConnection = openTunnelConnection({
    tunnel,
    localOrigin,
    previewOrigin,
    resourceLimits,
    interrupted: isInterrupted,
    registerSocket(socket) {
      activeSocket = socket;
    },
    onReady() {
      ready = true;
      stopSessionRefreshLoopRef.current = startSessionRefreshLoop({
        interrupted: isInterrupted,
        refreshSession,
      });
      readyResolve();
    },
  });

  void firstConnection
    .then((outcome) => {
      if (!ready && outcome.kind === 'disconnected') {
        readyReject(new Error(outcome.message));
      } else if (!ready && outcome.kind === 'interrupted') {
        readyReject(new Error('Preview tunnel closed before it became ready.'));
      }
    })
    .catch((error) => {
      if (!ready) {
        readyReject(asError(error));
      }
    });

  void (async () => {
    try {
      let outcome = await firstConnection;
      let reconnectDelayMs = RECONNECT_BACKOFF_INITIAL_MS;
      while (!isInterrupted() && outcome.kind === 'disconnected') {
        await delay(reconnectDelayMs);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_BACKOFF_MAX_MS);
        await refreshSession();
        outcome = await openTunnelConnection({
          tunnel,
          localOrigin,
          previewOrigin,
          resourceLimits: resolveResourceLimits(tunnel.resourceLimits ?? resourceLimits),
          interrupted: isInterrupted,
          registerSocket(socket) {
            activeSocket = socket;
          },
          onReady() {},
        });
      }
      if (outcome.kind === 'disconnected') {
        await options.onClosed?.(new Error(outcome.message));
      } else {
        await options.onClosed?.(null);
      }
    } catch (error) {
      if (!interrupted) {
        await options.onClosed?.(asError(error));
      }
    } finally {
      const stopRefreshLoop = stopSessionRefreshLoopRef.current as (() => void) | null;
      stopSessionRefreshLoopRef.current = null;
      if (stopRefreshLoop) {
        stopRefreshLoop();
      }
      activeSocket = null;
      closeResolve();
    }
  })();

  try {
    await withTimeout(
      readyPromise,
      TUNNEL_READY_TIMEOUT_MS,
      'Timed out waiting for preview tunnel control connection to become ready'
    );
  } catch (error) {
    await close('Preview tunnel failed to become ready');
    throw error;
  }

  try {
    await verifyPreviewTunnelRoundTrip({
      publicUrl: tunnel.publicUrl,
      target: options.target,
    });
  } catch (error) {
    await close('Preview tunnel public round-trip validation failed').catch(() => {});
    throw error;
  }

  return {
    tunnelId: tunnel.tunnelId,
    publicUrl: tunnel.publicUrl,
    resourceLimits,
    close,
    closed,
  };
}

function startSessionRefreshLoop(options: {
  interrupted: () => boolean;
  refreshSession: () => Promise<void>;
}): () => void {
  let stopped = false;
  let timeoutHandle: NodeJS.Timeout | null = null;
  function schedule(delayMs: number): void {
    if (stopped) return;
    timeoutHandle = setTimeout(() => void tick(), delayMs);
    timeoutHandle.unref?.();
  }
  async function tick(): Promise<void> {
    if (stopped || options.interrupted()) return;
    try {
      await options.refreshSession();
      schedule(SESSION_REFRESH_INTERVAL_MS);
    } catch {
      schedule(SESSION_REFRESH_RETRY_MS);
    }
  }
  schedule(SESSION_REFRESH_INTERVAL_MS);
  return () => {
    stopped = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
  };
}

async function openTunnelConnection(options: {
  tunnel: PreviewTunnelCreateResponse;
  localOrigin: URL;
  previewOrigin: URL;
  resourceLimits: PreviewResourceLimits;
  interrupted: () => boolean;
  registerSocket: (socket: LocalWebSocket | null) => void;
  onReady: () => void;
}): Promise<ConnectionOutcome> {
  const tunnelSocket = new LocalWebSocket(options.tunnel.websocketUrl);
  const localRequests = new Map<string, LocalRequestContext>();
  const localSockets = new Map<string, LocalWebSocketContext>();
  let sendQueue = Promise.resolve();
  let pendingBinaryPayload: PreviewTunnelBinaryPayloadMessage | null = null;
  let capabilities = new Set<string>();
  let opened = false;
  let ready = false;

  options.registerSocket(tunnelSocket);

  const shouldIgnoreTunnelSendError = (error: unknown): boolean =>
    options.interrupted() ||
    (error instanceof Error && error.message === 'Tunnel connection is unavailable');

  const handleBackgroundTunnelSendError = (error: unknown): void => {
    if (!shouldIgnoreTunnelSendError(error)) {
      console.warn(`Failed to send preview tunnel message: ${formatError(error)}`);
    }
  };

  return new Promise<ConnectionOutcome>((resolve, reject) => {
    tunnelSocket.addEventListener('open', () => {
      opened = true;
    });

    tunnelSocket.addEventListener('message', (event) => {
      void handleServerMessage(event).catch((error) => {
        reject(asError(error));
        if (
          tunnelSocket.readyState === LocalWebSocket.OPEN ||
          tunnelSocket.readyState === LocalWebSocket.CONNECTING
        ) {
          tunnelSocket.close(1011, 'Client error');
        }
      });
    });

    tunnelSocket.addEventListener('close', (event) => {
      abortLocalRequests(localRequests);
      closeLocalWebSockets(localSockets, TUNNEL_REPLACED_CLOSE_CODE, 'Tunnel connection closed');
      pendingBinaryPayload = null;
      options.registerSocket(null);
      if (options.interrupted()) {
        resolve({ kind: 'interrupted' });
        return;
      }
      const detail = event.reason ? `: ${event.reason}` : '';
      const label = opened ? 'Preview tunnel disconnected' : 'Preview tunnel failed to connect';
      resolve({ kind: 'disconnected', message: `${label} (${event.code}${detail})` });
    });

    tunnelSocket.addEventListener('error', (event: LocalWebSocketErrorEvent) => {
      abortLocalRequests(localRequests);
      closeLocalWebSockets(localSockets, TUNNEL_REPLACED_CLOSE_CODE, 'Tunnel connection error');
      pendingBinaryPayload = null;
      options.registerSocket(null);
      if (options.interrupted()) {
        resolve({ kind: 'interrupted' });
        return;
      }
      const message = event.message || formatError(event.error) || 'Unknown WebSocket error';
      resolve({ kind: 'disconnected', message: `Preview tunnel connection error: ${message}` });
      if (
        tunnelSocket.readyState === LocalWebSocket.OPEN ||
        tunnelSocket.readyState === LocalWebSocket.CONNECTING
      ) {
        tunnelSocket.close(1011, 'Tunnel connection error');
      }
    });

    function markTunnelReady(): void {
      if (ready) return;
      ready = true;
      options.onReady();
    }

    async function handleServerMessage(event: LocalWebSocketMessageEvent): Promise<void> {
      const incomingMessage = await readTunnelSocketMessage(event.data);
      if (incomingMessage.kind === 'binary') {
        const binaryPayload = pendingBinaryPayload;
        pendingBinaryPayload = null;
        if (!binaryPayload) throw new Error('Received an unexpected binary tunnel payload');
        handleBinaryPayload(binaryPayload, incomingMessage.payload);
        return;
      }
      if (pendingBinaryPayload) {
        const missingPayload = pendingBinaryPayload;
        pendingBinaryPayload = null;
        throw new Error(
          `Expected a binary payload frame for ${missingPayload.stream} ${missingPayload.requestId}`
        );
      }

      const message = parsePreviewTunnelServerMessage(incomingMessage.text);
      if (!message) throw new Error('Received an invalid tunnel message');
      if (message.type === 'binary-payload') {
        pendingBinaryPayload = message;
        return;
      }

      switch (message.type) {
        case 'tunnel-ready': {
          if (message.protocolVersion !== PREVIEW_TUNNEL_PROTOCOL_VERSION) {
            throw new Error('Unsupported tunnel protocol version');
          }
          await sendMessage({
            type: 'client-ready',
            protocolVersion: PREVIEW_TUNNEL_PROTOCOL_VERSION,
            capabilities: [...PREVIEW_TUNNEL_CAPABILITIES],
          });
          return;
        }
        case 'tunnel-accepted':
          if (message.protocolVersion !== PREVIEW_TUNNEL_PROTOCOL_VERSION) {
            throw new Error('Unsupported tunnel protocol version');
          }
          capabilities = new Set(message.capabilities);
          markTunnelReady();
          return;
        case 'error':
          reject(new Error(message.message));
          tunnelSocket.close(1011, 'Server error');
          return;
        case 'request-start':
          void startLocalRequest(message).catch((error) => {
            void sendMessage({
              type: 'response-error',
              requestId: message.requestId,
              message: formatError(error),
            }).catch(handleBackgroundTunnelSendError);
          });
          return;
        case 'request-body':
          writeLocalRequestBody(message.requestId, decodeBase64(message.chunk));
          return;
        case 'request-end':
          queueLocalRequestWrite(message.requestId, (context, writer) =>
            writer.close().then(() => {
              context.writer = null;
            })
          );
          return;
        case 'request-cancel':
          cancelLocalRequest(message.requestId, message.reason);
          return;
        case 'response-body-credit': {
          const requestContext = localRequests.get(message.requestId);
          if (requestContext) addResponseBodyCredit(requestContext, message.credit);
          return;
        }
        case 'websocket-connect':
          try {
            startLocalWebSocket(message);
          } catch (error) {
            void sendMessage({
              type: 'websocket-reject',
              requestId: message.requestId,
              message: formatError(error),
            }).catch(handleBackgroundTunnelSendError);
          }
          return;
        case 'websocket-frame':
          forwardFrameToLocalWebSocket(message.requestId, message.chunk, message.isBinary);
          return;
        case 'websocket-close':
          closeLocalWebSocket(message.requestId, message.code, message.reason);
          return;
      }
    }

    function handleBinaryPayload(
      message: PreviewTunnelBinaryPayloadMessage,
      payload: Uint8Array
    ): void {
      switch (message.stream) {
        case 'request-body':
          writeLocalRequestBody(message.requestId, payload);
          return;
        case 'websocket-frame':
          forwardBinaryFrameToLocalWebSocket(message.requestId, payload);
          return;
        case 'response-body':
          throw new Error('Received an unexpected binary response payload');
      }
    }

    async function sendResponseBodyBytes(args: {
      requestId: string;
      requestContext: LocalRequestContext;
      body: Uint8Array;
      useBinaryPayload: boolean;
      useResponseBodyCredit: boolean;
    }): Promise<void> {
      let offset = 0;
      while (offset < args.body.byteLength) {
        const chunkByteLength = Math.min(
          PREVIEW_TUNNEL_HTTP_BODY_BATCH_BYTES,
          args.body.byteLength - offset
        );
        const batch = args.body.subarray(offset, offset + chunkByteLength);
        offset += chunkByteLength;
        args.requestContext.responseBodyBytes += batch.byteLength;
        if (args.requestContext.responseBodyBytes > options.resourceLimits.maxResponseBodyBytes) {
          throw new Error(
            `Preview response exceeds ${options.resourceLimits.maxResponseBodyBytes} byte limit`
          );
        }
        if (args.useResponseBodyCredit) {
          await consumeResponseBodyCredit(args.requestContext, batch.byteLength);
        }
        if (args.useBinaryPayload) {
          await sendBinaryPayload(args.requestId, 'response-body', batch);
          continue;
        }
        await sendMessage({
          type: 'response-body',
          requestId: args.requestId,
          chunk: encodeBase64(batch),
        });
      }
    }

    async function startLocalRequest(message: PreviewTunnelRequestStartMessage): Promise<void> {
      assertRelativeTunnelPath(message.url);
      const proxyUrl = new URL(message.url, options.localOrigin);
      assertBoundLocalUrl(proxyUrl, options.localOrigin);
      const proxyHeaders = buildLocalPreviewRequestHeaders(message.headers);
      const useBinaryPayload = shouldUseBinaryPayload(message);
      const useResponseBodyCredit = shouldUseResponseBodyCredit(message);
      const abortController = new AbortController();
      let bodyStream: ReadableStream<Uint8Array> | undefined;
      let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

      if (message.hasBody) {
        const streamPair = new TransformStream<Uint8Array, Uint8Array>();
        bodyStream = streamPair.readable;
        writer = streamPair.writable.getWriter();
      }

      const requestContext: LocalRequestContext = {
        startedAt: Date.now(),
        abortController,
        cancelled: false,
        writer,
        writeChain: Promise.resolve(),
        requestBodyBytes: 0,
        responseBodyBytes: 0,
        responseErrorSent: false,
        timeoutId: null,
        responseBodyCreditBytes: 0,
        responseBodyCreditWaiters: [],
      };
      requestContext.timeoutId = setTimeout(() => {
        requestContext.cancelled = false;
        abortController.abort(
          new Error(
            `Preview local request exceeded ${options.resourceLimits.maxRequestDurationMs} ms limit`
          )
        );
      }, options.resourceLimits.maxRequestDurationMs);
      requestContext.timeoutId.unref?.();
      localRequests.set(message.requestId, requestContext);

      try {
        const requestInit: RequestInitWithDuplex = {
          method: message.method,
          headers: proxyHeaders,
          body: bodyStream,
          duplex: bodyStream ? 'half' : undefined,
          signal: abortController.signal,
          redirect: 'manual',
        };
        const localResponse = await fetch(proxyUrl, requestInit);
        const injectedHtml = await maybeInjectVisualAnnotationRuntime(
          localResponse,
          message.method,
          options.resourceLimits.maxResponseBodyBytes
        );
        if (injectedHtml) {
          await sendMessage({
            type: 'response-start',
            requestId: message.requestId,
            status: localResponse.status,
            statusText: localResponse.statusText,
            headers: headersToEntries(
              buildInjectedHtmlHeaders(
                localResponse.headers,
                injectedHtml.body.byteLength,
                injectedHtml.runtimeInjected
              ),
              {
                localOrigin: options.localOrigin,
                previewOrigin: options.previewOrigin,
              }
            ),
            hasBody: injectedHtml.body.byteLength > 0,
          });
          await sendResponseBodyBytes({
            requestId: message.requestId,
            requestContext,
            body: injectedHtml.body,
            useBinaryPayload,
            useResponseBodyCredit,
          });
          await sendMessage({ type: 'response-end', requestId: message.requestId });
          return;
        }
        await sendMessage({
          type: 'response-start',
          requestId: message.requestId,
          status: localResponse.status,
          statusText: localResponse.statusText,
          headers: headersToEntries(localResponse.headers, {
            localOrigin: options.localOrigin,
            previewOrigin: options.previewOrigin,
          }),
          hasBody: localResponse.body !== null,
        });

        if (localResponse.body) {
          const reader = localResponse.body.getReader();
          let pendingBodyChunks: Uint8Array[] = [];
          let pendingBodyBytes = 0;
          const flushPendingResponseBody = async (): Promise<void> => {
            if (pendingBodyBytes === 0) return;
            const batch = concatUint8Arrays(pendingBodyChunks, pendingBodyBytes);
            pendingBodyChunks = [];
            pendingBodyBytes = 0;
            requestContext.responseBodyBytes += batch.byteLength;
            if (requestContext.responseBodyBytes > options.resourceLimits.maxResponseBodyBytes) {
              throw new Error(
                `Preview response exceeds ${options.resourceLimits.maxResponseBodyBytes} byte limit`
              );
            }
            if (useResponseBodyCredit) {
              await consumeResponseBodyCredit(requestContext, batch.byteLength);
            }
            if (useBinaryPayload) {
              await sendBinaryPayload(message.requestId, 'response-body', batch);
              return;
            }
            await sendMessage({
              type: 'response-body',
              requestId: message.requestId,
              chunk: encodeBase64(batch),
            });
          };

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              let offset = 0;
              while (offset < value.byteLength) {
                const chunkByteLength = Math.min(
                  PREVIEW_TUNNEL_HTTP_BODY_BATCH_BYTES - pendingBodyBytes,
                  value.byteLength - offset
                );
                pendingBodyChunks.push(value.subarray(offset, offset + chunkByteLength));
                pendingBodyBytes += chunkByteLength;
                offset += chunkByteLength;
                if (pendingBodyBytes >= PREVIEW_TUNNEL_HTTP_BODY_BATCH_BYTES) {
                  await flushPendingResponseBody();
                }
              }
            }
            await flushPendingResponseBody();
          } finally {
            reader.releaseLock();
          }
        }
        await sendMessage({ type: 'response-end', requestId: message.requestId });
      } catch (error) {
        if (requestContext.cancelled || shouldIgnoreTunnelSendError(error)) return;
        requestContext.responseErrorSent = true;
        await sendMessage({
          type: 'response-error',
          requestId: message.requestId,
          message: formatError(error),
        }).catch((sendError) => {
          if (!shouldIgnoreTunnelSendError(sendError)) throw sendError;
        });
      } finally {
        if (requestContext.timeoutId) {
          clearTimeout(requestContext.timeoutId);
          requestContext.timeoutId = null;
        }
        notifyResponseBodyCreditWaiters(requestContext);
        localRequests.delete(message.requestId);
      }
    }

    function startLocalWebSocket(message: PreviewTunnelWebSocketConnectMessage): void {
      assertRelativeTunnelPath(message.url);
      const proxyUrl = buildLocalWebSocketUrl(options.localOrigin, message.url);
      const localSocket = new LocalWebSocket(proxyUrl, message.protocols, {
        headers: headersToNodeRecord(stripLocalWebSocketHeaders(message.headers)),
      });
      const socketContext: LocalWebSocketContext = {
        socket: localSocket,
        opened: false,
        remoteClosed: false,
        handshakeSettled: false,
        useBinaryPayload: shouldUseBinaryPayload(message),
      };
      localSockets.set(message.requestId, socketContext);

      const rejectHandshake = (reason: string): void => {
        if (socketContext.handshakeSettled) return;
        socketContext.handshakeSettled = true;
        localSockets.delete(message.requestId);
        queueBackgroundMessage({
          type: 'websocket-reject',
          requestId: message.requestId,
          message: reason,
        });
      };

      localSocket.once('open', () => {
        socketContext.opened = true;
        socketContext.handshakeSettled = true;
        queueBackgroundMessage({
          type: 'websocket-accept',
          requestId: message.requestId,
          protocol: localSocket.protocol || undefined,
        });
      });
      localSocket.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          if (socketContext.useBinaryPayload) {
            queueBackgroundBinaryPayload(
              message.requestId,
              'websocket-frame',
              rawDataToBuffer(data)
            );
          } else {
            queueBackgroundMessage({
              type: 'websocket-frame',
              requestId: message.requestId,
              chunk: encodeBase64(rawDataToBuffer(data)),
              isBinary: true,
            });
          }
          return;
        }
        queueBackgroundMessage({
          type: 'websocket-frame',
          requestId: message.requestId,
          chunk: encodeBase64(rawDataToBuffer(data)),
          isBinary: false,
        });
      });
      localSocket.once('unexpected-response', (_request, response: IncomingMessage) => {
        rejectHandshake(formatUnexpectedWebSocketResponse(response));
        response.resume();
        localSocket.terminate();
      });
      localSocket.on('error', (error) => {
        if (!socketContext.handshakeSettled) rejectHandshake(formatError(error));
      });
      localSocket.on('close', (code, reasonBuffer) => {
        const reason = Buffer.from(reasonBuffer).toString('utf8');
        const wasOpened = socketContext.opened;
        const handshakeSettled = socketContext.handshakeSettled;
        const remoteClosed = socketContext.remoteClosed;
        localSockets.delete(message.requestId);
        if (!wasOpened && !handshakeSettled) {
          rejectHandshake(formatLocalWebSocketClose(code, reason));
          return;
        }
        if (!wasOpened || remoteClosed) return;
        queueBackgroundMessage({
          type: 'websocket-close',
          requestId: message.requestId,
          code,
          reason,
        });
      });
    }

    function forwardFrameToLocalWebSocket(
      requestId: string,
      chunk: string,
      isBinary: boolean
    ): void {
      if (isBinary) {
        forwardBinaryFrameToLocalWebSocket(requestId, decodeBase64(chunk));
        return;
      }
      const socketContext = localSockets.get(requestId);
      if (!socketContext || socketContext.socket.readyState !== LocalWebSocket.OPEN) return;
      socketContext.socket.send(decodeTextBase64(chunk), { binary: false });
    }

    function forwardBinaryFrameToLocalWebSocket(requestId: string, payload: Uint8Array): void {
      const socketContext = localSockets.get(requestId);
      if (!socketContext || socketContext.socket.readyState !== LocalWebSocket.OPEN) return;
      socketContext.socket.send(payload, { binary: true });
    }

    function closeLocalWebSocket(
      requestId: string,
      code: number | undefined,
      reason: string
    ): void {
      const socketContext = localSockets.get(requestId);
      if (!socketContext) return;
      socketContext.remoteClosed = true;
      if (socketContext.socket.readyState === LocalWebSocket.CONNECTING) {
        socketContext.socket.terminate();
        localSockets.delete(requestId);
        return;
      }
      if (
        socketContext.socket.readyState === LocalWebSocket.CLOSING ||
        socketContext.socket.readyState === LocalWebSocket.CLOSED
      ) {
        localSockets.delete(requestId);
        return;
      }
      socketContext.socket.close(
        normalizeWebSocketCloseCode(code),
        normalizeWebSocketCloseReason(reason)
      );
    }

    function cancelLocalRequest(requestId: string, reason: string): void {
      const requestContext = localRequests.get(requestId);
      if (!requestContext) return;
      requestContext.cancelled = true;
      requestContext.abortController.abort(new Error(reason));
      notifyResponseBodyCreditWaiters(requestContext);
      const writer = requestContext.writer;
      requestContext.writer = null;
      if (writer) {
        requestContext.writeChain = requestContext.writeChain
          .catch(() => undefined)
          .then(() => writer.abort(reason))
          .catch(() => undefined);
      }
    }

    function writeLocalRequestBody(requestId: string, payload: Uint8Array): void {
      queueLocalRequestWrite(requestId, async (context, writer) => {
        context.requestBodyBytes += payload.byteLength;
        if (context.requestBodyBytes > options.resourceLimits.maxRequestBodyBytes) {
          throw new Error(
            `Preview request body exceeds ${options.resourceLimits.maxRequestBodyBytes} byte limit`
          );
        }
        await writer.write(payload);
      });
    }

    function queueLocalRequestWrite(
      requestId: string,
      operation: (
        context: LocalRequestContext,
        writer: WritableStreamDefaultWriter<Uint8Array>
      ) => Promise<void>
    ): void {
      const requestContext = localRequests.get(requestId);
      const writer = requestContext?.writer;
      if (!requestContext || !writer) return;
      requestContext.writeChain = requestContext.writeChain
        .catch(() => undefined)
        .then(async () => {
          if (requestContext.cancelled || requestContext.abortController.signal.aborted) return;
          await operation(requestContext, writer);
        })
        .catch((error) => {
          requestContext.cancelled = true;
          requestContext.abortController.abort(error);
          notifyResponseBodyCreditWaiters(requestContext);
          if (!requestContext.responseErrorSent) {
            requestContext.responseErrorSent = true;
            queueBackgroundMessage({
              type: 'response-error',
              requestId,
              message: formatError(error),
            });
          }
        });
    }

    function queueBackgroundMessage(message: PreviewTunnelClientMessage): void {
      void sendMessage(message).catch(handleBackgroundTunnelSendError);
    }

    function queueBackgroundBinaryPayload(
      requestId: string,
      stream: PreviewTunnelBinaryPayloadMessage['stream'],
      payload: Uint8Array
    ): void {
      void sendBinaryPayload(requestId, stream, payload).catch(handleBackgroundTunnelSendError);
    }

    function shouldUseBinaryPayload(
      message: PreviewTunnelRequestStartMessage | PreviewTunnelWebSocketConnectMessage
    ): boolean {
      return message.binaryPayload ?? capabilities.has(PREVIEW_TUNNEL_BINARY_PAYLOAD_CAPABILITY);
    }

    function shouldUseResponseBodyCredit(message: PreviewTunnelRequestStartMessage): boolean {
      return (
        message.responseBodyCredit ??
        capabilities.has(PREVIEW_TUNNEL_RESPONSE_BODY_CREDIT_CAPABILITY)
      );
    }

    function sendMessage(message: PreviewTunnelClientMessage): Promise<void> {
      return sendSocketFrames([JSON.stringify(message)]);
    }

    function sendBinaryPayload(
      requestId: string,
      stream: PreviewTunnelBinaryPayloadMessage['stream'],
      payload: Uint8Array
    ): Promise<void> {
      return sendSocketFrames([
        JSON.stringify({ type: 'binary-payload', requestId, stream }),
        payload,
      ]);
    }

    function sendSocketFrames(frames: ReadonlyArray<string | Uint8Array>): Promise<void> {
      const nextSend = sendQueue
        .catch(() => undefined)
        .then(async () => {
          for (const frame of frames) {
            await waitForTunnelSocketCapacity(tunnelSocket);
            if (tunnelSocket.readyState !== LocalWebSocket.OPEN) {
              throw new Error('Tunnel connection is unavailable');
            }
            tunnelSocket.send(typeof frame === 'string' ? frame : (frame as Buffer));
          }
        });
      sendQueue = nextSend;
      return nextSend;
    }
  });
}

async function readTunnelSocketMessage(
  data: LocalWebSocketMessageEvent['data']
): Promise<{ kind: 'text'; text: string } | { kind: 'binary'; payload: Uint8Array }> {
  if (typeof data === 'string') return { kind: 'text', text: data };
  if (data instanceof ArrayBuffer) return { kind: 'binary', payload: new Uint8Array(data) };
  if (ArrayBuffer.isView(data)) {
    return {
      kind: 'binary',
      payload: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    };
  }
  if (data instanceof Blob)
    return { kind: 'binary', payload: new Uint8Array(await data.arrayBuffer()) };
  throw new Error('Unsupported WebSocket message payload');
}

function abortLocalRequests(localRequests: Map<string, LocalRequestContext>): void {
  for (const requestContext of localRequests.values()) {
    requestContext.cancelled = true;
    requestContext.abortController.abort();
    notifyResponseBodyCreditWaiters(requestContext);
  }
}

function addResponseBodyCredit(requestContext: LocalRequestContext, creditBytes: number): void {
  requestContext.responseBodyCreditBytes += creditBytes;
  notifyResponseBodyCreditWaiters(requestContext);
}

async function consumeResponseBodyCredit(
  requestContext: LocalRequestContext,
  creditBytes: number
): Promise<void> {
  while (requestContext.responseBodyCreditBytes < creditBytes) {
    if (requestContext.abortController.signal.aborted) {
      throw new Error('Tunnel connection is unavailable');
    }
    await new Promise<void>((resolve) => requestContext.responseBodyCreditWaiters.push(resolve));
  }
  requestContext.responseBodyCreditBytes -= creditBytes;
}

function notifyResponseBodyCreditWaiters(requestContext: LocalRequestContext): void {
  const waiters = requestContext.responseBodyCreditWaiters;
  if (waiters.length === 0) return;
  requestContext.responseBodyCreditWaiters = [];
  for (const resolve of waiters) resolve();
}

function closeLocalWebSockets(
  localSockets: Map<string, LocalWebSocketContext>,
  code: number,
  reason: string
): void {
  for (const socketContext of localSockets.values()) {
    socketContext.remoteClosed = true;
    if (
      socketContext.socket.readyState === LocalWebSocket.CONNECTING ||
      socketContext.socket.readyState === LocalWebSocket.OPEN
    ) {
      socketContext.socket.close(
        normalizeWebSocketCloseCode(code),
        normalizeWebSocketCloseReason(reason)
      );
    }
  }
  localSockets.clear();
}

function stripLocalPreviewRequestHeaders(headers: HeaderEntry[]): HeaderEntry[] {
  return headers.filter(
    ([name]) => !LOCAL_PREVIEW_REQUEST_HEADER_EXCLUSIONS.has(name.toLowerCase())
  );
}

function getHeaderValue(headers: HeaderEntry[], headerName: string): string | null {
  const normalizedHeaderName = headerName.toLowerCase();
  const entry = headers.find(([name]) => name.toLowerCase() === normalizedHeaderName);
  return entry?.[1] ?? null;
}

function rewriteLocalPreviewReferer(
  referer: string,
  options: LocalPreviewRequestHeaderOptions
): string | null {
  try {
    const refererUrl = new URL(referer);
    if (refererUrl.origin !== options.previewOrigin.origin) {
      return null;
    }
    refererUrl.search = removePreviewQueryParamFromSearch(
      refererUrl.search,
      options.localPreviewTokenQueryParam
    );
    return new URL(
      `${refererUrl.pathname}${refererUrl.search}${refererUrl.hash}`,
      options.localOrigin
    ).toString();
  } catch {
    return null;
  }
}

export function stripLocalWebSocketHeaders(headers: HeaderEntry[]): HeaderEntry[] {
  return headers.filter(([name]) => !LOCAL_WEBSOCKET_HEADER_EXCLUSIONS.has(name.toLowerCase()));
}

function rewriteLocalRedirectLocation(value: string, localOrigin: URL, previewOrigin: URL): string {
  const locationUrl = new URL(value, localOrigin);
  assertBoundLocalUrl(locationUrl, localOrigin);
  return new URL(
    `${locationUrl.pathname}${locationUrl.search}${locationUrl.hash}`,
    previewOrigin
  ).toString();
}

function canInjectVisualAnnotationRuntime(response: Response, method: string): boolean {
  if (method === 'HEAD' || response.body === null) {
    return false;
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/html')) {
    return false;
  }
  return true;
}

export async function maybeInjectVisualAnnotationRuntime(
  response: Response,
  method: string,
  maxResponseBodyBytes: number
): Promise<{ body: Uint8Array; runtimeInjected: boolean } | null> {
  if (!canInjectVisualAnnotationRuntime(response, method)) {
    return null;
  }
  const responseBody = await readResponseBodyBytesWithinLimit(response, maxResponseBodyBytes);
  const html = Buffer.from(responseBody).toString('utf8');
  // Node's fetch transparently decodes compressed responses but preserves the
  // original content-encoding header. If a non-fetch Response still contains
  // encoded bytes, do not append JS to binary data.
  if (response.headers.has('content-encoding') && !looksLikeDecodedHtml(html)) {
    return null;
  }
  if (html.includes(VISUAL_ANNOTATION_INJECTED_MARKER)) {
    return { body: responseBody, runtimeInjected: true };
  }
  const scriptTag = `<script ${VISUAL_ANNOTATION_INJECTED_MARKER}="true">\n${escapeHtmlScriptContent(
    VISUAL_ANNOTATION_INSPECTOR_BROWSER_SCRIPT
  )}\n</script>`;
  const lowerHtml = html.toLowerCase();
  let injectedHtml: Uint8Array;
  const bodyCloseIndex = lowerHtml.lastIndexOf('</body>');
  if (bodyCloseIndex >= 0) {
    injectedHtml = Buffer.from(
      `${html.slice(0, bodyCloseIndex)}${scriptTag}${html.slice(bodyCloseIndex)}`,
      'utf8'
    );
  } else if (lowerHtml.lastIndexOf('</html>') >= 0) {
    const htmlCloseIndex = lowerHtml.lastIndexOf('</html>');
    injectedHtml = Buffer.from(
      `${html.slice(0, htmlCloseIndex)}${scriptTag}${html.slice(htmlCloseIndex)}`,
      'utf8'
    );
  } else {
    injectedHtml = Buffer.from(`${html}${scriptTag}`, 'utf8');
  }
  if (injectedHtml.byteLength > maxResponseBodyBytes) {
    // Optional instrumentation must not reject an otherwise valid response.
    return { body: responseBody, runtimeInjected: false };
  }
  return { body: injectedHtml, runtimeInjected: true };
}

function looksLikeDecodedHtml(value: string): boolean {
  return /<(?:!doctype|html|head|body|script|main|div|section|article|meta|title)\b/i.test(value);
}

export function buildLocalPreviewRequestHeaders(
  headers: HeaderEntry[],
  options?: LocalPreviewRequestHeaderOptions
): Headers {
  const proxyHeaders = new Headers(stripLocalPreviewRequestHeaders(headers));
  const fetchMode = proxyHeaders.get('sec-fetch-mode');
  if (fetchMode === 'navigate' || fetchMode === 'nested-navigate') {
    // Node fetch replaces navigation mode with "cors". Forwarding the browser's
    // cross-site metadata alongside that mode makes Astro reject an otherwise
    // permitted iframe navigation. Treat this hop as a server-side navigation
    // fetch, while retaining metadata on subresources and preserving Origin.
    for (const name of ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user']) {
      proxyHeaders.delete(name);
    }
  }
  if (options) {
    const rewrittenReferer = rewriteLocalPreviewReferer(getHeaderValue(headers, 'referer') ?? '', {
      localOrigin: options.localOrigin,
      previewOrigin: options.previewOrigin,
      localPreviewTokenQueryParam: options.localPreviewTokenQueryParam,
    });
    if (rewrittenReferer) {
      proxyHeaders.set('referer', rewrittenReferer);
    }
  }
  // Most local dev servers honor this and return plain HTML, which keeps the
  // annotation runtime injectable. Node fetch also decodes gzip/br bodies for
  // servers that ignore it, but avoiding compression is the safer fast path.
  proxyHeaders.set('accept-encoding', LOCAL_PREVIEW_ACCEPT_ENCODING);
  return proxyHeaders;
}

function escapeHtmlScriptContent(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script');
}

async function readResponseBodyBytesWithinLimit(
  response: Response,
  maxResponseBodyBytes: number
): Promise<Uint8Array> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let totalByteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = value;
      totalByteLength += chunk.byteLength;
      if (totalByteLength > maxResponseBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Preview response exceeds ${maxResponseBodyBytes} byte limit`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return concatUint8Arrays(chunks, totalByteLength);
}

export function buildInjectedHtmlHeaders(
  sourceHeaders: Headers,
  bodyByteLength: number,
  runtimeInjected = true
): Headers {
  const headers = new Headers(sourceHeaders);
  headers.delete('content-encoding');
  headers.delete('content-length');
  if (runtimeInjected) {
    headers.delete('content-security-policy');
    headers.delete('content-security-policy-report-only');
  }
  headers.delete('etag');
  headers.delete('last-modified');
  headers.set('cache-control', 'no-store');
  headers.set('content-length', String(bodyByteLength));
  headers.delete(VISUAL_ANNOTATION_RUNTIME_RESPONSE_HEADER);
  if (runtimeInjected) {
    headers.set(
      VISUAL_ANNOTATION_RUNTIME_RESPONSE_HEADER,
      VISUAL_ANNOTATION_RUNTIME_RESPONSE_VERSION
    );
  }
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/html; charset=utf-8');
  }
  return headers;
}

export function headersToEntries(
  headers: Headers,
  options?: { localOrigin: URL; previewOrigin: URL }
): HeaderEntry[] {
  const responseHeaders: HeaderEntry[] = [];
  // Undici decodes fetch bodies but retains the local server's compression metadata.
  const bodyWasDecoded = headers.has('content-encoding');
  for (const [name, value] of headers) {
    const lowerName = name.toLowerCase();
    if (
      !LOCAL_RESPONSE_HEADER_EXCLUSIONS.has(lowerName) &&
      lowerName !== PREVIEW_PROXY_RESPONSE_HEADER &&
      !(bodyWasDecoded && (lowerName === 'content-encoding' || lowerName === 'content-length'))
    ) {
      responseHeaders.push([
        name,
        options && lowerName === 'location'
          ? rewriteLocalRedirectLocation(value, options.localOrigin, options.previewOrigin)
          : value,
      ]);
    }
  }
  responseHeaders.push([PREVIEW_PROXY_RESPONSE_HEADER, PREVIEW_PROXY_RESPONSE_VERSION]);
  return responseHeaders;
}

export function headersToNodeRecord(headers: HeaderEntry[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    const existingValue = result[name];
    result[name] = existingValue ? `${existingValue}, ${value}` : value;
  }
  return result;
}

export function buildLocalWebSocketUrl(localOrigin: URL, path: string): string {
  const proxyUrl = new URL(path, localOrigin);
  assertBoundLocalUrl(proxyUrl, localOrigin);
  proxyUrl.protocol = proxyUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return proxyUrl.toString();
}

async function waitForTunnelSocketCapacity(socket: LocalWebSocket): Promise<void> {
  if (socket.bufferedAmount <= PREVIEW_TUNNEL_SOCKET_BACKPRESSURE_HIGH_WATERMARK_BYTES) {
    return;
  }
  while (
    socket.readyState === LocalWebSocket.OPEN &&
    socket.bufferedAmount > PREVIEW_TUNNEL_SOCKET_BACKPRESSURE_LOW_WATERMARK_BYTES
  ) {
    await new Promise((resolve) => setTimeout(resolve, TUNNEL_SOCKET_BACKPRESSURE_POLL_MS));
  }
}

function concatUint8Arrays(chunks: Uint8Array[], totalByteLength: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array();
  const merged = new Uint8Array(totalByteLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function decodeBase64(value: string): Uint8Array {
  return Buffer.from(value, 'base64');
}

function decodeTextBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function rawDataToBuffer(value: RawData): Buffer {
  if (Array.isArray(value)) return Buffer.concat(value.map((chunk) => Buffer.from(chunk)));
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function normalizeWebSocketCloseCode(code?: number): number {
  if (
    typeof code === 'number' &&
    ((code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
      (code >= 3000 && code <= 4999))
  ) {
    return code;
  }
  return DEFAULT_WEBSOCKET_CLOSE_CODE;
}

function normalizeWebSocketCloseReason(reason: string): string {
  return (reason || 'Tunnel closed').slice(0, 123);
}

function formatUnexpectedWebSocketResponse(response: IncomingMessage): string {
  const statusCode = response.statusCode ?? 502;
  const statusMessage = response.statusMessage?.trim();
  return statusMessage
    ? `Local WebSocket service rejected the upgrade (${statusCode} ${statusMessage})`
    : `Local WebSocket service rejected the upgrade (${statusCode})`;
}

function formatLocalWebSocketClose(code: number, reason: string): string {
  return reason
    ? `Local WebSocket connection closed during handshake (${code}: ${reason})`
    : `Local WebSocket connection closed during handshake (${code})`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(formatError(error));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeoutHandle.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

function parseErrorMessage(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as { error?: unknown; message?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.error === 'string') return parsed.error;
    return null;
  } catch {
    return rawBody.trim() || null;
  }
}

function buildInvalidJsonResponseMessage(
  invalidMessage: string,
  response: Response,
  rawBody: string
): string {
  const details = [`HTTP ${response.status}`];
  const contentType = response.headers.get('content-type')?.trim();
  if (contentType) {
    details.push(`content-type ${contentType}`);
  }
  const summarizedBody = summarizeInvalidResponseBody(rawBody);
  if (!summarizedBody) {
    return `${invalidMessage} (${details.join(', ')}).`;
  }
  return `${invalidMessage} (${details.join(', ')}). Response body: ${summarizedBody}`;
}

function summarizeInvalidResponseBody(rawBody: string): string | null {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return null;
  }
  const compact = trimmed.replace(/\s+/g, ' ');
  const redacted = redactPreviewResponseSecrets(compact);
  if (redacted.length <= INVALID_RESPONSE_BODY_SNIPPET_MAX_CHARS) {
    return redacted;
  }
  return `${redacted.slice(0, INVALID_RESPONSE_BODY_SNIPPET_MAX_CHARS - 3)}...`;
}

function redactPreviewResponseSecrets(value: string): string {
  return value
    .replace(
      /([?&](?:__lody_preview_token|token|sessionToken|connectToken|viewerToken|authToken)=)[^&#\s"]+/gi,
      '$1***'
    )
    .replace(
      /("(?:sessionToken|connectToken|viewerToken|authToken|token)"\s*:\s*")([^"]+)(")/gi,
      '$1***$3'
    )
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/=]+/gi, '$1***');
}

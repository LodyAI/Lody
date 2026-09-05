import type { MachineId, SessionId, WorkspaceId } from './index';

export type PreviewProtocol = 'http' | 'https';

export type PreviewViewerScope = {
  type: 'workspace';
};

export type PreviewTarget = {
  protocol: PreviewProtocol;
  host: string;
  port: number;
  path?: string;
};

const PREVIEW_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * A preview target host is only ever a loopback address on the session's own
 * machine. The CLI validates this authoritatively before reporting a candidate,
 * but the value travels through the (workspace-shared) session doc, so renderers
 * embedding a local preview URL must re-check it as defense-in-depth against a
 * peer writing an arbitrary host/port.
 */
export const isLoopbackPreviewHost = (host: string): boolean => {
  const trimmed = host.trim().toLowerCase();
  const normalized =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return PREVIEW_LOOPBACK_HOSTS.has(normalized);
};

export type PreviewCandidateStatus = 'none' | 'reported' | 'validating' | 'available' | 'invalid';

export type PreviewConnectionStatus =
  | 'idle'
  | 'creating'
  | 'active'
  | 'failed'
  | 'revoked'
  | 'expired';

export type PreviewValidationStage = 'report' | 'create' | 'connect' | 'revoke';

export type PreviewErrorCode =
  | 'host_not_loopback'
  // `host_not_private` and `target_resolution_failed` are no longer produced: a
  // managed preview is loopback-only, so there is no private-LAN branch left to
  // fail. They stay in the vocabulary so a response from an older CLI decodes.
  | 'host_not_private'
  | 'host_prohibited'
  | 'target_resolution_failed'
  | 'target_changed'
  | 'user_confirmation_required'
  | 'invalid_port'
  | 'invalid_protocol'
  | 'session_mismatch'
  | 'session_not_found'
  | 'session_archived'
  | 'port_not_listening'
  | 'local_server_unreachable'
  | 'process_not_owned_by_session'
  | 'preview_already_active'
  | 'resource_limit_exceeded'
  | 'preview_expired'
  | 'preview_idle_timeout'
  | 'grant_denied'
  | 'tunnel_not_configured'
  | 'tunnel_creation_failed'
  | 'cloud_authorization_failed'
  | 'internal_error';

export type PreviewValidationResult = {
  lastCheckedAt: number;
  stage: PreviewValidationStage;
  ok: boolean;
  errorCode?: PreviewErrorCode;
  message?: string;
};

export type PreviewCandidateSource = {
  toolName?: string;
  devServerType?: string;
  command?: string;
  cwd?: string;
  pid?: number;
};

export type PreviewCandidate = {
  status: PreviewCandidateStatus;
  candidateId?: string;
  target?: PreviewTarget;
  source?: PreviewCandidateSource;
  reportedAt?: number;
  updatedAt?: number;
  validation?: PreviewValidationResult;
};

export type PreviewConnectionError = {
  stage: PreviewValidationStage;
  errorCode: PreviewErrorCode;
  message: string;
  retryable: boolean;
};

export type PreviewResourceLimits = {
  maxRequestBodyBytes: number;
  maxResponseBodyBytes: number;
  maxRequestDurationMs: number;
};

export type PreviewResourceUsage = {
  httpRequestCount?: number;
  webSocketOpenCount?: number;
  requestBytesIn?: number;
  responseBytesOut?: number;
  limitExceededCount?: number;
  lastLimitExceededAt?: number;
  lastCloseReason?: string;
};

export type PreviewConnection = {
  status: PreviewConnectionStatus;
  grantId?: string;
  publicUrl?: string;
  tunnelId?: string;
  target?: PreviewTarget;
  viewerScope?: PreviewViewerScope;
  approvedByUserId?: string;
  createdAt?: number;
  updatedAt?: number;
  leaseExpiresAt?: number;
  idleTimeoutMs?: number;
  lastActiveAt?: number;
  revokedAt?: number;
  revokeReason?: string;
  resourceLimits?: PreviewResourceLimits;
  resourceUsage?: PreviewResourceUsage;
  error?: PreviewConnectionError;
};

/**
 * Whether a session has a preview target worth offering a one-click Browser
 * entry point for. A session only gets one after the agent reported a url+port
 * through `lody_report_preview_candidate`, so `none`/`invalid` candidates (the
 * agent never reported, or the CLI rejected the target) must not surface it —
 * the click would land on an empty Browser panel. A live connection keeps the
 * entry point alive even if the candidate is later cleared.
 *
 * Both statuses come from the cheap `SessionMeta` preview summary; the candidate
 * target itself lives in the session doc `preview` state.
 */
export const hasReportedPreviewTarget = (preview: {
  candidateStatus?: PreviewCandidateStatus;
  connectionStatus?: PreviewConnectionStatus;
}): boolean =>
  preview.candidateStatus === 'reported' ||
  preview.candidateStatus === 'validating' ||
  preview.candidateStatus === 'available' ||
  preview.connectionStatus === 'creating' ||
  preview.connectionStatus === 'active';

export type PreviewEndpointKind = 'local-proxy' | 'cloud-gateway';

export type PreviewEndpointCapabilities = {
  visualAnnotation: boolean;
  shareable: boolean;
};

/**
 * Ephemeral viewer URL for the current renderer. Local proxy endpoints are
 * private to the machine that acquired them and must not be stored in durable
 * session metadata. Cloud gateway endpoints are derived from durable
 * PreviewConnection state.
 */
export type SessionPreviewEndpoint = {
  endpointId: string;
  kind: PreviewEndpointKind;
  viewerUrl: string;
  shareUrl?: string;
  target: PreviewTarget;
  capabilities: PreviewEndpointCapabilities;
  createdAt: number;
  expiresAt?: number;
};

export type SessionPreviewEndpointAcquireResponse = {
  type: 'session/preview-endpoint-acquire_response';
  sessionId: SessionId;
  success: boolean;
  endpoint?: SessionPreviewEndpoint;
  error?: PreviewErrorCode;
  message?: string;
};

export type SessionPreviewEndpointReleaseResponse = {
  type: 'session/preview-endpoint-release_response';
  sessionId: SessionId;
  endpointId?: string;
  success: boolean;
  error?: PreviewErrorCode;
  message?: string;
};

export type PreviewCandidateReportRequest = {
  type: 'session/preview-candidate-report';
  machineId: MachineId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  target: PreviewTarget;
  source?: PreviewCandidateSource;
};

export type PreviewCandidateReportResponse = {
  type: 'session/preview-candidate-report_response';
  sessionId: SessionId;
  success: boolean;
  candidate?: PreviewCandidate;
  error?: PreviewErrorCode;
  message?: string;
};

export type SessionPreviewCreateRequest = {
  type: 'session/preview-create';
  machineId: MachineId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  requestedByUserId: string;
  target: PreviewTarget;
  approval: PreviewTargetApproval;
  replaceExisting?: boolean;
};

export type PreviewTargetApproval = {
  source: 'browser_address' | 'share_action';
  /**
   * Always loopback. A managed preview opens one approved port on the agent
   * machine itself and never reaches past it — a LAN target would make that
   * machine a pivot into its own network for whoever holds the tunnel. The type
   * is narrowed so a client cannot even express the request; the CLI's
   * `normalizeTarget` is the authoritative rejection for any client that does.
   */
  targetClass: 'loopback';
  target: PreviewTarget;
  confirmedByUserId: string;
  confirmedAt: number;
};

export type SessionPreviewCreateResponse = {
  type: 'session/preview-create_response';
  sessionId: SessionId;
  success: boolean;
  connection?: PreviewConnection;
  error?: PreviewErrorCode;
  message?: string;
};

export type SessionPreviewRevokeRequest = {
  type: 'session/preview-revoke';
  machineId: MachineId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  requestedByUserId: string;
  reason?: string;
};

export type SessionPreviewRevokeResponse = {
  type: 'session/preview-revoke_response';
  sessionId: SessionId;
  success: boolean;
  connection?: PreviewConnection;
  error?: PreviewErrorCode;
  message?: string;
};

export const DEFAULT_PREVIEW_IDLE_TIMEOUT_MS = 45 * 60 * 1000;
export const DEFAULT_PREVIEW_LEASE_MS = 8 * 60 * 60 * 1000;
export const PREVIEW_PUBLIC_BASE_DOMAIN = 'mylody.app';
export const DEFAULT_PREVIEW_MAX_ACTIVE_TUNNELS_PER_MACHINE = 3;
export const PREVIEW_CREATE_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const PREVIEW_CREATE_RATE_LIMIT_MAX = 5;
export const DEFAULT_PREVIEW_RESOURCE_LIMITS: PreviewResourceLimits = {
  maxRequestBodyBytes: 10 * 1024 * 1024,
  maxResponseBodyBytes: 100 * 1024 * 1024,
  maxRequestDurationMs: 5 * 60 * 1000,
};
export const PREVIEW_TUNNEL_HTTP_BODY_BATCH_BYTES = 256 * 1024;
export const PREVIEW_TUNNEL_RESPONSE_BODY_CREDIT_WINDOW_BYTES = 512 * 1024;
export const PREVIEW_TUNNEL_SOCKET_BACKPRESSURE_HIGH_WATERMARK_BYTES = 2 * 1024 * 1024;
export const PREVIEW_TUNNEL_SOCKET_BACKPRESSURE_LOW_WATERMARK_BYTES = 512 * 1024;

const SHORT_ID_SAFE_CHARS = /[^a-z0-9]/gi;
const PREVIEW_TUNNEL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PREVIEW_PUBLIC_DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const normalizePreviewPublicBaseDomain = (value: string): string => {
  const domain = value.trim().toLowerCase();
  const labels = domain.split('.');
  const hasValidLabels =
    domain.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => PREVIEW_PUBLIC_DOMAIN_LABEL_PATTERN.test(label)) &&
    !/^\d+$/.test(labels[labels.length - 1] ?? '');

  if (!hasValidLabels) {
    throw new Error(
      'Preview public base domain must be an ASCII public base domain without a scheme, wildcard, port, path, query, or trailing dot'
    );
  }

  return domain;
};

export const toPreviewShortId = (value: string, fallback: string): string => {
  const normalized = value.replace(SHORT_ID_SAFE_CHARS, '').toLowerCase();
  return (normalized || fallback).slice(0, 7);
};

export const buildPreviewPublicUrl = (args: {
  sessionId: SessionId;
  grantId: string;
  baseDomain?: string;
}): string => {
  const sessionShortId = toPreviewShortId(args.sessionId, 'session');
  const grantShortId = toPreviewShortId(args.grantId, 'grant');
  const baseDomain = normalizePreviewPublicBaseDomain(
    args.baseDomain ?? PREVIEW_PUBLIC_BASE_DOMAIN
  );
  return `https://${sessionShortId}-${grantShortId}.${baseDomain}`;
};

export const isAllowedPreviewPublicUrl = (
  value: string | undefined,
  baseDomain: string = PREVIEW_PUBLIC_BASE_DOMAIN
): value is string => {
  if (!value) {
    return false;
  }
  try {
    const url = new URL(value);
    const normalizedBaseDomain = normalizePreviewPublicBaseDomain(baseDomain);
    const hostname = url.hostname.toLowerCase();
    const suffix = `.${normalizedBaseDomain}`;
    const subdomain = hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : '';
    return (
      url.protocol === 'https:' &&
      !!subdomain &&
      !subdomain.includes('.') &&
      PREVIEW_TUNNEL_ID_PATTERN.test(subdomain) &&
      !url.username &&
      !url.password &&
      (url.port === '' || url.port === '443')
    );
  } catch {
    return false;
  }
};

export const PREVIEW_TUNNELS_API_PATH = '/api/preview/tunnels';
export const PREVIEW_ACCESS_TOKEN_QUERY_PARAM = '__lody_preview_token';
export const PREVIEW_ACCESS_TOKEN_COOKIE = 'lody_preview';
export const DEFAULT_PREVIEW_VIEWER_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;
export const MIN_PREVIEW_VIEWER_COOKIE_MAX_AGE_SECONDS = 60;

const getRawQueryParamName = (part: string): string => {
  const equalsIndex = part.indexOf('=');
  const rawName = equalsIndex === -1 ? part : part.slice(0, equalsIndex);
  try {
    return decodeURIComponent(rawName.replace(/\+/g, ' '));
  } catch {
    return rawName;
  }
};

export const removePreviewQueryParamFromSearch = (
  search: string,
  parameterName: string
): string => {
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (query === '') {
    return '';
  }
  const keptParts = query.split('&').filter((part) => getRawQueryParamName(part) !== parameterName);
  return keptParts.length > 0 ? `?${keptParts.join('&')}` : '';
};

export const setPreviewQueryParamInUrl = (
  source: URL,
  parameterName: string,
  value: string
): URL => {
  const url = new URL(source.href);
  const encodedPair = `${encodeURIComponent(parameterName)}=${encodeURIComponent(value)}`;
  const sanitizedSearch = removePreviewQueryParamFromSearch(url.search, parameterName);
  url.search = sanitizedSearch === '' ? `?${encodedPair}` : `${sanitizedSearch}&${encodedPair}`;
  return url;
};

/**
 * Resolves the viewer URL a managed preview actually loads: the gateway origin,
 * the target's path, and every authorization param the gateway handed out. The
 * renderer and the CLI's post-create round-trip check must agree on this exact
 * URL, so both build it here.
 */
export const buildManagedPreviewViewerUrl = (
  publicUrl: string | URL,
  target: PreviewTarget
): URL => {
  const gateway = typeof publicUrl === 'string' ? new URL(publicUrl) : publicUrl;
  let viewer = new URL(target.path ?? '/', gateway.origin);
  gateway.searchParams.forEach((value, name) => {
    viewer = setPreviewQueryParamInUrl(viewer, name, value);
  });
  return viewer;
};

export const removePreviewAccessTokenFromSearch = (search: string): string =>
  removePreviewQueryParamFromSearch(search, PREVIEW_ACCESS_TOKEN_QUERY_PARAM);

export const buildPreviewAccessTokenCookie = (args: {
  token: string;
  expiresAt: number;
  now?: number;
  maxAgeSeconds?: number;
}): string => {
  const maxAge = Math.max(
    MIN_PREVIEW_VIEWER_COOKIE_MAX_AGE_SECONDS,
    Math.min(
      args.maxAgeSeconds ?? DEFAULT_PREVIEW_VIEWER_COOKIE_MAX_AGE_SECONDS,
      Math.floor((args.expiresAt - (args.now ?? Date.now())) / 1000)
    )
  );
  return `${PREVIEW_ACCESS_TOKEN_COOKIE}=${encodeURIComponent(
    args.token
  )}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`;
};

export type HeaderEntry = [name: string, value: string];

const CONTENT_SECURITY_POLICY_HEADER = 'content-security-policy';
const FRAME_ANCESTORS_DIRECTIVE = 'frame-ancestors';
const X_FRAME_OPTIONS_HEADER = 'x-frame-options';

const getContentSecurityPolicyDirectiveName = (directive: string): string => {
  const whitespaceIndex = directive.search(/\s/);
  return (whitespaceIndex === -1 ? directive : directive.slice(0, whitespaceIndex)).toLowerCase();
};

export const stripPreviewFrameAncestorsDirective = (value: string): string | null => {
  const directives = value
    .split(';')
    .map((directive) => directive.trim())
    .filter(
      (directive) =>
        directive.length > 0 &&
        getContentSecurityPolicyDirectiveName(directive) !== FRAME_ANCESTORS_DIRECTIVE
    );

  return directives.length > 0 ? directives.join('; ') : null;
};

export const sanitizePreviewProxyResponseHeaders = (headers: HeaderEntry[]): HeaderEntry[] => {
  const sanitizedHeaders: HeaderEntry[] = [];
  for (const [name, value] of headers) {
    const lowerName = name.toLowerCase();
    if (lowerName === X_FRAME_OPTIONS_HEADER) {
      continue;
    }
    if (lowerName === CONTENT_SECURITY_POLICY_HEADER) {
      const sanitizedValue = stripPreviewFrameAncestorsDirective(value);
      if (sanitizedValue !== null) {
        sanitizedHeaders.push([name, sanitizedValue]);
      }
      continue;
    }
    sanitizedHeaders.push([name, value]);
  }
  return sanitizedHeaders;
};

// The Lody web app embedder runs under `Cross-Origin-Embedder-Policy: credentialless`
// (see apps/web/vite.config.ts and functions/_middleware.ts). A nested cross-origin
// iframe document under that embedder must declare a compatible COEP on its own
// response, otherwise Chromium replaces the frame with `chrome-error://chromewebdata/`
// (NotSameOriginAfterDefaultedToSameOriginByCoep). CORP `cross-origin` lets the same
// response also be used as a subresource by other origins. We apply both to every
// preview-subdomain response — including 302 redirects and gateway-generated errors
// (401/403/503) — because the iframe loads the very first response of the chain.
export const PREVIEW_EMBEDDER_POLICY = 'credentialless';
export const PREVIEW_RESOURCE_POLICY = 'cross-origin';

export const applyPreviewEmbeddingHeaders = (headers: Headers): Headers => {
  headers.set('Cross-Origin-Embedder-Policy', PREVIEW_EMBEDDER_POLICY);
  headers.set('Cross-Origin-Resource-Policy', PREVIEW_RESOURCE_POLICY);
  return headers;
};

export type PreviewTunnelCreateRequest = {
  workspaceId: WorkspaceId;
  machineId: MachineId;
  sessionId: SessionId;
  grantId: string;
  approvedByUserId: string;
  leaseExpiresAt: number;
  idleTimeoutMs: number;
};

export type PreviewTunnelCreateResponse = {
  tunnelId: string;
  publicUrl: string;
  websocketUrl: string;
  sessionToken: string;
  expiresAt: number;
  resourceLimits?: PreviewResourceLimits;
};

export type PreviewTunnelRefreshResponse = {
  websocketUrl: string;
  sessionToken: string;
  expiresAt: number;
};

export type PreviewTunnelReadyMessage = {
  type: 'tunnel-ready';
  tunnelId: string;
  publicUrl: string;
  protocolVersion?: number;
  capabilities?: string[];
};

export type PreviewTunnelAcceptedMessage = {
  type: 'tunnel-accepted';
  tunnelId: string;
  publicUrl: string;
  protocolVersion: number;
  capabilities: string[];
};

export type PreviewTunnelErrorMessage = {
  type: 'error';
  message: string;
};

export type PreviewTunnelRequestStartMessage = {
  type: 'request-start';
  requestId: string;
  method: string;
  url: string;
  headers: HeaderEntry[];
  hasBody: boolean;
  binaryPayload?: boolean;
  responseBodyCredit?: boolean;
};

export type PreviewTunnelRequestCancelMessage = {
  type: 'request-cancel';
  requestId: string;
  reason: string;
};

export type PreviewTunnelRequestBodyMessage = {
  type: 'request-body';
  requestId: string;
  chunk: string;
};

export type PreviewTunnelRequestEndMessage = {
  type: 'request-end';
  requestId: string;
};

export type PreviewTunnelResponseBodyCreditMessage = {
  type: 'response-body-credit';
  requestId: string;
  credit: number;
};

export type PreviewTunnelBinaryPayloadStream = 'request-body' | 'response-body' | 'websocket-frame';

export type PreviewTunnelBinaryPayloadMessage = {
  type: 'binary-payload';
  requestId: string;
  stream: PreviewTunnelBinaryPayloadStream;
};

export type PreviewTunnelClientReadyMessage = {
  type: 'client-ready';
  protocolVersion: number;
  capabilities: string[];
};

export type PreviewTunnelClientCapabilitiesMessage = {
  type: 'client-capabilities';
  capabilities: string[];
};

export type PreviewTunnelWebSocketConnectMessage = {
  type: 'websocket-connect';
  requestId: string;
  url: string;
  headers: HeaderEntry[];
  protocols: string[];
  binaryPayload?: boolean;
};

export type PreviewTunnelWebSocketAcceptMessage = {
  type: 'websocket-accept';
  requestId: string;
  protocol?: string;
};

export type PreviewTunnelWebSocketRejectMessage = {
  type: 'websocket-reject';
  requestId: string;
  message: string;
};

export type PreviewTunnelWebSocketFrameMessage = {
  type: 'websocket-frame';
  requestId: string;
  chunk: string;
  isBinary: boolean;
};

export type PreviewTunnelWebSocketCloseMessage = {
  type: 'websocket-close';
  requestId: string;
  code?: number;
  reason: string;
};

export type PreviewTunnelResponseStartMessage = {
  type: 'response-start';
  requestId: string;
  status: number;
  statusText: string;
  headers: HeaderEntry[];
  hasBody: boolean;
};

export type PreviewTunnelResponseBodyMessage = {
  type: 'response-body';
  requestId: string;
  chunk: string;
};

export type PreviewTunnelResponseEndMessage = {
  type: 'response-end';
  requestId: string;
};

export type PreviewTunnelResponseErrorMessage = {
  type: 'response-error';
  requestId: string;
  message: string;
};

export type PreviewTunnelServerMessage =
  | PreviewTunnelReadyMessage
  | PreviewTunnelAcceptedMessage
  | PreviewTunnelErrorMessage
  | PreviewTunnelRequestStartMessage
  | PreviewTunnelRequestBodyMessage
  | PreviewTunnelBinaryPayloadMessage
  | PreviewTunnelRequestEndMessage
  | PreviewTunnelRequestCancelMessage
  | PreviewTunnelResponseBodyCreditMessage
  | PreviewTunnelWebSocketConnectMessage
  | PreviewTunnelWebSocketFrameMessage
  | PreviewTunnelWebSocketCloseMessage;

export type PreviewTunnelClientMessage =
  | PreviewTunnelErrorMessage
  | PreviewTunnelClientReadyMessage
  | PreviewTunnelClientCapabilitiesMessage
  | PreviewTunnelResponseStartMessage
  | PreviewTunnelResponseBodyMessage
  | PreviewTunnelBinaryPayloadMessage
  | PreviewTunnelResponseEndMessage
  | PreviewTunnelResponseErrorMessage
  | PreviewTunnelWebSocketAcceptMessage
  | PreviewTunnelWebSocketRejectMessage
  | PreviewTunnelWebSocketFrameMessage
  | PreviewTunnelWebSocketCloseMessage;

export const PREVIEW_TUNNEL_PROTOCOL_VERSION = 3;
export const PREVIEW_TUNNEL_BINARY_PAYLOAD_CAPABILITY = 'binary-payload';
export const PREVIEW_TUNNEL_RESPONSE_BODY_CREDIT_CAPABILITY = 'response-body-credit';
export const PREVIEW_TUNNEL_CAPABILITIES = [
  PREVIEW_TUNNEL_BINARY_PAYLOAD_CAPABILITY,
  PREVIEW_TUNNEL_RESPONSE_BODY_CREDIT_CAPABILITY,
] as const;

export const normalizePreviewTunnelId = (value: string): string | null => {
  const normalized = value.trim().toLowerCase();
  return PREVIEW_TUNNEL_ID_PATTERN.test(normalized) ? normalized : null;
};

export const buildPreviewTunnelId = (args: { sessionId: SessionId; grantId: string }): string =>
  `${toPreviewShortId(args.sessionId, 'session')}-${toPreviewShortId(args.grantId, 'grant')}`;

export const buildPreviewTunnelConnectPath = (tunnelId: string): string =>
  `${PREVIEW_TUNNELS_API_PATH}/${encodeURIComponent(tunnelId)}/connect`;

export const buildPreviewTunnelRefreshPath = (tunnelId: string): string =>
  `${PREVIEW_TUNNELS_API_PATH}/${encodeURIComponent(tunnelId)}/refresh`;

export const buildPreviewTunnelRevokePath = (tunnelId: string): string =>
  `${PREVIEW_TUNNELS_API_PATH}/${encodeURIComponent(tunnelId)}/revoke`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isString = (value: unknown): value is string => typeof value === 'string';

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

const isOptionalNumber = (value: unknown): value is number | undefined =>
  value === undefined || typeof value === 'number';

const isOptionalBoolean = (value: unknown): value is boolean | undefined =>
  value === undefined || typeof value === 'boolean';

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isHeaderEntries = (value: unknown): value is HeaderEntry[] =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === 'string' &&
      typeof entry[1] === 'string'
  );

const isPreviewTunnelBinaryPayloadStream = (
  value: unknown
): value is PreviewTunnelBinaryPayloadStream =>
  value === 'request-body' || value === 'response-body' || value === 'websocket-frame';

export const isPreviewResourceLimits = (value: unknown): value is PreviewResourceLimits =>
  isRecord(value) &&
  isPositiveInteger(value.maxRequestBodyBytes) &&
  isPositiveInteger(value.maxResponseBodyBytes) &&
  isPositiveInteger(value.maxRequestDurationMs);

const parseJsonRecord = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const isPreviewTunnelServerMessage = (
  value: Record<string, unknown>
): value is PreviewTunnelServerMessage => {
  switch (value.type) {
    case 'tunnel-ready':
      return (
        isString(value.tunnelId) &&
        isString(value.publicUrl) &&
        isOptionalNumber(value.protocolVersion) &&
        (value.protocolVersion === undefined || Number.isInteger(value.protocolVersion)) &&
        (value.capabilities === undefined || isStringArray(value.capabilities))
      );
    case 'tunnel-accepted':
      return (
        isString(value.tunnelId) &&
        isString(value.publicUrl) &&
        typeof value.protocolVersion === 'number' &&
        Number.isInteger(value.protocolVersion) &&
        isStringArray(value.capabilities)
      );
    case 'error':
      return isString(value.message);
    case 'request-start':
      return (
        isString(value.requestId) &&
        isString(value.method) &&
        isString(value.url) &&
        isHeaderEntries(value.headers) &&
        typeof value.hasBody === 'boolean' &&
        isOptionalBoolean(value.binaryPayload) &&
        isOptionalBoolean(value.responseBodyCredit)
      );
    case 'request-body':
      return isString(value.requestId) && isString(value.chunk);
    case 'binary-payload':
      return isString(value.requestId) && isPreviewTunnelBinaryPayloadStream(value.stream);
    case 'request-end':
      return isString(value.requestId);
    case 'request-cancel':
      return isString(value.requestId) && isString(value.reason);
    case 'response-body-credit':
      return (
        isString(value.requestId) &&
        typeof value.credit === 'number' &&
        Number.isInteger(value.credit) &&
        value.credit > 0
      );
    case 'websocket-connect':
      return (
        isString(value.requestId) &&
        isString(value.url) &&
        isHeaderEntries(value.headers) &&
        isStringArray(value.protocols) &&
        isOptionalBoolean(value.binaryPayload)
      );
    case 'websocket-frame':
      return (
        isString(value.requestId) && isString(value.chunk) && typeof value.isBinary === 'boolean'
      );
    case 'websocket-close':
      return isString(value.requestId) && isOptionalNumber(value.code) && isString(value.reason);
    default:
      return false;
  }
};

const isPreviewTunnelClientMessage = (
  value: Record<string, unknown>
): value is PreviewTunnelClientMessage => {
  switch (value.type) {
    case 'error':
      return isString(value.message);
    case 'client-ready':
      return (
        typeof value.protocolVersion === 'number' &&
        Number.isInteger(value.protocolVersion) &&
        isStringArray(value.capabilities)
      );
    case 'client-capabilities':
      return isStringArray(value.capabilities);
    case 'response-start':
      return (
        isString(value.requestId) &&
        typeof value.status === 'number' &&
        isString(value.statusText) &&
        isHeaderEntries(value.headers) &&
        typeof value.hasBody === 'boolean'
      );
    case 'response-body':
      return isString(value.requestId) && isString(value.chunk);
    case 'binary-payload':
      return isString(value.requestId) && isPreviewTunnelBinaryPayloadStream(value.stream);
    case 'response-end':
      return isString(value.requestId);
    case 'response-error':
      return isString(value.requestId) && isString(value.message);
    case 'websocket-accept':
      return isString(value.requestId) && isOptionalString(value.protocol);
    case 'websocket-reject':
      return isString(value.requestId) && isString(value.message);
    case 'websocket-frame':
      return (
        isString(value.requestId) && isString(value.chunk) && typeof value.isBinary === 'boolean'
      );
    case 'websocket-close':
      return isString(value.requestId) && isOptionalNumber(value.code) && isString(value.reason);
    default:
      return false;
  }
};

export const parsePreviewTunnelServerMessage = (raw: string): PreviewTunnelServerMessage | null => {
  const parsed = parseJsonRecord(raw);
  return parsed && isPreviewTunnelServerMessage(parsed) ? parsed : null;
};

export const parsePreviewTunnelClientMessage = (raw: string): PreviewTunnelClientMessage | null => {
  const parsed = parseJsonRecord(raw);
  return parsed && isPreviewTunnelClientMessage(parsed) ? parsed : null;
};

export const isPreviewTunnelCreateResponse = (
  value: unknown
): value is PreviewTunnelCreateResponse =>
  isRecord(value) &&
  isString(value.tunnelId) &&
  isString(value.publicUrl) &&
  isString(value.websocketUrl) &&
  isString(value.sessionToken) &&
  typeof value.expiresAt === 'number' &&
  (value.resourceLimits === undefined || isPreviewResourceLimits(value.resourceLimits));

export const isPreviewTunnelRefreshResponse = (
  value: unknown
): value is PreviewTunnelRefreshResponse =>
  isRecord(value) &&
  isString(value.websocketUrl) &&
  isString(value.sessionToken) &&
  typeof value.expiresAt === 'number';

import type { MachineId, SessionId, WorkspaceId } from './index';

export type PreviewProtocol = 'http' | 'https';

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

export type PreviewConnectionStatus = 'creating' | 'active' | 'closed' | 'failed';
export type PreviewCloseReason =
  | 'idle_timeout'
  | 'revoked'
  | 'session_ended'
  | 'replaced'
  | 'runtime_lost';

export type PreviewValidationStage = 'report' | 'create' | 'connect' | 'revoke';

export type PreviewErrorCode =
  | 'host_not_loopback'
  | 'host_prohibited'
  | 'target_changed'
  | 'user_confirmation_required'
  | 'invalid_port'
  | 'invalid_protocol'
  | 'session_mismatch'
  | 'session_not_found'
  | 'session_archived'
  | 'port_not_listening'
  | 'local_server_unreachable'
  | 'preview_already_active'
  | 'resource_limit_exceeded'
  | 'grant_denied'
  | 'tunnel_not_configured'
  | 'tunnel_creation_failed'
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

export type PreviewConnection = {
  status: PreviewConnectionStatus;
  endpointId?: string;
  publicUrl?: string;
  target?: PreviewTarget;
  approvedByUserId?: string;
  createdAt?: number;
  updatedAt?: number;
  idleTimeoutMs?: number;
  closedReason?: PreviewCloseReason;
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

export type PreviewEndpointKind = 'local-proxy' | 'quick-tunnel';

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
  restart?: boolean;
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

export type SessionPreviewStatusRequest = {
  type: 'session/preview-status';
  machineId: MachineId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  requestedByUserId: string;
  /** A heartbeat must name the exact live endpoint; a stale page cannot renew its replacement. */
  renewEndpointId?: string;
};

export type SessionPreviewStatusResponse = {
  type: 'session/preview-status_response';
  sessionId: SessionId;
  success: boolean;
  connection?: PreviewConnection;
  /** Observation only; never persisted on each request. */
  expiresAt?: number;
  error?: PreviewErrorCode;
  message?: string;
};

export const DEFAULT_PREVIEW_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_PREVIEW_MAX_ACTIVE_TUNNELS_PER_MACHINE = 3;
export const PREVIEW_CREATE_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const PREVIEW_CREATE_RATE_LIMIT_MAX = 5;
export const DEFAULT_PREVIEW_RESOURCE_LIMITS: PreviewResourceLimits = {
  maxRequestBodyBytes: 10 * 1024 * 1024,
  maxResponseBodyBytes: 100 * 1024 * 1024,
  maxRequestDurationMs: 5 * 60 * 1000,
};
export const PREVIEW_ACCESS_TOKEN_QUERY_PARAM = '__lody_preview_token';
export const PREVIEW_ACCESS_TOKEN_COOKIE = 'lody_preview';
/** Validate an endpoint returned by the CLI, not an arbitrary URL to auto-trust. */
export const isQuickTunnelViewerUrl = (value: string | undefined): value is string => {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(url.hostname) &&
      Boolean(url.searchParams.get(PREVIEW_ACCESS_TOKEN_QUERY_PARAM))
    );
  } catch {
    return false;
  }
};
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

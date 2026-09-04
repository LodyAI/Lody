import fs from 'fs/promises';
import net from 'net';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  DEFAULT_PREVIEW_IDLE_TIMEOUT_MS,
  DEFAULT_PREVIEW_LEASE_MS,
  DEFAULT_PREVIEW_MAX_ACTIVE_TUNNELS_PER_MACHINE,
  PREVIEW_CREATE_RATE_LIMIT_MAX,
  PREVIEW_CREATE_RATE_LIMIT_WINDOW_MS,
  classifyBrowserHostname,
  getServerNow,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  type MachineId,
  type PreviewCandidate,
  type PreviewCandidateReportRequest,
  type PreviewCandidateReportResponse,
  type PreviewConnection,
  type PreviewErrorCode,
  type PreviewTarget,
  type SessionId,
  type SessionMeta,
  type SessionPreviewCandidateMeta,
  type SessionPreviewConnectionMeta,
  type SessionPreviewEndpointAcquireResponse,
  type SessionPreviewEndpointReleaseResponse,
  type SessionPreviewDocState,
  type SessionPreviewCreateRequest,
  type SessionPreviewCreateResponse,
  type SessionPreviewRevokeRequest,
  type SessionPreviewRevokeResponse,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { withFileLock } from '@/utils/file-lock';
import { LocalPreviewProxyManager } from './local-preview-proxy';
import { startPreviewTunnel, type PreviewTunnelHandle } from './preview-tunnel-client';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

type PreviewSessionMeta = Omit<SessionMeta, 'previewCandidate' | 'previewConnection'> & {
  previewCandidate?: PreviewCandidate;
  previewConnection?: PreviewConnection;
};

type SessionPreviewStatePatch = {
  previewCandidate?: PreviewCandidate;
  previewConnection?: PreviewConnection;
};

type PreviewServiceDeps = {
  logger: Logger;
  workspaceDocument: LoroDocumentManager;
  machineId: MachineId;
  workspaceId: WorkspaceId;
  userId: string;
  authToken: () => string;
  remoteGatewayUrl: string | null;
  now?: () => number;
};

type ValidationFailure = {
  code: PreviewErrorCode;
  message: string;
  retryable: boolean;
};

type ValidationSuccess = {
  normalizedTarget: PreviewTarget;
};

type PreviewRegistryEntry = {
  key: string;
  pid: number;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  sessionId: SessionId;
  grantId: string;
  updatedAt: number;
};

const PREVIEW_TCP_TIMEOUT_MS = 2_000;
const PREVIEW_HTTP_TIMEOUT_MS = 3_000;
const PREVIEW_REGISTRY_LOCK_NAME = 'preview-tunnels';
const PREVIEW_REGISTRY_FILE = path.join(getLodyDataDir(), 'preview-tunnels.json');
// Reject registry entries whose `updatedAt` lies more than this far in the future:
// such timestamps indicate a clock-skewed or corrupt writer, not a live tunnel.
const PREVIEW_REGISTRY_FUTURE_SKEW_MS = 60_000;
const PREVIEW_APPROVAL_MAX_AGE_MS = 5 * 60 * 1000;
const PREVIEW_APPROVAL_FUTURE_SKEW_MS = 60 * 1000;

const normalizeHost = (host: string): string => {
  const trimmed = host.trim().toLowerCase();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
};

const normalizePath = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!trimmed.startsWith('/') || /^https?:\/\//i.test(trimmed) || trimmed.startsWith('//')) {
    return undefined;
  }
  return trimmed;
};

const normalizeTarget = (target: PreviewTarget): PreviewTarget | ValidationFailure => {
  if (target.protocol !== 'http' && target.protocol !== 'https') {
    return {
      code: 'invalid_protocol',
      message: 'Preview only supports HTTP(S) targets.',
      retryable: false,
    };
  }

  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    return {
      code: 'invalid_port',
      message: `Invalid preview port: ${target.port}`,
      retryable: false,
    };
  }

  const host = normalizeHost(target.host);
  const targetClass = classifyBrowserHostname(host);
  if (targetClass === 'prohibited') {
    return {
      code: 'host_prohibited',
      message: `Preview target host is reserved or unsafe: ${target.host}.`,
      retryable: false,
    };
  }
  // INVARIANT: a managed preview reaches this machine's own loopback and nothing
  // else, whether the target came from an agent report or a user's address bar.
  // There is deliberately no policy parameter that could relax this. The tunnel makes this machine the origin of whatever
  // it connects to, so accepting a LAN address would turn it into a pivot that
  // lets a remote workspace member — or an agent that talked them into a click —
  // reach hosts behind this machine that they could never reach themselves.
  // User approval does not change that: the approver is on the OTHER side of the
  // tunnel and cannot see what a LAN address here actually is. The client never
  // routes LAN addresses here (`parseBrowserAddress` sends them to the user's own
  // local browser), but this check is the authoritative one — it must hold for
  // any client, including an older or hostile one.
  if (targetClass !== 'loopback') {
    return {
      code: 'host_not_loopback',
      message: `Preview target host must be loopback, got ${target.host}.`,
      retryable: false,
    };
  }
  // `classifyBrowserHostname` reads the hostname TEXT, so it calls any `*.localhost`
  // name loopback. RFC 6761 says a resolver should answer those from 127.0.0.0/8, but
  // nothing makes it — a search domain or a rebinding record can point `foo.localhost`
  // at a LAN host, and `probeHosts` only substitutes literals for the exact string
  // `localhost`, so the probe and the forwarded request resolve separately. Requiring a
  // literal or that exact name is what makes the invariant above true of the ADDRESS
  // rather than of the spelling. Agents report `127.0.0.1` or `localhost`
  // (`lody_report_preview_candidate`), so nothing legitimate is turned away.
  if (host !== 'localhost' && net.isIP(host) === 0) {
    return {
      code: 'host_not_loopback',
      message: `Preview target host must be a loopback address or "localhost", got ${target.host}.`,
      retryable: false,
    };
  }

  const normalizedPath = normalizePath(target.path);
  if (target.path !== undefined && !normalizedPath) {
    return {
      code: 'local_server_unreachable',
      message: 'Preview path must be a path-relative URL starting with "/".',
      retryable: false,
    };
  }

  return {
    protocol: target.protocol,
    host,
    port: target.port,
    ...(normalizedPath ? { path: normalizedPath } : {}),
  };
};

const sameTargetOrigin = (left: PreviewTarget | undefined, right: PreviewTarget): boolean =>
  !!left &&
  left.protocol === right.protocol &&
  normalizeHost(left.host) === normalizeHost(right.host) &&
  left.port === right.port;

const isValidationFailure = (
  value: PreviewTarget | ValidationFailure
): value is ValidationFailure => 'code' in value;

const toUrlHost = (host: string): string => (host.includes(':') ? `[${host}]` : host);

const buildLocalPreviewUrl = (target: PreviewTarget, host: string = target.host): string =>
  `${target.protocol}://${toUrlHost(host)}:${target.port}${target.path ?? '/'}`;

// `localhost` resolves to a single family, and which one depends on the host's
// resolver: macOS answers `::1` first, while a Linux box without a routable IPv6
// address answers `127.0.0.1` only. Probe both loopback literals so a dev server
// bound to just one stack is still detected.
const probeHosts = (host: string): string[] =>
  host === 'localhost' ? ['::1', '127.0.0.1'] : [host];

const probeTcpHost = async (host: string, port: number): Promise<boolean> =>
  await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, PREVIEW_TCP_TIMEOUT_MS);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

const probeTcp = async (target: PreviewTarget): Promise<ValidationFailure | null> => {
  const hosts = probeHosts(target.host);
  const reachable = (await Promise.all(hosts.map((host) => probeTcpHost(host, target.port)))).some(
    Boolean
  );
  return reachable
    ? null
    : {
        code: 'port_not_listening',
        message: `No local server is listening on ${target.host}:${target.port}.`,
        retryable: true,
      };
};

const probeHttpHost = async (
  target: PreviewTarget,
  host: string
): Promise<{ ok: true } | { ok: false; error: unknown }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREVIEW_HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(buildLocalPreviewUrl(target, host), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => {});
    return { ok: true };
  } catch (error) {
    // TCP probing already proved something is listening; a response slower than
    // the probe timeout is a cold dev server compiling its first request, not an
    // unreachable one. Only connection-level failures should fail the probe.
    if (controller.signal.aborted) {
      return { ok: true };
    }
    return { ok: false, error };
  } finally {
    clearTimeout(timeout);
  }
};

const probeHttp = async (target: PreviewTarget): Promise<ValidationFailure | null> => {
  let lastError: unknown;
  for (const host of probeHosts(target.host)) {
    const result = await probeHttpHost(target, host);
    if (result.ok) {
      return null;
    }
    lastError = result.error;
  }
  return {
    code: 'local_server_unreachable',
    message: `Local preview server did not respond over HTTP: ${formatErrorMessage(lastError)}`,
    retryable: true,
  };
};

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const isPreviewRegistryEntry = (value: unknown): value is PreviewRegistryEntry =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as PreviewRegistryEntry).key === 'string' &&
  Number.isInteger((value as PreviewRegistryEntry).pid) &&
  typeof (value as PreviewRegistryEntry).workspaceId === 'string' &&
  typeof (value as PreviewRegistryEntry).machineId === 'string' &&
  typeof (value as PreviewRegistryEntry).sessionId === 'string' &&
  typeof (value as PreviewRegistryEntry).grantId === 'string' &&
  Number.isInteger((value as PreviewRegistryEntry).updatedAt);

const readPreviewRegistryEntries = async (): Promise<PreviewRegistryEntry[]> => {
  try {
    const raw = await fs.readFile(PREVIEW_REGISTRY_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isPreviewRegistryEntry);
  } catch {
    return [];
  }
};

const writePreviewRegistryEntries = async (entries: PreviewRegistryEntry[]): Promise<void> => {
  await fs.mkdir(path.dirname(PREVIEW_REGISTRY_FILE), { recursive: true });
  const tmpPath = `${PREVIEW_REGISTRY_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(entries)}\n`, 'utf8');
  await fs.rename(tmpPath, PREVIEW_REGISTRY_FILE);
};

const filterLivePreviewRegistryEntries = (
  entries: PreviewRegistryEntry[],
  now: number
): PreviewRegistryEntry[] =>
  entries.filter(
    (entry) => isProcessAlive(entry.pid) && entry.updatedAt <= now + PREVIEW_REGISTRY_FUTURE_SKEW_MS
  );

const classifyPreviewTunnelCloseError = (error: Error): PreviewErrorCode => {
  const message = error.message.toLowerCase();
  if (message.includes('idle timeout')) {
    return 'preview_idle_timeout';
  }
  if (message.includes('lease expired') || message.includes('tunnel has expired')) {
    return 'preview_expired';
  }
  if (
    message.includes('resource limit') ||
    message.includes('too many') ||
    message.includes('exceeds') ||
    message.includes('byte limit')
  ) {
    return 'resource_limit_exceeded';
  }
  return 'tunnel_creation_failed';
};

const shouldMarkPreviewClosedForCleanup = (connection: PreviewConnection | undefined): boolean =>
  !!connection &&
  connection.status !== 'idle' &&
  connection.status !== 'revoked' &&
  connection.status !== 'expired';

const hasPreviewPatchKey = <Key extends keyof SessionPreviewStatePatch>(
  patch: SessionPreviewStatePatch,
  key: Key
): boolean => Object.prototype.hasOwnProperty.call(patch, key);

const summarizePreviewCandidateForMeta = (
  candidate: PreviewCandidate | undefined
): SessionPreviewCandidateMeta | undefined =>
  candidate
    ? {
        status: candidate.status,
        updatedAt: candidate.updatedAt,
      }
    : undefined;

const summarizePreviewConnectionForMeta = (
  connection: PreviewConnection | undefined
): SessionPreviewConnectionMeta | undefined =>
  connection
    ? {
        status: connection.status,
        updatedAt: connection.updatedAt,
      }
    : undefined;

export class PreviewService {
  private readonly activeTunnels = new Map<SessionId, PreviewTunnelHandle>();
  private readonly activeRegistryKeys = new Map<SessionId, string>();
  private readonly previewCreateAttempts: number[] = [];
  private readonly localProxyManager: LocalPreviewProxyManager;

  constructor(private readonly deps: PreviewServiceDeps) {
    this.localProxyManager = new LocalPreviewProxyManager({
      logger: deps.logger,
      now: deps.now,
    });
  }

  async reportCandidate(
    request: PreviewCandidateReportRequest
  ): Promise<PreviewCandidateReportResponse> {
    const scopeFailure = this.validateRequestScope(request.machineId, request.workspaceId);
    if (scopeFailure) {
      return {
        type: 'session/preview-candidate-report_response',
        sessionId: request.sessionId,
        success: false,
        error: scopeFailure.code,
        message: scopeFailure.message,
      };
    }

    const session = await this.getSessionMeta(request.sessionId);
    const normalized = normalizeTarget(request.target);
    const now = this.now();
    const baseCandidate: PreviewCandidate = {
      status: 'invalid',
      candidateId: randomUUID(),
      target: isValidationFailure(normalized) ? request.target : normalized,
      source: request.source,
      reportedAt: now,
      updatedAt: now,
    };

    if (!session.ok) {
      const candidate = this.withCandidateFailure(baseCandidate, 'report', session.failure);
      await this.patchSessionPreview(request.sessionId, { previewCandidate: candidate });
      return this.candidateResponse(request.sessionId, false, candidate, session.failure);
    }

    if (isValidationFailure(normalized)) {
      const candidate = this.withCandidateFailure(baseCandidate, 'report', normalized);
      await this.patchSessionPreview(request.sessionId, { previewCandidate: candidate });
      return this.candidateResponse(request.sessionId, false, candidate, normalized);
    }

    const tcpFailure = await probeTcp(normalized);
    if (tcpFailure) {
      const candidate = this.withCandidateFailure(baseCandidate, 'report', tcpFailure);
      await this.patchSessionPreview(request.sessionId, { previewCandidate: candidate });
      return this.candidateResponse(request.sessionId, false, candidate, tcpFailure);
    }

    const candidate: PreviewCandidate = {
      ...baseCandidate,
      status: 'available',
      target: normalized,
      validation: {
        lastCheckedAt: now,
        stage: 'report',
        ok: true,
      },
    };
    await this.patchSessionPreview(request.sessionId, {
      previewCandidate: candidate,
      previewConnection:
        session.meta.previewConnection?.status === 'active'
          ? session.meta.previewConnection
          : { status: 'idle', updatedAt: now },
    });
    return {
      type: 'session/preview-candidate-report_response',
      sessionId: request.sessionId,
      success: true,
      candidate,
    };
  }

  async createPreview(request: SessionPreviewCreateRequest): Promise<SessionPreviewCreateResponse> {
    const scopeFailure = this.validateRequestScope(request.machineId, request.workspaceId);
    if (scopeFailure) {
      return {
        type: 'session/preview-create_response',
        sessionId: request.sessionId,
        success: false,
        error: scopeFailure.code,
        message: scopeFailure.message,
      };
    }

    const session = await this.getSessionMeta(request.sessionId);
    const now = this.now();
    if (!session.ok) {
      return this.failCreate(request.sessionId, session.failure, now);
    }

    if (request.requestedByUserId !== session.meta.userId) {
      const failure: ValidationFailure = {
        code: 'grant_denied',
        message: 'Only the session initiator can approve a team preview in v1.',
        retryable: false,
      };
      return this.failCreate(request.sessionId, failure, now);
    }

    if (
      !request.approval ||
      request.approval.confirmedByUserId !== request.requestedByUserId ||
      request.approval.confirmedAt < now - PREVIEW_APPROVAL_MAX_AGE_MS ||
      request.approval.confirmedAt > now + PREVIEW_APPROVAL_FUTURE_SKEW_MS
    ) {
      const failure: ValidationFailure = {
        code: 'user_confirmation_required',
        message: 'Remote preview requires a recent confirmation from the requesting user.',
        retryable: false,
      };
      return this.failCreate(request.sessionId, failure, now, request.target);
    }

    const requestedTarget = normalizeTarget(request.target);
    if (isValidationFailure(requestedTarget)) {
      return this.failCreate(request.sessionId, requestedTarget, now, request.target);
    }

    const approvedTarget = normalizeTarget(request.approval.target);
    const actualTargetClass = classifyBrowserHostname(requestedTarget.host);
    const approvedTargetClass = request.approval.targetClass.replace('_', '-');
    if (
      isValidationFailure(approvedTarget) ||
      actualTargetClass !== approvedTargetClass ||
      !sameTargetOrigin(approvedTarget, requestedTarget)
    ) {
      const failure: ValidationFailure = {
        code: 'target_changed',
        message: 'The approved preview target origin does not match the requested target.',
        retryable: false,
      };
      return this.failCreate(request.sessionId, failure, now, requestedTarget);
    }

    const validation = await this.validateTargetForCreate(requestedTarget);
    if ('failure' in validation) {
      return this.failCreate(request.sessionId, validation.failure, now, requestedTarget);
    }

    const existing = session.meta.previewConnection;
    if (
      existing?.status === 'active' &&
      !this.isConnectionLeaseExpired(existing) &&
      sameTargetOrigin(existing.target, validation.normalizedTarget) &&
      this.activeTunnels.has(request.sessionId)
    ) {
      return {
        type: 'session/preview-create_response',
        sessionId: request.sessionId,
        success: true,
        connection: existing,
      };
    }
    if (
      existing?.status === 'active' &&
      !this.isConnectionLeaseExpired(existing) &&
      !request.replaceExisting
    ) {
      const failure: ValidationFailure = {
        code: 'preview_already_active',
        message: 'This session already has an active preview. Revoke or replace it first.',
        retryable: false,
      };
      return this.connectionResponse(request.sessionId, false, existing, failure);
    }

    const rateLimitFailure = this.enforceCreateRateLimit(now);
    if (rateLimitFailure) {
      return this.failCreate(request.sessionId, rateLimitFailure, now);
    }

    const grantId = randomUUID();
    const creating: PreviewConnection = {
      status: 'creating',
      grantId,
      target: validation.normalizedTarget,
      viewerScope: { type: 'workspace' },
      approvedByUserId: request.requestedByUserId,
      createdAt: now,
      updatedAt: now,
      leaseExpiresAt: now + DEFAULT_PREVIEW_LEASE_MS,
      idleTimeoutMs: DEFAULT_PREVIEW_IDLE_TIMEOUT_MS,
      lastActiveAt: now,
    };
    await this.patchSessionPreview(request.sessionId, { previewConnection: creating });

    const gatewayUrl = this.deps.remoteGatewayUrl;
    if (!gatewayUrl) {
      const failure: ValidationFailure = {
        code: 'tunnel_not_configured',
        message: 'Remote preview is unavailable on this platform.',
        retryable: false,
      };
      return this.failCreatingConnection(request.sessionId, creating, failure);
    }

    if (request.replaceExisting) {
      await this.closeActiveTunnel(request.sessionId, 'Preview tunnel replaced');
    }

    const registryReservation = await this.reserveMachinePreviewSlot(
      request.sessionId,
      grantId,
      now
    );
    if ('failure' in registryReservation) {
      return this.failCreatingConnection(request.sessionId, creating, registryReservation.failure);
    }

    try {
      const handle = await startPreviewTunnel({
        gatewayUrl,
        authToken: this.deps.authToken(),
        target: validation.normalizedTarget,
        createRequest: {
          workspaceId: this.deps.workspaceId,
          machineId: this.deps.machineId,
          sessionId: request.sessionId,
          grantId,
          approvedByUserId: request.requestedByUserId,
          leaseExpiresAt: creating.leaseExpiresAt ?? now + DEFAULT_PREVIEW_LEASE_MS,
          idleTimeoutMs: creating.idleTimeoutMs ?? DEFAULT_PREVIEW_IDLE_TIMEOUT_MS,
        },
        onClosed: async (error) => {
          this.activeTunnels.delete(request.sessionId);
          await this.releaseMachinePreviewSlot(request.sessionId);
          if (!error) {
            return;
          }
          await this.markTunnelClosedWithError(request.sessionId, creating, error);
        },
      });
      this.activeTunnels.set(request.sessionId, handle);

      const active: PreviewConnection = {
        ...creating,
        status: 'active',
        tunnelId: handle.tunnelId,
        publicUrl: handle.publicUrl,
        resourceLimits: handle.resourceLimits,
        resourceUsage: {
          httpRequestCount: 0,
          webSocketOpenCount: 0,
          requestBytesIn: 0,
          responseBytesOut: 0,
          limitExceededCount: 0,
        },
        updatedAt: this.now(),
        lastActiveAt: this.now(),
      };
      await this.patchSessionPreview(request.sessionId, { previewConnection: active });
      return {
        type: 'session/preview-create_response',
        sessionId: request.sessionId,
        success: true,
        connection: active,
      };
    } catch (error) {
      if (this.activeTunnels.has(request.sessionId)) {
        await this.closeActiveTunnel(request.sessionId, 'Preview tunnel creation failed');
      } else {
        await this.releaseMachinePreviewSlot(request.sessionId);
      }
      const failure: ValidationFailure = {
        code: 'tunnel_creation_failed',
        message: `Preview tunnel creation failed: ${formatErrorMessage(error)}`,
        retryable: true,
      };
      const failed: PreviewConnection = {
        ...creating,
        status: 'failed',
        updatedAt: this.now(),
        error: {
          stage: 'connect',
          errorCode: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        },
      };
      await this.patchSessionPreview(request.sessionId, { previewConnection: failed });
      return this.connectionResponse(request.sessionId, false, failed, failure);
    }
  }

  async acquireEndpoint(request: {
    machineId: MachineId;
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    requestedByUserId: string;
    target: PreviewTarget;
  }): Promise<SessionPreviewEndpointAcquireResponse> {
    const scopeFailure = this.validateRequestScope(request.machineId, request.workspaceId);
    if (scopeFailure) {
      return {
        type: 'session/preview-endpoint-acquire_response',
        sessionId: request.sessionId,
        success: false,
        error: scopeFailure.code,
        message: scopeFailure.message,
      };
    }

    const session = await this.getSessionMeta(request.sessionId);
    if (!session.ok) {
      return {
        type: 'session/preview-endpoint-acquire_response',
        sessionId: request.sessionId,
        success: false,
        error: session.failure.code,
        message: session.failure.message,
      };
    }

    if (request.requestedByUserId !== session.meta.userId) {
      return {
        type: 'session/preview-endpoint-acquire_response',
        sessionId: request.sessionId,
        success: false,
        error: 'grant_denied',
        message: 'Only the session initiator can open a managed local preview.',
      };
    }

    const validation = await this.validateTargetForCreate(request.target);
    if ('failure' in validation) {
      return {
        type: 'session/preview-endpoint-acquire_response',
        sessionId: request.sessionId,
        success: false,
        error: validation.failure.code,
        message: validation.failure.message,
      };
    }

    const shareUrl =
      session.meta.previewConnection?.status === 'active' &&
      typeof session.meta.previewConnection.publicUrl === 'string' &&
      sameTargetOrigin(session.meta.previewConnection.target, validation.normalizedTarget) &&
      !this.isConnectionLeaseExpired(session.meta.previewConnection)
        ? session.meta.previewConnection.publicUrl
        : undefined;
    const endpoint = await this.localProxyManager.acquire({
      sessionId: request.sessionId,
      target: validation.normalizedTarget,
      shareUrl,
      resourceLimits: session.meta.previewConnection?.resourceLimits,
    });
    return {
      type: 'session/preview-endpoint-acquire_response',
      sessionId: request.sessionId,
      success: true,
      endpoint,
    };
  }

  async releaseEndpoint(request: {
    machineId: MachineId;
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    endpointId: string;
  }): Promise<SessionPreviewEndpointReleaseResponse> {
    const scopeFailure = this.validateRequestScope(request.machineId, request.workspaceId);
    if (scopeFailure) {
      return {
        type: 'session/preview-endpoint-release_response',
        sessionId: request.sessionId,
        endpointId: request.endpointId,
        success: false,
        error: scopeFailure.code,
        message: scopeFailure.message,
      };
    }
    await this.localProxyManager.release(request.sessionId, request.endpointId);
    return {
      type: 'session/preview-endpoint-release_response',
      sessionId: request.sessionId,
      endpointId: request.endpointId,
      success: true,
    };
  }

  async closeSessionPreviewForCleanup(sessionId: SessionId, reason: string): Promise<void> {
    let current: PreviewConnection | undefined;
    try {
      const session = await this.getSessionMeta(sessionId);
      if (session.ok) {
        current = session.meta.previewConnection;
      } else {
        this.deps.logger.debug(
          `[${sessionId}] Skipping preview metadata update during cleanup: ${session.failure.message}`
        );
      }
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] Failed to read preview metadata during cleanup: ${formatErrorMessage(error)}`
      );
    }

    await this.closeActiveTunnel(sessionId, reason);
    await this.localProxyManager.closeSession(sessionId, reason);

    if (!shouldMarkPreviewClosedForCleanup(current)) {
      return;
    }

    const now = this.now();
    try {
      await this.patchSessionPreview(sessionId, {
        previewConnection: {
          ...current,
          status: 'revoked',
          updatedAt: now,
          revokedAt: now,
          revokeReason: reason,
          error: undefined,
        },
      });
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] Failed to mark preview closed during cleanup: ${formatErrorMessage(error)}`
      );
    }
  }

  async closeAllActiveTunnelsForCleanup(reason: string): Promise<void> {
    const sessionIds = [...this.activeTunnels.keys()];
    await Promise.allSettled(
      sessionIds.map(async (sessionId) => {
        await this.closeSessionPreviewForCleanup(sessionId, reason);
      })
    );
    await this.localProxyManager.closeAll(reason);
  }

  async revokePreview(request: SessionPreviewRevokeRequest): Promise<SessionPreviewRevokeResponse> {
    const scopeFailure = this.validateRequestScope(request.machineId, request.workspaceId);
    if (scopeFailure) {
      return {
        type: 'session/preview-revoke_response',
        sessionId: request.sessionId,
        success: false,
        error: scopeFailure.code,
        message: scopeFailure.message,
      };
    }

    const session = await this.getSessionMeta(request.sessionId);
    const now = this.now();
    if (!session.ok) {
      const connection = this.failedConnection('revoke', session.failure, now);
      return this.revokeResponse(request.sessionId, false, connection, session.failure);
    }

    const current = session.meta.previewConnection;
    await this.closeActiveTunnel(request.sessionId, request.reason?.trim() || 'Preview revoked');
    const revoked: PreviewConnection = {
      ...(current ?? { status: 'idle' as const }),
      status: 'revoked',
      updatedAt: now,
      revokedAt: now,
      revokeReason: request.reason?.trim() || 'user_revoked',
      error: undefined,
    };
    await this.patchSessionPreview(request.sessionId, { previewConnection: revoked });
    return {
      type: 'session/preview-revoke_response',
      sessionId: request.sessionId,
      success: true,
      connection: revoked,
    };
  }

  private async validateTargetForCreate(
    target: PreviewTarget
  ): Promise<ValidationSuccess | { failure: ValidationFailure }> {
    const normalized = normalizeTarget(target);
    if (isValidationFailure(normalized)) {
      return { failure: normalized };
    }

    const tcpFailure = await probeTcp(normalized);
    if (tcpFailure) {
      return { failure: tcpFailure };
    }

    const httpFailure = await probeHttp(normalized);
    if (httpFailure) {
      return { failure: httpFailure };
    }

    return {
      normalizedTarget: normalized,
    };
  }

  private async closeActiveTunnel(sessionId: SessionId, reason: string): Promise<void> {
    const handle = this.activeTunnels.get(sessionId);
    if (!handle) {
      return;
    }
    this.activeTunnels.delete(sessionId);
    try {
      await handle.close(reason);
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] Failed to close preview tunnel: ${formatErrorMessage(error)}`
      );
    } finally {
      await this.releaseMachinePreviewSlot(sessionId);
    }
  }

  private async markTunnelClosedWithError(
    sessionId: SessionId,
    previous: PreviewConnection,
    error: Error
  ): Promise<void> {
    const latest = await this.getSessionMeta(sessionId);
    if (!latest.ok || latest.meta.previewConnection?.grantId !== previous.grantId) {
      return;
    }
    if (latest.meta.previewConnection?.status !== 'active') {
      return;
    }
    const failure: ValidationFailure = {
      code: classifyPreviewTunnelCloseError(error),
      message: `Preview tunnel disconnected: ${error.message}`,
      retryable: true,
    };
    const status =
      failure.code === 'preview_expired' || failure.code === 'preview_idle_timeout'
        ? 'expired'
        : 'failed';
    await this.patchSessionPreview(sessionId, {
      previewConnection: {
        ...latest.meta.previewConnection,
        status,
        updatedAt: this.now(),
        ...(status === 'expired' ? { revokeReason: failure.message } : {}),
        resourceUsage: {
          ...latest.meta.previewConnection.resourceUsage,
          lastCloseReason: error.message,
        },
        error: {
          stage: 'connect',
          errorCode: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        },
      },
    });
  }

  private enforceCreateRateLimit(now: number): ValidationFailure | null {
    const windowStart = now - PREVIEW_CREATE_RATE_LIMIT_WINDOW_MS;
    while (
      this.previewCreateAttempts.length > 0 &&
      (this.previewCreateAttempts[0] ?? 0) < windowStart
    ) {
      this.previewCreateAttempts.shift();
    }
    if (this.previewCreateAttempts.length >= PREVIEW_CREATE_RATE_LIMIT_MAX) {
      return {
        code: 'resource_limit_exceeded',
        message: `Too many preview creation attempts. Try again in a minute.`,
        retryable: true,
      };
    }
    this.previewCreateAttempts.push(now);
    return null;
  }

  private getMachinePreviewRegistryKey(sessionId: SessionId, grantId: string): string {
    return `${this.deps.machineId}:${this.deps.workspaceId}:${sessionId}:${grantId}`;
  }

  private async reserveMachinePreviewSlot(
    sessionId: SessionId,
    grantId: string,
    now: number
  ): Promise<{ key: string } | { failure: ValidationFailure }> {
    const key = this.getMachinePreviewRegistryKey(sessionId, grantId);
    try {
      const result = await withFileLock(
        PREVIEW_REGISTRY_LOCK_NAME,
        async (): Promise<{ key: string } | { failure: ValidationFailure }> => {
          const entries = filterLivePreviewRegistryEntries(await readPreviewRegistryEntries(), now);
          const machineEntries = entries.filter((entry) => entry.machineId === this.deps.machineId);
          const hasExistingEntry = entries.some((entry) => entry.key === key);
          if (
            !hasExistingEntry &&
            machineEntries.length >= DEFAULT_PREVIEW_MAX_ACTIVE_TUNNELS_PER_MACHINE
          ) {
            return {
              failure: {
                code: 'resource_limit_exceeded',
                message: `This machine already has ${machineEntries.length} active previews. Close one before creating another.`,
                retryable: true,
              },
            };
          }

          const nextEntries = entries.filter((entry) => entry.key !== key);
          nextEntries.push({
            key,
            pid: process.pid,
            workspaceId: this.deps.workspaceId,
            machineId: this.deps.machineId,
            sessionId,
            grantId,
            updatedAt: now,
          });
          await writePreviewRegistryEntries(nextEntries);
          return { key };
        },
        { timeout: 2_000 }
      );
      if ('key' in result) {
        this.activeRegistryKeys.set(sessionId, result.key);
      }
      return result;
    } catch (error) {
      return {
        failure: {
          code: 'resource_limit_exceeded',
          message: `Preview machine limit check failed: ${formatErrorMessage(error)}`,
          retryable: true,
        },
      };
    }
  }

  private async releaseMachinePreviewSlot(sessionId: SessionId): Promise<void> {
    const key = this.activeRegistryKeys.get(sessionId);
    if (!key) {
      return;
    }
    this.activeRegistryKeys.delete(sessionId);
    await withFileLock(
      PREVIEW_REGISTRY_LOCK_NAME,
      async () => {
        const entries = await readPreviewRegistryEntries();
        await writePreviewRegistryEntries(entries.filter((entry) => entry.key !== key));
      },
      { timeout: 2_000 }
    ).catch((error: unknown) => {
      this.deps.logger.debug(
        `[${sessionId}] Failed to release preview machine slot: ${formatErrorMessage(error)}`
      );
    });
  }

  private async getSessionMeta(
    sessionId: SessionId
  ): Promise<{ ok: true; meta: PreviewSessionMeta } | { ok: false; failure: ValidationFailure }> {
    const record = await this.deps.workspaceDocument.repo.getDocMeta(getSessionRoomId(sessionId));
    if (!record?.meta || isLoroRepoDocDeleted(record)) {
      return {
        ok: false,
        failure: {
          code: 'session_not_found',
          message: `Session not found: ${sessionId}`,
          retryable: false,
        },
      };
    }

    let meta = record.meta as PreviewSessionMeta;
    if (meta.machineId !== this.deps.machineId) {
      return {
        ok: false,
        failure: {
          code: 'session_mismatch',
          message: 'Preview request does not match this CLI machine or workspace.',
          retryable: false,
        },
      };
    }

    if (meta.isArchived) {
      return {
        ok: false,
        failure: {
          code: 'session_archived',
          message: 'Archived sessions cannot create or update remote previews.',
          retryable: false,
        },
      };
    }

    try {
      const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const preview = await sessionDoc.getPreviewState();
      if (preview?.candidate || preview?.connection) {
        meta = {
          ...meta,
          previewCandidate: preview.candidate ?? meta.previewCandidate,
          previewConnection: preview.connection ?? meta.previewConnection,
        };
      }
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] Failed to read preview session doc state: ${formatErrorMessage(error)}`
      );
    }

    return { ok: true, meta };
  }

  private validateRequestScope(
    machineId: MachineId,
    workspaceId: WorkspaceId
  ): ValidationFailure | null {
    if (machineId === this.deps.machineId && workspaceId === this.deps.workspaceId) {
      return null;
    }

    return {
      code: 'session_mismatch',
      message: 'Preview request does not match this CLI machine or workspace.',
      retryable: false,
    };
  }

  private isConnectionLeaseExpired(connection: PreviewConnection): boolean {
    return typeof connection.leaseExpiresAt === 'number' && connection.leaseExpiresAt <= this.now();
  }

  private async patchSessionPreview(
    sessionId: SessionId,
    patch: SessionPreviewStatePatch
  ): Promise<void> {
    try {
      const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const current = (await sessionDoc.getPreviewState()) ?? {};
      const next: SessionPreviewDocState = {
        ...current,
      };
      if (hasPreviewPatchKey(patch, 'previewCandidate')) {
        next.candidate = patch.previewCandidate;
      }
      if (hasPreviewPatchKey(patch, 'previewConnection')) {
        next.connection = patch.previewConnection;
      }
      await sessionDoc.setPreviewState(next);
      await this.deps.workspaceDocument.repo.upsertDocMeta(getSessionRoomId(sessionId), {
        previewCandidate: summarizePreviewCandidateForMeta(next.candidate),
        previewConnection: summarizePreviewConnectionForMeta(next.connection),
      } satisfies Partial<Pick<SessionMeta, 'previewCandidate' | 'previewConnection'>>);
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] Failed to update preview session meta: ${formatErrorMessage(error)}`
      );
      throw error;
    }
  }

  private withCandidateFailure(
    candidate: PreviewCandidate,
    stage: 'report' | 'create',
    failure: ValidationFailure
  ): PreviewCandidate {
    return {
      ...candidate,
      status: 'invalid',
      updatedAt: this.now(),
      validation: {
        lastCheckedAt: this.now(),
        stage,
        ok: false,
        errorCode: failure.code,
        message: failure.message,
      },
    };
  }

  private failedConnection(
    stage: 'create' | 'connect' | 'revoke',
    failure: ValidationFailure,
    now: number,
    target?: PreviewTarget
  ): PreviewConnection {
    return {
      status: 'failed',
      ...(target ? { target } : {}),
      updatedAt: now,
      error: {
        stage,
        errorCode: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
    };
  }

  /** Persists a create failure raised before the `creating` state was written. */
  private async failCreate(
    sessionId: SessionId,
    failure: ValidationFailure,
    now: number,
    target?: PreviewTarget
  ): Promise<SessionPreviewCreateResponse> {
    const connection = this.failedConnection('create', failure, now, target);
    await this.patchSessionPreview(sessionId, { previewConnection: connection });
    return this.connectionResponse(sessionId, false, connection, failure);
  }

  /** Persists a create failure raised after the `creating` state was written. */
  private async failCreatingConnection(
    sessionId: SessionId,
    creating: PreviewConnection,
    failure: ValidationFailure
  ): Promise<SessionPreviewCreateResponse> {
    const failed: PreviewConnection = {
      ...creating,
      status: 'failed',
      updatedAt: this.now(),
      error: {
        stage: 'connect',
        errorCode: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
    };
    await this.patchSessionPreview(sessionId, { previewConnection: failed });
    return this.connectionResponse(sessionId, false, failed, failure);
  }

  private candidateResponse(
    sessionId: SessionId,
    success: boolean,
    candidate: PreviewCandidate,
    failure: ValidationFailure
  ): PreviewCandidateReportResponse {
    return {
      type: 'session/preview-candidate-report_response',
      sessionId,
      success,
      candidate,
      error: failure.code,
      message: failure.message,
    };
  }

  private connectionResponse(
    sessionId: SessionId,
    success: boolean,
    connection: PreviewConnection,
    failure: ValidationFailure
  ): SessionPreviewCreateResponse {
    return {
      type: 'session/preview-create_response',
      sessionId,
      success,
      connection,
      error: failure.code,
      message: failure.message,
    };
  }

  private revokeResponse(
    sessionId: SessionId,
    success: boolean,
    connection: PreviewConnection,
    failure: ValidationFailure
  ): SessionPreviewRevokeResponse {
    return {
      type: 'session/preview-revoke_response',
      sessionId,
      success,
      connection,
      error: failure.code,
      message: failure.message,
    };
  }

  private now(): number {
    return Math.round(this.deps.now?.() ?? getServerNow());
  }
}

import type { CloudRemotePreviewPort } from '@lody/platform';
import { PreviewControlAuthority } from './preview-control-authority';
import type { PreviewControlOperation, PreviewControlProof } from '@lody/shared';
import net from 'net';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  DEFAULT_PREVIEW_IDLE_TIMEOUT_MS,
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
  type SessionPreviewStatusRequest,
  type SessionPreviewStatusResponse,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { LocalPreviewProxyManager } from './local-preview-proxy';
import { QuickTunnelSession, type PreviewCloseReason } from './quick-tunnel-session';
import { createPreviewTargetTransport, fetchPreviewTarget } from './preview-target-transport';

const PreviewSessionOwner = z.object({
  userId: z.string(),
  machineId: z.string(),
  isArchived: z.boolean().optional(),
  localProjectId: z.string().optional(),
});
type PreviewSessionMeta = z.infer<typeof PreviewSessionOwner> & {
  previewCandidate?: PreviewCandidate;
  previewConnection?: PreviewConnection;
};

type SessionPreviewStatePatch = {
  previewCandidate?: PreviewCandidate;
  previewConnection?: PreviewConnection;
};

type PreviewServiceDeps = {
  logger: Logger;
  workspaceDocument: {
    getOrCreateSessionDoc(
      sessionId: SessionId
    ): Promise<
      Pick<
        Awaited<ReturnType<LoroDocumentManager['getOrCreateSessionDoc']>>,
        'getPreviewState' | 'setPreviewState'
      >
    >;
    repo: {
      getDocMeta(
        roomId: ReturnType<typeof getSessionRoomId>
      ): Promise<
        { meta?: unknown; exists?: boolean; e?: boolean; deleted?: boolean } | undefined | null
      >;
      upsertDocMeta(
        roomId: ReturnType<typeof getSessionRoomId>,
        patch: Partial<SessionMeta>
      ): Promise<unknown>;
    };
  };
  machineId: MachineId;
  workspaceId: WorkspaceId;
  userId: string;
  runtimeBaseUrl: string | null;
  remotePreview: CloudRemotePreviewPort | null;
  now?: () => number;
};

type ValidationFailure = {
  code: PreviewErrorCode;
  message: string;
  retryable: boolean;
};

type ValidationSuccess = {
  normalizedTarget: PreviewTarget;
  connectionAddress: string;
};

// The Host lease guarantees one Worker; slots span all of its workspaces.
const machinePreviewSlots = new Map<MachineId, Set<string>>();

const PREVIEW_TCP_TIMEOUT_MS = 2_000;
const PREVIEW_HTTP_TIMEOUT_MS = 3_000;
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
  // The UI classifier accepts *.localhost, but this network boundary accepts only
  // exact localhost or a literal. HTTP probing selects a loopback address and the
  // proxy pins HTTP/WS to it; neither can resolve an arbitrary DNS name.
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

const buildLocalPreviewUrl = (target: PreviewTarget): string =>
  `${target.protocol}://${toUrlHost(target.host)}:${target.port}${target.path ?? '/'}`;

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
  const { dispatcher } = createPreviewTargetTransport(target, host);
  try {
    const response = await fetchPreviewTarget(buildLocalPreviewUrl(target), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      dispatcher,
    });
    await response.body?.cancel();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  } finally {
    clearTimeout(timeout);
    await dispatcher.destroy();
  }
};

const probeHttp = async (
  target: PreviewTarget
): Promise<ValidationFailure | { connectionAddress: string }> => {
  let lastError: unknown;
  for (const host of probeHosts(target.host)) {
    const result = await probeHttpHost(target, host);
    if (result.ok) {
      return { connectionAddress: host };
    }
    lastError = result.error;
  }
  return {
    code: 'local_server_unreachable',
    message: `Local preview server did not respond over HTTP: ${formatErrorMessage(lastError)}`,
    retryable: true,
  };
};

const shouldMarkPreviewClosedForCleanup = (connection: PreviewConnection | undefined): boolean =>
  !!connection && connection.status !== 'closed';

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
  private readonly activeTunnels = new Map<SessionId, QuickTunnelSession>();
  private readonly operations = new Map<SessionId, Promise<unknown>>();
  private readonly cancelled = new Map<SessionId, AbortController>();
  private readonly slotIds = new Map<SessionId, string>();
  private readonly previewCreateAttempts: number[] = [];
  private readonly localProxyManager: LocalPreviewProxyManager;

  readonly controlAuthority: PreviewControlAuthority;

  constructor(private readonly deps: PreviewServiceDeps) {
    this.controlAuthority = new PreviewControlAuthority(deps.remotePreview?.verifyControl, () =>
      this.now()
    );
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
    });
    return {
      type: 'session/preview-candidate-report_response',
      sessionId: request.sessionId,
      success: true,
      candidate,
    };
  }

  async createPreview(request: SessionPreviewCreateRequest): Promise<SessionPreviewCreateResponse> {
    if (this.operations.has(request.sessionId))
      return {
        type: 'session/preview-create_response',
        sessionId: request.sessionId,
        success: false,
        error: 'preview_already_active',
        message: 'A preview lifecycle operation is already in progress.',
      };
    // Serialize all lifecycle writes. A revoke aborts the currently running create
    // before joining this queue, so a slow download cannot delay invalidation.
    const cancellation = new AbortController();
    this.cancelled.set(request.sessionId, cancellation);
    return this.serialize(request.sessionId, () =>
      this.createPreviewExclusive(request, cancellation.signal)
    ).finally(() => this.cancelled.delete(request.sessionId));
  }

  private async createPreviewExclusive(
    request: SessionPreviewCreateRequest,
    signal: AbortSignal
  ): Promise<SessionPreviewCreateResponse> {
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

    signal.throwIfAborted();
    const validation = await this.validateTargetForCreate(requestedTarget);
    signal.throwIfAborted();
    if ('failure' in validation) {
      return this.failCreate(request.sessionId, validation.failure, now, requestedTarget);
    }

    const existing = session.meta.previewConnection;
    if (
      existing?.status === 'active' &&
      !request.restart &&
      sameTargetOrigin(existing.target, validation.normalizedTarget) &&
      this.activeTunnels.get(request.sessionId)?.active
    ) {
      return {
        type: 'session/preview-create_response',
        sessionId: request.sessionId,
        success: true,
        connection: existing,
      };
    }

    const rateLimitFailure = this.enforceCreateRateLimit(now);
    if (rateLimitFailure) {
      return this.failCreate(request.sessionId, rateLimitFailure, now);
    }

    const endpointId = randomUUID();
    const creating: PreviewConnection = {
      status: 'creating',
      endpointId,
      target: validation.normalizedTarget,
      approvedByUserId: request.requestedByUserId,
      createdAt: now,
      updatedAt: now,
      idleTimeoutMs: DEFAULT_PREVIEW_IDLE_TIMEOUT_MS,
    };
    await this.patchSessionPreview(request.sessionId, { previewConnection: creating });

    const runtimeBaseUrl = this.deps.runtimeBaseUrl;
    if (!this.deps.remotePreview || !runtimeBaseUrl) {
      const failure: ValidationFailure = {
        code: 'tunnel_not_configured',
        message: 'Remote preview is unavailable on this platform.',
        retryable: false,
      };
      return this.failCreatingConnection(request.sessionId, creating, failure);
    }

    await this.closeActiveTunnel(request.sessionId, 'replaced');
    signal.throwIfAborted();

    const slotFailure = this.reserveMachinePreviewSlot(request.sessionId, endpointId);
    if (slotFailure) {
      return this.failCreatingConnection(request.sessionId, creating, slotFailure);
    }

    try {
      signal.throwIfAborted();
      const handle = new QuickTunnelSession({
        sessionId: request.sessionId,
        target: validation.normalizedTarget,
        connectionAddress: validation.connectionAddress,
        runtimeBaseUrl,
        logger: this.deps.logger,
        now: () => this.now(),
      });
      this.activeTunnels.set(request.sessionId, handle);
      const endpoint = await handle.ready;
      signal.throwIfAborted();
      if (!handle.active) throw new Error('Quick Tunnel closed before activation');

      const active: PreviewConnection = {
        ...creating,
        status: 'active',
        publicUrl: endpoint.viewerUrl,
        updatedAt: this.now(),
      };
      await this.patchSessionPreview(request.sessionId, { previewConnection: active });
      signal.throwIfAborted();
      // Completion updates share the same serialization boundary as create/revoke.
      void handle.closed
        .then((result) =>
          this.serialize(request.sessionId, async () => {
            if (this.activeTunnels.get(request.sessionId) !== handle) return;
            this.activeTunnels.delete(request.sessionId);
            this.releaseMachinePreviewSlot(request.sessionId);
            if (result.error)
              await this.markTunnelClosedWithError(request.sessionId, active, result.error);
            else
              await this.patchSessionPreview(request.sessionId, {
                previewConnection: {
                  ...active,
                  status: 'closed',
                  closedReason: result.reason,
                  publicUrl: undefined,
                  updatedAt: this.now(),
                },
              });
          })
        )
        .catch((error: unknown) =>
          this.deps.logger.error('Failed to publish Quick Tunnel closure', error)
        );
      return {
        type: 'session/preview-create_response',
        sessionId: request.sessionId,
        success: true,
        connection: active,
      };
    } catch (error) {
      let failureError = error;
      try {
        if (this.activeTunnels.has(request.sessionId)) {
          await this.closeActiveTunnel(request.sessionId, 'revoked');
        } else {
          this.releaseMachinePreviewSlot(request.sessionId);
        }
      } catch (cleanupError) {
        if (cleanupError !== error)
          failureError = new AggregateError(
            [error, cleanupError],
            'Preview creation and cleanup failed',
            { cause: error }
          );
      }
      const failure: ValidationFailure = {
        code: 'tunnel_creation_failed',
        message: `Preview tunnel creation failed: ${formatErrorMessage(failureError)}`,
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
      this.activeTunnels.get(request.sessionId)?.active
        ? session.meta.previewConnection.publicUrl
        : undefined;
    const endpoint = await this.localProxyManager.acquire({
      sessionId: request.sessionId,
      target: validation.normalizedTarget,
      connectionAddress: validation.connectionAddress,
      shareUrl,
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
    this.cancelled.get(sessionId)?.abort(new Error(reason));
    this.activeTunnels.get(sessionId)?.cancel('session_ended');
    return this.serialize(sessionId, async () => {
      await this.closeSessionPreviewExclusive(sessionId, reason);
    });
  }

  private async closeSessionPreviewExclusive(sessionId: SessionId, reason: string): Promise<void> {
    const [remote, local, session] = await Promise.allSettled([
      this.closeActiveTunnel(sessionId, 'session_ended'),
      this.localProxyManager.closeSession(sessionId, reason),
      this.getSessionMeta(sessionId),
    ]);
    const failures = [remote, local, session].flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length) throw new AggregateError(failures, 'Session preview cleanup failed');
    if (session.status !== 'fulfilled' || !session.value.ok) return;
    const current = session.value.meta.previewConnection;
    if (!shouldMarkPreviewClosedForCleanup(current)) return;
    const now = this.now();
    await this.patchSessionPreview(sessionId, {
      previewConnection: {
        ...current,
        status: 'closed',
        publicUrl: undefined,
        updatedAt: now,
        closedReason: 'session_ended',
        error: undefined,
      },
    });
  }

  async closeAllActiveTunnelsForCleanup(reason: string): Promise<void> {
    const sessionIds = new Set([...this.activeTunnels.keys(), ...this.operations.keys()]);
    const results = await Promise.allSettled(
      [...sessionIds].map((sessionId) => this.closeSessionPreviewForCleanup(sessionId, reason))
    );
    const local = await Promise.allSettled([this.localProxyManager.closeAll(reason)]);
    const failures = [...results, ...local].flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length) throw new AggregateError(failures, 'Preview shutdown failed');
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

    if (request.requestedByUserId !== session.meta.userId)
      return {
        type: 'session/preview-revoke_response',
        sessionId: request.sessionId,
        success: false,
        error: 'grant_denied',
        message: 'Only the session initiator can close this preview.',
      };
    this.cancelled.get(request.sessionId)?.abort(new Error('Preview revoked'));
    this.activeTunnels.get(request.sessionId)?.cancel('revoked');
    return this.serialize(request.sessionId, async () => {
      const current = session.meta.previewConnection;
      await this.closeActiveTunnel(request.sessionId, 'revoked');
      const revoked: PreviewConnection = {
        ...current,
        status: 'closed',
        publicUrl: undefined,
        updatedAt: now,
        closedReason: 'revoked',
        error: undefined,
      };
      await this.patchSessionPreview(request.sessionId, { previewConnection: revoked });
      return {
        type: 'session/preview-revoke_response',
        sessionId: request.sessionId,
        success: true,
        connection: revoked,
      };
    });
  }

  async authorizeRemoteControl(
    sessionId: SessionId,
    requesterUserId: string,
    operation: PreviewControlOperation,
    proof: PreviewControlProof
  ): Promise<void> {
    const session = await this.getSessionMeta(sessionId);
    if (!session.ok) throw new Error(session.failure.message);
    if (session.meta.userId !== requesterUserId)
      throw new Error('Only the session initiator can manage this preview.');
    await this.controlAuthority.authorize(
      {
        workspaceId: this.deps.workspaceId,
        machineId: this.deps.machineId,
        sessionId,
        requesterUserId,
        operation,
      },
      proof,
      session.meta.localProjectId
    );
  }

  async getStatus(request: SessionPreviewStatusRequest): Promise<SessionPreviewStatusResponse> {
    const base = { type: 'session/preview-status_response' as const, sessionId: request.sessionId };
    const scopeFailure = this.validateRequestScope(request.machineId, request.workspaceId);
    if (scopeFailure)
      return { ...base, success: false, error: scopeFailure.code, message: scopeFailure.message };
    const session = await this.getSessionMeta(request.sessionId);
    if (!session.ok)
      return {
        ...base,
        success: false,
        error: session.failure.code,
        message: session.failure.message,
      };
    if (request.requestedByUserId !== session.meta.userId)
      return {
        ...base,
        success: false,
        error: 'grant_denied',
        message: 'Only the session initiator can manage this preview.',
      };
    const current = session.meta.previewConnection;
    const handle = this.activeTunnels.get(request.sessionId);
    if (!handle) {
      const connection =
        current &&
        (current.status === 'active' || current.status === 'creating') &&
        !this.operations.has(request.sessionId)
          ? {
              ...current,
              status: 'closed' as const,
              publicUrl: undefined,
              closedReason: 'runtime_lost' as const,
            }
          : current;
      return { ...base, success: true, connection };
    }
    if (current?.status === 'creating') return { ...base, success: true, connection: current };
    await handle.checkHealth();
    // A replacement/revoke can finish while the public check is pending. Never
    // publish the checked owner's result over a different endpoint's state.
    if (this.activeTunnels.get(request.sessionId) !== handle) {
      await this.operations.get(request.sessionId);
      const latest = await this.getSessionMeta(request.sessionId);
      if (!latest.ok)
        return {
          ...base,
          success: false,
          error: latest.failure.code,
          message: latest.failure.message,
        };
      return {
        ...base,
        success: true,
        connection: latest.meta.previewConnection,
        expiresAt: this.activeTunnels.get(request.sessionId)?.expiresAt,
      };
    }
    if (request.renewEndpointId && request.renewEndpointId === current?.endpointId)
      handle.activity(true);
    if (handle.active)
      return { ...base, success: true, connection: current, expiresAt: handle.expiresAt };
    const outcome = await handle.closed;
    const connection: PreviewConnection = outcome.error
      ? {
          ...current,
          ...this.failedConnection(
            'connect',
            {
              code: 'tunnel_creation_failed',
              message: outcome.error.message,
              retryable: true,
            },
            this.now(),
            current?.target
          ),
          publicUrl: undefined,
        }
      : { ...current, status: 'closed', closedReason: outcome.reason, publicUrl: undefined };
    return { ...base, success: true, connection };
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

    const httpProbe = await probeHttp(normalized);
    if ('code' in httpProbe) {
      return { failure: httpProbe };
    }

    return {
      normalizedTarget: normalized,
      connectionAddress: httpProbe.connectionAddress,
    };
  }

  private async closeActiveTunnel(sessionId: SessionId, reason: PreviewCloseReason): Promise<void> {
    const handle = this.activeTunnels.get(sessionId);
    if (!handle) {
      return;
    }
    this.activeTunnels.delete(sessionId);
    try {
      await handle.close(reason);
    } finally {
      this.releaseMachinePreviewSlot(sessionId);
    }
  }

  private async markTunnelClosedWithError(
    sessionId: SessionId,
    previous: PreviewConnection,
    error: Error
  ): Promise<void> {
    const latest = await this.getSessionMeta(sessionId);
    if (!latest.ok || latest.meta.previewConnection?.endpointId !== previous.endpointId) {
      return;
    }
    if (latest.meta.previewConnection?.status !== 'active') {
      return;
    }
    const failure: ValidationFailure = {
      code: 'tunnel_creation_failed',
      message: `Preview tunnel disconnected: ${error.message}`,
      retryable: true,
    };
    await this.patchSessionPreview(sessionId, {
      previewConnection: {
        ...latest.meta.previewConnection,
        status: 'failed',
        publicUrl: undefined,
        updatedAt: this.now(),
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

  private reserveMachinePreviewSlot(
    sessionId: SessionId,
    endpointId: string
  ): ValidationFailure | null {
    const slots = machinePreviewSlots.get(this.deps.machineId) ?? new Set<string>();
    if (slots.size >= DEFAULT_PREVIEW_MAX_ACTIVE_TUNNELS_PER_MACHINE)
      return {
        code: 'resource_limit_exceeded',
        message: 'Close an active preview before creating another.',
        retryable: true,
      };
    slots.add(endpointId);
    machinePreviewSlots.set(this.deps.machineId, slots);
    this.slotIds.set(sessionId, endpointId);
    return null;
  }

  private releaseMachinePreviewSlot(sessionId: SessionId): void {
    const key = this.slotIds.get(sessionId);
    if (!key) return;
    this.slotIds.delete(sessionId);
    const slots = machinePreviewSlots.get(this.deps.machineId);
    slots?.delete(key);
    if (slots?.size === 0) machinePreviewSlots.delete(this.deps.machineId);
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

    const meta = PreviewSessionOwner.parse(record.meta);
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

    const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
    const preview = await sessionDoc.getPreviewState();
    return {
      ok: true,
      meta: {
        ...meta,
        previewCandidate: preview?.candidate,
        previewConnection: preview?.connection,
      },
    };
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

  /** Rejected inputs must not overwrite another user's preview or a live endpoint. */
  private async failCreate(
    sessionId: SessionId,
    failure: ValidationFailure,
    now: number,
    target?: PreviewTarget
  ): Promise<SessionPreviewCreateResponse> {
    const connection = this.failedConnection('create', failure, now, target);
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

  private serialize<T>(sessionId: SessionId, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(sessionId) ?? Promise.resolve();
    const operation = previous.then(action, action);
    this.operations.set(sessionId, operation);
    const clear = () => {
      if (this.operations.get(sessionId) === operation) this.operations.delete(sessionId);
    };
    void operation.then(clear, clear);
    return operation;
  }
}

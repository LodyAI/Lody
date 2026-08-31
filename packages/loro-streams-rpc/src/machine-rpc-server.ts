import type {
  AgentConfigId,
  AgentConfigCliType,
  CodeCollabV2InitDirectoryOk,
  CodeCollabV2InitDirectoryRequest,
  CodeCollabV2Error,
  CodeCollabV2LspUnsupported,
  CodeCollabV2OpenAllChangesDiffRequest,
  CodeCollabV2OpenAllChangesDiffResponse,
  CodeCollabV2OpenCurrentDiffRequest,
  CodeCollabV2OpenCurrentDiffResponse,
  CodeCollabV2OpenTextOk,
  CodeCollabV2OpenTextRequest,
  CodeCollabV2OpenTurnDiffRequest,
  CodeCollabV2OpenTurnDiffResponse,
  CodeCollabV2RefreshTextRequest,
  CodeCollabV2RefreshTextResponse,
  CodeCollabV2SaveTextRequest,
  CodeCollabV2SaveTextResponse,
  BuiltinRuntimeOverrides,
  CustomAcpLaunchSpec,
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  LocalProjectId,
  MachineAcpBinaryInstallResponse,
  MachineAcpBinaryProgressMessage,
  MachineAcpBinaryStatusResponse,
  MachineAcpAuthenticateResponse,
  MachineAcpAuthenticationProgressMessage,
  MachineAcpCapabilitiesRefreshResponse,
  MachineBugReportResponse,
  MachineId,
  MachinePingResponse,
  MachineRestartResponse,
  MachineStatusResponse,
  MachineUpgradeResponse,
  PreviewTarget,
  PreviewTargetApproval,
  SessionCancelResponse,
  SessionPreparationCancelSpec,
  SessionPreparationSpec,
  SessionPrepareCancelResponse,
  SessionPrepareResponse,
  SessionTerminateResponse,
  SessionDispatchTurnResponse,
  SessionEditAndResendResponse,
  SessionEditAndResendSpec,
  SessionForkResponse,
  SessionForkSpec,
  SessionSteerResponse,
  SessionId,
  SessionPreviewCreateResponse,
  SessionPreviewRevokeResponse,
  SessionTurnInputConfig,
  WorkspaceId,
} from '@lody/shared';
import { LoroStreamsTokenAuthError } from '@lody/shared';
import {
  CodeCollabV2ErrorCodeSchema,
  normalizeSessionTurnInputConfig,
  CodeCollabV2InitDirectoryRequestSchema,
  CodeCollabV2OpenAllChangesDiffRequestSchema,
  CodeCollabV2OpenCurrentDiffRequestSchema,
  CodeCollabV2OpenTextRequestSchema,
  CodeCollabV2OpenTurnDiffRequestSchema,
  CodeCollabV2RefreshTextRequestSchema,
  CodeCollabV2RpcContentEnvelopeSchema,
  CodeCollabV2SaveTextRequestSchema,
  FilePreviewV3RequestSchema,
  FilePreviewV3ErrorCodeSchema,
  filePreviewV3Error,
  type FilePreviewV3Request,
  type FilePreviewV3Response,
} from '@lody/shared';
import {
  CodeCollabV2LspRpcParamsSchema,
  decryptCodeCollabV2RpcPayload,
  encryptCodeCollabV2RpcPayload,
  type LoroJsonStreamState,
  type LoroStreamsJsonStreamClient,
  LoroStreamsGatewayError,
  LORO_STREAMS_RPC_ERROR_CODES,
  LORO_STREAMS_RPC_RETENTION_SECONDS,
  LORO_STREAMS_RPC_VERSION,
  type LocalProjectGitStateRpcResponse,
  type LoroSessionLiveStatusRpcResponse,
  LoroStreamsRpcRequestSchema,
  type LoroStreamsRpcMethod,
  getLoroMachineRpcRequestStreamId,
} from './rpc';
import {
  createRpcSecretRecipient,
  getMachineAcpAuthenticationInputSecretContext,
  getMachineAcpAuthorizationCodeSecretContext,
  type RpcSecretRecipient,
} from './rpc-secret';

const JSON_RPC_VERSION = '2.0';

// Upper bound on RPC handlers running at once on the shared per-machine request
// loop. Requests are dispatched concurrently (see `handleRequestBatch`) so a slow
// handler (e.g. a large turn diff) cannot head-of-line block independent reads;
// this cap keeps a burst of requests from spawning unbounded concurrent work and
// backpressures the read loop once saturated.
const DEFAULT_MAX_CONCURRENT_REQUESTS = 16;
// Dedicated concurrency for fast control-plane methods (chat dispatch, steer,
// terminate, cancel, ping, status). These handlers run in milliseconds, but on
// the shared semaphore they used to queue behind up to 16 in-flight code-collab diff
// handlers (500-2000ms each) because the intake loop acquires a slot per
// message. Control requests bypass the shared semaphore entirely; their tasks
// acquire from this small pool inside the task, so intake never blocks on them.
const DEFAULT_MAX_CONCURRENT_CONTROL_REQUESTS = 4;
const CONTROL_METHODS: ReadonlySet<string> = new Set([
  'machine/status',
  'machine/ping',
  'machine/restart',
  'machine/upgrade',
  'machine/acp-capabilities-refresh-cancel',
  'session/cancel',
  'session/live-status',
  'session/steer',
  'session/terminate',
  'session/dispatch-turn',
  'session/prepare',
  'session/prepare-cancel',
]);
const REQUEST_LOOP_RETRY_DELAY_MS = 1000;
const REQUEST_LOOP_REPEAT_WARN_INTERVAL_MS = 30_000;

const redactRpcRequestForLog = (raw: unknown): unknown => {
  if (typeof raw !== 'object' || raw === null) return raw;
  const request = raw as { method?: unknown; params?: unknown };
  if (
    request.method !== 'machine/acp-authenticate' ||
    typeof request.params !== 'object' ||
    request.params === null ||
    ![
      'authorizationCode',
      'authenticationInput',
      'authorizationCodeEnvelope',
      'authenticationInputEnvelope',
    ].some((key) => Object.hasOwn(request.params as object, key))
  ) {
    return raw;
  }
  return {
    ...request,
    params: {
      ...(request.params as Record<string, unknown>),
      ...(Object.hasOwn(request.params, 'authorizationCode')
        ? { authorizationCode: '[REDACTED]' }
        : {}),
      ...(Object.hasOwn(request.params, 'authenticationInput')
        ? { authenticationInput: '[REDACTED]' }
        : {}),
      ...(Object.hasOwn(request.params, 'authorizationCodeEnvelope')
        ? { authorizationCodeEnvelope: '[REDACTED]' }
        : {}),
      ...(Object.hasOwn(request.params, 'authenticationInputEnvelope')
        ? { authenticationInputEnvelope: '[REDACTED]' }
        : {}),
    },
  };
};

const delay = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const formatRpcStartupError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
};

/**
 * Minimal counting semaphore. `acquire()` resolves immediately while slots are
 * free and otherwise waits FIFO until `release()` hands one over. Used to bound
 * how many RPC handlers run concurrently on the request loop.
 */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.available = Math.max(1, Math.floor(max));
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the freed slot straight to the next waiter; `available` stays put.
      next();
      return;
    }
    this.available += 1;
  }
}

const toCodeCollabRpcError = (
  error: unknown
): { code: string; message: string; data?: unknown } | null => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code = typeof error.code === 'string' ? error.code : undefined;
  if (!code || !CodeCollabV2ErrorCodeSchema.safeParse(code).success) {
    return null;
  }
  const message =
    'message' in error && typeof error.message === 'string' && error.message.trim().length > 0
      ? error.message
      : 'Code Collab operation failed.';
  const data =
    'toRpcError' in error && typeof error.toRpcError === 'function'
      ? error.toRpcError()
      : undefined;
  return {
    code,
    message,
    ...(data === undefined ? {} : { data }),
  };
};

/**
 * Map a thrown handler error onto the File Preview v3 error shape so the client
 * gets a typed `status: 'error'` payload instead of a bare internal error. An
 * unrecognized code stays `transient_io`, and no raw error text is promoted to a
 * structured code.
 */
const toFilePreviewRpcError = (
  error: unknown,
  message: string
): { code: string; message: string; data?: unknown } => {
  const rawCode =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  const parsed = rawCode ? FilePreviewV3ErrorCodeSchema.safeParse(rawCode) : undefined;
  const code = parsed?.success ? parsed.data : 'transient_io';
  return {
    code,
    message,
    data: filePreviewV3Error(code, { message, retryable: code === 'transient_io' }),
  };
};

const codeCollabOwnerMismatchError = (): Error & {
  code: 'permission_denied';
  toRpcError: () => CodeCollabV2Error;
} => {
  const message = 'Code Collab RPC owner session mismatch.';
  return Object.assign(new Error(message), {
    code: 'permission_denied' as const,
    toRpcError: () => ({
      status: 'error' as const,
      code: 'permission_denied' as const,
      message,
      retryable: false,
    }),
  });
};

type RpcServerDeps = {
  logger: {
    info?: (message: string) => void;
    debug?: (message: string) => void;
    warn: (message: string) => void;
    error?: (message: string) => void;
  };
  workspaceId: WorkspaceId;
  machineId: MachineId;
  streamClient: LoroStreamsJsonStreamClient;
  now?: () => number;
  rpcVersion?: string;
  retentionSeconds?: number;
  /**
   * Maximum RPC handlers allowed to run concurrently on the request loop.
   * Defaults to {@link DEFAULT_MAX_CONCURRENT_REQUESTS}.
   */
  maxConcurrentRequests?: number;
  getMachineStatus: () => Promise<MachineStatusResponse>;
  pingMachine?: (args: { requestId: string }) => Promise<MachinePingResponse>;
  restartMachine?: (args: {
    requesterUserId: string;
    requestToken: string;
    requestId: string;
  }) => Promise<MachineRestartResponse>;
  upgradeMachine?: (args: {
    requesterUserId: string;
    requestToken: string;
    requestId: string;
    targetVersion?: string;
  }) => Promise<MachineUpgradeResponse>;
  onMachineLifecycleResponseAppended?: (
    args:
      | { action: 'restart'; response: MachineRestartResponse }
      | { action: 'upgrade'; response: MachineUpgradeResponse }
  ) => void;
  refreshMachineAcpCapabilities: (args: {
    configId: AgentConfigId;
    cliType: AgentConfigCliType;
    agentType: string;
    customAcp?: CustomAcpLaunchSpec;
    runtimeOverrides?: BuiltinRuntimeOverrides;
    env?: Record<string, string>;
    onAcpBinaryProgress?: (message: MachineAcpBinaryProgressMessage) => void;
    signal: AbortSignal;
  }) => Promise<MachineAcpCapabilitiesRefreshResponse>;
  authenticateMachineAcp?: (args: {
    requestId: string;
    action: 'start' | 'cancel' | 'submit-code' | 'submit-input';
    authenticationRequestId?: string;
    authorizationCode?: string;
    methodId?: string;
    interactionId?: string;
    authenticationInput?: string;
    configId?: AgentConfigId;
    cliType: AgentConfigCliType;
    agentType: string;
    customAcp?: CustomAcpLaunchSpec;
    runtimeOverrides?: BuiltinRuntimeOverrides;
    env?: Record<string, string>;
    onProgress?: (message: MachineAcpAuthenticationProgressMessage) => void;
  }) => Promise<MachineAcpAuthenticateResponse>;
  getMachineAcpBinaryStatus?: (args: {
    agentType: string;
  }) => Promise<MachineAcpBinaryStatusResponse>;
  installMachineAcpBinary?: (args: {
    agentType: string;
    onAcpBinaryProgress?: (message: MachineAcpBinaryProgressMessage) => void;
  }) => Promise<MachineAcpBinaryInstallResponse>;
  submitBugReport?: (args: {
    description: string;
    reporterUserId: string;
    requestToken: string;
  }) => Promise<MachineBugReportResponse>;
  cancelSession?: (args: {
    sessionId: SessionId;
    turnId: string;
  }) => Promise<SessionCancelResponse>;
  getSessionLiveStatus?: (args: {
    sessionId: SessionId;
  }) => Promise<LoroSessionLiveStatusRpcResponse>;
  steerSession?: (args: {
    sessionId: SessionId;
    expectedTurnId: string;
    userTurnId: string;
    userId: string;
    timestamp: string;
    inputConfig: SessionTurnInputConfig;
  }) => Promise<SessionSteerResponse>;
  terminateSession?: (args: { sessionId: SessionId }) => Promise<SessionTerminateResponse>;
  forkSession?: (args: SessionForkSpec) => Promise<SessionForkResponse>;
  editAndResendSession?: (
    args: SessionEditAndResendSpec & { inputConfig: SessionTurnInputConfig }
  ) => Promise<SessionEditAndResendResponse>;
  /**
   * Fast-path user-turn dispatch. Must ack-then-execute: validate + stash the
   * payload + wake the dispatch watcher and return immediately; never run the
   * agent turn inside this handler (it would pin a control-lane slot for the
   * turn duration).
   */
  dispatchSessionTurn?: (args: {
    sessionId: SessionId;
    userTurnId: string;
    userId: string;
    timestamp: string;
    inputConfig: SessionTurnInputConfig;
  }) => Promise<SessionDispatchTurnResponse>;
  prepareSession?: (args: SessionPreparationSpec) => Promise<SessionPrepareResponse>;
  cancelSessionPreparation?: (
    args: SessionPreparationCancelSpec
  ) => Promise<SessionPrepareCancelResponse>;
  openCodeCollabText?: (args: CodeCollabV2OpenTextRequest) => Promise<CodeCollabV2OpenTextOk>;
  resolveCodeCollabOwnerSessionId?: (sessionId: SessionId) => Promise<SessionId>;
  /** File Preview v3 — a plain read; must not activate Code Collab. */
  previewFile?: (args: FilePreviewV3Request) => Promise<FilePreviewV3Response>;
  refreshCodeCollabText?: (
    args: CodeCollabV2RefreshTextRequest
  ) => Promise<CodeCollabV2RefreshTextResponse>;
  saveCodeCollabText?: (args: CodeCollabV2SaveTextRequest) => Promise<CodeCollabV2SaveTextResponse>;
  openCodeCollabCurrentDiff?: (
    args: CodeCollabV2OpenCurrentDiffRequest
  ) => Promise<CodeCollabV2OpenCurrentDiffResponse>;
  openCodeCollabAllChangesDiff?: (
    args: CodeCollabV2OpenAllChangesDiffRequest
  ) => Promise<CodeCollabV2OpenAllChangesDiffResponse>;
  openCodeCollabTurnDiff?: (
    args: CodeCollabV2OpenTurnDiffRequest
  ) => Promise<CodeCollabV2OpenTurnDiffResponse>;
  initCodeCollabDirectory?: (
    args: CodeCollabV2InitDirectoryRequest
  ) => Promise<CodeCollabV2InitDirectoryOk>;
  getCodeCollabLspDefinition?: (args: {
    sessionId: SessionId;
    path: string;
    line?: number;
    character?: number;
  }) => Promise<CodeCollabV2LspUnsupported>;
  getCodeCollabLspReferences?: (args: {
    sessionId: SessionId;
    path: string;
    line?: number;
    character?: number;
  }) => Promise<CodeCollabV2LspUnsupported>;
  createSessionPreview?: (args: {
    sessionId: SessionId;
    requestedByUserId: string;
    target: PreviewTarget;
    approval: PreviewTargetApproval;
    replaceExisting?: boolean;
  }) => Promise<SessionPreviewCreateResponse>;
  revokeSessionPreview?: (args: {
    sessionId: SessionId;
    requestedByUserId: string;
    reason?: string;
  }) => Promise<SessionPreviewRevokeResponse>;
  getLocalProjectGitState?: (args: {
    localProjectId: LocalProjectId;
    requestedByUserId: string;
  }) => Promise<LocalProjectGitStateRpcResponse>;
  dispatchLocalProjectControl?: (
    request: LocalProjectControlRequest
  ) => Promise<LocalProjectControlResponse>;
  /**
   * Invoked when the request loop hits a non-retriable auth failure
   * (401/403 from the Loro Streams token endpoint). Consumers should use
   * this to shut down the process instead of letting the loop spin on
   * a revoked credential.
   */
  onFatalAuthFailure?: (error: LoroStreamsTokenAuthError) => void;
};

export class LoroStreamsMachineRpcServer {
  private readonly requestStreamId: string;
  private readonly requestState: LoroJsonStreamState = { nextOffset: '-1' };
  private readonly stopController = new AbortController();
  private readonly requestConcurrency: Semaphore;
  private readonly controlConcurrency = new Semaphore(DEFAULT_MAX_CONCURRENT_CONTROL_REQUESTS);
  private readonly inFlightRequests = new Set<Promise<void>>();
  private readonly acpAuthorizationCodeRecipients = new Map<string, RpcSecretRecipient>();
  private readonly acpCapabilitiesRefreshControllers = new Map<string, AbortController>();
  private requestLoopFailure: {
    message: string;
    count: number;
    firstSeenAt: number;
    lastSeenAt: number;
    lastWarnedAt: number;
  } | null = null;
  private loopPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: RpcServerDeps) {
    this.requestStreamId = getLoroMachineRpcRequestStreamId(deps.workspaceId, deps.machineId);
    this.requestConcurrency = new Semaphore(
      deps.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS
    );
  }

  async start(): Promise<void> {
    if (this.loopPromise) {
      this.deps.logger.debug?.(
        `[rpc-server:${this.deps.machineId}] request listener already running on ${this.requestStreamId}`
      );
      return;
    }

    const retention = this.deps.retentionSeconds ?? LORO_STREAMS_RPC_RETENTION_SECONDS;
    const startedAt = Date.now();
    this.deps.logger.info?.(
      `[rpc-server:${this.deps.machineId}] ensuring request stream ${this.requestStreamId} for workspace ${this.deps.workspaceId} (retentionSeconds=${retention})`
    );
    try {
      await this.deps.streamClient.ensureJsonStream(this.requestStreamId, retention);
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const logError = this.deps.logger.error ?? this.deps.logger.warn;
      logError(
        `[rpc-server:${this.deps.machineId}] failed to ensure request stream ${this.requestStreamId} for workspace ${this.deps.workspaceId} after ${elapsedMs}ms: ${formatRpcStartupError(error)}`
      );
      throw error;
    }

    this.loopPromise = this.runLoop();
    const elapsedMs = Date.now() - startedAt;
    this.deps.logger.info?.(
      `[rpc-server:${this.deps.machineId}] listening on request stream ${this.requestStreamId} for workspace ${this.deps.workspaceId} (ensureElapsedMs=${elapsedMs})`
    );
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.acpAuthorizationCodeRecipients.clear();
    for (const controller of this.acpCapabilitiesRefreshControllers.values()) {
      controller.abort();
    }
    this.acpCapabilitiesRefreshControllers.clear();
    this.stopController.abort();
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.deps.streamClient.readJsonLive(
          this.requestStreamId,
          this.requestState,
          async (batch) => {
            await this.handleRequestBatch(batch);
          },
          { signal: this.stopController.signal }
        );
        this.logRequestLoopRecovered();
      } catch (error) {
        if (this.stopped) {
          return;
        }

        if (error instanceof LoroStreamsTokenAuthError) {
          const logError = this.deps.logger.error ?? this.deps.logger.warn;
          logError(
            `[rpc-server:${this.deps.machineId}] Loro Streams token rejected (status=${error.status}); the CLI token is invalid or has been revoked. Stopping request loop.`
          );
          this.stopped = true;
          this.deps.onFatalAuthFailure?.(error);
          return;
        }

        if (error instanceof LoroStreamsGatewayError) {
          if (error.status === 404) {
            this.deps.logger.warn(
              `[rpc-server:${this.deps.machineId}] request stream returned 404; recreating ${this.requestStreamId}`
            );
            await this.deps.streamClient.ensureJsonStream(
              this.requestStreamId,
              this.deps.retentionSeconds ?? LORO_STREAMS_RPC_RETENTION_SECONDS
            );
            this.requestState.nextOffset = '-1';
            this.requestState.cursor = undefined;
            continue;
          }
          if (error.status === 410) {
            this.requestState.nextOffset = '-1';
            this.requestState.cursor = undefined;
            continue;
          }
        }

        const message = error instanceof Error ? error.message : String(error);
        this.logRequestLoopError(message);
        await delay(REQUEST_LOOP_RETRY_DELAY_MS);
      }
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private logRequestLoopRecovered(): void {
    const failure = this.requestLoopFailure;
    if (!failure) {
      return;
    }
    const now = this.now();
    this.requestLoopFailure = null;
    this.deps.logger.info?.(
      `[rpc-server:${this.deps.machineId}] request loop recovered after ${
        now - failure.firstSeenAt
      }ms (consecutiveFailures=${failure.count} lastError=${failure.message})`
    );
  }

  private logRequestLoopError(message: string): void {
    const now = this.now();
    const previous = this.requestLoopFailure;

    if (!previous || previous.message !== message) {
      this.requestLoopFailure = {
        message,
        count: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        lastWarnedAt: now,
      };
      this.deps.logger.warn(
        `[rpc-server:${this.deps.machineId}] request loop error: ${message} (consecutiveFailures=1 nextRetryMs=${REQUEST_LOOP_RETRY_DELAY_MS})`
      );
      return;
    }

    previous.count += 1;
    previous.lastSeenAt = now;
    if (now - previous.lastWarnedAt < REQUEST_LOOP_REPEAT_WARN_INTERVAL_MS) {
      return;
    }

    previous.lastWarnedAt = now;
    this.deps.logger.warn(
      `[rpc-server:${this.deps.machineId}] request loop error repeated: ${message} (consecutiveFailures=${previous.count} firstSeenMsAgo=${
        now - previous.firstSeenAt
      } nextRetryMs=${REQUEST_LOOP_RETRY_DELAY_MS})`
    );
  }

  private async handleRequestBatch(batch: {
    messages: unknown[];
    nextOffset?: string;
    cursor?: string;
    upToDate: boolean;
  }): Promise<void> {
    this.requestState.nextOffset = batch.nextOffset ?? this.requestState.nextOffset;
    this.requestState.cursor = batch.cursor;

    // Dispatch each request concurrently instead of awaiting them in series. The
    // request stream is shared by every client of this machine and every method,
    // so a single slow handler (e.g. materializing a large turn diff, or a handler
    // that stalls on git/fs) must not head-of-line block independent reads like
    // open-file/refresh. Handlers run as tracked tasks; the semaphore bounds how
    // many execute at once and backpressures this loop (pausing intake of new
    // requests) once saturated rather than spawning unbounded work.
    for (const raw of batch.messages) {
      if (this.stopped) {
        return;
      }
      // Control-plane requests never wait for the shared semaphore at intake:
      // their tasks acquire from the dedicated control pool inside the task, so
      // a burst of slow code-collab handlers cannot delay a chat dispatch or a
      // cancel sitting behind them in the same batch. The peek at `method` is
      // classification only — full schema validation still happens in
      // handleRawRequest.
      if (this.isControlRequest(raw)) {
        const task = this.runRequestTask(raw, this.controlConcurrency, { deferredAcquire: true });
        this.inFlightRequests.add(task);
        void task.finally(() => {
          this.inFlightRequests.delete(task);
        });
        continue;
      }
      await this.requestConcurrency.acquire();
      if (this.stopped) {
        this.requestConcurrency.release();
        return;
      }
      const task = this.runRequestTask(raw, this.requestConcurrency);
      this.inFlightRequests.add(task);
      void task.finally(() => {
        this.inFlightRequests.delete(task);
      });
    }
  }

  private isControlRequest(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null) {
      return false;
    }
    const request = raw as { method?: unknown; params?: unknown };
    if (typeof request.method !== 'string') return false;
    if (CONTROL_METHODS.has(request.method)) return true;
    if (
      request.method !== 'machine/acp-authenticate' ||
      typeof request.params !== 'object' ||
      request.params === null
    ) {
      return false;
    }
    const action = (request.params as { action?: unknown }).action;
    return action === 'cancel' || action === 'submit-code' || action === 'submit-input';
  }

  private async runRequestTask(
    raw: unknown,
    lane: Semaphore,
    options?: { deferredAcquire?: boolean }
  ): Promise<void> {
    if (options?.deferredAcquire) {
      await lane.acquire();
      if (this.stopped) {
        lane.release();
        return;
      }
    }
    try {
      await this.handleRawRequest(raw);
    } catch (error) {
      // handleRawRequest is self-contained — it appends an error response when a
      // handler throws — but the error-append itself can still reject if the
      // response-stream POST keeps failing after retries. Swallow it here so one
      // failed response cannot crash the shared request loop or surface as an
      // unhandled rejection.
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn(
        `[rpc-server:${this.deps.machineId}] failed to process request: ${message}`
      );
    } finally {
      lane.release();
    }
  }

  private async handleRawRequest(raw: unknown): Promise<void> {
    const parsed = LoroStreamsRpcRequestSchema.safeParse(raw);
    if (!parsed.success) {
      this.deps.logger.warn(
        `[rpc-server:${this.deps.machineId}] ignored invalid RPC request: issues=${JSON.stringify(
          parsed.error.issues
        )} raw=${JSON.stringify(redactRpcRequestForLog(raw))}`
      );
      return;
    }

    const request = parsed.data;
    if (
      request.machineId !== this.deps.machineId ||
      request.workspaceId !== this.deps.workspaceId
    ) {
      return;
    }

    const now = this.deps.now?.() ?? Date.now();
    if (request.expiresAt <= now) {
      return;
    }

    if (request.rpcVersion !== (this.deps.rpcVersion ?? LORO_STREAMS_RPC_VERSION)) {
      await this.appendErrorResponse(request.replyTo, request.id, request.method, {
        code: LORO_STREAMS_RPC_ERROR_CODES.rpcVersionMismatch,
        message: `Expected rpcVersion=${this.deps.rpcVersion ?? LORO_STREAMS_RPC_VERSION}, got ${request.rpcVersion}`,
      });
      return;
    }

    let codeCollabOwnerSessionId: string | undefined;
    try {
      switch (request.method) {
        case 'machine/status': {
          const response = await this.deps.getMachineStatus();
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'machine/ping': {
          if (!this.deps.pingMachine) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Machine ping is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.pingMachine({
            requestId: request.params.requestId,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'machine/restart': {
          if (!this.deps.restartMachine) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Machine restart is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.restartMachine({
            requesterUserId: request.params.requesterUserId,
            requestToken: request.params.requestToken,
            requestId: request.params.requestId,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          this.deps.onMachineLifecycleResponseAppended?.({ action: 'restart', response });
          return;
        }
        case 'machine/upgrade': {
          if (!this.deps.upgradeMachine) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Machine upgrade is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.upgradeMachine({
            requesterUserId: request.params.requesterUserId,
            requestToken: request.params.requestToken,
            requestId: request.params.requestId,
            targetVersion: request.params.targetVersion,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          this.deps.onMachineLifecycleResponseAppended?.({ action: 'upgrade', response });
          return;
        }
        case 'machine/acp-capabilities-refresh': {
          const controller = new AbortController();
          this.acpCapabilitiesRefreshControllers.set(request.id, controller);
          try {
            let progressWrites: Promise<void> = Promise.resolve();
            const appendProgress = (progress: MachineAcpBinaryProgressMessage) => {
              if (controller.signal.aborted) return;
              progressWrites = progressWrites
                .then(() =>
                  controller.signal.aborted
                    ? undefined
                    : this.appendResultResponse(
                        request.replyTo,
                        request.id,
                        request.method,
                        progress
                      )
                )
                .catch(() => undefined);
            };
            const response = await this.deps.refreshMachineAcpCapabilities({
              configId: request.params.configId as AgentConfigId,
              cliType: request.params.cliType,
              agentType: request.params.agentType,
              customAcp: request.params.customAcp,
              runtimeOverrides: request.params.runtimeOverrides,
              env: request.params.env,
              onAcpBinaryProgress: appendProgress,
              signal: controller.signal,
            });
            await progressWrites;
            if (!controller.signal.aborted) {
              await this.appendResultResponse(
                request.replyTo,
                request.id,
                request.method,
                response
              );
            }
            return;
          } catch (error) {
            if (controller.signal.aborted) return;
            throw error;
          } finally {
            if (this.acpCapabilitiesRefreshControllers.get(request.id) === controller) {
              this.acpCapabilitiesRefreshControllers.delete(request.id);
            }
          }
        }
        case 'machine/acp-capabilities-refresh-cancel': {
          this.acpCapabilitiesRefreshControllers.get(request.params.requestId)?.abort();
          return;
        }
        case 'machine/acp-authenticate': {
          if (!this.deps.authenticateMachineAcp) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'ACP authentication is not available on this machine.',
            });
            return;
          }
          const isStart = request.params.action === 'start';
          const recipient = isStart ? await createRpcSecretRecipient() : undefined;
          if (recipient) {
            this.acpAuthorizationCodeRecipients.set(request.params.requestId, recipient);
          }
          let progressWrites: Promise<void> = Promise.resolve();
          const appendProgress = (progress: MachineAcpAuthenticationProgressMessage) => {
            const acceptsInteractionInput =
              progress.status === 'auth-methods' ||
              progress.status === 'input-required' ||
              progress.requiresAuthorizationConsent === true;
            const safeProgress =
              recipient && (progress.acceptsAuthorizationCode || acceptsInteractionInput)
                ? {
                    ...progress,
                    ...(progress.acceptsAuthorizationCode
                      ? { authorizationCodePublicKey: recipient.publicKey }
                      : {}),
                    ...(acceptsInteractionInput
                      ? { authenticationInputPublicKey: recipient.publicKey }
                      : {}),
                  }
                : progress;
            progressWrites = progressWrites
              .then(() =>
                this.appendResultResponse(request.replyTo, request.id, request.method, safeProgress)
              )
              .catch(() => undefined);
          };

          let authorizationCode: string | undefined;
          let authenticationInput: string | undefined;
          if (request.params.action === 'submit-code') {
            const authenticationRequestId = request.params.authenticationRequestId;
            const authorizationCodeEnvelope = request.params.authorizationCodeEnvelope;
            if (!authenticationRequestId || !authorizationCodeEnvelope) {
              throw new Error('Missing encrypted authorization-code input.');
            }
            const activeRecipient =
              this.acpAuthorizationCodeRecipients.get(authenticationRequestId);
            if (!activeRecipient) {
              throw new Error('Authorization-code recipient is no longer active.');
            }
            authorizationCode = await activeRecipient.decrypt(
              authorizationCodeEnvelope,
              getMachineAcpAuthorizationCodeSecretContext({
                workspaceId: this.deps.workspaceId,
                machineId: this.deps.machineId,
                authenticationRequestId,
              })
            );
            if (!authorizationCode.trim() || authorizationCode.length > 4096) {
              throw new Error('Invalid decrypted authorization-code input.');
            }
          }
          if (request.params.action === 'submit-input') {
            const authenticationRequestId = request.params.authenticationRequestId;
            const interactionId = request.params.interactionId;
            const authenticationInputEnvelope = request.params.authenticationInputEnvelope;
            if (!authenticationRequestId || !interactionId || !authenticationInputEnvelope) {
              throw new Error('Missing encrypted authentication input.');
            }
            const activeRecipient =
              this.acpAuthorizationCodeRecipients.get(authenticationRequestId);
            if (!activeRecipient) {
              throw new Error('Authentication-input recipient is no longer active.');
            }
            authenticationInput = await activeRecipient.decrypt(
              authenticationInputEnvelope,
              getMachineAcpAuthenticationInputSecretContext({
                workspaceId: this.deps.workspaceId,
                machineId: this.deps.machineId,
                authenticationRequestId,
                interactionId,
              })
            );
            if (!authenticationInput || authenticationInput.length > 65_536) {
              throw new Error('Invalid decrypted authentication input.');
            }
          }

          try {
            const response = await this.deps.authenticateMachineAcp({
              requestId: request.params.requestId,
              action: request.params.action,
              authenticationRequestId: request.params.authenticationRequestId,
              authorizationCode,
              methodId: request.params.methodId,
              interactionId: request.params.interactionId,
              authenticationInput,
              configId: request.params.configId as AgentConfigId | undefined,
              cliType: request.params.cliType,
              agentType: request.params.agentType,
              customAcp: request.params.customAcp,
              runtimeOverrides: request.params.runtimeOverrides,
              env: request.params.env,
              onProgress: appendProgress,
            });
            await progressWrites;
            await this.appendResultResponse(request.replyTo, request.id, request.method, response);
            return;
          } finally {
            if (isStart || request.params.action === 'cancel') {
              this.acpAuthorizationCodeRecipients.delete(request.params.requestId);
            }
          }
        }
        case 'machine/acp-binary-status': {
          if (!this.deps.getMachineAcpBinaryStatus) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'ACP binary status is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.getMachineAcpBinaryStatus({
            agentType: request.params.agentType,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'machine/acp-binary-install': {
          if (!this.deps.installMachineAcpBinary) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'ACP binary install is not available on this machine.',
            });
            return;
          }
          let progressWrites: Promise<void> = Promise.resolve();
          const appendProgress = (progress: MachineAcpBinaryProgressMessage) => {
            progressWrites = progressWrites
              .then(() =>
                this.appendResultResponse(request.replyTo, request.id, request.method, progress)
              )
              .catch(() => undefined);
          };
          const response = await this.deps.installMachineAcpBinary({
            agentType: request.params.agentType,
            onAcpBinaryProgress: appendProgress,
          });
          await progressWrites;
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'machine/bug-report': {
          if (!this.deps.submitBugReport) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Bug report is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.submitBugReport({
            description: request.params.description,
            reporterUserId: request.params.reporterUserId,
            requestToken: request.params.requestToken,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'session/cancel': {
          if (!this.deps.cancelSession) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Session cancel is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.cancelSession({
            sessionId: request.params.sessionId,
            turnId: request.params.turnId,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'session/live-status': {
          if (!this.deps.getSessionLiveStatus) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Session live status is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.getSessionLiveStatus({
            sessionId: request.params.sessionId as SessionId,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'session/steer': {
          if (!this.deps.steerSession) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Session steer is not available on this machine.',
            });
            return;
          }
          const inputConfig = normalizeSessionTurnInputConfig(request.params.inputConfig);
          if (!inputConfig) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.internalError,
              message: 'Steer input config could not be parsed.',
            });
            return;
          }
          const response = await this.deps.steerSession({
            sessionId: request.params.sessionId as SessionId,
            expectedTurnId: request.params.expectedTurnId,
            userTurnId: request.params.userTurnId,
            userId: request.params.userId,
            timestamp: request.params.timestamp,
            inputConfig,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'session/terminate': {
          if (!this.deps.terminateSession) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Session terminate is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.terminateSession({
            sessionId: request.params.sessionId as SessionId,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'session/fork': {
          if (!this.deps.forkSession) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Session fork is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.forkSession({
            sourceSessionId: request.params.sourceSessionId,
            sourceTurnId: request.params.sourceTurnId,
            targetSessionId: request.params.targetSessionId,
            requestedByUserId: request.params.requestedByUserId,
            targetContext: request.params.targetContext,
            targetPlacement: request.params.targetPlacement,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'session/edit-and-resend': {
          if (!this.deps.editAndResendSession) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Session edit and resend is not available on this machine.',
            });
            return;
          }
          const inputConfig = normalizeSessionTurnInputConfig(request.params.inputConfig);
          if (!inputConfig) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.internalError,
              message: 'Edit and resend input config could not be parsed.',
            });
            return;
          }
          const response = await this.deps.editAndResendSession({
            ...request.params,
            inputConfig,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'session/dispatch-turn': {
          if (!this.deps.dispatchSessionTurn) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Session turn dispatch is not available on this machine.',
            });
            return;
          }
          const inputConfig = normalizeSessionTurnInputConfig(request.params.inputConfig);
          if (!inputConfig) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.internalError,
              message: 'Dispatch turn input config could not be parsed.',
            });
            return;
          }
          const response = await this.deps.dispatchSessionTurn({
            sessionId: request.params.sessionId,
            userTurnId: request.params.userTurnId,
            userId: request.params.userId,
            timestamp: request.params.timestamp,
            inputConfig,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'session/prepare': {
          if (!this.deps.prepareSession) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Session preparation is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.prepareSession(request.params);
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'session/prepare-cancel': {
          if (!this.deps.cancelSessionPreparation) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Session preparation cancellation is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.cancelSessionPreparation(request.params);
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'code-collab/open-text': {
          const decoded = await this.decryptCodeCollabV2RequestParams(request.params);
          codeCollabOwnerSessionId = decoded.ownerSessionId;
          const params = CodeCollabV2OpenTextRequestSchema.parse(decoded.payload);
          await this.verifyCodeCollabV2OwnerSession(decoded.ownerSessionId, params.sessionId);
          if (!this.deps.openCodeCollabText) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Code Collab open-text is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.openCodeCollabText({
            sessionId: params.sessionId as SessionId,
            path: params.path,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response, {
            codeCollabOwnerSessionId: decoded.ownerSessionId,
          });
          return;
        }
        case 'code-collab/refresh-text': {
          const decoded = await this.decryptCodeCollabV2RequestParams(request.params);
          codeCollabOwnerSessionId = decoded.ownerSessionId;
          const params = CodeCollabV2RefreshTextRequestSchema.parse(decoded.payload);
          await this.verifyCodeCollabV2OwnerSession(decoded.ownerSessionId, params.sessionId);
          if (!this.deps.refreshCodeCollabText) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Code Collab refresh-text is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.refreshCodeCollabText({
            sessionId: params.sessionId as SessionId,
            path: params.path,
            digest: params.digest,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response, {
            codeCollabOwnerSessionId: decoded.ownerSessionId,
          });
          return;
        }
        case 'code-collab/save-text': {
          const decoded = await this.decryptCodeCollabV2RequestParams(request.params);
          codeCollabOwnerSessionId = decoded.ownerSessionId;
          const params = CodeCollabV2SaveTextRequestSchema.parse(decoded.payload);
          await this.verifyCodeCollabV2OwnerSession(decoded.ownerSessionId, params.sessionId);
          if (!this.deps.saveCodeCollabText) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Code Collab save-text is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.saveCodeCollabText({
            sessionId: params.sessionId as SessionId,
            requestedByUserId: params.requestedByUserId,
            path: params.path,
            baseDigest: params.baseDigest,
            text: params.text,
            ...(params.format === undefined ? {} : { format: params.format }),
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response, {
            codeCollabOwnerSessionId: decoded.ownerSessionId,
          });
          return;
        }
        case 'code-collab/open-current-diff': {
          const decoded = await this.decryptCodeCollabV2RequestParams(request.params);
          codeCollabOwnerSessionId = decoded.ownerSessionId;
          const params = CodeCollabV2OpenCurrentDiffRequestSchema.parse(decoded.payload);
          await this.verifyCodeCollabV2OwnerSession(decoded.ownerSessionId, params.sessionId);
          if (!this.deps.openCodeCollabCurrentDiff) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Code Collab open-current-diff is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.openCodeCollabCurrentDiff({
            sessionId: params.sessionId as SessionId,
            path: params.path,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response, {
            codeCollabOwnerSessionId: decoded.ownerSessionId,
          });
          return;
        }
        case 'code-collab/open-all-changes-diff': {
          const decoded = await this.decryptCodeCollabV2RequestParams(request.params);
          codeCollabOwnerSessionId = decoded.ownerSessionId;
          const params = CodeCollabV2OpenAllChangesDiffRequestSchema.parse(decoded.payload);
          await this.verifyCodeCollabV2OwnerSession(decoded.ownerSessionId, params.sessionId);
          if (!this.deps.openCodeCollabAllChangesDiff) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Code Collab open-all-changes-diff is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.openCodeCollabAllChangesDiff({
            sessionId: params.sessionId as SessionId,
            ...(params.focusPath === undefined ? {} : { focusPath: params.focusPath }),
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response, {
            codeCollabOwnerSessionId: decoded.ownerSessionId,
          });
          return;
        }
        case 'code-collab/open-turn-diff': {
          const decoded = await this.decryptCodeCollabV2RequestParams(request.params);
          codeCollabOwnerSessionId = decoded.ownerSessionId;
          const params = CodeCollabV2OpenTurnDiffRequestSchema.parse(decoded.payload);
          await this.verifyCodeCollabV2OwnerSession(decoded.ownerSessionId, params.sessionId);
          if (!this.deps.openCodeCollabTurnDiff) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Code Collab open-turn-diff is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.openCodeCollabTurnDiff({
            sessionId: params.sessionId as SessionId,
            turnId: params.turnId,
            path: params.path,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response, {
            codeCollabOwnerSessionId: decoded.ownerSessionId,
          });
          return;
        }
        case 'code-collab/init-directory': {
          const decoded = await this.decryptCodeCollabV2RequestParams(request.params);
          codeCollabOwnerSessionId = decoded.ownerSessionId;
          const params = CodeCollabV2InitDirectoryRequestSchema.parse(decoded.payload);
          await this.verifyCodeCollabV2OwnerSession(decoded.ownerSessionId, params.sessionId);
          if (!this.deps.initCodeCollabDirectory) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Code Collab init-directory is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.initCodeCollabDirectory({
            sessionId: params.sessionId as SessionId,
            path: params.path,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response, {
            codeCollabOwnerSessionId: decoded.ownerSessionId,
          });
          return;
        }
        case 'code-collab/lsp-definition': {
          const decoded = await this.decryptCodeCollabV2RequestParams(request.params);
          codeCollabOwnerSessionId = decoded.ownerSessionId;
          const params = CodeCollabV2LspRpcParamsSchema.parse(decoded.payload);
          await this.verifyCodeCollabV2OwnerSession(decoded.ownerSessionId, params.sessionId);
          if (!this.deps.getCodeCollabLspDefinition) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Code Collab LSP definition is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.getCodeCollabLspDefinition({
            sessionId: params.sessionId as SessionId,
            path: params.path,
            ...(params.line === undefined ? {} : { line: params.line }),
            ...(params.character === undefined ? {} : { character: params.character }),
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response, {
            codeCollabOwnerSessionId: decoded.ownerSessionId,
          });
          return;
        }
        case 'code-collab/lsp-references': {
          const decoded = await this.decryptCodeCollabV2RequestParams(request.params);
          codeCollabOwnerSessionId = decoded.ownerSessionId;
          const params = CodeCollabV2LspRpcParamsSchema.parse(decoded.payload);
          await this.verifyCodeCollabV2OwnerSession(decoded.ownerSessionId, params.sessionId);
          if (!this.deps.getCodeCollabLspReferences) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Code Collab LSP references is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.getCodeCollabLspReferences({
            sessionId: params.sessionId as SessionId,
            path: params.path,
            ...(params.line === undefined ? {} : { line: params.line }),
            ...(params.character === undefined ? {} : { character: params.character }),
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response, {
            codeCollabOwnerSessionId: decoded.ownerSessionId,
          });
          return;
        }
        case 'file/preview': {
          const decoded = await this.decryptCodeCollabV2RequestParams(request.params);
          codeCollabOwnerSessionId = decoded.ownerSessionId;
          const params = FilePreviewV3RequestSchema.parse(decoded.payload);
          // Same owner binding as Code Collab reads: the envelope's owner must be
          // the session's real owner, so a client cannot read another session's
          // workspace by swapping the session id.
          await this.verifyCodeCollabV2OwnerSession(decoded.ownerSessionId, params.sessionId);
          const response: FilePreviewV3Response = this.deps.previewFile
            ? await this.deps.previewFile(params)
            : filePreviewV3Error('transient_io', {
                message: 'File preview is not available on this machine.',
                path: params.path,
              });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response, {
            codeCollabOwnerSessionId: decoded.ownerSessionId,
          });
          return;
        }
        case 'session/preview-create': {
          if (!this.deps.createSessionPreview) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Session preview creation is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.createSessionPreview({
            sessionId: request.params.sessionId as SessionId,
            requestedByUserId: request.params.requestedByUserId,
            target: request.params.target,
            approval: request.params.approval,
            replaceExisting: request.params.replaceExisting,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'session/preview-revoke': {
          if (!this.deps.revokeSessionPreview) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Session preview revocation is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.revokeSessionPreview({
            sessionId: request.params.sessionId as SessionId,
            requestedByUserId: request.params.requestedByUserId,
            reason: request.params.reason,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'local-project/git-state': {
          if (!this.deps.getLocalProjectGitState) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Local project Git state is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.getLocalProjectGitState({
            localProjectId: request.params.localProjectId as LocalProjectId,
            requestedByUserId: request.params.requestedByUserId,
          });
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
        case 'local-project/control': {
          if (!this.deps.dispatchLocalProjectControl) {
            await this.appendErrorResponse(request.replyTo, request.id, request.method, {
              code: LORO_STREAMS_RPC_ERROR_CODES.methodUnavailable,
              message: 'Local project control is not available on this machine.',
            });
            return;
          }
          const response = await this.deps.dispatchLocalProjectControl(
            request.params.request as LocalProjectControlRequest
          );
          await this.appendResultResponse(request.replyTo, request.id, request.method, response);
          return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const codeCollabError = request.method.startsWith('code-collab/')
        ? toCodeCollabRpcError(error)
        : request.method === 'file/preview'
          ? toFilePreviewRpcError(error, message)
          : null;
      await this.appendErrorResponse(
        request.replyTo,
        request.id,
        request.method,
        {
          code: codeCollabError?.code ?? LORO_STREAMS_RPC_ERROR_CODES.internalError,
          message: codeCollabError?.message ?? message,
          ...(codeCollabError?.data === undefined ? {} : { data: codeCollabError.data }),
        },
        {
          codeCollabOwnerSessionId,
        }
      );
    }
  }

  private async decryptCodeCollabV2RequestParams(
    value: unknown
  ): Promise<{ ownerSessionId: string; payload: unknown }> {
    const envelope = CodeCollabV2RpcContentEnvelopeSchema.parse(value);
    return {
      ownerSessionId: envelope.ownerSessionId,
      payload: await decryptCodeCollabV2RpcPayload(envelope),
    };
  }

  private async verifyCodeCollabV2OwnerSession(
    envelopeOwnerSessionId: string,
    businessSessionId: string
  ): Promise<void> {
    const resolveOwnerSessionId = this.deps.resolveCodeCollabOwnerSessionId;
    if (!resolveOwnerSessionId) {
      return;
    }
    const expectedOwnerSessionId = await resolveOwnerSessionId(businessSessionId as SessionId);
    if (expectedOwnerSessionId !== envelopeOwnerSessionId) {
      throw codeCollabOwnerMismatchError();
    }
  }

  private async appendResultResponse(
    replyTo: string,
    requestId: string,
    method: LoroStreamsRpcMethod,
    result:
      | MachineStatusResponse
      | MachinePingResponse
      | MachineAcpCapabilitiesRefreshResponse
      | MachineAcpAuthenticateResponse
      | MachineAcpAuthenticationProgressMessage
      | MachineRestartResponse
      | MachineUpgradeResponse
      | MachineAcpBinaryStatusResponse
      | MachineAcpBinaryInstallResponse
      | MachineAcpBinaryProgressMessage
      | MachineBugReportResponse
      | SessionCancelResponse
      | LoroSessionLiveStatusRpcResponse
      | SessionSteerResponse
      | SessionTerminateResponse
      | SessionForkResponse
      | SessionEditAndResendResponse
      | SessionDispatchTurnResponse
      | SessionPrepareResponse
      | SessionPrepareCancelResponse
      | CodeCollabV2Error
      | CodeCollabV2OpenTextOk
      | CodeCollabV2RefreshTextResponse
      | CodeCollabV2SaveTextResponse
      | CodeCollabV2OpenCurrentDiffResponse
      | CodeCollabV2OpenAllChangesDiffResponse
      | CodeCollabV2OpenTurnDiffResponse
      | CodeCollabV2InitDirectoryOk
      | CodeCollabV2LspUnsupported
      | FilePreviewV3Response
      | SessionPreviewCreateResponse
      | SessionPreviewRevokeResponse
      | LocalProjectGitStateRpcResponse
      | LocalProjectControlResponse,
    options: { readonly codeCollabOwnerSessionId?: string } = {}
  ): Promise<void> {
    const wireResult =
      options.codeCollabOwnerSessionId === undefined
        ? result
        : await encryptCodeCollabV2RpcPayload(options.codeCollabOwnerSessionId, result);
    await this.appendResponse(replyTo, {
      jsonrpc: JSON_RPC_VERSION,
      id: requestId,
      method,
      rpcVersion: this.deps.rpcVersion ?? LORO_STREAMS_RPC_VERSION,
      machineId: this.deps.machineId,
      result: wireResult,
    });
  }
  private async appendErrorResponse(
    replyTo: string,
    requestId: string,
    method: LoroStreamsRpcMethod,
    error: {
      code: string;
      message: string;
      data?: unknown;
    },
    options: { readonly codeCollabOwnerSessionId?: string } = {}
  ): Promise<void> {
    const wireError =
      options.codeCollabOwnerSessionId === undefined || error.data === undefined
        ? error
        : {
            ...error,
            data: await encryptCodeCollabV2RpcPayload(options.codeCollabOwnerSessionId, error.data),
          };
    await this.appendResponse(replyTo, {
      jsonrpc: JSON_RPC_VERSION,
      id: requestId,
      method,
      rpcVersion: this.deps.rpcVersion ?? LORO_STREAMS_RPC_VERSION,
      machineId: this.deps.machineId,
      error: wireError,
    });
  }

  private async appendResponse(replyTo: string, payload: unknown): Promise<void> {
    // The host POSTs the RPC response to the per-client response stream over
    // HTTP. That request can fail transiently — a raw network error
    // ("fetch failed", e.g. a connection reset or a stalled event loop) or a
    // gateway 5xx — which previously surfaced to the web client as
    // `internal_error: Failed to append to stream …: fetch failed` and showed
    // up as a directory that "sometimes" fails to open. Retry those with a
    // short backoff; a 404 still means the stream needs creating first, and
    // non-404 4xx (e.g. payload rejected) is not retryable.
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.deps.streamClient.appendJson(replyTo, payload);
        return;
      } catch (error) {
        if (error instanceof LoroStreamsGatewayError && error.status === 404) {
          await this.deps.streamClient.ensureJsonStream(
            replyTo,
            this.deps.retentionSeconds ?? LORO_STREAMS_RPC_RETENTION_SECONDS
          );
          await this.deps.streamClient.appendJson(replyTo, payload);
          return;
        }
        const retryable = !(error instanceof LoroStreamsGatewayError) || error.status >= 500;
        if (!retryable || attempt >= maxAttempts) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 200));
      }
    }
  }
}

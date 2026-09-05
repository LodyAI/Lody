import { EventEmitter } from 'eventemitter3';
import os from 'os';
import path from 'path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  SessionId,
  ACPSessionId,
  type AcpSessionNotification,
  type AgentConfigCliType,
  type MessageContent,
  SessionStatusFactory,
  MachineId,
  CliType,
  getManagedBuiltinRuntimeByAgentType,
  getManagedBuiltinRuntimeByRuntimeName,
  isManagedBuiltinAgentType,
  RepoId,
  SessionContextWindowUsage,
  WorkspaceId,
  type SessionPreparationSpec,
  type SessionPreparationCancelSpec,
  type SessionPrepareCancelResponse,
  type SessionPrepareResponse,
  type AgentConfigId,
  type AgentConfigMeta,
  type LocalProjectId,
  type ProjectRef,
  buildSessionPreparationClaimKey,
  buildSessionPreparationRequestKey,
  buildSessionLaunchConfig,
  getMachineFlockDocId,
  getSessionRoomId,
  normalizeSessionPreparationRunConfigForDedup,
  isLoroRepoDocDeleted,
  type SessionLaunchConfig,
  type SessionMeta,
  type McpServerId,
} from '@lody/shared';
import { Logger } from '@/utils/logger';
import { SessionConfig, SessionOutputEvent, SessionErrorEvent, SessionExitEvent } from './types';
import { LoroDocumentManager } from '../lib/loro/doc';
import {
  AgentClient,
  type AcpWriteTextFileEvidence,
  type AcpStartupStageEvent,
  type AcpSessionStartTarget,
  type AgentClientOptions,
  type AgentSessionWarning,
  type ImageGenerationBeginEvent,
  type ImageGenerationEndEvent,
} from '@/agent/agent-client';
import { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { TerminalManager } from './terminal-manager';
import { resolveACPProcessLaunchAsync } from '@/agent/setting';
import {
  classifyManagedRuntimeFailureReason,
  formatManagedRuntimeFailureMessage,
  getManagedAgentRuntimeManager,
  ManagedRuntimeError,
  type ManagedRuntimeName,
  type ManagedRuntimeProgressEvent,
} from '@/agent/managed-agent-runtime';
import { buildGitHubCloneUrl, deriveRepoIdFromGitHubRepo, redactUrlAuth } from '@/utils/github';
import {
  GitCredentialBroker,
  LODY_GIT_CRED_BROKER_STATE_FILE_ENV,
  LODY_GIT_CRED_CONTEXT_TOKEN_ENV,
} from '@/lib/git-credential-broker';
import type { CloudGithubTokenManager, CloudPort } from '@lody/platform';
import { isDevEnv } from '@/utils/runtime-env';
import {
  buildCredentialHelperValueForHost,
  ensureCredentialHelperScript,
} from '@/lib/git-credential-helper-script';
import {
  getGhTokenFingerprint,
  hasManagedGhToken,
  LODY_MANAGED_GH_TOKEN_SHA256_ENV,
  resolveGhTokenForSession,
} from '@/lib/gh-token-injector';
import { ensureGhShimScript, prependGhShimBinDirToPath } from '@/lib/gh-shim-script';
import { ensureLodyBashEnvForGhShim, shouldInjectBashEnvForGhShim } from '@/lib/lody-bashenv';
import { ensureLodyZdotdirForGhShim, shouldInjectZdotdirForGhShim } from '@/lib/lody-zdotdir';
import type { RateLimit, SessionUsageUpdate } from 'acp-extension-core';
import { getWorktreeManager } from './worktree/worktree-manager';
import type {
  GitCredentialBrokerAuth,
  WorktreeInfo,
  WorktreeManager,
  WorktreeManagerConfig,
  WorktreeManagerSource,
} from './worktree/worktree-manager';
import { readLocalProjectWorktreeSetup } from './worktree/worktree-setup-config-store';
import { resolveTerminalWorkdirFromMetadata } from '@/lib/terminal-workdir-resolver';
import { createWorktreeScriptHistoryRecorder } from './worktree/worktree-script-history';
import { runWorktreeSetup } from './worktree/worktree-setup-runner';
import { deriveRepoIdFromLocalProjectPath } from '@lody/shared/node/worktree-paths';
import {
  normalizeLocalProjectRootPath,
  parseLocalProjectBranchRefAtRootPath,
  resolveLocalProjectLegacyBaseBranchAtRootPath,
} from '@lody/shared/node/local-project';
import { ensureDefaultSessionWorkdir, getDefaultSessionWorkdir, Session } from './session';
import {
  calculateAutomaticSessionSandboxLimits,
  createSessionSandboxFactory,
  type SessionSandbox,
  type SessionSandboxFactory,
  type SessionSandboxLimits,
  type SessionResourceAccounting,
} from './session-sandbox';
import { formatErrorMessage } from '@/utils/format-error';
import { captureCli } from '@/lib/analytics/posthog';
import { getEffectiveMemoryLimitBytes } from '@/utils/memory';
import { withSlowOperationWarning } from '@/utils/slow-operation-warning';
import { resolveGitHubRepoWorktreeConfig } from './worktree/worktree-config-resolver';
import type { AcpCapabilitiesResult } from '@/agent/acp-capability-normalization';
import { resolveWorkspaceLocalProjectRootPathWithRetry } from '@/lib/local-project-meta';
import { readTimeoutEnv } from '@/lib/loro/timeout-utils';
import { loadSessionMcpCatalog } from '@/agent/session-mcp-resolver';
import { SessionUserResolver } from './session-user-resolver';
import {
  SessionPreparationService,
  type SessionPreparationResource,
} from './session-preparation-service';
import {
  readMachineSessionLaunchSnapshotFromFlock,
  type SessionLaunchConfigResolution,
} from './session-launch-config-resolver';
import { applyAcpSessionRunConfig } from './acp-session-config-applier';
import {
  claimSpeculativeWorktreeForDurableSession,
  completeSpeculativeWorktreeSetup,
  materializeSpeculativeWorktree,
  recoverStaleSpeculativeWorktrees,
  type PreparedWorktree,
  type SpeculativeWorktreeTarget,
} from './worktree/speculative-worktree';

function formatManagedRuntimeProgressDetail(event: ManagedRuntimeProgressEvent): string {
  const runtimeLabel =
    getManagedBuiltinRuntimeByRuntimeName(event.runtimeName)?.displayName ?? event.runtimeName;
  switch (event.phase) {
    case 'downloading':
      return event.percent !== undefined
        ? `Downloading ${runtimeLabel} runtime ${event.percent}%`
        : `Downloading ${runtimeLabel} runtime`;
    case 'verifying':
      return `Verifying ${runtimeLabel} runtime`;
    case 'extracting':
      return `Extracting ${runtimeLabel} runtime`;
    case 'publishing':
      return `Installing ${runtimeLabel} runtime`;
    case 'complete':
      return `${runtimeLabel} runtime ready`;
  }
  return `Preparing ${runtimeLabel} runtime`;
}

function resolveManagedRuntimeNameForBuiltin(agentType: string): ManagedRuntimeName | undefined {
  return getManagedBuiltinRuntimeByAgentType(agentType)?.runtimeName;
}

function truncateAnalyticsString(value: string, maxLength = 1_000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

// Some call paths provide only githubRepoUrl; derive owner/repo so we still
// bootstrap the broker + git env injection (avoids prompt-disabled failures).
const tryDeriveGitHubRepoFromUrl = (rawUrl?: string): string | null => {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') {
      return null;
    }
    if (url.protocol !== 'https:') {
      return null;
    }
    const cleanedPath = url.pathname
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '');
    const parts = cleanedPath.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1];
    if (!owner || !repo) return null;
    return `${owner}/${repo}`;
  } catch {
    return null;
  }
};

const SESSION_PREPARATION_HARD_TTL_MS = 120_000;
const MAX_CONCURRENT_SESSION_PREPARATIONS = 1;

function getSessionPreparationSandboxId(sessionId: SessionId, preparationId: string): SessionId {
  const preparationHash = createHash('sha256').update(preparationId).digest('hex').slice(0, 16);
  return `${sessionId}-prepare-${preparationHash}` as SessionId;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

type PreparedSessionRuntime = SessionPreparationResource & {
  session: Session;
  config: SessionConfig;
  compatibility: ReturnType<typeof buildSessionPreparationCompatibility>;
  readCurrentLaunchConfig?: (sessionMeta: SessionMeta) => SessionLaunchConfigResolution | null;
  workspaceReady: Promise<PreparedWorktree | null>;
  agentResult: Promise<string>;
  adopt(): Promise<void>;
};

type SessionWorktreeTarget = {
  manager: WorktreeManager;
  managerConfig: Omit<WorktreeManagerConfig, 'logger'>;
  target: SpeculativeWorktreeTarget;
};

type ResolvedAcpProcessLaunch = Awaited<ReturnType<typeof resolveACPProcessLaunchAsync>>;

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

/**
 * The two halves come from different objects on the re-check paths — the launch
 * config from the prepared process, the selection from the session that wants to
 * claim it — so they stay separate parameters instead of one spliced record.
 */
function buildSessionPreparationCompatibility(
  launchSource: Partial<SessionLaunchConfig> | null | undefined,
  mcpServerIds: readonly McpServerId[] | undefined,
  configOptionValues: SessionConfig['configOptionValues'],
  taskToolsEnabled: boolean
) {
  return {
    launch: buildSessionLaunchConfig({
      customAcp: launchSource?.customAcp,
      runtimeOverrides: launchSource?.runtimeOverrides,
      env: launchSource?.env,
    }),
    runConfig: normalizeSessionPreparationRunConfigForDedup({
      mcpServerIds: mcpServerIds ? [...mcpServerIds] : undefined,
      configOptionValues,
      taskToolsEnabled,
    }),
  };
}

function agentConfigMatchesPreparation(
  agentConfig: {
    machineId: MachineId;
    cliType: AgentConfigCliType;
    agentType: string;
  },
  spec: SessionPreparationSpec,
  machineId: MachineId
): boolean {
  return (
    agentConfig.machineId === machineId &&
    agentConfig.cliType === spec.cliType &&
    agentConfig.agentType === spec.agentType
  );
}

export type PreparedSessionLaunchConfigSnapshot = {
  config: SessionLaunchConfig | undefined;
};

export interface ISession {
  agentClient: AgentClient | null;
  acpSessionId: ACPSessionId | null;
  sessionId: SessionId;
  terminalManager: TerminalManager;
  createAgent(config: CreateAgentConfig): Promise<string>;
  getAcpCapabilities?(): AcpCapabilitiesResult | null;
  getAcpCapabilitySourceVersion?(): string | null;
  getWorkdir(): string;
  /**
   * Host-side working directory for file operations.
   *
   * Returns null if the session has no host path mapping.
   */
  getHostWorkdir(): string | null;
  getParentSessionId(): SessionId | undefined;
  applyExecutionPlaneLimits(limits: SessionSandboxLimits): Promise<void>;
  getMonitorRuntimeInfo(): Promise<SessionMonitorRuntimeInfo>;
  exec(command: string, args: string[], workdir: string, isAI: boolean): Promise<string>;
  terminate(force?: boolean): Promise<void>;
  /**
   * Update git identity for commits made in this session.
   * This should be called when a new user sends a chat request to an existing session.
   */
  updateGitIdentity(userName: string, userEmail: string, userId?: string): void;
  /**
   * Return the already-resolved effective git identity only when it belongs to
   * the requested user. Forks use this as an optimistic local fast path.
   */
  getGitIdentityForUser?(userId: string): {
    id: string;
    name: string;
    email: string;
  } | null;
  /**
   * Update environment variables for this session.
   * Takes effect on all subsequent exec() calls (each exec spawns a new process).
   */
  updateEnv(env: Record<string, string | undefined>): void;
  /**
   * Whether we injected a managed GitHub token as GH_TOKEN at session startup.
   * When false, the user has their own auth and we should not overwrite it.
   */
  ghTokenInjected: boolean;
}

export type SessionMonitorRuntimeInfo = {
  sessionId: SessionId;
  parentSessionId: SessionId | null;
  agentCliType: AgentConfigCliType;
  agentType: string;
  startedAtMs: number;
  runtimeStatus: 'created' | 'failed' | 'running' | 'stopping' | 'terminated';
  accounting: SessionResourceAccounting;
};

export interface CreateAgentConfig {
  cliType: AgentConfigCliType;
  agentType: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  capabilitySourceVersion?: string;
  /**
   * Optional ACP session id to attempt to resume. This is a per-agent-start hint and is intentionally
   * not stored on the session instance because sessions can be reused, and persisting
   * it would make retries/fallbacks accidentally re-use stale resume ids.
   */
  resumeSessionId?: ACPSessionId;
  /** Source ACP session id for a native `session/fork` startup. Never replayed. */
  forkSessionId?: ACPSessionId;
  /** Provider-native turn id used as the source boundary for a turn-addressed fork. */
  forkSessionTurnId?: string;
  /**
   * Optional claim gate used by speculative preparation. ACP initialize may
   * finish before the durable session workspace exists; newSession waits here
   * for the final cwd without blocking the RPC handler.
   */
  resolveSessionStart?: () => Promise<AcpSessionStartTarget>;
  abortSignal?: AbortSignal;
  onStartupStage?: (event: AcpStartupStageEvent) => void;
  onUpdateMessage: (message: AcpSessionNotification) => void;
  onRequestPermission: (
    requestId: string,
    request: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>;
  onUsageUpdate: (usage: SessionUsageUpdate) => void;
  onContextWindowUsageUpdate: (usage: SessionContextWindowUsage) => void;
  onRateLimitUpdate: (limits: RateLimit) => void;
  onThreadGoalUpdated: (goal: Extract<MessageContent, { type: 'goal' }>) => void;
  onThreadGoalCleared: (threadId: string) => void;
  onSessionTitleUpdate: (title: string) => void;
  onAgentWarning: (warning: AgentSessionWarning) => void;
  loadExternalMcpServers: NonNullable<AgentClientOptions['loadExternalMcpServers']>;
  onImageGenerationBegin: (event: ImageGenerationBeginEvent) => void;
  onImageGenerationEnd: (event: ImageGenerationEndEvent) => void;
  onWriteTextFile: (event: AcpWriteTextFileEvidence) => void | Promise<void>;
}

export type AgentStartConfig = {
  /**
   * ACP session id to resume when starting the agent, if the ACP agent supports it.
   * Kept separate from SessionConfig because it only applies to a single ACP startup attempt.
   */
  resumeSessionId?: ACPSessionId;
  /** Source ACP session id for a native `session/fork` startup. */
  forkSessionId?: ACPSessionId;
  /** Provider-native turn id used as the source boundary for a turn-addressed fork. */
  forkSessionTurnId?: string;
  /** Let a higher-level saga publish the ACP id with the complete target meta. */
  deferAcpSessionIdPersistence?: boolean;
};

export type SessionTerminatedEvent = {
  sessionId: SessionId;
  exitCode?: number;
  [key: string]: unknown;
};

interface SessionManagerEvents {
  create: (sessionId: SessionId, exec: ISession) => void;
  output: (output: SessionOutputEvent) => void;
  error: (error: SessionErrorEvent) => void;
  exit: (exit: SessionExitEvent) => void;
  terminated: (exit: SessionTerminatedEvent) => void;
  onACPUpdateMessage: (sessionId: SessionId, message: AcpSessionNotification) => void;
  onUsageUpdate: (event: {
    sessionId: SessionId;
    acpSessionId: ACPSessionId;
    usage: SessionUsageUpdate;
  }) => void;
  onContextWindowUsageUpdate: (sessionId: SessionId, usage: SessionContextWindowUsage) => void;
  onRateLimitUpdate: (machineId: MachineId, cliType: CliType, limits: RateLimit) => void;
  onThreadGoalUpdated: (
    sessionId: SessionId,
    goal: Extract<MessageContent, { type: 'goal' }>
  ) => void;
  onThreadGoalCleared: (sessionId: SessionId, threadId: string) => void;
  onSessionTitleUpdate: (sessionId: SessionId, title: string) => void;
  onAgentWarning: (sessionId: SessionId, warning: AgentSessionWarning) => void;
  onImageGenerationBegin: (sessionId: SessionId, event: ImageGenerationBeginEvent) => void;
  onImageGenerationEnd: (sessionId: SessionId, event: ImageGenerationEndEvent) => void;
  onWriteTextFile: (sessionId: SessionId, event: AcpWriteTextFileEvidence) => void;
  ping: () => void;
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  protected logger: Logger;
  protected machineId: MachineId;
  protected workspaceId: WorkspaceId;
  protected token: string;
  private githubTokenManager: CloudGithubTokenManager | null = null;
  private gitCredentialBroker: GitCredentialBroker | null = null;
  private readonly sessions = new Map<SessionId, Session>();
  private readonly pendingSessionCreates = new Map<SessionId, Promise<ISession>>();
  private readonly pendingTerminationPromises = new Map<SessionId, Promise<void>>();
  private readonly preparationSessions = new Map<SessionId, Session>();
  private readonly sessionSandboxFactory: SessionSandboxFactory;
  private readonly preparationUserResolver: SessionUserResolver;
  private readonly preparationService: SessionPreparationService<PreparedSessionRuntime>;
  private readonly cloudPort: CloudPort;
  private detachPreparationRecovery: (() => void) | null = null;
  private preparationRecoveryChain: Promise<void> = Promise.resolve();
  /** Coalescing latch for {@link enqueueSpeculativeWorktreeRecovery}. */
  private preparationRecoveryQueued = false;
  private preparationRecoveryGeneration = 0;
  // Rebalance requests are serialized because the per-session limit is derived from a
  // shared machine-wide budget. This avoids create/exit races briefly applying stale
  // shares of the 90% execution-plane budget. See docs/exec-sandbox.md.
  private sandboxRebalanceChain: Promise<void> = Promise.resolve();
  private requestPermissionHandler?: (
    sessionId: SessionId,
    requestId: string,
    request: RequestPermissionRequest,
    agentClient: AgentClient
  ) => Promise<RequestPermissionResponse>;

  constructor(
    logger: Logger,
    token: string,
    machineId: MachineId,
    workspaceId: WorkspaceId,
    protected workspaceDocument: LoroDocumentManager,
    options: {
      sessionSandboxFactory?: SessionSandboxFactory;
      cloudPort: CloudPort;
    }
  ) {
    super();
    this.logger = logger;
    this.token = token;
    this.machineId = machineId;
    this.workspaceId = workspaceId;
    if (!options.cloudPort) {
      throw new Error('SessionManager requires an assembled CloudPort');
    }
    this.cloudPort = options.cloudPort;
    this.sessionSandboxFactory =
      options.sessionSandboxFactory ?? createSessionSandboxFactory({ logger: this.logger });
    this.preparationUserResolver = new SessionUserResolver(
      this.logger,
      this.workspaceId,
      async (userId) =>
        await this.cloudPort.access.resolveWorkspaceUser({
          workspaceId: this.workspaceId,
          userId,
        })
    );
    this.preparationService = new SessionPreparationService(this.logger, {
      hardTtlMs: SESSION_PREPARATION_HARD_TTL_MS,
      maxConcurrent: MAX_CONCURRENT_SESSION_PREPARATIONS,
    });
  }

  /**
   * If a session is currently being created (worktree + ACP startup), callers should wait
   * for that in-flight promise instead of assuming the session is ready.
   *
   * This avoids race conditions where the server sends chat requests while a session is still
   * initializing.
   */
  getPendingSession(sessionId: SessionId): Promise<ISession> | null {
    return this.pendingSessionCreates.get(sessionId) ?? null;
  }

  requestSessionPreparation(spec: SessionPreparationSpec): SessionPrepareResponse {
    const { sessionId } = spec;
    if (this.sessions.has(sessionId) || this.pendingSessionCreates.has(sessionId)) {
      return {
        type: 'session/prepare_response',
        preparationId: spec.preparationId,
        sessionId,
        accepted: true,
        disposition: 'duplicate',
      };
    }
    const disposition = this.preparationService.start({
      preparationId: spec.preparationId,
      sessionId,
      requesterUserId: spec.requestedByUserId,
      requestKey: buildSessionPreparationRequestKey(spec),
      claimKey: buildSessionPreparationClaimKey(spec),
      create: async (signal) => await this.createPreparedSessionRuntime(spec, signal),
    });
    return {
      type: 'session/prepare_response',
      preparationId: spec.preparationId,
      sessionId,
      accepted: disposition !== 'busy',
      disposition,
    };
  }

  cancelSessionPreparation(args: SessionPreparationCancelSpec): SessionPrepareCancelResponse {
    const { sessionId } = args;
    const disposition = this.preparationService.cancel({
      preparationId: args.preparationId,
      sessionId,
      requesterUserId: args.requestedByUserId,
    });
    return {
      type: 'session/prepare-cancel_response',
      preparationId: args.preparationId,
      sessionId,
      cancelled: disposition === 'cancelled',
      disposition,
    };
  }

  getPreparedSessionLaunchConfig(input: {
    sessionMeta: SessionMeta;
    requesterUserId: string;
  }): PreparedSessionLaunchConfigSnapshot | null {
    const { sessionMeta } = input;
    if (
      sessionMeta.machineId !== this.machineId ||
      !sessionMeta.agentConfigId ||
      !sessionMeta.cliType ||
      !sessionMeta.agentType
    ) {
      return null;
    }
    const resource = this.preparationService.peek({
      sessionId: sessionMeta.id,
      requesterUserId: input.requesterUserId,
      claimKey: buildSessionPreparationClaimKey({
        requestedByUserId: input.requesterUserId,
        agentConfigId: sessionMeta.agentConfigId,
        cliType: sessionMeta.cliType,
        agentType: sessionMeta.agentType,
        project: sessionMeta.project,
      }),
    });
    if (!resource?.readCurrentLaunchConfig) {
      return null;
    }
    const current = resource.readCurrentLaunchConfig(sessionMeta);
    if (
      !current ||
      !isDeepStrictEqual(
        resource.compatibility,
        buildSessionPreparationCompatibility(
          current.config,
          resource.config.mcpServerIds,
          resource.config.configOptionValues,
          resource.config.taskToolsEnabled
        )
      )
    ) {
      return null;
    }
    return { config: current.config };
  }

  async createSession(config: SessionConfig, agentStart?: AgentStartConfig): Promise<ISession> {
    if (!config.assumeDocExisting) {
      const sessionId = await this.workspaceDocument.createSession(
        config.machineId,
        config.agentCliType,
        config.agentType,
        config.title
      );
      config.sessionId = sessionId;
    }

    const sessionId = config.sessionId;
    if (!sessionId) {
      throw new Error('SessionId is required to create a session');
    }

    const existing = this.pendingSessionCreates.get(sessionId);
    if (existing) {
      return await existing;
    }

    // Register durable ownership before claim/cold-start work begins. Besides
    // deduplicating concurrent creates, this prevents an abandoned preparation
    // from deleting a default workdir that the authoritative create is taking over.
    const promise = Promise.resolve()
      .then(async () => await this.createSessionFromPreparationOrCold(config, agentStart))
      .finally(() => {
        if (this.pendingSessionCreates.get(sessionId) === promise) {
          this.pendingSessionCreates.delete(sessionId);
        }
      });
    this.pendingSessionCreates.set(sessionId, promise);
    return await promise;
  }

  private async createSessionFromPreparationOrCold(
    config: SessionConfig,
    agentStart?: AgentStartConfig
  ): Promise<ISession> {
    const sessionId = config.sessionId!;
    const preparationIdentity = config.agentConfigId
      ? {
          requestedByUserId: config.requesterUserId,
          agentConfigId: config.agentConfigId,
          cliType: config.agentCliType,
          agentType: config.agentType,
          project: config.project,
        }
      : null;
    if (!preparationIdentity || agentStart?.resumeSessionId || agentStart?.forkSessionId) {
      await this.preparationService.discard(sessionId);
      return await this.createSessionInnerWithAgent(config, agentStart);
    }

    const compatibility = buildSessionPreparationCompatibility(
      config,
      config.mcpServerIds,
      config.configOptionValues,
      config.taskToolsEnabled
    );
    const claim = this.preparationService.claim({
      sessionId,
      requesterUserId: config.requesterUserId,
      claimKey: buildSessionPreparationClaimKey(preparationIdentity),
      isCompatible: (resource) => {
        if (!isDeepStrictEqual(resource.compatibility, compatibility)) {
          return false;
        }
        if (!resource.readCurrentLaunchConfig) {
          return true;
        }
        const current = resource.readCurrentLaunchConfig({
          id: sessionId,
          machineId: this.machineId,
          agentConfigId: config.agentConfigId,
          cliType: config.agentCliType,
          agentType: config.agentType,
        } as SessionMeta);
        return (
          current !== null &&
          isDeepStrictEqual(
            resource.compatibility,
            buildSessionPreparationCompatibility(
              current.config,
              config.mcpServerIds,
              config.configOptionValues,
              config.taskToolsEnabled
            )
          )
        );
      },
    });
    if (claim.status === 'miss') {
      await claim.cleanup;
      return await this.createSessionInnerWithAgent(config, agentStart);
    }
    return await this.finishPreparedSession(config, claim.resource, agentStart);
  }

  /**
   * Terminate a session whether it is already resident or still starting.
   * Returns only after a resident or still-starting session has stopped.
   */
  async requestSessionTerminate(
    sessionId: SessionId,
    force: boolean = true
  ): Promise<'terminated' | 'not-found'> {
    const existingTermination = this.pendingTerminationPromises.get(sessionId);
    if (existingTermination) {
      await existingTermination;
      return 'terminated';
    }
    if (this.sessions.has(sessionId)) {
      await this.terminateSession(sessionId, force);
      return 'terminated';
    }
    const pendingCreate = this.pendingSessionCreates.get(sessionId);
    if (pendingCreate) {
      const termination = pendingCreate.then(
        async (session) => await session.terminate(force),
        () => undefined
      );
      this.pendingTerminationPromises.set(sessionId, termination);
      const clearTermination = () => {
        if (this.pendingTerminationPromises.get(sessionId) === termination) {
          this.pendingTerminationPromises.delete(sessionId);
        }
      };
      void termination.then(clearTermination, clearTermination);
      await termination;
      return 'terminated';
    }
    const pendingPreparationCleanup = this.preparationService.discard(sessionId);
    if (pendingPreparationCleanup) {
      await pendingPreparationCleanup;
      return 'terminated';
    }
    return 'not-found';
  }

  async initialize(): Promise<void> {
    const recoveryGeneration = ++this.preparationRecoveryGeneration;
    this.detachPreparationRecovery?.();
    this.detachPreparationRecovery = this.workspaceDocument.onMetaRoomSynced((reason) => {
      if (this.preparationRecoveryGeneration === recoveryGeneration) {
        this.enqueueSpeculativeWorktreeRecovery(`meta-room-synced:${reason}`);
      }
    });
    void this.workspaceDocument
      .waitUntilMetaSynced({ reason: 'session-preparation-recovery' })
      .then((synced) => {
        if (synced && this.preparationRecoveryGeneration === recoveryGeneration) {
          this.enqueueSpeculativeWorktreeRecovery('initialize');
        }
      })
      .catch((error: unknown) => {
        this.logger.debug(
          `Failed to wait for metadata sync before speculative worktree recovery: ${formatErrorMessage(
            error
          )}`
        );
      });
    this.logger.debug('Session manager initialized');
  }

  private enqueueSpeculativeWorktreeRecovery(reason: string): void {
    // Bound a burst to one running + one queued pass. This is an O(sessions)
    // filesystem sweep on a recovery signal, and without a latch every
    // transport edge appended another full pass to the chain — the dispatch
    // bootstrap scan has had this latch all along, this one was missing it.
    if (this.preparationRecoveryQueued) {
      return;
    }
    this.preparationRecoveryQueued = true;
    this.preparationRecoveryChain = this.preparationRecoveryChain
      .then(async () => {
        // Released before the sweep runs, so a signal arriving DURING it still
        // gets its own follow-up pass and nothing is silently skipped.
        this.preparationRecoveryQueued = false;
        await recoverStaleSpeculativeWorktrees({
          workspaceId: this.workspaceId,
          machineId: this.machineId,
          logger: this.logger,
          isActiveSession: (sessionId) =>
            this.preparationService.getState(sessionId) !== null ||
            this.pendingSessionCreates.has(sessionId) ||
            this.sessions.has(sessionId),
          isDurableSession: async (sessionId) => {
            const record = await this.workspaceDocument.repo.getDocMeta(
              getSessionRoomId(sessionId)
            );
            return !!record?.meta && !isLoroRepoDocDeleted(record);
          },
        });
      })
      .catch((error: unknown) => {
        this.preparationRecoveryQueued = false;
        this.logger.debug(
          `Failed speculative worktree recovery (${reason}): ${formatErrorMessage(error)}`
        );
      });
  }

  private async createPreparedSessionRuntime(
    spec: SessionPreparationSpec,
    signal: AbortSignal
  ): Promise<PreparedSessionRuntime> {
    signal.throwIfAborted();
    const { sessionId } = spec;
    const preparationSessionMeta = {
      id: sessionId,
      machineId: this.machineId,
      agentConfigId: spec.agentConfigId as AgentConfigId,
      cliType: spec.cliType,
      agentType: spec.agentType,
    } as SessionMeta;
    let readCurrentLaunchConfig: PreparedSessionRuntime['readCurrentLaunchConfig'];
    let agentConfig: AgentConfigMeta | null = null;
    try {
      const handle = await this.workspaceDocument.repo.openFlockDoc(
        getMachineFlockDocId(this.workspaceId, this.machineId)
      );
      const preparedSnapshot = readMachineSessionLaunchSnapshotFromFlock({
        flock: handle.flock,
        sessionId,
        sessionMeta: preparationSessionMeta,
      });
      agentConfig = preparedSnapshot.agentConfig;
      if (agentConfig) {
        readCurrentLaunchConfig = (sessionMeta) => {
          try {
            const current = readMachineSessionLaunchSnapshotFromFlock({
              flock: handle.flock,
              sessionId,
              sessionMeta,
            });
            if (
              !current.agentConfig ||
              !agentConfigMatchesPreparation(current.agentConfig, spec, this.machineId)
            ) {
              return null;
            }
            return current.resolution;
          } catch {
            return null;
          }
        };
      }
    } catch (error) {
      this.logger.debug(
        `[${sessionId}] Failed to open machine launch config for preparation: ${formatErrorMessage(
          error
        )}`
      );
    }
    agentConfig ??= await this.workspaceDocument.getAgentConfigById(
      spec.agentConfigId as AgentConfigId,
      this.machineId
    );
    if (!agentConfig) {
      throw new Error(`Agent config not found: ${spec.agentConfigId}`);
    }
    if (!agentConfigMatchesPreparation(agentConfig, spec, this.machineId)) {
      throw new Error(`Agent config no longer matches preparation ${spec.preparationId}`);
    }
    const user = await this.preparationUserResolver.resolve(spec.requestedByUserId);
    signal.throwIfAborted();

    let provisionalWorkdir = os.homedir();
    let establishBeforeClaim = false;
    if (!spec.project) {
      provisionalWorkdir = getDefaultSessionWorkdir(sessionId);
      establishBeforeClaim = true;
    } else if (spec.project.kind === 'local') {
      const localRoot = await resolveWorkspaceLocalProjectRootPathWithRetry(
        this.workspaceDocument.repo,
        this.workspaceId,
        this.machineId,
        spec.project.localProjectId as LocalProjectId,
        {
          requestSync: () =>
            this.workspaceDocument.syncMachineFlockDoc(this.machineId, {
              reason: 'session-preparation-local-project-resolve',
              timeoutMs: readTimeoutEnv('LODY_LOCAL_PROJECT_RESOLVE_SYNC_TIMEOUT_MS', 1_500),
            }),
          signal,
        }
      );
      if (!localRoot) {
        throw new Error(`Local project not found: ${spec.project.localProjectId}`);
      }
      provisionalWorkdir = localRoot;
      establishBeforeClaim = spec.project.useWorktree !== true;
    }

    const config: SessionConfig = {
      sessionId,
      workspaceId: this.workspaceId,
      requesterUserId: spec.requestedByUserId,
      machineId: this.machineId,
      agentConfigId: spec.agentConfigId as AgentConfigId,
      agentCliType: spec.cliType,
      agentType: spec.agentType,
      configOptionValues: spec.runConfig?.configOptionValues,
      mcpServerIds: spec.runConfig?.mcpServerIds ?? [],
      taskToolsEnabled: spec.runConfig?.taskToolsEnabled === true,
      customAcp: agentConfig.customAcp,
      runtimeOverrides: agentConfig.runtimeOverrides,
      project: spec.project as ProjectRef | undefined,
      assumeDocExisting: true,
      env: { ...agentConfig.env },
      githubRepo:
        spec.project?.kind === 'github'
          ? spec.project.repoFullName
          : spec.project?.githubRepoFullName,
      branch: spec.project?.branch,
      workdir: spec.project?.kind === 'local' ? provisionalWorkdir : undefined,
      userName: user.name,
      userEmail: user.email,
    };
    const compatibility = buildSessionPreparationCompatibility(
      config,
      config.mcpServerIds,
      config.configOptionValues,
      config.taskToolsEnabled
    );
    const ghTokenInjected = await this.prepareGitHubRepoSessionConfig(config);
    signal.throwIfAborted();
    const launch = await resolveACPProcessLaunchAsync({
      cliType: config.agentCliType,
      agentType: config.agentType,
      customAcp: config.customAcp,
      runtimeOverrides: config.runtimeOverrides,
      env: config.env,
    });
    signal.throwIfAborted();
    const worktreeTarget = this.resolveSessionWorktreeTarget(config);

    let sandbox: SessionSandbox | null = await this.sessionSandboxFactory(
      getSessionPreparationSandboxId(sessionId, spec.preparationId)
    );
    let session: Session | null = null;
    let createdDefaultWorkdir = false;
    let adopted = false;
    let adoptionPromise: Promise<void> | null = null;
    let started = false;
    let cleanupPromise: Promise<void> | null = null;
    const initialized = createDeferred<void>();
    const sessionStart = createDeferred<AcpSessionStartTarget>();
    const workspaceReady = createDeferred<PreparedWorktree | null>();
    const agentResult = createDeferred<string>();
    const sessionReady = createDeferred<void>();
    const rejectAgentPreparation = (error: unknown): void => {
      agentResult.reject(error);
      initialized.reject(error);
      sessionReady.reject(error);
    };
    void agentResult.promise.catch(() => undefined);
    void workspaceReady.promise.catch(() => undefined);

    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        const abortError = new Error('Session preparation disposed before claim');
        abortError.name = 'AbortError';
        sessionStart.reject(abortError);
        if (!started) {
          workspaceReady.resolve(null);
          agentResult.reject(abortError);
          initialized.reject(abortError);
          sessionReady.reject(abortError);
        }
        try {
          if (session) {
            await session.terminate(true);
          } else if (sandbox) {
            await sandbox.terminate(true).catch((error: unknown) => {
              this.logger.debug(
                `[${sessionId}] Failed to terminate unclaimed preparation sandbox: ${formatErrorMessage(
                  error
                )}`
              );
            });
            await sandbox.cleanup().catch((error: unknown) => {
              this.logger.debug(
                `[${sessionId}] Failed to clean up unclaimed preparation sandbox: ${formatErrorMessage(
                  error
                )}`
              );
            });
          }
        } finally {
          await agentResult.promise.catch(() => undefined);
          const preparedWorktree = await workspaceReady.promise.catch(() => null);
          if (session && this.preparationSessions.get(sessionId) === session) {
            this.preparationSessions.delete(sessionId);
            await this.rebalanceSessionSandboxes();
          }
          const durableCreateOwnsWorkdir =
            this.pendingSessionCreates.has(sessionId) || this.sessions.has(sessionId);
          if (preparedWorktree && !adopted) {
            await preparedWorktree.dispose();
          }
          if (createdDefaultWorkdir && !adopted && !durableCreateOwnsWorkdir) {
            await rm(provisionalWorkdir, { recursive: true, force: true }).catch(
              (error: unknown) => {
                this.logger.debug(
                  `[${sessionId}] Failed to remove abandoned preparation workdir: ${formatErrorMessage(
                    error
                  )}`
                );
              }
            );
          }
        }
      })();
      return cleanupPromise;
    };

    try {
      signal.throwIfAborted();
      if (!spec.project && !existsSync(provisionalWorkdir)) {
        ensureDefaultSessionWorkdir(sessionId);
        createdDefaultWorkdir = true;
      }
      session = new Session(config, this.logger, provisionalWorkdir, sandbox);
      sandbox = null;
      session.ghTokenInjected = ghTokenInjected;
      this.preparationSessions.set(sessionId, session);
      await this.rebalanceSessionSandboxes();
      signal.throwIfAborted();

      if (establishBeforeClaim) {
        sessionStart.resolve({ workdir: provisionalWorkdir });
      }

      const ownedSession = session;
      const runtime: PreparedSessionRuntime = {
        session: ownedSession,
        config,
        compatibility,
        ...(readCurrentLaunchConfig ? { readCurrentLaunchConfig } : {}),
        start: () => {
          if (started) return;
          started = true;
          const materialization = worktreeTarget
            ? materializeSpeculativeWorktree({
                preparationId: spec.preparationId,
                sessionId,
                workspaceId: this.workspaceId,
                machineId: this.machineId,
                manager: worktreeTarget.manager,
                managerConfig: worktreeTarget.managerConfig,
                baseBranch: config.branch,
                restoreBranchName: config.restoreBranchName,
                resolveBrokerAuth: () =>
                  this.resolveHostGitBrokerAuth(worktreeTarget.target.source),
                logger: this.logger,
              })
            : Promise.resolve(null);
          void materialization.then(
            (preparedWorktree) => {
              workspaceReady.resolve(preparedWorktree);
              if (preparedWorktree) {
                ownedSession.setWorkdir(preparedWorktree.info.hostPath);
                sessionStart.resolve({ workdir: preparedWorktree.info.hostPath });
              }
            },
            (error) => {
              workspaceReady.reject(error);
              sessionStart.reject(error);
            }
          );

          const startedAgent = ownedSession.createAgent(
            this.buildCreateAgentConfig(ownedSession, config, launch, {
              abortSignal: signal,
              resolveSessionStart: async () => await sessionStart.promise,
              dispatchEvent: (event) => {
                if (adopted) event();
              },
              allowInteractiveRequest: () => adopted,
              onStartupStage: (event) => {
                if (event.type === 'initialize_end') {
                  initialized.resolve(undefined);
                }
              },
            })
          );
          void startedAgent.then(async (acpSessionId) => {
            try {
              if (spec.runConfig) {
                await applyAcpSessionRunConfig({
                  session: ownedSession,
                  config: {
                    cliType: spec.cliType,
                    agentType: spec.agentType,
                    ...spec.runConfig,
                  },
                  logger: this.logger,
                });
              }
              agentResult.resolve(acpSessionId);
              sessionReady.resolve(undefined);
            } catch (error) {
              rejectAgentPreparation(error);
            }
          }, rejectAgentPreparation);
        },
        initialized: initialized.promise,
        sessionReady: sessionReady.promise,
        workspaceReady: workspaceReady.promise,
        agentResult: agentResult.promise,
        adopt: async () => {
          adoptionPromise ??= (async () => {
            const preparedWorktree = await workspaceReady.promise;
            await preparedWorktree?.claim();
            adopted = true;
          })();
          await adoptionPromise;
        },
        dispose: cleanup,
      };
      if (signal.aborted) {
        await runtime.dispose();
        signal.throwIfAborted();
      }
      return runtime;
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  private async finishPreparedSession(
    incomingConfig: SessionConfig,
    prepared: PreparedSessionRuntime,
    agentStart?: AgentStartConfig
  ): Promise<ISession> {
    const sessionId = incomingConfig.sessionId!;
    await prepared.adopt();
    const preparedWorktree = await prepared.workspaceReady;
    const config = prepared.config;
    const preparedEnv = config.env;
    Object.assign(config, incomingConfig, {
      env: { ...preparedEnv, ...incomingConfig.env },
    });
    await this.workspaceDocument.getOrCreateSessionDoc(sessionId);

    // The durable config is authoritative for the worktree target. The prepared
    // worktree was materialized from the preparation-time guess, and its
    // directory can also have been removed underneath us (a superseded
    // preparation's late dispose, a cross-process sweep). Adopting the prepared
    // ACP process anyway would hand it a cwd whose inode no longer exists —
    // recreating the path does not revive the process's working directory — so
    // an unusable worktree discards the whole preparation and takes the cold
    // path, which rebuilds the worktree before spawning a fresh process.
    if (preparedWorktree) {
      const worktreeTarget = this.resolveSessionWorktreeTarget(config);
      const claimOutcome = worktreeTarget
        ? await claimSpeculativeWorktreeForDurableSession({
            sessionId: config.sessionId!,
            workspaceId: config.workspaceId,
            machineId: this.machineId,
            target: worktreeTarget.target,
            logger: this.logger,
          })
        : null;
      const worktreeUsable =
        worktreeTarget !== null &&
        claimOutcome !== 'mismatch' &&
        existsSync(preparedWorktree.info.hostPath);
      if (!worktreeUsable) {
        this.logger.warn(
          `[${sessionId}] Discarding prepared session: prepared worktree is unusable for the durable target (claim=${claimOutcome ?? 'no-worktree-target'} path=${preparedWorktree.info.hostPath})`
        );
        await prepared.dispose();
        return await this.createSessionInnerWithAgent(config, agentStart);
      }
    }

    try {
      const session = await withSlowOperationWarning(
        this.createSessionInner(config, prepared.session, preparedWorktree?.info),
        this.logger,
        'session.createSessionInner.prepared',
        sessionId
      );
      session.ghTokenInjected = prepared.session.ghTokenInjected;
      session.updateGitIdentity(config.userName, config.userEmail, config.requesterUserId);
      const acpSessionId = await prepared.agentResult;
      const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
      await sessionDoc.setACPSessionId(acpSessionId as ACPSessionId);
      return session;
    } catch (error) {
      await prepared.dispose();
      throw error;
    }
  }

  private buildCreateAgentConfig(
    session: Session,
    config: SessionConfig,
    launch: ResolvedAcpProcessLaunch,
    options?: {
      resumeSessionId?: ACPSessionId;
      forkSessionId?: ACPSessionId;
      forkSessionTurnId?: string;
      abortSignal?: AbortSignal;
      resolveSessionStart?: () => Promise<AcpSessionStartTarget>;
      dispatchEvent?: (event: () => void) => void;
      allowInteractiveRequest?: () => boolean;
      onStartupStage?: (event: AcpStartupStageEvent) => void;
    }
  ): CreateAgentConfig {
    const sessionId = config.sessionId!;
    const dispatchEvent = options?.dispatchEvent ?? ((event: () => void) => event());
    return {
      cliType: config.agentCliType,
      agentType: config.agentType,
      command: launch.command,
      args: launch.args,
      env: launch.env,
      capabilitySourceVersion: launch.capabilitySourceVersion,
      resumeSessionId: options?.resumeSessionId,
      forkSessionId: options?.forkSessionId,
      forkSessionTurnId: options?.forkSessionTurnId,
      abortSignal: options?.abortSignal,
      resolveSessionStart: options?.resolveSessionStart,
      onStartupStage: options?.onStartupStage,
      onUpdateMessage: (update) => {
        dispatchEvent(() => this.emit('onACPUpdateMessage', sessionId, update));
      },
      onRequestPermission: (requestId, request) => {
        if (options?.allowInteractiveRequest && !options.allowInteractiveRequest()) {
          return Promise.resolve({ outcome: { outcome: 'cancelled' } });
        }
        if (!this.requestPermissionHandler) {
          this.logger.debug(`[${sessionId}] Permission handler not configured`);
          return Promise.resolve({ outcome: { outcome: 'cancelled' } });
        }
        return this.requestPermissionHandler(sessionId, requestId, request, session.agentClient!);
      },
      onUsageUpdate: (usage: SessionUsageUpdate) => {
        dispatchEvent(() => {
          const currentAcpSessionId = session.acpSessionId;
          if (!currentAcpSessionId) {
            this.logger.debug(
              `[${sessionId}] Dropping usage update: ACP session ID not available yet`
            );
            return;
          }
          this.emit('onUsageUpdate', { sessionId, acpSessionId: currentAcpSessionId, usage });
        });
      },
      onContextWindowUsageUpdate: (usage: SessionContextWindowUsage) => {
        dispatchEvent(() => this.emit('onContextWindowUsageUpdate', sessionId, usage));
      },
      onRateLimitUpdate: (limits: RateLimit) => {
        dispatchEvent(() => {
          if (config.agentCliType === 'builtin' && isManagedBuiltinAgentType(config.agentType)) {
            this.emit('onRateLimitUpdate', this.machineId, config.agentType, limits);
          }
        });
      },
      onThreadGoalUpdated: (goal) =>
        dispatchEvent(() => this.emit('onThreadGoalUpdated', sessionId, goal)),
      onThreadGoalCleared: (threadId) =>
        dispatchEvent(() => this.emit('onThreadGoalCleared', sessionId, threadId)),
      onSessionTitleUpdate: (title) =>
        dispatchEvent(() => this.emit('onSessionTitleUpdate', sessionId, title)),
      onAgentWarning: (warning) =>
        dispatchEvent(() => this.emit('onAgentWarning', sessionId, warning)),
      loadExternalMcpServers: () =>
        loadSessionMcpCatalog({
          repo: this.workspaceDocument.repo,
          syncFlockDoc: (docId, { timeoutMs }) =>
            this.workspaceDocument.syncFlockDocOrThrow(docId, {
              timeoutMs,
              reason: 'session-mcp-catalog-start',
            }),
          workspaceId: this.workspaceId,
          sessionId,
          selectedIds: config.mcpServerIds,
          logger: this.logger,
        }),
      onImageGenerationBegin: (event) =>
        dispatchEvent(() => this.emit('onImageGenerationBegin', sessionId, event)),
      onImageGenerationEnd: (event) =>
        dispatchEvent(() => this.emit('onImageGenerationEnd', sessionId, event)),
      onWriteTextFile: (event) => {
        dispatchEvent(() => this.emit('onWriteTextFile', sessionId, event));
      },
    };
  }

  private async createSessionInnerWithAgent(
    config: SessionConfig,
    agentStart?: AgentStartConfig
  ): Promise<ISession> {
    const ghTokenInjected = await this.prepareGitHubRepoSessionConfig(config);
    const requestedResumeSessionId = agentStart?.resumeSessionId;
    const requestedForkSessionId = agentStart?.forkSessionId;
    const requestedForkSessionTurnId = agentStart?.forkSessionTurnId;
    if (requestedResumeSessionId && requestedForkSessionId) {
      throw new Error('ACP resume and fork startup hints are mutually exclusive');
    }
    this.logger.debug(
      `[${config.sessionId}] Creating session (cliType=${config.agentCliType} agentType=${config.agentType} assumeDocExisting=${
        config.assumeDocExisting ? 'yes' : 'no'
      } resumeWorkdir=${config.resume ? 'yes' : 'no'} acpResumeSessionId=${
        requestedResumeSessionId ?? 'none'
      } acpForkSessionId=${requestedForkSessionId ?? 'none'} repoId=${
        config.repoId ?? 'none'
      } repoUrl=${config.githubRepoUrl ? redactUrlAuth(config.githubRepoUrl) : 'none'})`
    );
    await this.workspaceDocument.getOrCreateSessionDoc(config.sessionId!);
    this.logger.debug(`[${config.sessionId}] Session will enter create inner`);
    const session = await withSlowOperationWarning(
      this.createSessionInner(config),
      this.logger,
      'session.createSessionInner',
      config.sessionId!
    );
    session.ghTokenInjected = ghTokenInjected;
    const sessionId = config.sessionId!;
    this.logger.debug(`[${sessionId}] Session workdir resolved: ${session.getWorkdir()}`);
    session.updateGitIdentity(config.userName, config.userEmail, config.requesterUserId);
    let acpSessionId: string | undefined;

    const launchResolutionStartedAt = performance.now();
    let managedRuntimeReadyLogged = false;
    const launch = await resolveACPProcessLaunchAsync({
      cliType: config.agentCliType,
      agentType: config.agentType,
      customAcp: config.customAcp,
      runtimeOverrides: config.runtimeOverrides,
      env: config.env,
      onManagedRuntimeProgress: (event) => {
        config.onPresencePhase?.('managed-runtime', formatManagedRuntimeProgressDetail(event));
        if (event.phase === 'complete' && !managedRuntimeReadyLogged) {
          managedRuntimeReadyLogged = true;
          this.logger.debug(
            `[${sessionId}] Managed runtime ready in ${Math.round(performance.now() - launchResolutionStartedAt)}ms (runtime=${event.runtimeName})`
          );
        }
      },
    }).catch((error: unknown) => {
      if (error instanceof ManagedRuntimeError) {
        const runtimeName = resolveManagedRuntimeNameForBuiltin(config.agentType);
        const runtimeDiagnostics = runtimeName
          ? getManagedAgentRuntimeManager().getDiagnostics(runtimeName)
          : undefined;
        captureCli(
          'managed_runtime/install_failed',
          {
            workspace_id: config.workspaceId,
            session_id: sessionId,
            machine_id: config.machineId,
            agent_type: config.agentType,
            ...(runtimeName ? { runtime_name: runtimeName } : {}),
            ...(runtimeDiagnostics
              ? {
                  runtime_version: runtimeDiagnostics.version,
                  platform_arch: runtimeDiagnostics.platformArch,
                  runtime_base_host: runtimeDiagnostics.runtimeBaseHost,
                  proxy_env_present: runtimeDiagnostics.proxyEnvPresent,
                  proxy_configured_for_runtime_url: runtimeDiagnostics.proxyConfiguredForRuntimeUrl,
                }
              : {}),
            source: 'session_start',
            reason: classifyManagedRuntimeFailureReason(error),
            error_message: truncateAnalyticsString(formatManagedRuntimeFailureMessage(error)),
          },
          { tier: 'A' }
        );
      }
      throw error;
    });
    const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
    const publishAcpStep = (step: 'spawn' | 'initialize' | 'new-session') => {
      const detail =
        step === 'spawn'
          ? 'Starting agent process'
          : step === 'initialize'
            ? 'Negotiating ACP capabilities'
            : 'Creating ACP session';
      config.onPresencePhase?.('acp', detail);
    };

    publishAcpStep('spawn');
    this.logger.debug(`[${sessionId}] About to call session.createAgent`);
    try {
      acpSessionId = await withSlowOperationWarning(
        session.createAgent(
          this.buildCreateAgentConfig(session, config, launch, {
            resumeSessionId: requestedResumeSessionId,
            forkSessionId: requestedForkSessionId,
            forkSessionTurnId: requestedForkSessionTurnId,
            onStartupStage: (event) => {
              if (event.type === 'initialize_start') {
                publishAcpStep('initialize');
              } else if (event.type === 'new_session_start') {
                publishAcpStep('new-session');
              }
            },
          })
        ),
        this.logger,
        `session.createAgent(resume=${requestedResumeSessionId ? 'yes' : 'no'})`,
        sessionId
      );
      this.logger.debug(`[${sessionId}] createAgent returned successfully`);
    } catch (error) {
      this.logger.error(
        `[${config.sessionId}] Failed to create agent: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      try {
        await session.terminate(true);
      } catch (terminateError) {
        this.logger.debug(
          `[${sessionId}] Failed to terminate session after createAgent failure: ${formatErrorMessage(
            terminateError
          )}`
        );
      }
      throw error;
    }

    if (requestedResumeSessionId) {
      if (acpSessionId === requestedResumeSessionId) {
        this.logger.debug(`[${sessionId}] ACP resume confirmed (acpSessionId=${acpSessionId})`);
      } else {
        this.logger.debug(
          `[${sessionId}] ACP resume not honored (requested=${requestedResumeSessionId} actual=${
            acpSessionId ?? 'unknown'
          })`
        );
      }
    }

    this.logger.debug(`[${sessionId}] About to persist ACP session ID to doc`);
    if (!agentStart?.deferAcpSessionIdPersistence) {
      await sessionDoc.setACPSessionId(acpSessionId as ACPSessionId);
    }
    this.logger.debug(`[${sessionId}] ACP session ID persisted to doc`);
    this.logger.debug(
      `[${sessionId}] ACP session established (acpSessionId=${acpSessionId ?? 'unknown'})`
    );
    this.logger.debug(`[${sessionId}] createSessionInnerWithAgent returning session`);
    return session;
  }

  private async prepareGitHubRepoSessionConfig(config: SessionConfig): Promise<boolean> {
    const githubRepo = config.githubRepo ?? tryDeriveGitHubRepoFromUrl(config.githubRepoUrl);
    if (!config.githubRepo && githubRepo) {
      config.githubRepo = githubRepo;
    }
    if (!githubRepo) {
      return false;
    }

    const repoId = deriveRepoIdFromGitHubRepo(githubRepo);
    const githubRepoUrl = buildGitHubCloneUrl(githubRepo);
    if (config.project?.kind === 'github' || !config.project) {
      config.repoId = repoId;
      config.githubRepoUrl = githubRepoUrl;
    }
    const tokenManager = this.getGitHubTokenManager();
    tokenManager?.retainRepoOwner(githubRepo);
    if (tokenManager) {
      // Prefetch token BEFORE git operations to avoid race conditions.
      // Previously this was fire-and-forget (void), which caused the first git clone
      // to fail because the token wasn't ready when credential helper was invoked.
      try {
        await tokenManager.getAppTokenForRepo(githubRepo);
        this.logger.debug(
          `[${config.sessionId}] [github-token] Prefetch succeeded for ${githubRepo}`
        );
      } catch (error) {
        // Log but don't fail - git operations will retry with fresh token if needed
        this.logger.debug(
          `[${config.sessionId}] [github-token] Prefetch failed for ${githubRepo}: ${formatErrorMessage(
            error
          )}`
        );
      }
    }

    const brokerEnv = await this.ensureGitCredentialBrokerEnv();
    if (!brokerEnv) {
      return false;
    }
    const sessionId = config.sessionId;
    if (!sessionId) {
      throw new Error('SessionId is required to prepare GitHub session credentials');
    }
    const contextToken = this.gitCredentialBroker?.activateSessionContext({
      sessionId,
      requesterUserId: config.requesterUserId,
      machineId: this.machineId,
    });

    ensureCredentialHelperScript(repoId);

    const isDev = isDevEnv();
    const debugEnv: Record<string, string> = {};
    const env = config.env;
    if (isDev && env?.LODY_GIT_CRED_HELPER_DEBUG && !env?.LODY_GIT_CRED_HELPER_DEBUG_FILE) {
      debugEnv.LODY_GIT_CRED_HELPER_DEBUG_FILE = path.join(
        os.tmpdir(),
        'lody-git-credential-helper-debug.log'
      );
    }

    const sessionEnv: Record<string, string> = {
      ...env,
      ...debugEnv,
    };
    if (contextToken) {
      sessionEnv[LODY_GIT_CRED_CONTEXT_TOKEN_ENV] = contextToken;
    }

    this.ensureGhShimSessionEnv(sessionEnv);

    // Inject GH_TOKEN if the user isn't already authenticated with gh CLI
    const ghToken = await resolveGhTokenForSession({
      env: sessionEnv,
      githubRepo,
      tokenManager,
      requesterUserId: config.requesterUserId,
      machineId: this.machineId,
      logger: this.logger,
    });
    if (ghToken) {
      sessionEnv.GH_TOKEN = ghToken;
      sessionEnv[LODY_MANAGED_GH_TOKEN_SHA256_ENV] = getGhTokenFingerprint(ghToken);
    }

    const credentialHelperValue = buildCredentialHelperValueForHost(repoId);
    const brokerUrl = brokerEnv.url;

    const brokerStateFilePath = this.gitCredentialBroker?.getStateFilePath();

    config.env = {
      ...sessionEnv,
      LODY_GIT_CRED_BROKER_URL: brokerUrl,
      LODY_GIT_CRED_BROKER_TOKEN: brokerEnv.token,
      // Keeps the helper's connection-refused fallback inside this workspace instead
      // of landing on the shared, last-writer-wins broker.json.
      ...(brokerStateFilePath
        ? { [LODY_GIT_CRED_BROKER_STATE_FILE_ENV]: brokerStateFilePath }
        : {}),
      LODY_GITHUB_REPO_FULL_NAME: githubRepo,
      GIT_TERMINAL_PROMPT: '0',
      // Use credential helper for all git invocations inside the ACP process tree.
      // The helper talks to the local broker to fetch fresh managed tokens on-demand.
      GIT_CONFIG_COUNT: '3',
      // Clear any existing helpers so only the CLI helper is used.
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: credentialHelperValue,
      GIT_CONFIG_KEY_2: 'credential.useHttpPath',
      GIT_CONFIG_VALUE_2: 'true',
    };
    return !!ghToken || hasManagedGhToken(sessionEnv);
  }

  /**
   * Refresh GH_TOKEN for a session using the managed write-operation token.
   * This ensures gh CLI commands use a fresh token before each turn.
   */
  async refreshGhTokenForSession(
    session: ISession,
    githubRepo: string,
    requesterUserId: string
  ): Promise<void> {
    const contextToken = this.gitCredentialBroker?.activateSessionContext({
      sessionId: session.sessionId,
      requesterUserId,
      machineId: this.machineId,
    });
    if (contextToken) {
      session.updateEnv({ [LODY_GIT_CRED_CONTEXT_TOKEN_ENV]: contextToken });
    }
    // Only refresh if we originally injected the token at session startup.
    // If the user has their own auth (GH_TOKEN, GITHUB_TOKEN, or gh CLI login),
    // we must not overwrite it with a managed token.
    if (!session.ghTokenInjected) {
      return;
    }
    const tokenManager = this.getGitHubTokenManager();
    if (!tokenManager) {
      this.clearManagedGhTokenForSession(session, contextToken);
      return;
    }
    try {
      // Re-resolve before every turn so enabling personal identity immediately
      // replaces any cached app write token for git/gh operations.
      tokenManager.invalidate(githubRepo, { requesterUserId });
      const token = await tokenManager.getWriteTokenForRepo(githubRepo, {
        requesterUserId,
        machineId: this.machineId,
      });
      session.updateEnv({
        ...(contextToken ? { [LODY_GIT_CRED_CONTEXT_TOKEN_ENV]: contextToken } : {}),
        GH_TOKEN: token,
        [LODY_MANAGED_GH_TOKEN_SHA256_ENV]: getGhTokenFingerprint(token),
      });
    } catch (error) {
      this.clearManagedGhTokenForSession(session, contextToken);
      this.logger.debug(
        `[${session.sessionId}] Failed to refresh GH_TOKEN: ${formatErrorMessage(error)}`
      );
    }
  }

  private clearManagedGhTokenForSession(session: ISession, contextToken: string | undefined): void {
    session.updateEnv({
      ...(contextToken ? { [LODY_GIT_CRED_CONTEXT_TOKEN_ENV]: contextToken } : {}),
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      [LODY_MANAGED_GH_TOKEN_SHA256_ENV]: undefined,
    });
  }

  private ensureGhShimSessionEnv(sessionEnv: Record<string, string>): void {
    ensureGhShimScript();

    sessionEnv.PATH = prependGhShimBinDirToPath(sessionEnv.PATH ?? process.env.PATH);

    if (shouldInjectBashEnvForGhShim()) {
      sessionEnv.BASH_ENV = ensureLodyBashEnvForGhShim(sessionEnv.BASH_ENV);
    }

    if (shouldInjectZdotdirForGhShim()) {
      sessionEnv.ZDOTDIR = ensureLodyZdotdirForGhShim(sessionEnv.ZDOTDIR);
    }
  }

  private getGitHubTokenManager(): CloudGithubTokenManager | null {
    if (this.githubTokenManager) {
      return this.githubTokenManager;
    }
    if (!this.cloudPort.githubTokens) {
      return null;
    }
    this.githubTokenManager = this.cloudPort.githubTokens.createTokenManager(this.workspaceId);
    this.githubTokenManager.startAutoRefresh();
    return this.githubTokenManager;
  }

  private async ensureGitCredentialBrokerEnv(): Promise<{
    url: string;
    port: number;
    token: string;
  } | null> {
    const tokenManager = this.getGitHubTokenManager();
    if (!tokenManager) {
      return null;
    }
    if (!this.gitCredentialBroker) {
      this.gitCredentialBroker = new GitCredentialBroker({
        tokenManager,
        workspaceId: this.workspaceId,
        logger: this.logger,
      });
    }
    return await this.gitCredentialBroker.ensureStarted();
  }

  /**
   * Broker coordinates for host-side git run on behalf of THIS workspace.
   *
   * Host git must be handed these explicitly. `GitCredentialBroker.ensureStarted()`
   * publishes `LODY_GIT_CRED_BROKER_*` into the process environment, and a fleet
   * process runs one broker per workspace, so the ambient value belongs to whichever
   * workspace started or recovered its broker last — not to this session.
   *
   * Only GitHub sources need it; local worktree sources never authenticate to a
   * remote, and asking for it would start a broker they do not use.
   */
  private async resolveHostGitBrokerAuth(
    source: WorktreeManagerSource | undefined
  ): Promise<GitCredentialBrokerAuth | undefined> {
    if (source && source.kind !== 'github') {
      return undefined;
    }
    const brokerEnv = await this.ensureGitCredentialBrokerEnv();
    if (!brokerEnv) {
      return undefined;
    }
    return {
      workspaceId: this.workspaceId,
      url: brokerEnv.url,
      token: brokerEnv.token,
    };
  }

  private async resolveSharedWorkdir(
    config: SessionConfig,
    repoId: RepoId | undefined
  ): Promise<string | undefined> {
    if (!config.parentSessionId) {
      return config.workdir;
    }

    const parentSession = this.sessions.get(config.parentSessionId);
    if (parentSession) {
      const parentWorkdir = parentSession.getWorkdir();
      return parentWorkdir;
    }

    const parentSessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(
      config.parentSessionId
    );
    const parentMeta = await parentSessionDoc.getMetaState();
    const parentProject = parentMeta?.project ?? config.project;
    const localParentWorktreeSource = this.resolveLocalWorktreeSource(
      parentProject,
      config.workdir
    );
    if (parentMeta?.isWorktree && parentProject?.kind === 'local' && localParentWorktreeSource) {
      const worktreeManager = getWorktreeManager({
        repoId: localParentWorktreeSource.repoId,
        source: {
          kind: 'local-shared',
          originalRootPath: localParentWorktreeSource.originalRootPath,
        },
        logger: this.logger,
      });
      if (!worktreeManager.hasWorktree(config.parentSessionId)) {
        this.logger.debug(
          `[${config.sessionId}] Shared local parent worktree missing for ${config.parentSessionId}; creating it now`
        );
        await worktreeManager.ensureRepo();
        let sharedBaseRef: string;
        try {
          sharedBaseRef = await this.resolveLocalWorktreeBaseRef({
            project: parentProject,
            originalRootPath: localParentWorktreeSource.originalRootPath,
            storedBaseBranch: parentMeta?.baseBranch,
            fallbackBranch: config.branch,
          });
        } catch (error) {
          const legacyBase = parentMeta?.baseBranch?.trim();
          if (
            legacyBase &&
            legacyBase === parentProject.branch?.trim() &&
            parentMeta?.branchName?.trim() &&
            formatErrorMessage(error).includes('Local project branch not found:')
          ) {
            // Old worktree metadata may only contain the raw selector. If its
            // base disappeared, WorktreeManager can still restore the exact
            // recorded session branch before it needs to resolve that base.
            // Ambiguous selectors continue to fail closed above.
            sharedBaseRef = legacyBase;
          } else {
            throw error;
          }
        }
        if (parentMeta?.baseBranch !== sharedBaseRef) {
          await parentSessionDoc.setBaseBranch(sharedBaseRef);
          await this.workspaceDocument.persistPendingChanges('session-local-base-ref');
        }
        const sharedWorktree = await worktreeManager.createWorktree(
          config.parentSessionId,
          sharedBaseRef,
          parentMeta?.branchName?.trim() || undefined
        );
        await parentSessionDoc.setBranchName(sharedWorktree.branch);
        await parentSessionDoc.setIsWorktree(true);
        return sharedWorktree.hostPath;
      }
      const parentWorktreePath = worktreeManager.getWorktreeHostPath(config.parentSessionId);
      return parentWorktreePath;
    }

    if (config.workdir) {
      return config.workdir;
    }

    if (!parentProject) {
      const parentWorkdir = ensureDefaultSessionWorkdir(config.parentSessionId);
      return parentWorkdir;
    }

    if (!repoId || !config.githubRepoUrl) {
      return undefined;
    }

    const worktreeManager = getWorktreeManager({
      repoId,
      repoUrl: config.githubRepoUrl,
      logger: this.logger,
    });
    if (!worktreeManager.hasWorktree(config.parentSessionId)) {
      this.logger.debug(
        `[${config.sessionId}] Shared parent worktree missing for ${config.parentSessionId}; creating it now`
      );
      await worktreeManager.ensureRepo({
        brokerAuth: await this.resolveHostGitBrokerAuth({
          kind: 'github',
          repoUrl: config.githubRepoUrl,
        }),
      });
      const sharedWorktree = await worktreeManager.createWorktree(
        config.parentSessionId,
        parentMeta?.baseBranch?.trim() || config.branch,
        parentMeta?.branchName?.trim() || undefined
      );
      await parentSessionDoc.setBranchName(sharedWorktree.branch);
      await parentSessionDoc.setIsWorktree(true);
      return sharedWorktree.hostPath;
    }

    const parentWorktreePath = worktreeManager.getWorktreeHostPath(config.parentSessionId);
    return parentWorktreePath;
  }

  private resolveLocalWorktreeSource(
    project: SessionConfig['project'],
    workdir: string | undefined
  ): { repoId: RepoId; originalRootPath: string } | null {
    if (project?.kind !== 'local' || project.useWorktree !== true || !workdir) {
      return null;
    }
    const originalRootPath = normalizeLocalProjectRootPath(workdir);
    return {
      repoId: deriveRepoIdFromLocalProjectPath(originalRootPath),
      originalRootPath,
    };
  }

  private resolveSessionWorktreeTarget(config: SessionConfig): SessionWorktreeTarget | null {
    if (config.parentSessionId) return null;
    const localSource = this.resolveLocalWorktreeSource(config.project, config.workdir);
    const repoId = localSource?.repoId ?? config.repoId;
    if (!repoId) return null;
    const source = localSource
      ? {
          kind: 'local-shared' as const,
          originalRootPath: localSource.originalRootPath,
        }
      : {
          kind: 'github' as const,
          repoUrl: config.githubRepoUrl,
        };
    const managerConfig: Omit<WorktreeManagerConfig, 'logger'> = { repoId, source };
    return {
      managerConfig,
      manager: getWorktreeManager({ ...managerConfig, logger: this.logger }),
      target: {
        repoId,
        source,
        ...(config.branch ? { baseBranch: config.branch } : {}),
      },
    };
  }

  private async resolveLocalWorktreeBaseRef(options: {
    project: Extract<ProjectRef, { kind: 'local' }>;
    originalRootPath: string;
    storedBaseBranch: string | undefined;
    fallbackBranch: string | undefined;
  }): Promise<string> {
    // Older session metadata stored a bare branch name directly in baseBranch,
    // which was handed to `git worktree add` and therefore meant the local
    // branch whenever one existed. Worktree mode never checks out a remote
    // tracking branch in the project root, so the legacy resolver keeps that
    // local-first precedence here instead of recovering an upstream.
    const selector = options.project.branch?.trim();
    const storedBaseBranch = options.storedBaseBranch?.trim();
    const fallbackBranch = options.fallbackBranch?.trim();

    if (!selector) {
      const existingRef = storedBaseBranch || fallbackBranch;
      if (!existingRef) throw new Error('Local project branch is required');
      return (
        await (existingRef.startsWith('refs/')
          ? parseLocalProjectBranchRefAtRootPath(options.originalRootPath, existingRef)
          : resolveLocalProjectLegacyBaseBranchAtRootPath(options.originalRootPath, existingRef, {
              useWorktree: true,
            }))
      ).refName;
    }
    if (storedBaseBranch && storedBaseBranch !== selector) {
      return (
        await parseLocalProjectBranchRefAtRootPath(options.originalRootPath, storedBaseBranch)
      ).refName;
    }

    return (
      await resolveLocalProjectLegacyBaseBranchAtRootPath(options.originalRootPath, selector, {
        useWorktree: true,
      })
    ).refName;
  }

  private async resolveWorktreeSetupConfig(config: SessionConfig) {
    if (config.project?.kind === 'local' && config.project.useWorktree === true) {
      return await readLocalProjectWorktreeSetup(config.project.localProjectId);
    }
    if (config.project?.kind === 'github') {
      return (
        config.worktreeSetup ??
        (
          await resolveGitHubRepoWorktreeConfig({
            token: this.token,
            workspaceId: this.workspaceId,
            repoFullName: config.githubRepo,
            logger: this.logger,
          })
        )?.worktreeSetup ??
        null
      );
    }
    return null;
  }

  private async createSessionInner(
    config: SessionConfig,
    preparedSession?: Session,
    preparedWorktree?: WorktreeInfo
  ): Promise<Session> {
    let workdir: string | undefined = config.workdir;
    const repoId = config.repoId;
    const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(config.sessionId!);
    if (config.githubRepo) {
      await sessionDoc.setRepoFullName(config.githubRepo);
    }

    workdir = await this.resolveSharedWorkdir(config, repoId);
    const worktreeTarget = this.resolveSessionWorktreeTarget(config);

    // Child sessions reuse the parent's workdir — skip worktree creation
    if (worktreeTarget) {
      const worktreeManager = worktreeTarget.manager;
      this.logger.debug(
        `[${config.sessionId}] Preparing worktree (repoId=${worktreeTarget.managerConfig.repoId} sessionId=${config.sessionId}) in host`
      );
      const speculativeClaim = await claimSpeculativeWorktreeForDurableSession({
        sessionId: config.sessionId!,
        workspaceId: config.workspaceId,
        machineId: this.machineId,
        target: worktreeTarget.target,
        logger: this.logger,
      });
      const speculativeSetupPending = speculativeClaim === 'claimed';
      const worktreeAlreadyExisted = worktreeManager.hasWorktree(config.sessionId!);
      // A `mismatch` claim just DELETED the prepared directory (it was built for
      // a different target), and a lost cross-process race can remove it without
      // any claim outcome. Either way the prepared info now names a path that is
      // not on disk — fall through to createWorktree, which rebuilds it, instead
      // of handing the session a dead workdir.
      const preparedWorktreeUsable =
        preparedWorktree && speculativeClaim !== 'mismatch' && existsSync(preparedWorktree.hostPath)
          ? preparedWorktree
          : undefined;
      if (preparedWorktree && !preparedWorktreeUsable) {
        this.logger.warn(
          `[${config.sessionId}] Prepared worktree is unusable (claim=${speculativeClaim} path=${preparedWorktree.hostPath}); recreating it via the cold path`
        );
      }
      const worktreeInfo =
        preparedWorktreeUsable ??
        (await (async () => {
          await worktreeManager.ensureRepo({
            brokerAuth: await this.resolveHostGitBrokerAuth(worktreeTarget.target.source),
          });
          return await worktreeManager.createWorktree(
            config.sessionId!,
            config.branch,
            config.restoreBranchName,
            config.worktreeStartPoint
          );
        })());
      if (!config.deferWorktreeMetaPersistence) {
        await sessionDoc.setBranchName(worktreeInfo.branch);
        await sessionDoc.setIsWorktree(true);
      }
      workdir = worktreeInfo.hostPath;
      this.logger.debug(`[${config.sessionId}] Using worktree as workdir: ${workdir}`);
      this.logger.debug(
        `[${config.sessionId}] Worktree details (branch=${worktreeInfo.branch} head=${worktreeInfo.headSha ?? 'unknown'}): host=${worktreeInfo.hostPath}`
      );
      if (config.resume && worktreeAlreadyExisted && !speculativeSetupPending) {
        this.logger.debug(
          `[${config.sessionId}] Skipping worktree setup for restored session because the worktree already exists`
        );
      } else {
        await runWorktreeSetup({
          config: await this.resolveWorktreeSetupConfig(config),
          sessionId: config.sessionId!,
          workspaceId: config.workspaceId,
          workdir,
          branch: worktreeInfo.branch,
          repoFullName: config.githubRepo,
          localProjectId:
            config.project?.kind === 'local' ? config.project.localProjectId : undefined,
          logger: this.logger,
          events: createWorktreeScriptHistoryRecorder({
            sessionDoc,
            sessionId: config.sessionId!,
            phase: 'setup',
            logger: this.logger,
            insertBeforeEntryId: config.worktreeScriptHistoryInsertBeforeEntryId,
          }),
        });
        await completeSpeculativeWorktreeSetup({
          sessionId: config.sessionId!,
          workspaceId: config.workspaceId,
          machineId: this.machineId,
          target: worktreeTarget.target,
        });
      }
    } else if (config.parentSessionId) {
      const parentSessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(
        config.parentSessionId
      );
      const parentMeta = await parentSessionDoc.getMetaState();
      if (parentMeta?.isWorktree) {
        await sessionDoc.setIsWorktree(true);
      }
      this.logger.debug(
        `[${config.sessionId}] Child session of ${config.parentSessionId}, skipping worktree creation (workdir=${workdir})`
      );
    }

    let session: Session;
    if (preparedSession) {
      session = preparedSession;
      if (workdir) {
        session.setWorkdir(workdir);
      }
      this.preparationSessions.delete(config.sessionId!);
    } else {
      const sandbox = await this.sessionSandboxFactory(config.sessionId!);
      this.logger.debug(`[${config.sessionId}] Session sandbox: ${sandbox.description}`);
      session = new Session(config, this.logger, workdir, sandbox);
    }
    this.registerSessionEvents(session);
    this.sessions.set(config.sessionId!, session);
    await this.rebalanceSessionSandboxes();
    return session;
  }

  async terminateSession(sessionId: SessionId, force: boolean = false): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logger.debug(`Session ${sessionId} not found`);
      return;
    }

    await session.terminate(force);
    this.logger.debug(`[${sessionId}] Session terminated`);
  }

  async cleanUp(options: { keepWorkspaceDocumentOpen?: boolean } = {}) {
    this.preparationRecoveryGeneration += 1;
    this.detachPreparationRecovery?.();
    this.detachPreparationRecovery = null;
    await this.preparationService.disposeAll();
    await this.preparationRecoveryChain;
    this.preparationSessions.clear();
    this.preparationUserResolver.clear();
    await this.cleanupSessions();
    // MessageHandler owns the final ACP/Code Collab drain. It first stops all
    // session producers through this phase, persists their last callbacks while
    // the document manager is still usable, then calls cleanUp() again for the
    // remaining shared-resource teardown.
    if (options.keepWorkspaceDocumentOpen) {
      return;
    }
    await this.workspaceDocument.cleanUp();
    await this.gitCredentialBroker?.shutdown();
    this.gitCredentialBroker = null;
    await this.githubTokenManager?.shutdown();
    this.githubTokenManager = null;
  }

  private async cleanupSessions(): Promise<void> {
    this.logger.debug('Cleaning up all sessions...');

    const terminations = Array.from(this.sessions.values()).map((session) =>
      session
        .terminate(true)
        .catch((error: unknown) =>
          this.logger.error(
            `[${session.sessionId}] Failed to terminate session: ${error instanceof Error ? error.message : 'Unknown error'}`
          )
        )
    );

    await Promise.allSettled(terminations);
    this.sessions.clear();
  }

  hasSession(sessionId: SessionId): boolean {
    return this.sessions.has(sessionId);
  }

  getSession(sessionId: SessionId): ISession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async resolveSessionWorkdir(sessionId: SessionId): Promise<string> {
    const resident = this.sessions.get(sessionId);
    if (resident) return resident.getWorkdir();

    return await resolveTerminalWorkdirFromMetadata({
      sessionId,
      machineId: this.machineId,
      lookupSessionMeta: async (candidateId) => {
        const meta = await this.workspaceDocument.repo.getDocMeta(getSessionRoomId(candidateId));
        if (!meta) return { type: 'missing' as const };
        if (isLoroRepoDocDeleted(meta)) return { type: 'deleted' as const };
        return { type: 'found' as const, meta: meta.meta as SessionMeta };
      },
      resolveLocalProjectRootPath: async (localProjectId) =>
        await resolveWorkspaceLocalProjectRootPathWithRetry(
          this.workspaceDocument.repo,
          this.workspaceId,
          this.machineId,
          localProjectId,
          {
            requestSync: () =>
              this.workspaceDocument.syncMachineFlockDoc(this.machineId, {
                reason: 'session-fork-workdir-resolve',
                timeoutMs: readTimeoutEnv('LODY_LOCAL_PROJECT_RESOLVE_SYNC_TIMEOUT_MS', 1_500),
              }),
          }
        ),
    });
  }

  async resolveLocalProjectRootPath(localProjectId: LocalProjectId): Promise<string | null> {
    return await resolveWorkspaceLocalProjectRootPathWithRetry(
      this.workspaceDocument.repo,
      this.workspaceId,
      this.machineId,
      localProjectId,
      {
        requestSync: () =>
          this.workspaceDocument.syncMachineFlockDoc(this.machineId, {
            reason: 'session-fork-local-project-resolve',
            timeoutMs: readTimeoutEnv('LODY_LOCAL_PROJECT_RESOLVE_SYNC_TIMEOUT_MS', 1_500),
          }),
      }
    );
  }

  async cleanupForkWorktree(config: SessionConfig): Promise<void> {
    if (config.project?.kind === 'github' && !config.repoId) {
      await this.prepareGitHubRepoSessionConfig(config);
    }
    const target = this.resolveSessionWorktreeTarget(config);
    if (!target || !config.sessionId) return;
    await target.manager.removeWorktree(config.sessionId, true, undefined, {
      baseBranchName: config.branch,
    });
  }

  async listMonitorSessions(): Promise<SessionMonitorRuntimeInfo[]> {
    return await Promise.all(
      Array.from(this.sessions.values(), (session) => session.getMonitorRuntimeInfo())
    );
  }

  listPendingMonitorSessionIds(): SessionId[] {
    return Array.from(this.pendingSessionCreates.keys());
  }

  getActiveChildSessionIds(parentSessionId: SessionId): SessionId[] {
    const childSessionIds: SessionId[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.getParentSessionId() === parentSessionId) {
        childSessionIds.push(sessionId);
      }
    }
    return childSessionIds;
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    await this.workspaceDocument.cleanSessionDoc(sessionId);
  }

  /**
   * Invalidate cached GitHub token for a specific repo.
   * Called when an auth failure is detected to force a fresh token fetch on retry.
   */
  invalidateGitHubToken(repoFullName: string): void {
    if (!this.githubTokenManager) {
      return;
    }
    this.githubTokenManager.invalidate(repoFullName);
  }

  /**
   * Invalidate all cached GitHub tokens.
   * Called when a global auth issue is detected (e.g., CLI token expired).
   */
  invalidateAllGitHubTokens(): void {
    if (!this.githubTokenManager) {
      return;
    }
    this.githubTokenManager.invalidateAll();
  }

  setRequestPermissionHandler(
    handler: (
      sessionId: SessionId,
      requestId: string,
      request: RequestPermissionRequest,
      agentClient: AgentClient
    ) => Promise<RequestPermissionResponse>
  ) {
    this.requestPermissionHandler = handler;
  }

  async setSessionError(sessionId: SessionId, _error: string): Promise<void> {
    const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
    if (sessionDoc) {
      // Errors are turn-level, not session-level. Set session to idle.
      await sessionDoc.setStatus(SessionStatusFactory.idle());
    }
  }

  private registerSessionEvents(session: Session): void {
    session.on('output', (event: SessionOutputEvent) => {
      this.emit('output', event);
    });

    session.on('error', (event: SessionErrorEvent) => {
      this.emit('error', event);
    });

    session.on('exit', (event: SessionExitEvent) => {
      this.sessions.delete(event.sessionId);
      void this.rebalanceSessionSandboxes();
      this.emit('exit', event);
    });

    session.on('terminated', (event: SessionExitEvent) => {
      this.sessions.delete(event.sessionId);
      void this.rebalanceSessionSandboxes();
      const terminatedEvent: SessionTerminatedEvent = {
        sessionId: event.sessionId,
        exitCode: event.exitCode,
      };
      this.emit('terminated', terminatedEvent);
    });
  }

  private async rebalanceSessionSandboxes(): Promise<void> {
    const run = async (): Promise<void> => {
      const activeSessions = [...this.sessions.values(), ...this.preparationSessions.values()];
      if (activeSessions.length === 0) {
        return;
      }

      // Limits are recomputed from machine capacity on every membership change so the
      // aggregate execution plane stays within the shared budget while leaving headroom
      // for the control plane. See docs/exec-sandbox.md and specs/container-resources.md.
      const limits = calculateAutomaticSessionSandboxLimits(
        {
          totalMemoryBytes: getEffectiveMemoryLimitBytes(),
          totalCpuCount: os.cpus().length,
        },
        activeSessions.length
      );

      const results = await Promise.allSettled(
        activeSessions.map(async (session) => {
          await session.applyExecutionPlaneLimits(limits);
        })
      );

      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const session = activeSessions[index];
          this.logger.debug(
            `[${session?.sessionId ?? 'unknown'}] Failed to apply execution-plane limits: ${
              result.reason instanceof Error ? result.reason.message : String(result.reason)
            }`
          );
        }
      });
    };

    const next = this.sandboxRebalanceChain.then(run, run);
    this.sandboxRebalanceChain = next.catch(() => {});
    await next;
  }
}

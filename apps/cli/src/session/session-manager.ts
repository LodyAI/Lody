import { resolveGitIdentityPolicyLegacy } from './git-identity-policy';
import {
  acquireSessionCredentialsLegacy,
  nativeSessionCredentials,
  type SessionCredentials,
} from './session-credentials';
import { GitCredentialContextError } from '@/lib/git-credential-broker';
import { applyNonOwnerShellEnv } from '@/lib/non-owner-shell-env';
import path from 'node:path';
import {
  ensureCredentialHelperAtPath,
  buildCredentialHelperValueForPath,
} from '@/lib/git-credential-helper-script';
import { EventEmitter } from 'eventemitter3';
import os from 'os';

import {
  SessionId,
  ACPSessionId,
  type AcpSessionNotification,
  type AgentConfigCliType,
  type MessageContent,
  SessionStatusFactory,
  MachineId,
  getManagedBuiltinRuntimeByAgentType,
  getManagedBuiltinRuntimeByRuntimeName,
  isManagedBuiltinAgentType,
  RepoId,
  SessionContextWindowUsage,
  WorkspaceId,
  type AgentConfigId,
  type LocalProjectId,
  type ProjectRef,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  type SessionMeta,
} from '@lody/shared';
import { Logger } from '@/utils/logger';
import { SessionConfig, SessionOutputEvent, SessionErrorEvent, SessionExitEvent } from './types';
import { recordIncompleteStartCleanup, type SessionStartStage } from './session-start-stage';
import { LoroDocumentManager } from '../lib/loro/doc';
import {
  AgentClient,
  type AcpWriteTextFileEvidence,
  type AcpStartupStageEvent,
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
  LODY_GIT_CRED_CONTEXT_FILE_ENV,
} from '@/lib/git-credential-broker';
import type { CloudGithubTokenManager, CloudPort } from '@lody/platform';
import { clearManagedGhTokenEnv } from '@/lib/gh-token-env';
import {
  ensureGhShimScript,
  getGhShimHostBinDir,
  prependGhShimBinDirToPath,
} from '@/lib/gh-shim-script';
import { ensureLodyBashEnvForGhShim, shouldInjectBashEnvForGhShim } from '@/lib/lody-bashenv';
import { ensureLodyZdotdirForGhShim, shouldInjectZdotdirForGhShim } from '@/lib/lody-zdotdir';
import type { RateLimit, SessionUsageUpdate } from 'acp-extension-core';
import { getWorktreeManager } from './worktree/worktree-manager';
import type {
  GitCredentialBrokerAuth,
  WorktreeManager,
  WorktreeManagerConfig,
  WorktreeManagerSource,
} from './worktree/worktree-manager';
import { readLocalProjectWorktreeSetup } from './worktree/worktree-setup-config-store';
import { resolveTerminalWorkdirFromMetadata } from '@/lib/terminal-workdir-resolver';
import { createWorktreeScriptHistoryRecorder } from './worktree/worktree-script-history';
import { createSessionBackend } from './session-backend';
import { runWorktreeSetup } from './worktree/worktree-setup-runner';
import { deriveRepoIdFromLocalProjectPath } from '@lody/shared/node/worktree-paths';
import { localProjectsLegacy } from '@lody/shared/node/local-project';
import { ensureDefaultSessionWorkdir, Session } from './session';
import {
  calculateAutomaticSessionSandboxLimits,
  createSessionSandboxFactory,
  type SessionSandboxFactory,
  type SessionSandboxLimits,
  type SessionResourceAccounting,
} from './session-sandbox';
import { formatErrorMessage, formatErrorWithCauses } from '@/utils/format-error';
import { captureCli } from '@/lib/analytics/posthog';
import { getEffectiveMemoryLimitBytes } from '@/utils/memory';
import { withSlowOperationWarning } from '@/utils/slow-operation-warning';
import { resolveGitHubRepoWorktreeConfig } from './worktree/worktree-config-resolver';
import type { AcpCapabilitiesResult } from '@/agent/acp-capability-normalization';
import { resolveWorkspaceLocalProjectRootPathWithRetry } from '@/lib/local-project-meta';
import { readTimeoutEnv } from '@/lib/loro/timeout-utils';
import { loadSessionMcpCatalog } from '@/agent/session-mcp-resolver';
import {
  claimLegacySpeculativeWorktree,
  completeLegacySpeculativeWorktreeSetup,
  recoverLegacySpeculativeWorktrees,
} from './worktree/legacy-speculative-worktrees';

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

/**
 * How long teardown waits for an in-flight create to reach a terminable state
 * before detaching it. Generous enough for a cold ACP start (the slowest healthy
 * one observed was 249s), while keeping a wedged create from hanging shutdown.
 */
const PENDING_CREATE_TERMINATE_TIMEOUT_MS = 300_000;
const PENDING_CREATE_TERMINATE_TIMED_OUT = Symbol('pending-create-terminate-timed-out');

type SessionWorktreeTarget = {
  manager: WorktreeManager;
  managerConfig: Omit<WorktreeManagerConfig, 'logger'>;
};

type ResolvedAcpProcessLaunch = Awaited<ReturnType<typeof resolveACPProcessLaunchAsync>>;

export interface ISession {
  agentClient: AgentClient | null;
  acpSessionId: ACPSessionId | null;
  sessionId: SessionId;
  terminalManager: TerminalManager;
  createAgent(config: CreateAgentConfig): Promise<string>;
  getAcpCapabilities?(): AcpCapabilitiesResult | null;
  getAcpCapabilitySourceVersion?(): string | null;
  getMemoryBinding?(): SessionConfig['memory'];
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
  watchInboxRecoveryResources?(
    persist: (identity: import('./session-sandbox').SessionRecoveryResources) => void
  ): Promise<() => void>;
  exec(command: string, args: string[], workdir: string, isAI: boolean): Promise<string>;
  terminate(force?: boolean): Promise<void>;
  /**
   * Update git identity for commits made in this session.
   * This should be called when a new user sends a chat request to an existing session.
   */
  updateGitIdentity(
    userName: string,
    userEmail: string,
    userId: string | undefined,
    options: { preferMachineIdentity: boolean }
  ): void;
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
  getGitHubCredentials(): SessionCredentials;
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
  resolveWorktreeProject?: AgentClientOptions['resolveWorktreeProject'];
  cliType: AgentConfigCliType;
  agentType: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  capabilitySourceVersion?: string;
  /** A retry must confirm the managed Codex provider still authorizes this process. */
  revalidateManagedCodexProfile?: () => Promise<void>;
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
  abortSignal?: AbortSignal;
  onStartupStage?: (event: AcpStartupStageEvent) => void;
  onUpdateMessage: (message: AcpSessionNotification) => void;
  onRequestPermission: (
    requestId: string,
    request: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>;
  onUsageUpdate: (usage: SessionUsageUpdate, accountingId?: string) => void;
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
    accountingId?: string;
  }) => void;
  onContextWindowUsageUpdate: (sessionId: SessionId, usage: SessionContextWindowUsage) => void;
  onRateLimitUpdate: (
    machineId: MachineId,
    agentConfigId: AgentConfigId | undefined,
    cliType: string,
    limits: RateLimit
  ) => void;
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
  /** Per-instance listener teardown for `detachSession`; see `registerSessionEvents`. */
  private readonly sessionEventDetachers = new WeakMap<ISession, () => void>();
  private readonly pendingSessionCreates = new Map<SessionId, Promise<ISession>>();
  private readonly pendingCreateControllers = new Map<SessionId, AbortController>();
  private readonly pendingTerminationPromises = new Map<SessionId, Promise<void>>();
  private readonly sessionSandboxFactory: SessionSandboxFactory;
  private readonly cloudPort: CloudPort;
  private detachSpeculativeWorktreeRecovery: (() => void) | null = null;
  private speculativeWorktreeRecoveryChain: Promise<void> = Promise.resolve();
  /** Coalescing latch for {@link enqueueSpeculativeWorktreeRecovery}. */
  private speculativeWorktreeRecoveryQueued = false;
  private speculativeWorktreeRecoveryGeneration = 0;
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

  /**
   * Detach a create that will never be awaited again, so the deduplication map
   * stops handing the same promise to every retry.
   *
   * `createSession` returns the cached in-flight promise for a session id, and
   * that entry is only removed by the promise's own `finally`. A create wedged
   * inside a managed-runtime install or ACP startup therefore never settles,
   * never clears its entry, and turns every subsequent attempt into the same
   * stall. Callers that have given up (the initialization stall watchdog) must
   * detach it here instead.
   *
   * Git identity preflight is cancelled immediately. Other dependencies may
   * still finish after cancellation, so they are reaped instead: if the
   * abandoned create ever produces a Session, that Session is terminated rather
   * than left as an orphan process. Returns whether an entry was detached.
   */
  abandonPendingSessionCreate(sessionId: SessionId, reason: string): boolean {
    const pending = this.pendingSessionCreates.get(sessionId);
    if (!pending) {
      return false;
    }
    this.pendingCreateControllers.get(sessionId)?.abort(new Error(reason));
    this.pendingCreateControllers.delete(sessionId);
    this.pendingSessionCreates.delete(sessionId);
    this.logger.warn(
      `[${sessionId}] Abandoning in-flight session create (${reason}); a retry will start a new one`
    );
    void pending.then(
      async (session) => {
        // The create finished after all. Its Session was never handed to a
        // caller, so it is an orphan: terminate it — but DETACH it first, for
        // the same reason as the `createAgent` failure path. `createSessionInner`
        // already registered the manager's listeners on it, and `onTerminated`
        // deletes `sessions[event.sessionId]` by ID and forwards `terminated` to
        // MessageHandler. Left attached, the orphan's death would unregister a
        // retry's healthy replacement under the same id and finalize its live
        // turn as "the agent died". `detachSession` is keyed by instance, so the
        // replacement's registration survives.
        this.detachSession(session);
        try {
          await session.terminate(true);
          this.logger.debug(
            `[${sessionId}] Terminated orphaned session from abandoned create (${reason})`
          );
        } catch (error) {
          this.logger.debug(
            `[${sessionId}] Failed to terminate orphaned session from abandoned create: ${formatErrorMessage(error)}`
          );
        }
      },
      () => undefined
    );
    return true;
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

    // Register ownership before any startup work so concurrent creates share one attempt.
    const controller = new AbortController();
    this.pendingCreateControllers.set(sessionId, controller);
    const promise = Promise.resolve()
      .then(
        async () => await this.createSessionInnerWithAgent(config, agentStart, controller.signal)
      )
      .finally(() => {
        if (this.pendingSessionCreates.get(sessionId) === promise) {
          this.pendingSessionCreates.delete(sessionId);
        }
        if (this.pendingCreateControllers.get(sessionId) === controller) {
          this.pendingCreateControllers.delete(sessionId);
        }
      });
    this.pendingSessionCreates.set(sessionId, promise);
    return await promise;
  }

  /**
   * Terminate a session whether it is already resident or still starting.
   * Returns only after a resident or still-starting session has stopped.
   */
  async requestSessionTerminate(
    sessionId: SessionId,
    force: boolean = true
  ): Promise<'terminated' | 'not-found'> {
    this.pendingCreateControllers
      .get(sessionId)
      ?.abort(new Error('Session initialization cancelled'));
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
      // A create wedged in a managed-runtime install or ACP startup never
      // settles, so awaiting it outright makes teardown hang with it. Wait only
      // as long as a create plausibly needs to reach a terminable state, then
      // detach: `abandonPendingSessionCreate` keeps reaping it, so a Session
      // that materializes later is still terminated rather than orphaned. The
      // deadline is raced through a sentinel rather than a rejection so a
      // genuine terminate failure still propagates to the caller.
      let deadlineTimer: NodeJS.Timeout | undefined;
      const deadline = new Promise<typeof PENDING_CREATE_TERMINATE_TIMED_OUT>((resolve) => {
        deadlineTimer = setTimeout(
          () => resolve(PENDING_CREATE_TERMINATE_TIMED_OUT),
          PENDING_CREATE_TERMINATE_TIMEOUT_MS
        );
        deadlineTimer.unref?.();
      });
      try {
        const outcome = await Promise.race([termination, deadline]);
        if (outcome === PENDING_CREATE_TERMINATE_TIMED_OUT) {
          clearTermination();
          this.abandonPendingSessionCreate(sessionId, 'terminate-timeout');
        }
      } finally {
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
        }
      }
      return 'terminated';
    }
    return 'not-found';
  }

  async initialize(): Promise<void> {
    const recoveryGeneration = ++this.speculativeWorktreeRecoveryGeneration;
    this.detachSpeculativeWorktreeRecovery?.();
    this.detachSpeculativeWorktreeRecovery = this.workspaceDocument.onMetaRoomSynced((reason) => {
      if (this.speculativeWorktreeRecoveryGeneration === recoveryGeneration) {
        this.enqueueSpeculativeWorktreeRecovery(`meta-room-synced:${reason}`);
      }
    });
    void this.workspaceDocument
      .waitUntilMetaSynced({ reason: 'legacy-speculative-worktree-recovery' })
      .then((synced) => {
        if (synced && this.speculativeWorktreeRecoveryGeneration === recoveryGeneration) {
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
    if (this.speculativeWorktreeRecoveryQueued) {
      return;
    }
    this.speculativeWorktreeRecoveryQueued = true;
    this.speculativeWorktreeRecoveryChain = this.speculativeWorktreeRecoveryChain
      .then(async () => {
        // Released before the sweep runs, so a signal arriving DURING it still
        // gets its own follow-up pass and nothing is silently skipped.
        this.speculativeWorktreeRecoveryQueued = false;
        await recoverLegacySpeculativeWorktrees({
          workspaceId: this.workspaceId,
          machineId: this.machineId,
          logger: this.logger,
          isActiveSession: (sessionId) =>
            this.pendingSessionCreates.has(sessionId) || this.sessions.has(sessionId),
          isDurableSession: async (sessionId) => {
            const record = await this.workspaceDocument.repo.getDocMeta(
              getSessionRoomId(sessionId)
            );
            return !!record?.meta && !isLoroRepoDocDeleted(record);
          },
        });
      })
      .catch((error: unknown) => {
        this.speculativeWorktreeRecoveryQueued = false;
        this.logger.debug(
          `Failed speculative worktree recovery (${reason}): ${formatErrorMessage(error)}`
        );
      });
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
      onStartupStage?: (event: AcpStartupStageEvent) => void;
    }
  ): CreateAgentConfig {
    const sessionId = config.sessionId!;
    const localProjectId =
      config.project?.kind === 'local' ? config.project.localProjectId : undefined;
    return {
      cliType: config.agentCliType,
      agentType: config.agentType,
      command: launch.command,
      args: launch.args,
      env: launch.env,
      resolveWorktreeProject: localProjectId
        ? async () => {
            const originProjectPath = await this.resolveLocalProjectRootPath(localProjectId);
            if (!originProjectPath) throw new Error(`Local project not found: ${localProjectId}`);
            return { version: 1, originProjectPath };
          }
        : undefined,
      capabilitySourceVersion: launch.capabilitySourceVersion,
      revalidateManagedCodexProfile:
        config.codexProfile?.profile.mode === 'chatgpt'
          ? async () => await this.freezeCodexProfile(config)
          : undefined,
      resumeSessionId: options?.resumeSessionId,
      forkSessionId: options?.forkSessionId,
      forkSessionTurnId: options?.forkSessionTurnId,
      abortSignal: options?.abortSignal,
      onStartupStage: options?.onStartupStage,
      onUpdateMessage: (update) => {
        this.emit('onACPUpdateMessage', sessionId, update);
      },
      onRequestPermission: (requestId, request) => {
        if (!this.requestPermissionHandler) {
          this.logger.debug(`[${sessionId}] Permission handler not configured`);
          return Promise.resolve({ outcome: { outcome: 'cancelled' } });
        }
        return this.requestPermissionHandler(sessionId, requestId, request, session.agentClient!);
      },
      onUsageUpdate: (usage: SessionUsageUpdate, accountingId?: string) => {
        const currentAcpSessionId = session.acpSessionId;
        if (!currentAcpSessionId) {
          this.logger.debug(
            `[${sessionId}] Dropping usage update: ACP session ID not available yet`
          );
          return;
        }
        this.emit('onUsageUpdate', {
          sessionId,
          acpSessionId: currentAcpSessionId,
          usage,
          accountingId,
        });
      },
      onContextWindowUsageUpdate: (usage: SessionContextWindowUsage) => {
        this.emit('onContextWindowUsageUpdate', sessionId, usage);
      },
      onRateLimitUpdate: (limits: RateLimit) => {
        if (
          config.agentConfigId ||
          (config.agentCliType === 'builtin' && isManagedBuiltinAgentType(config.agentType))
        ) {
          this.emit(
            'onRateLimitUpdate',
            this.machineId,
            config.agentConfigId,
            config.agentType,
            limits
          );
        }
      },
      onThreadGoalUpdated: (goal) => this.emit('onThreadGoalUpdated', sessionId, goal),
      onThreadGoalCleared: (threadId) => this.emit('onThreadGoalCleared', sessionId, threadId),
      onSessionTitleUpdate: (title) => this.emit('onSessionTitleUpdate', sessionId, title),
      onAgentWarning: (warning) => this.emit('onAgentWarning', sessionId, warning),
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
      onImageGenerationBegin: (event) => this.emit('onImageGenerationBegin', sessionId, event),
      onImageGenerationEnd: (event) => this.emit('onImageGenerationEnd', sessionId, event),
      onWriteTextFile: (event) => {
        this.emit('onWriteTextFile', sessionId, event);
      },
    };
  }

  private async createSessionInnerWithAgent(
    config: SessionConfig,
    agentStart?: AgentStartConfig,
    signal?: AbortSignal
  ): Promise<ISession> {
    signal?.throwIfAborted();
    this.reportStartStage(config, 'credentials');
    await this.freezeCodexProfile(config);
    signal?.throwIfAborted();
    const credentials = await this.prepareGitHubRepoSessionConfig(config);
    let session: Session | undefined;
    try {
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
      session = await withSlowOperationWarning(
        this.createSessionInner(config, credentials),
        this.logger,
        'session.createSessionInner',
        config.sessionId!
      );
      const sessionId = config.sessionId!;
      this.logger.debug(`[${sessionId}] Session workdir resolved: ${session.getWorkdir()}`);
      signal?.throwIfAborted();
      this.reportStartStage(config, 'git-identity');
      config.onPresencePhase?.('initializing', 'Resolving Git identity');
      const gitIdentityOptions = await this.resolveGitIdentityOptions(
        config.requesterUserId,
        signal,
        sessionId
      );
      signal?.throwIfAborted();
      session.updateGitIdentity(
        config.userName,
        config.userEmail,
        config.requesterUserId,
        gitIdentityOptions
      );
      config.onPresencePhase?.(
        requestedResumeSessionId ? 'resuming' : 'acp',
        'Resolving agent runtime'
      );
      let acpSessionId: string | undefined;

      this.reportStartStage(config, 'agent-runtime');
      const launchResolutionStartedAt = performance.now();
      let managedRuntimeReadyLogged = false;
      const launch = await resolveACPProcessLaunchAsync({
        agentConfigId: config.agentConfigId,
        magpieGatewayUrl: config.magpieGatewayUrl,
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
                    proxy_configured_for_runtime_url:
                      runtimeDiagnostics.proxyConfiguredForRuntimeUrl,
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

      signal?.throwIfAborted();
      this.reportStartStage(config, 'agent-start');
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
        // This instance never left `createSession`, so nobody upstream holds it
        // and nobody may observe its death. Detach it BEFORE terminate: the
        // Session still emits `terminated`/`exit` while it kills its processes,
        // and with the manager listeners attached those events reach
        // MessageHandler as "the session running turn X died". The handler then
        // finalizes the live turn (clears its ACP update target, stamps the
        // assistant entry finished) even though the caller is about to recover —
        // e.g. the execution service falls back from a failed ACP resume to a
        // history-replay session — and every update from the replacement agent
        // is dropped for lack of a target. The trade-off: a startup crash no
        // longer produces an `exit`-driven idle-status write; the rejected
        // promise is the only signal, and the caller owns the recovery.
        this.detachSession(session);
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

      signal?.throwIfAborted();
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
    } catch (error) {
      // Cleanup runs to the end and never replaces the start failure: callers
      // classify that error (auth, resume, transient) to decide what happens next.
      if (session) {
        this.detachSession(session);
        await session.terminate(true).catch((terminateError: unknown) => {
          recordIncompleteStartCleanup(error);
          this.logger.error(
            `[${config.sessionId}] Failed to terminate session after start failure: ${formatErrorWithCauses(terminateError)}`
          );
        });
      }
      await credentials.release().catch((releaseError: unknown) => {
        recordIncompleteStartCleanup(error);
        this.logger.error(
          `[${config.sessionId}] Failed to release credentials after start failure: ${formatErrorWithCauses(releaseError)}`
        );
      });
      throw error;
    }
  }

  /** Marks the start step that begins now; a failure is reported against it. */
  private reportStartStage(config: SessionConfig, stage: SessionStartStage): void {
    this.logger.debug(`[${config.sessionId}] Session start stage: ${stage}`);
    config.onStartStage?.(stage);
  }

  private async freezeCodexProfile(config: SessionConfig): Promise<void> {
    if (config.agentCliType !== 'builtin' || config.agentType !== 'codex') return;
    const store = getCodexProfileStore();
    if (config.agentConfigId) {
      const provider = await this.workspaceDocument.getAgentConfigById(
        config.agentConfigId,
        this.machineId
      );
      if (config.codexAuth && !provider?.codexAuth) {
        throw new Error('This Codex provider account is no longer available');
      }
      if (provider?.codexAuth) {
        if (
          config.codexAuth &&
          JSON.stringify(config.codexAuth) !== JSON.stringify(provider.codexAuth)
        )
          throw new Error('Codex account changed before session launch');
        config.codexAuth = provider.codexAuth;
      }
    }
    if (!config.codexAuth) {
      if (
        config.agentConfigId &&
        (await store.list(this.workspaceId)).some(
          (item) => item.configId === config.agentConfigId && item.machineId === this.machineId
        )
      ) {
        throw new Error(
          'This Codex provider account reference is missing; restore its configuration'
        );
      }
      return;
    }
    if (!config.agentConfigId) throw new Error('A managed Codex account requires a provider');
    config.codexProfile = await store.resolve(this.workspaceId, {
      id: config.agentConfigId,
      machineId: this.machineId,
      name: 'Codex',
      description: undefined,
      cliType: config.agentCliType,
      agentType: config.agentType,
      codexAuth: config.codexAuth,
      env: config.env ?? {},
      customAcp: config.customAcp,
      runtimeOverrides: config.runtimeOverrides,
      magpieGatewayUrl: config.magpieGatewayUrl,
    });
  }

  /**
   * Commit identity follows the same precedence as GitHub credentials: a
   * requester who enabled "Act as you" commits as themselves; otherwise the
   * machine owner may use the machine's global Git identity. Policy lookup
   * failures degrade to "not enabled" rather than blocking the turn.
   */
  async resolveGitIdentityOptions(
    requesterUserId: string,
    signal?: AbortSignal,
    sessionId?: SessionId
  ): Promise<{ preferMachineIdentity: boolean; personalIdentityEnabled: boolean }> {
    signal?.throwIfAborted();
    const preferMachineIdentity = requesterUserId === this.cloudPort.identity.userId;
    const tokenManager = this.getGitHubTokenManager();
    if (!tokenManager) return { preferMachineIdentity, personalIdentityEnabled: false };
    const policy = await resolveGitIdentityPolicyLegacy(
      () => tokenManager.getCredentialPolicy({ requesterUserId, machineId: this.machineId }),
      this.logger,
      sessionId ?? 'git-identity',
      signal
    );
    return { preferMachineIdentity, personalIdentityEnabled: policy.personalEnabled };
  }

  private async prepareGitHubRepoSessionConfig(config: SessionConfig): Promise<SessionCredentials> {
    // A GitHub remote does not make a local project a managed GitHub checkout.
    // Direct local sessions and their worktrees keep the user's native auth.
    if (config.project?.kind === 'local') return nativeSessionCredentials;

    const githubRepo = config.githubRepo ?? tryDeriveGitHubRepoFromUrl(config.githubRepoUrl);
    if (githubRepo) {
      config.githubRepo = githubRepo;
      if (config.project?.kind === 'github' || !config.project) {
        config.repoId ??= deriveRepoIdFromGitHubRepo(githubRepo);
        config.githubRepoUrl = buildGitHubCloneUrl(githubRepo);
      }
    }
    const brokerEnv = await this.ensureGitCredentialBrokerEnv();
    if (!brokerEnv) return nativeSessionCredentials;
    if (!config.sessionId) throw new Error('SessionId is required for GitHub credentials');
    const credentialOwner = await this.resolveGitHubOwner(config.sessionId, config.requesterUserId);
    const broker = this.gitCredentialBroker;
    if (!broker) throw new Error('GitHub credential broker is required');
    const credentials = acquireSessionCredentialsLegacy(broker, {
      sessionId: config.sessionId,
      requesterUserId: credentialOwner,
      machineId: this.machineId,
    });
    if (credentials.mode !== 'managed') throw new Error('Managed credentials are required');
    try {
      const brokerStateFilePath = credentials.lease.stateFilePath;
      if (!brokerStateFilePath) throw new Error('Workspace-scoped GitHub broker is required');
      const sessionEnv: Record<string, string> = { ...config.env };
      clearManagedGhTokenEnv(sessionEnv);
      sessionEnv[LODY_GIT_CRED_CONTEXT_TOKEN_ENV] = credentials.lease.contextToken;
      if (credentials.lease.contextFilePath)
        sessionEnv[LODY_GIT_CRED_CONTEXT_FILE_ENV] = credentials.lease.contextFilePath;
      this.ensureGhShimSessionEnv(sessionEnv);
      if (!credentials.lease.allowLocalAuth)
        applyNonOwnerShellEnv(sessionEnv, brokerStateFilePath, this.logger);
      // Native Git helper adapters keep remote URLs and wire protocols unchanged.
      // Save only caller config; each native attempt removes our SSH normalization.
      sessionEnv.LODY_GIT_LOCAL_CONFIG ??= JSON.stringify(
        Object.fromEntries(
          Object.entries({ ...process.env, ...sessionEnv }).filter(([key]) =>
            /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)
          )
        )
      );
      const localConfig = JSON.parse(sessionEnv.LODY_GIT_LOCAL_CONFIG) as Record<string, string>;
      for (const key of Object.keys(sessionEnv)) {
        if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete sessionEnv[key];
      }
      Object.assign(sessionEnv, localConfig);
      let configCount = Number(localConfig.GIT_CONFIG_COUNT ?? 0);
      for (const value of [
        'git@github.com:',
        'ssh://git@github.com/',
        'ssh://git@github.com:22/',
        'ssh://git@ssh.github.com:443/',
      ]) {
        sessionEnv[`GIT_CONFIG_KEY_${configCount}`] = value.includes(':443/')
          ? 'url.https://github.com:443/.insteadOf'
          : 'url.https://github.com/.insteadOf';
        sessionEnv[`GIT_CONFIG_VALUE_${configCount++}`] = value;
      }
      // Checkout filters and LFS ask Git for credentials directly, outside HTTP transport.
      const helperPath = path.join(
        getGhShimHostBinDir(brokerStateFilePath),
        'git-credential-lody.cjs'
      );
      ensureCredentialHelperAtPath(helperPath);
      for (const host of ['https://github.com', 'https://www.github.com']) {
        for (const [key, value] of [
          [`credential.${host}.helper`, ''],
          [`credential.${host}.helper`, buildCredentialHelperValueForPath(helperPath)],
          [`credential.${host}.useHttpPath`, 'true'],
        ] as const) {
          sessionEnv[`GIT_CONFIG_KEY_${configCount}`] = key;
          sessionEnv[`GIT_CONFIG_VALUE_${configCount++}`] = value;
        }
      }
      sessionEnv.GIT_CONFIG_COUNT = String(configCount);
      sessionEnv.GIT_EXEC_PATH = getGhShimHostBinDir(brokerStateFilePath);
      config.env = {
        ...sessionEnv,
        LODY_GIT_CRED_BROKER_URL: brokerEnv.url,
        LODY_GIT_CRED_BROKER_TOKEN: brokerEnv.token,
        [LODY_GIT_CRED_BROKER_STATE_FILE_ENV]: brokerStateFilePath,
        ...(githubRepo ? { LODY_GITHUB_REPO_FULL_NAME: githubRepo } : {}),
        GIT_TERMINAL_PROMPT: '0',
      };
      return credentials;
    } catch (error) {
      await credentials.release().catch((releaseError: unknown) => {
        recordIncompleteStartCleanup(error);
        this.logger.error(
          `[${config.sessionId}] Failed to release credentials after preparation failure: ${formatErrorWithCauses(releaseError)}`
        );
      });
      throw error;
    }
  }

  private async resolveGitHubOwner(sessionId: SessionId, initialOwner: string): Promise<string> {
    const record = await this.workspaceDocument.repo.getDocMeta(getSessionRoomId(sessionId));
    const owner = record?.meta?.userId;
    if (typeof owner === 'string' && owner) return owner;
    if (record?.meta) throw new Error('GitHub session owner is missing');
    // A new session has not published metadata yet; its creator is the owner.
    return initialOwner;
  }

  async validateSessionCredentials(session: ISession, requesterUserId: string): Promise<void> {
    const credentials = session.getGitHubCredentials();
    if (credentials.mode === 'native') return;
    const { lease } = credentials;
    if (
      !lease.active ||
      lease.context.sessionId !== session.sessionId ||
      lease.context.machineId !== this.machineId
    ) {
      throw new GitCredentialContextError({ message: 'github_runtime_context_invalid' });
    }
    const owner = await this.resolveGitHubOwner(session.sessionId, requesterUserId);
    // The runtime may have been retired while trusted metadata was loading.
    if (!lease.active)
      throw new GitCredentialContextError({ message: 'github_runtime_context_released' });
    if (lease.context.requesterUserId !== owner) {
      try {
        lease.revoke();
      } finally {
        await session.terminate(true);
      }
      throw new GitCredentialContextError({
        message:
          'github_owner_changed: previous session processes were closed; start a new turn with the new owner',
      });
    }
  }

  private ensureGhShimSessionEnv(sessionEnv: Record<string, string>): void {
    const statePath = this.gitCredentialBroker?.getStateFilePath();
    ensureGhShimScript(statePath, this.logger);

    sessionEnv.PATH = prependGhShimBinDirToPath(sessionEnv.PATH ?? process.env.PATH, statePath);

    if (shouldInjectBashEnvForGhShim()) {
      sessionEnv.BASH_ENV = ensureLodyBashEnvForGhShim(sessionEnv.BASH_ENV, statePath);
    }

    if (shouldInjectZdotdirForGhShim()) {
      sessionEnv.ZDOTDIR = ensureLodyZdotdirForGhShim(sessionEnv.ZDOTDIR, statePath);
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
        ownerUserId: this.cloudPort.identity.userId ?? undefined,
      });
    }
    try {
      return await this.gitCredentialBroker.ensureStarted();
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error ? String(error.code) : 'broker_start_failed';
      this.logger.warn(
        `[Lody GitHub] broker unavailable (${code}); continuing with eligible local credentials`
      );
      // The trusted owner snapshot remains usable independently of token service.
      return { url: '', port: 0, token: '' };
    }
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
    source: WorktreeManagerSource | undefined,
    config: SessionConfig,
    credentials: SessionCredentials
  ): Promise<GitCredentialBrokerAuth | undefined> {
    if (source && source.kind !== 'github') {
      return undefined;
    }
    if (credentials.mode === 'native') return undefined;
    if (!credentials.lease.active)
      throw new GitCredentialContextError({ message: 'github_runtime_context_released' });
    const brokerEnv = await this.ensureGitCredentialBrokerEnv();
    if (!brokerEnv)
      throw new GitCredentialContextError({ message: 'github_runtime_broker_missing' });
    const contextToken = credentials.lease.contextToken;
    if (!contextToken) {
      throw new Error(
        'GitHub worktree preparation is missing its requester credential context; no GitHub operation was attempted.'
      );
    }
    return {
      workspaceId: this.workspaceId,
      allowLocalAuth: credentials.lease.allowLocalAuth,
      url: brokerEnv.url,
      token: brokerEnv.token,
      contextToken,
      stateFilePath: this.gitCredentialBroker?.getStateFilePath(),
      transportEnv: Object.fromEntries(
        Object.entries(config.env ?? {}).filter(
          ([key]) =>
            key === 'PATH' ||
            key === 'GIT_EXEC_PATH' ||
            key === 'BASH_ENV' ||
            key === 'ZDOTDIR' ||
            key === 'LODY_GIT_LOCAL_CONFIG' ||
            /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)
        )
      ),
    };
  }

  private async resolveSharedWorkdir(
    config: SessionConfig,
    repoId: RepoId | undefined,
    credentials: SessionCredentials
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
      const sharedWorktree = await worktreeManager.createWorktree(
        config.parentSessionId,
        parentMeta?.baseBranch?.trim() || config.branch,
        parentMeta?.branchName?.trim() || undefined,
        undefined,
        await this.resolveHostGitBrokerAuth(
          { kind: 'github', repoUrl: config.githubRepoUrl },
          config,
          credentials
        )
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
    const originalRootPath = localProjectsLegacy.normalizeLocalProjectRootPath(workdir);
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
          ? localProjectsLegacy.parseLocalProjectBranchRefAtRootPath(
              options.originalRootPath,
              existingRef
            )
          : localProjectsLegacy.resolveLocalProjectLegacyBaseBranchAtRootPath(
              options.originalRootPath,
              existingRef,
              {
                useWorktree: true,
              }
            ))
      ).refName;
    }
    if (storedBaseBranch && storedBaseBranch !== selector) {
      return (
        await localProjectsLegacy.parseLocalProjectBranchRefAtRootPath(
          options.originalRootPath,
          storedBaseBranch
        )
      ).refName;
    }

    return (
      await localProjectsLegacy.resolveLocalProjectLegacyBaseBranchAtRootPath(
        options.originalRootPath,
        selector,
        {
          useWorktree: true,
        }
      )
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
    credentials: SessionCredentials = nativeSessionCredentials
  ): Promise<Session> {
    let workdir: string | undefined = config.workdir;
    const repoId = config.repoId;
    this.reportStartStage(config, 'workdir');
    const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(config.sessionId!);
    if (config.githubRepo) {
      await sessionDoc.setRepoFullName(config.githubRepo);
    }

    workdir = await this.resolveSharedWorkdir(config, repoId, credentials);
    const worktreeTarget = this.resolveSessionWorktreeTarget(config);

    // Child sessions reuse the parent's workdir — skip worktree creation
    if (worktreeTarget) {
      const worktreeManager = worktreeTarget.manager;
      this.reportStartStage(config, 'worktree');
      this.logger.debug(
        `[${config.sessionId}] Preparing worktree (repoId=${worktreeTarget.managerConfig.repoId} sessionId=${config.sessionId}) in host`
      );
      // An older daemon may have prepared this Session's worktree for a draft.
      // Claim before probing the directory: a mismatched one is removed here.
      const legacyTarget = {
        repoId: worktreeTarget.managerConfig.repoId,
        source: worktreeTarget.managerConfig.source ?? {
          kind: 'github' as const,
          repoUrl: worktreeTarget.managerConfig.repoUrl,
        },
        ...(config.branch ? { baseBranch: config.branch } : {}),
      };
      const legacyClaim = await claimLegacySpeculativeWorktree({
        sessionId: config.sessionId!,
        workspaceId: config.workspaceId,
        machineId: this.machineId,
        target: legacyTarget,
        restoreBranchName: config.restoreBranchName,
        logger: this.logger,
      });
      const legacySetupPending = legacyClaim === 'setup-pending';
      const worktreeAlreadyExisted = worktreeManager.hasWorktree(config.sessionId!);
      const worktreeInfo = await worktreeManager.createWorktree(
        config.sessionId!,
        config.branch,
        config.restoreBranchName,
        config.worktreeStartPoint,
        await this.resolveHostGitBrokerAuth(
          worktreeTarget.managerConfig.source,
          config,
          credentials
        )
      );
      if (!config.deferWorktreeMetaPersistence) {
        await sessionDoc.setBranchName(worktreeInfo.branch);
        await sessionDoc.setIsWorktree(true);
      }
      workdir = worktreeInfo.hostPath;
      this.logger.debug(`[${config.sessionId}] Using worktree as workdir: ${workdir}`);
      this.logger.debug(
        `[${config.sessionId}] Worktree details (branch=${worktreeInfo.branch} head=${worktreeInfo.headSha ?? 'unknown'}): host=${worktreeInfo.hostPath}`
      );
      if (config.resume && worktreeAlreadyExisted && !legacySetupPending) {
        this.logger.debug(
          `[${config.sessionId}] Skipping worktree setup for restored session because the worktree already exists`
        );
      } else {
        const setupHistory = createWorktreeScriptHistoryRecorder({
          sessionDoc,
          sessionId: config.sessionId!,
          phase: 'setup',
          logger: this.logger,
          backend: await createSessionBackend(sessionDoc, await sessionDoc.getMetaState()),
          insertBeforeEntryId: config.worktreeScriptHistoryInsertBeforeEntryId,
        });
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
          events: {
            // Only a script that actually starts makes this start unsafe to repeat.
            onStart: async (event) => {
              this.reportStartStage(config, 'worktree-setup');
              await setupHistory.onStart?.(event);
            },
            onStepStart: (event) => setupHistory.onStepStart?.(event),
            onOutput: (event) => setupHistory.onOutput?.(event),
            onStepEnd: (event) => setupHistory.onStepEnd?.(event),
            onEnd: (event) => setupHistory.onEnd?.(event),
          },
        });
        if (legacySetupPending) {
          await completeLegacySpeculativeWorktreeSetup({
            sessionId: config.sessionId!,
            workspaceId: config.workspaceId,
            machineId: this.machineId,
          });
        }
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

    this.reportStartStage(config, 'sandbox');
    const sandbox = await this.sessionSandboxFactory(config.sessionId!);
    this.logger.debug(`[${config.sessionId}] Session sandbox: ${sandbox.description}`);
    const session = new Session(config, this.logger, workdir, sandbox, credentials);
    this.registerSessionEvents(session);
    this.sessions.set(config.sessionId!, session);
    try {
      await this.rebalanceSessionSandboxes();
      return session;
    } catch (error) {
      this.detachSession(session);
      await session.terminate(true).catch((terminateError: unknown) => {
        recordIncompleteStartCleanup(error);
        this.logger.error(
          `[${config.sessionId}] Failed to terminate session after sandbox rebalance failure: ${formatErrorWithCauses(terminateError)}`
        );
      });
      throw error;
    }
  }

  /** Called only between prompts under the execution service's turn ownership. */
  async retireSessionForReconfiguration(session: ISession): Promise<void> {
    if (this.sessions.get(session.sessionId) !== session)
      throw new Error('Session changed before reconfiguration');
    // Reconfiguration is not agent death: keep the new turn's history owner alive.
    this.detachSession(session);
    await session.terminate(true);
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
    this.speculativeWorktreeRecoveryGeneration += 1;
    this.detachSpeculativeWorktreeRecovery?.();
    this.detachSpeculativeWorktreeRecovery = null;
    await this.speculativeWorktreeRecoveryChain;
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

    const sessions = Array.from(this.sessions.values());
    const outcomes = await Promise.allSettled(sessions.map((session) => session.terminate(true)));
    const failures: unknown[] = [];
    outcomes.forEach((outcome, index) => {
      const session = sessions[index]!;
      if (outcome.status === 'fulfilled') {
        if (this.sessions.get(session.sessionId) === session)
          this.sessions.delete(session.sessionId);
      } else failures.push(outcome.reason);
    });
    if (failures.length)
      throw new AggregateError(failures, 'Session cleanup retains unreleased resources');
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
      config.repoId = deriveRepoIdFromGitHubRepo(config.project.repoFullName);
      config.githubRepoUrl = buildGitHubCloneUrl(config.project.repoFullName);
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
    const onOutput = (event: SessionOutputEvent): void => {
      this.emit('output', event);
    };
    const onError = (event: SessionErrorEvent): void => {
      this.emit('error', event);
    };
    const onExit = (event: SessionExitEvent): void => {
      const current = this.sessions.get(event.sessionId);
      if (current && current !== session) return;
      if (this.sessions.get(event.sessionId) === session) this.sessions.delete(event.sessionId);
      void this.rebalanceSessionSandboxes();
      this.emit('exit', event);
    };
    const onTerminated = (event: SessionExitEvent): void => {
      const current = this.sessions.get(event.sessionId);
      if (current && current !== session) return;
      if (this.sessions.get(event.sessionId) === session) this.sessions.delete(event.sessionId);
      void this.rebalanceSessionSandboxes();
      const terminatedEvent: SessionTerminatedEvent = {
        sessionId: event.sessionId,
        exitCode: event.exitCode,
      };
      this.emit('terminated', terminatedEvent);
    };
    session.on('output', onOutput);
    session.on('error', onError);
    session.on('exit', onExit);
    session.on('terminated', onTerminated);
    this.sessionEventDetachers.set(session, () => {
      session.off('output', onOutput);
      session.off('error', onError);
      session.off('exit', onExit);
      session.off('terminated', onTerminated);
    });
  }

  /**
   * Stop publishing a Session instance's lifecycle events and drop it from the
   * live map. Only for an instance that was registered by `createSessionInner`
   * but never reached a caller, or retired between prompts for reconfiguration.
   * The owning execution path handles replacement and failures. Keyed by instance, not session id, because a
   * recovery path may already be creating the replacement under the same id.
   */
  private detachSession(session: ISession): void {
    this.sessionEventDetachers.get(session)?.();
    this.sessionEventDetachers.delete(session);
    if (this.sessions.get(session.sessionId) === session) {
      this.sessions.delete(session.sessionId);
      void this.rebalanceSessionSandboxes();
    }
  }

  private async rebalanceSessionSandboxes(): Promise<void> {
    const run = async (): Promise<void> => {
      const activeSessions = [...this.sessions.values()];
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
import { getCodexProfileStore } from '../agent/codex-profile-store';

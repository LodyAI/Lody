import EventEmitter from 'eventemitter3';
import { ACPSessionId, getServerNow, MachineId, SessionId } from '@lody/shared';
import type { CreateAgentConfig, ISession, SessionMonitorRuntimeInfo } from './session-manager';
import {
  SessionConfig,
  SessionStatus,
  SessionOutputEvent,
  SessionErrorEvent,
  SessionExitEvent,
} from './types';
import { JsonLinesParser } from '../utils/json-lines-parser';
import path from 'path';
import { Logger } from '@/utils/logger';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import * as fs from 'fs';
import type { AcpStartupTimeoutOptions, AgentClient } from '@/agent/agent-client';
import { createAcpClient } from '@/agent/acp-runner';
import { withAcpSessionStartSlot } from '@/agent/acp-session-start-gate';
import {
  AcpStartupProcessError,
  AcpStartupProcessExitError,
  appendStderrTail,
  createAcpStartupMonitor,
} from '@/agent/acp-startup-monitor';
import { runNpxStartupWithRecovery } from '@/agent/acp-npx-startup-policy';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { withLodyNpmCacheForNpx } from '@/agent/npx-cache';
import {
  type AcpLauncher,
  captureAcpSpawnFailed,
  captureAcpSpawnStarted,
  classifyCliSpawnReason,
  resolveAcpLauncher,
} from '@/agent/acp-analytics';
import { scrubInheritedClaudeAuthEnv, shouldScrubClaudeAuthEnv } from '@/agent/claude-env-conflict';
import { getCachedLoginShellEnvSync, getLoginShellEnv } from '@/agent/login-shell-env';
import { mergeLoginShellEnv, withDefaultAcpPathEntries } from '@/agent/setting';
import { withLoopbackNoProxy } from '@lody/shared/proxy-env';
import { ShellTerminalManager, TerminalManager } from './terminal-manager';
import { decodeBuffer } from '@/utils/encoding';
import {
  createNoopSessionSandbox,
  createSessionResourceLimitError,
  type SessionProcessHandle,
  type SessionSandboxLimits,
  type SessionSandbox,
} from './session-sandbox';
import { formatErrorMessage } from '@/utils/format-error';
import { truncateLogText } from '@/utils/log-format';
import { createStdinWritableStream, createStdoutReadableStream } from '@/utils/stream';
import { resolveSessionGitIdentity } from './git-identity';
import {
  normalizeAcpSessionCapabilities,
  type AcpCapabilitiesResult,
} from '@/agent/acp-capability-normalization';

type SessionEvents = {
  output: (event: SessionOutputEvent) => void;
  error: (event: SessionErrorEvent) => void;
  exit: (event: SessionExitEvent) => void;
  terminated: (event: SessionExitEvent) => void;
};

export const getDefaultSessionWorkdir = (sessionId: SessionId): string =>
  path.join(getLodyDataDir(), 'chats', sessionId);

export const ensureDefaultSessionWorkdir = (sessionId: SessionId): string => {
  const dir = getDefaultSessionWorkdir(sessionId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
};

function createAbortPromise(signal?: AbortSignal):
  | {
      promise: Promise<never>;
      dispose: () => void;
    }
  | undefined {
  if (!signal) {
    return undefined;
  }
  let rejectAbort: ((reason: Error) => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    const error = new Error('ACP startup aborted');
    error.name = 'AbortError';
    rejectAbort?.(error);
  };
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener('abort', abort, { once: true });
  }
  return {
    promise,
    dispose: () => signal.removeEventListener('abort', abort),
  };
}

export class Session extends EventEmitter<SessionEvents> implements ISession {
  readonly sessionId: SessionId;
  private readonly config: SessionConfig;
  private readonly logger: Logger;
  private fixedWorkdir?: string;
  private status: SessionStatus['status'] = 'created';
  /** Memoizes `terminate()` so one instance emits `terminated` exactly once. */
  private terminationPromise: Promise<void> | null = null;
  private forceTerminationRequested = false;
  private forceTerminationPromise: Promise<void> | null = null;
  private readonly forceTerminationWaiters = new Set<() => void>();
  private readonly startedAtMs = getServerNow();
  private activeProcess: SessionProcessHandle | null = null;
  private agentProcess: SessionProcessHandle | null = null;
  private readonly sandbox: SessionSandbox;
  private gitIdentity: { id: string; name: string; email: string };
  public agentClient: AgentClient | null = null;
  public acpSessionId: ACPSessionId | null = null;
  private acpCapabilities: AcpCapabilitiesResult | null = null;
  private acpCapabilitySourceVersion: string | null = null;
  public terminalManager: TerminalManager;
  public ghTokenInjected: boolean = false;

  constructor(
    config: SessionConfig,
    logger: Logger,
    workdir?: string,
    sandbox: SessionSandbox = createNoopSessionSandbox()
  ) {
    super();
    this.config = config;
    this.logger = logger;
    this.fixedWorkdir = workdir;
    this.sandbox = sandbox;
    this.sessionId = config.sessionId!;
    this.gitIdentity = {
      id: config.requesterUserId,
      name: config.userName,
      email: config.userEmail,
    };
    this.terminalManager = new ShellTerminalManager({
      logger: this.logger,
      sessionLabel: this.sessionId,
      getActiveAcpSessionId: () => this.acpSessionId,
      resolveWorkdir: (cwd?: string) => cwd ?? this.getWorkdir(),
      buildEnv: (overrides?: Record<string, string>) => this.buildShellEnv(overrides),
      sandbox: this.sandbox,
      onResourceLimitExceeded: (violation) => {
        void this.handleResourceLimitExceeded(
          createSessionResourceLimitError(this.sessionId, violation)
        );
      },
    });
  }

  getWorkdir(): string {
    if (this.fixedWorkdir) {
      try {
        const stat = fs.statSync(this.fixedWorkdir);
        if (!stat.isDirectory()) {
          throw new Error(`Session workdir is not a directory: ${this.fixedWorkdir}`);
        }
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? (error as { code?: unknown }).code
            : null;
        if (code === 'ENOENT') {
          throw new Error(`Session workdir does not exist: ${this.fixedWorkdir}`, {
            cause: error,
          });
        }
        throw error;
      }
      return this.fixedWorkdir;
    }
    return ensureDefaultSessionWorkdir(this.sessionId);
  }

  getHostWorkdir(): string | null {
    return this.getWorkdir();
  }

  setWorkdir(workdir: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(workdir);
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? (error as { code?: unknown }).code
          : null;
      if (code === 'ENOENT') {
        throw new Error(`Session workdir does not exist: ${workdir}`, { cause: error });
      }
      throw error;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Session workdir is not a directory: ${workdir}`);
    }
    this.fixedWorkdir = workdir;
  }

  getParentSessionId(): SessionId | undefined {
    return this.config.parentSessionId;
  }

  async applyExecutionPlaneLimits(limits: SessionSandboxLimits): Promise<void> {
    await this.sandbox.applyLimits(limits);
  }

  async getMonitorRuntimeInfo(): Promise<SessionMonitorRuntimeInfo> {
    let accounting: SessionMonitorRuntimeInfo['accounting'];
    try {
      accounting = await this.sandbox.readResourceAccounting();
    } catch (error) {
      accounting = {
        kind: 'unavailable',
        reason: formatErrorMessage(error),
      };
    }
    return {
      sessionId: this.sessionId,
      parentSessionId: this.config.parentSessionId ?? null,
      agentCliType: this.config.agentCliType,
      agentType: this.config.agentType,
      startedAtMs: this.startedAtMs,
      runtimeStatus:
        this.status === 'existing' || this.status === 'stopped' ? 'created' : this.status,
      accounting,
    };
  }

  async exec(command: string, args: string[], workdir: string, isAI: boolean): Promise<string> {
    if (this.status === 'failed' || this.status === 'stopping' || this.status === 'terminated') {
      throw new Error(`Session ${this.sessionId} is not running`);
    }
    const execPromise = await this.runCommand(command, args, workdir, isAI);
    return execPromise;
  }

  /**
   * Idempotent. Termination is reached from several directions at once — a
   * resource-limit failure terminates while cancel is terminating, cleanup runs
   * over every session, an error path terminates after the turn already did — and
   * running the body twice emits a second `terminated` event for one instance.
   * Concurrent and later callers await the first run instead.
   *
   * A FAILED teardown releases the memo so a later attempt can retry; a
   * successful one keeps it, because `terminated` is a terminal state.
   */
  async terminate(force: boolean = false): Promise<void> {
    const shouldEscalate = force && !this.forceTerminationRequested;
    if (shouldEscalate) {
      this.forceTerminationRequested = true;
      for (const resolve of this.forceTerminationWaiters) resolve();
      this.forceTerminationWaiters.clear();
    }
    const inFlight = this.terminationPromise;
    if (inFlight) {
      this.logger.debug(`[${this.sessionId}] Terminate already in progress; awaiting it`);
      if (shouldEscalate) {
        await this.forceTerminateResources();
      }
      return await inFlight;
    }
    const run = this.terminateOnce(force);
    this.terminationPromise = run;
    try {
      await run;
    } catch (error) {
      this.terminationPromise = null;
      this.forceTerminationPromise = null;
      this.forceTerminationRequested = false;
      throw error;
    }
  }

  private async terminateOnce(force: boolean): Promise<void> {
    this.logger.debug(`[${this.sessionId}] Terminating session${force ? ' (force)' : ''}`);
    this.status = 'stopping';

    if (this.acpSessionId && this.terminalManager.disposeAll) {
      try {
        await this.terminalManager.disposeAll(this.acpSessionId);
      } catch (error) {
        this.logger.debug(
          `[${
            this.sessionId
          }] Failed to dispose ACP terminals during terminate: ${formatErrorMessage(error)}`
        );
      }
    }

    if (!force && this.acpSessionId && this.agentClient?.isCreated()) {
      const forceRequest = this.waitForForceTermination();
      const closeResult = this.agentClient.closeSession(this.acpSessionId).then(
        () => ({ type: 'closed' as const }),
        (error: unknown) => ({ type: 'error' as const, error })
      );
      const result = await Promise.race([
        closeResult,
        forceRequest.promise.then(() => ({ type: 'forced' as const })),
      ]);
      forceRequest.dispose();
      if (result.type === 'error') {
        this.logger.debug(
          `[${this.sessionId}] Failed to close ACP session during terminate: ${formatErrorMessage(
            result.error
          )}`
        );
      }
    }

    if (this.forceTerminationPromise) {
      await this.forceTerminationPromise;
    } else {
      await this.terminateResources(force || this.forceTerminationRequested);
    }

    try {
      await this.sandbox.cleanup();
    } catch (error) {
      this.logger.debug(
        `[${this.sessionId}] Failed to clean up sandbox state: ${formatErrorMessage(error)}`
      );
    }

    const exitCode = this.activeProcess?.child.exitCode ?? 0;
    this.activeProcess = null;
    this.agentProcess = null;
    this.agentClient = null;
    this.acpSessionId = null;
    this.acpCapabilities = null;

    this.status = 'terminated';

    const event: SessionExitEvent = {
      sessionId: this.sessionId,
      exitCode,
    };
    this.emit('terminated', event);
  }

  private async forceTerminateResources(): Promise<void> {
    this.forceTerminationPromise ??= this.terminateResources(true);
    await this.forceTerminationPromise;
  }

  private waitForForceTermination(): { promise: Promise<void>; dispose: () => void } {
    if (this.forceTerminationRequested) {
      return { promise: Promise.resolve(), dispose: () => undefined };
    }
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.forceTerminationWaiters.add(resolve);
    return {
      promise,
      dispose: () => this.forceTerminationWaiters.delete(resolve),
    };
  }

  private async terminateResources(force: boolean): Promise<void> {
    const activeProcess = this.activeProcess;
    const agentProcess = this.agentProcess;
    await Promise.all([
      this.killAndWait(activeProcess, force),
      this.killAndWait(agentProcess, force),
    ]);
    try {
      await this.sandbox.terminate(force);
    } catch (error) {
      this.logger.debug(
        `[${this.sessionId}] Failed to terminate sandbox process tree: ${formatErrorMessage(error)}`
      );
    }
  }

  /**
   * Kill a process and wait for it to actually exit.
   *
   * With force=false: sends SIGTERM, waits up to SIGTERM_GRACE_MS, then
   * escalates to SIGKILL if the process hasn't exited.
   * With force=true: sends SIGKILL directly.
   *
   * Always awaits the actual OS process exit before returning, so callers can
   * be certain no orphaned processes remain.
   */
  private async killAndWait(proc: SessionProcessHandle | null, force: boolean): Promise<void> {
    if (!proc?.child) return;

    const child = proc.child;
    // Already exited — nothing to do.
    // Note: child.killed only means a signal was *sent*, not that the process
    // exited. Only exitCode !== null proves the process has actually terminated.
    if (child.exitCode !== null) return;

    const waitForExit = (): Promise<void> =>
      new Promise<void>((resolve) => {
        const unsubscribe = proc.onExit(() => {
          unsubscribe();
          resolve();
        });
        // Guard: if the process exited between the check above and
        // registering the listener, resolve immediately.
        if (child.exitCode !== null) {
          unsubscribe();
          resolve();
        }
      });

    if (force) {
      await proc.terminate(true);
      await waitForExit();
      return;
    }

    // Graceful path: SIGTERM → wait → SIGKILL fallback
    const SIGTERM_GRACE_MS = 5_000;
    await proc.terminate(false);

    const outcome = await Promise.race([
      waitForExit().then(() => 'exited' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), SIGTERM_GRACE_MS)),
    ]);

    if (outcome === 'timeout' && child.exitCode === null) {
      this.logger.debug(
        `[${this.sessionId}] Process did not exit within ${SIGTERM_GRACE_MS}ms of SIGTERM; escalating to SIGKILL`
      );
      await proc.terminate(true);
      await waitForExit();
    }
  }

  /**
   * Update git identity for commits made in this session.
   * This should be called when a new user sends a chat request to an existing session.
   */
  updateGitIdentity(userName: string, userEmail: string, userId?: string): void {
    const configEnv = this.config.env ?? {};
    // Set git identity using Git's recognized environment variables directly
    const { name, email } = resolveSessionGitIdentity(
      { name: userName, email: userEmail },
      undefined,
      this.getWorkdir()
    );
    configEnv.GIT_AUTHOR_NAME = name;
    configEnv.GIT_COMMITTER_NAME = name;
    configEnv.GIT_AUTHOR_EMAIL = email;
    configEnv.GIT_COMMITTER_EMAIL = email;
    this.config.env = configEnv;
    this.gitIdentity = {
      id: userId ?? this.gitIdentity.id,
      name,
      email,
    };
    this.logger.debug(`[${this.sessionId}] Git identity updated: ${name} <${email}>`);
  }

  getGitIdentityForUser(userId: string): { id: string; name: string; email: string } | null {
    return this.gitIdentity.id === userId ? { ...this.gitIdentity } : null;
  }

  updateEnv(env: Record<string, string | undefined>): void {
    const configEnv = this.config.env ?? {};
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        // Keep an explicit undefined override. Deleting would let buildShellEnv()
        // re-inherit host vars like GH_TOKEN from process.env.
        configEnv[key] = undefined as unknown as string;
      } else {
        configEnv[key] = value;
      }
    }
    this.config.env = configEnv;
  }

  private handleParserData = (data: unknown): void => {
    const json = JSON.stringify(data);
    this.emitOutput(json);
  };

  private handleParserError = (error: unknown): void => {
    const message = formatErrorMessage(error);
    this.logger.error(`[${this.sessionId}] Parser error: ${message}`);
  };

  private buildShellEnv(
    extraEnv?: Record<string, string>,
    loginShellEnv: NodeJS.ProcessEnv = getCachedLoginShellEnvSync()
  ): NodeJS.ProcessEnv {
    const configEnv = this.config.env ?? {};
    const workspaceSessionId = this.config.parentSessionId ?? this.sessionId;

    // Git identity is set directly via GIT_AUTHOR_*/GIT_COMMITTER_* in configEnv
    // (see updateGitIdentity and session-manager.ts)

    const merged: NodeJS.ProcessEnv = {
      ...process.env,
      ...configEnv,
      ...extraEnv,
      FORCE_COLOR: '1',
      TERM: 'xterm-256color',
      PS1: '',
      PROMPT_COMMAND: '',
      LODY_SESSION_ID: this.sessionId,
      LODY_WORKSPACE_SESSION_ID: workspaceSessionId,
    };

    // Same ENOENT trap as the ACP runner: overlay the login-shell env so a
    // GUI/daemon launch with a minimal PATH can still find agent binaries. This
    // path is synchronous (terminal-manager callback), so read the cached env;
    // withDefaultAcpPathEntries covers the not-yet-warmed first call.
    //
    // This MUST happen before the scrub below: the login profile (~/.zshrc) is a
    // second source of ANTHROPIC_*/CLAUDE_CODE_* vars that the scrub never saw
    // otherwise. Scrubbing first and overlaying after would let a stray
    // `ANTHROPIC_API_KEY` from the shell silently override a configured
    // `ANTHROPIC_AUTH_TOKEN` — the exact override the scrub exists to prevent.
    // Same ENOENT trap as the ACP runner: overlay the login-shell env so a
    // GUI/daemon launch with a minimal PATH can still find agent binaries. This
    // path is synchronous (terminal-manager callback), so read the cached env;
    // withDefaultAcpPathEntries covers the not-yet-warmed first call.
    //
    // This MUST happen before the scrub below: the login profile (~/.zshrc) is a
    // second source of ANTHROPIC_*/CLAUDE_CODE_* vars that the scrub never saw
    // otherwise. Scrubbing first and overlaying after would let a stray
    // `ANTHROPIC_API_KEY` from the shell silently override a configured
    // `ANTHROPIC_AUTH_TOKEN` — the exact override the scrub exists to prevent.
    const withLoginShell = mergeLoginShellEnv(merged, loginShellEnv);

    // For Claude-like builtins, when the user has explicit auth/routing config (preset or
    // manual), strip inherited ANTHROPIC_*/CLAUDE_CODE_* vars (from the host
    // process env *and* the login shell) so e.g. a stray `ANTHROPIC_API_KEY`
    // doesn't override a configured `ANTHROPIC_AUTH_TOKEN`, and
    // `CLAUDE_CODE_USE_BEDROCK=1` doesn't reroute a configured `ANTHROPIC_BASE_URL`.
    const agentEnv = shouldScrubClaudeAuthEnv(this.config.agentCliType, this.config.agentType)
      ? scrubInheritedClaudeAuthEnv(withLoginShell, { ...configEnv, ...extraEnv })
      : withLoginShell;
    // The child talks to Lody's own loopback services (MCP HTTP host, preview
    // gateway); a proxy inherited from the host process or the login shell
    // must never intercept those. Runs last so a proxy contributed by the
    // login shell is covered too.
    return withLoopbackNoProxy(withDefaultAcpPathEntries(agentEnv, this.config.agentType));
  }

  async createAgent(callbacks: CreateAgentConfig): Promise<string> {
    this.acpCapabilitySourceVersion = callbacks.capabilitySourceVersion ?? null;
    const loginShellEnv = await getLoginShellEnv();
    callbacks.abortSignal?.throwIfAborted();
    const env = withLodyNpmCacheForNpx(
      callbacks.command,
      this.buildShellEnv(callbacks.env, loginShellEnv)
    );
    const launcher: AcpLauncher = resolveAcpLauncher(callbacks.command);
    const spawnAnalyticsProps = {
      cliType: callbacks.cliType,
      agentType: callbacks.agentType,
      launcher,
      isResume: !!callbacks.resumeSessionId,
      sessionId: this.sessionId,
      ...(this.config.workspaceId ? { workspaceId: this.config.workspaceId } : {}),
    };
    let lastStderrTail = '';
    let lastAgentProcessHandle: SessionProcessHandle | null = null;

    const cleanupFailedAttempt = async (): Promise<void> => {
      const handle = lastAgentProcessHandle;
      if (!handle) {
        return;
      }
      try {
        await this.killAndWait(handle, true);
      } catch (error) {
        this.logger.debug(
          `[${
            this.sessionId
          }] Failed to terminate ACP startup attempt before retry: ${formatErrorMessage(error)}`
        );
      } finally {
        if (this.agentProcess === handle) {
          this.agentProcess = null;
        }
        lastAgentProcessHandle = null;
      }
    };

    const attemptCreateAgent = async (
      startupTimeouts?: AcpStartupTimeoutOptions
    ): Promise<string> => {
      lastStderrTail = '';
      lastAgentProcessHandle = null;
      this.logger.debug(
        `[${this.sessionId}] Starting ACP agent process (cwd=${this.getWorkdir()} cmd=${
          callbacks.command
        } args=${JSON.stringify(callbacks.args ?? [])})`
      );
      captureAcpSpawnStarted(spawnAnalyticsProps);
      let agentProcessHandle: SessionProcessHandle;
      try {
        callbacks.abortSignal?.throwIfAborted();
        agentProcessHandle = await this.sandbox.spawn(callbacks.command, callbacks.args ?? [], {
          cwd: this.getWorkdir(),
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        captureAcpSpawnFailed({ ...spawnAnalyticsProps, reason: classifyCliSpawnReason(error) });
        throw error;
      }
      const agentProcess = agentProcessHandle.child;

      this.agentProcess = agentProcessHandle;
      lastAgentProcessHandle = agentProcessHandle;

      agentProcessHandle.onError((err) => {
        this.logger.error(`[${this.sessionId}] Agent process error: ${err.message}`);
      });

      agentProcessHandle.onExit((code, signal) => {
        this.logger.debug(
          `[${this.sessionId}] ACP agent process exited with code ${code} signal ${signal}`
        );
        this.agentProcess = null;
        void agentProcessHandle
          .inspectExit(code, signal)
          .then((violation) => {
            if (violation) {
              return this.handleResourceLimitExceeded(
                createSessionResourceLimitError(this.sessionId, violation)
              );
            }
            return undefined;
          })
          .catch((error: unknown) => {
            this.logger.debug(
              `[${
                this.sessionId
              }] Failed to inspect agent exit for resource limits: ${formatErrorMessage(error)}`
            );
          });
      });
      callbacks.abortSignal?.throwIfAborted();

      // Use setEncoding to handle UTF-8 multibyte boundaries correctly
      let stderrTail = '';
      agentProcess.stderr?.setEncoding('utf8');
      agentProcess.stderr?.on('data', (chunk: string) => {
        if (chunk) {
          stderrTail = appendStderrTail(stderrTail, chunk);
          lastStderrTail = stderrTail;
          const preview = truncateLogText(chunk, {
            maxChars: 1200,
            headChars: 900,
            tailChars: 180,
          });
          this.logger.debug(
            `[${this.sessionId}] ACP agent stderr (${chunk.length} chars): ${preview}`
          );
        }
      });

      if (!agentProcess.stdin) {
        throw new Error('Agent process stdin is not available');
      }
      if (!agentProcess.stdout) {
        throw new Error('Agent process stdout is not available');
      }
      const startupMonitor = createAcpStartupMonitor(agentProcessHandle, {
        sessionId: this.sessionId,
        command: callbacks.command,
        args: callbacks.args ?? [],
        getStderrTail: () => stderrTail,
      });
      const externalAbort = createAbortPromise(callbacks.abortSignal);

      const input = createStdinWritableStream(agentProcess.stdin);
      const output = createStdoutReadableStream(agentProcess.stdout);
      const stream = ndJsonStream(input, output);
      this.logger.debug(`[${this.sessionId}] ndJsonStream created, calling createAcpClient`);
      let client: AgentClient;
      let acpSessionId: ACPSessionId;
      let acpCapabilities: AcpCapabilitiesResult;
      try {
        const started = await createAcpClient({
          stream,
          workdir: this.getWorkdir(),
          logger: this.logger,
          terminalManager: this.terminalManager,
          agentConfig: {
            cliType: callbacks.cliType,
            agentType: callbacks.agentType,
          },
          configOptionValues: this.config.configOptionValues,
          taskToolsEnabled: this.config.taskToolsEnabled,
          launcher,
          workspaceId: this.config.workspaceId,
          machineId: this.config.machineId as MachineId,
          resumeSessionId: callbacks.resumeSessionId,
          forkSessionId: callbacks.forkSessionId,
          forkSessionTurnId: callbacks.forkSessionTurnId,
          onStartupStage: callbacks.onStartupStage,
          onUpdateMessage: callbacks.onUpdateMessage,
          onRequestPermission: callbacks.onRequestPermission,
          onUsageUpdate: callbacks.onUsageUpdate,
          onContextWindowUsageUpdate: callbacks.onContextWindowUsageUpdate,
          onRateLimitUpdate: callbacks.onRateLimitUpdate,
          onThreadGoalUpdated: callbacks.onThreadGoalUpdated,
          onThreadGoalCleared: callbacks.onThreadGoalCleared,
          onSessionTitleUpdate: callbacks.onSessionTitleUpdate,
          onAgentWarning: callbacks.onAgentWarning,
          loadExternalMcpServers: callbacks.loadExternalMcpServers,
          onImageGenerationBegin: callbacks.onImageGenerationBegin,
          onImageGenerationEnd: callbacks.onImageGenerationEnd,
          onWriteTextFile: callbacks.onWriteTextFile,
          sessionId: this.sessionId,
          startupTimeouts,
          startupAbort: externalAbort
            ? Promise.race([startupMonitor.abortPromise, externalAbort.promise])
            : startupMonitor.abortPromise,
          resolveSessionStart: callbacks.resolveSessionStart,
        });
        client = started.client;
        acpSessionId = started.acpSessionId;
        acpCapabilities = normalizeAcpSessionCapabilities(started.sessionResponse, {
          sessionFork: started.client.supportsSessionFork(),
          acknowledgedSteer: started.client.supportsAcknowledgedSteer(),
        });
      } catch (error) {
        // The agent process died before startup completed (the startup monitor
        // surfaces async ENOENT/EACCES/early-exit here). Protocol-level failures
        // are captured inside AgentClient.startSession; only spawn-level monitor
        // errors are reported here to avoid double-counting.
        if (
          error instanceof AcpStartupProcessExitError ||
          error instanceof AcpStartupProcessError
        ) {
          captureAcpSpawnFailed({ ...spawnAnalyticsProps, reason: classifyCliSpawnReason(error) });
        }
        throw error;
      } finally {
        startupMonitor.dispose();
        externalAbort?.dispose();
      }
      this.logger.debug(
        `[${this.sessionId}] createAcpClient returned (acpSessionId=${acpSessionId})`
      );
      this.acpSessionId = acpSessionId;
      this.agentClient = client;
      this.acpCapabilities = acpCapabilities;
      this.logger.debug(`[${this.sessionId}] ACP agent process started, returning acpSessionId`);
      return acpSessionId;
    };

    try {
      return await withAcpSessionStartSlot(
        {
          label: this.sessionId,
          logger: this.logger,
          abortSignal: callbacks.abortSignal,
        },
        async () =>
          await runNpxStartupWithRecovery({
            command: callbacks.command,
            args: callbacks.args ?? [],
            env,
            logger: this.logger,
            logPrefix: `[${this.sessionId}]`,
            attempt: ({ startupTimeouts }) => attemptCreateAgent(startupTimeouts),
            cleanupFailedAttempt,
            getStderrTail: () => lastStderrTail,
          })
      );
    } catch (error) {
      await cleanupFailedAttempt();
      throw error;
    }
  }

  getAcpCapabilities(): AcpCapabilitiesResult | null {
    return this.acpCapabilities;
  }

  getAcpCapabilitySourceVersion(): string | null {
    return this.acpCapabilitySourceVersion;
  }

  private runCommand(
    command: string,
    args: string[],
    workdir: string,
    isAI: boolean
  ): Promise<string> {
    const env = this.buildShellEnv();
    this.logger.debug(
      `[${this.sessionId}] Executing command: ${command} args=${JSON.stringify(args)}`
    );

    return new Promise<string>((resolve, reject) => {
      void this.sandbox
        .spawn(command, args, {
          cwd: workdir,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          // The command's output IS the result here, and spawn() can return the
          // handle long after a short command already exited (the daemon's event
          // loop stalls under load). Without this, `git branch --show-current`
          // resolves to '' and reads as "no branch" instead of "exec failed".
          captureOutput: true,
        })
        .then((processHandle) => {
          const child = processHandle.child;
          this.logger.debug(
            `[${this.sessionId}] Spawned process PID: ${child.pid} with command: ${command}`
          );

          this.activeProcess = processHandle;

          // Accumulate raw buffers to avoid issues with multi-byte characters split across chunks.
          // Decoding happens at the end when the stream is complete.
          const stdoutChunks: Buffer[] = [];
          const stderrChunks: Buffer[] = [];

          const parser = isAI ? new JsonLinesParser() : null;
          if (parser) {
            parser.on('data', this.handleParserData);
            parser.on('error', this.handleParserError);
          }

          processHandle.onStdout((chunk: Buffer) => {
            stdoutChunks.push(chunk);
            if (parser) {
              // Parser expects string data - use toString for streaming JSON parsing
              // JSON content from AI should be ASCII/UTF-8 safe
              parser.write(chunk.toString());
            }
          });

          // why git clone info is sent to stderr?
          processHandle.onStderr((chunk: Buffer) => {
            stderrChunks.push(chunk);
            const stderrText = chunk.toString();
            this.logger.debug(
              `[${this.sessionId}] Shell stderr (${stderrText.length} chars): ${truncateLogText(
                stderrText,
                {
                  maxChars: 1200,
                  headChars: 900,
                  tailChars: 180,
                }
              )}`
            );
          });

          const cleanup = () => {
            this.activeProcess = null;
            if (parser) {
              parser.end();
              parser.removeListener('data', this.handleParserData);
              parser.removeListener('error', this.handleParserError);
            }
          };

          processHandle.onClose((code: number | null, signal: NodeJS.Signals | null) => {
            cleanup();
            void processHandle
              .inspectExit(code, signal)
              .then((violation) => {
                if (violation) {
                  const error = createSessionResourceLimitError(this.sessionId, violation);
                  void this.handleResourceLimitExceeded(error);
                  reject(error);
                  return;
                }

                const exitCode = code ?? 0;

                // Decode accumulated buffers now that stream is complete.
                // This avoids issues with multi-byte characters split across chunks.
                const stdoutBuffer = Buffer.concat(stdoutChunks);
                const stderrBuffer = Buffer.concat(stderrChunks);
                const stdout = decodeBuffer(stdoutBuffer);
                const stderr = decodeBuffer(stderrBuffer);

                if (!isAI) {
                  if (stdoutBuffer.length > 0) {
                    this.logger.debug(
                      `[${this.sessionId}] Command stdout captured (${stdoutBuffer.length} bytes)`
                    );
                  }
                  if (stderrBuffer.length > 0) {
                    this.logger.debug(
                      `[${this.sessionId}] Command stderr captured (${stderrBuffer.length} bytes)`
                    );
                  }
                  // exec() resolves with stdout regardless of exit status, so a
                  // failed command otherwise looks exactly like an empty one.
                  if (exitCode !== 0 || signal !== null) {
                    this.logger.debug(
                      `[${this.sessionId}] Command failed: ${command} exitCode=${exitCode} signal=${signal} stdoutBytes=${stdoutBuffer.length}`
                    );
                  }
                }
                if (isAI) {
                  this.emit('exit', { sessionId: this.sessionId, exitCode });
                }
                // stderr is decoded but not used in return value (only logged above)
                void stderr;
                resolve(stdout);
              })
              .catch((error: unknown) => {
                reject(error);
              });
          });

          processHandle.onError((error) => {
            cleanup();
            reject(error);
          });
        })
        .catch((error: unknown) => {
          reject(error);
        });
    });
  }

  //
  private async handleResourceLimitExceeded(error: Error): Promise<void> {
    if (this.status === 'failed' || this.status === 'terminated') {
      return;
    }

    this.status = 'failed';
    this.logger.error(`[${this.sessionId}] ${error.message}`);
    this.emit('error', { sessionId: this.sessionId, error });

    try {
      await this.terminate(true);
    } catch (terminateError) {
      this.logger.debug(
        `[${
          this.sessionId
        }] Failed to terminate session after resource limit violation: ${formatErrorMessage(
          terminateError
        )}`
      );
    }
  }
  private emitOutput(data: string): void {
    const output: SessionOutputEvent = {
      sessionId: this.sessionId,
      data,
      timestamp: new Date(),
    };
    this.emit('output', output);
  }
}

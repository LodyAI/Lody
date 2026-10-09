import type { ChildProcess } from 'child_process';
import os from 'os';
import path from 'path';
import * as fs from 'fs';
import {
  ndJsonStream,
  type Stream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { v4 as uuidV4 } from 'uuid';
import { z } from 'zod';

import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { startProcess, terminateChildTree, withSpawn } from '@/platform/promise-facade';
import type { NodeProcessApi } from '@lody/shared/node/process';
import type { TerminalManager } from '@/session/terminal-manager';
import {
  AgentClient,
  type AgentClientOptions,
  type AcpWriteTextFileEvidence,
  type AgentSessionWarning,
  type ImageGenerationBeginEvent,
  type ImageGenerationEndEvent,
  type AcpStartupStageEvent,
  type AcpStartupTimeoutOptions,
  type AcpSessionStartTarget,
} from './agent-client';
import { getLoginShellEnv } from './login-shell-env';
import {
  mergeACPProcessEnv,
  mergeLoginShellEnv,
  resolveACPProcessLaunch,
  resolveACPProcessLaunchAsync,
  withDefaultAcpPathEntries,
} from './setting';
import type { ManagedRuntimeProgressCallback } from '@/agent/managed-agent-runtime';
import type {
  ACPSessionId,
  AcpSessionNotification,
  AgentConfigCliType,
  BuiltinRuntimeOverrides,
  CustomAcpLaunchSpec,
  MachineId,
  MessageContent,
  SessionContextWindowUsage,
  SessionId,
  WorkspaceId,
} from '@lody/shared';

import { createStdinWritableStream, createStdoutReadableStream } from '@/utils/stream';
import type { RateLimit, SessionUsageUpdate } from 'acp-extension-core';
import {
  appendStderrTail,
  AcpStartupProcessError,
  AcpStartupProcessExitError,
  createAcpStartupMonitor,
} from './acp-startup-monitor';
import { withLodyNpmCacheForNpx } from './npx-cache';
import { resolveDeepSeekHarnessSpawn } from './deepseek-harness-runtime';
import { runNpxStartupWithRecovery } from './acp-npx-startup-policy';
import { truncateLogText } from '@/utils/log-format';
import {
  type AcpLauncher,
  captureAcpSpawnFailed,
  captureAcpSpawnStarted,
  classifyCliSpawnReason,
  resolveAcpLauncher,
} from './acp-analytics';
import { withoutElectronBootstrapCredentials } from '@/electron-bootstrap-env';
import { ACP_STARTUP_QUEUE_WAIT_TIMEOUT_MS } from '@lody/shared/acp-startup-budget';
import { withLoopbackNoProxy } from '@lody/shared/proxy-env';
import { withAcpSessionStartSlot } from './acp-session-start-gate';

export type CreateAcpClientOptions = {
  resolveWorktreeProject?: AgentClientOptions['resolveWorktreeProject'];
  stream: Stream;
  workdir: string;
  logger: Logger;
  terminalManager: TerminalManager;
  agentConfig?: {
    cliType: AgentConfigCliType;
    agentType: string;
  };
  modelId?: AgentClientOptions['modelId'];
  configOptionValues?: AgentClientOptions['configOptionValues'];
  /** Launcher family (npx/uvx/local) for ACP startup analytics; non-PII. */
  launcher?: AcpLauncher;
  resumeSessionId?: ACPSessionId;
  forkSessionId?: ACPSessionId;
  /** Provider-native turn id selected as the source boundary for a turn-addressed fork. */
  forkSessionTurnId?: string;
  /**
   * Overrides terminal capability advertisement. Builtin Grok defaults to false so its
   * adapter uses the native local runner; other agents default to true.
   */
  terminalEnabled?: boolean;
  workspaceId?: WorkspaceId;
  machineId?: MachineId;
  onStartupStage?: (event: AcpStartupStageEvent) => void;
  onUpdateMessage(message: AcpSessionNotification): void;
  onRequestPermission(
    requestId: string,
    request: RequestPermissionRequest
  ): Promise<RequestPermissionResponse>;
  onUsageUpdate?(usage: SessionUsageUpdate): void;
  onContextWindowUsageUpdate?(usage: SessionContextWindowUsage): void;
  onRateLimitUpdate?(limits: RateLimit): void;
  onThreadGoalUpdated?(goal: Extract<MessageContent, { type: 'goal' }>): void;
  onThreadGoalCleared?(threadId: string): void;
  onSessionTitleUpdate?(title: string): void;
  onAgentWarning?(warning: AgentSessionWarning): void;
  loadExternalMcpServers?: AgentClientOptions['loadExternalMcpServers'];
  onImageGenerationBegin?(event: ImageGenerationBeginEvent): void;
  onImageGenerationEnd?(event: ImageGenerationEndEvent): void;
  onWriteTextFile?(event: AcpWriteTextFileEvidence): void | Promise<void>;
  sessionId?: SessionId;
  startupTimeouts?: AcpStartupTimeoutOptions;
  startupAbort?: Promise<never>;
  resolveSessionStart?: () => Promise<AcpSessionStartTarget>;
};

export const createAcpClient = async (options: CreateAcpClientOptions) => {
  const sessionId = options.sessionId ?? (uuidV4() as SessionId);
  options.logger.debug(`[${sessionId}] createAcpClient: creating AgentClient`);
  const client = new AgentClient({
    logger: options.logger,
    sessionId,
    workspaceId: options.workspaceId,
    machineId: options.machineId,
    terminalManager: options.terminalManager,
    agentConfig: options.agentConfig,
    modelId: options.modelId,
    configOptionValues: options.configOptionValues,
    resolveWorktreeProject: options.resolveWorktreeProject,
    launcher: options.launcher,
    terminalEnabled: options.terminalEnabled,
    onStartupStage: options.onStartupStage,
    onUpdateMessage: options.onUpdateMessage,
    onRequestPermission: options.onRequestPermission,
    onUsageUpdate: options.onUsageUpdate,
    onContextWindowUsageUpdate: options.onContextWindowUsageUpdate,
    onRateLimitUpdate: options.onRateLimitUpdate,
    onThreadGoalUpdated: options.onThreadGoalUpdated,
    onThreadGoalCleared: options.onThreadGoalCleared,
    onSessionTitleUpdate: options.onSessionTitleUpdate,
    onAgentWarning: options.onAgentWarning,
    loadExternalMcpServers: options.loadExternalMcpServers,
    onImageGenerationBegin: options.onImageGenerationBegin,
    onImageGenerationEnd: options.onImageGenerationEnd,
    onWriteTextFile: options.onWriteTextFile,
  });
  options.logger.debug(`[${sessionId}] createAcpClient: AgentClient created, calling startSession`);
  const sessionResponse = await client.startSession(
    options.stream,
    options.workdir,
    options.resumeSessionId,
    options.startupTimeouts,
    options.startupAbort,
    options.resolveSessionStart,
    options.forkSessionId,
    options.forkSessionTurnId
  );
  options.logger.debug(
    `[${sessionId}] createAcpClient: startSession returned (acpSessionId=${sessionResponse.sessionId})`
  );
  return { client, acpSessionId: sessionResponse.sessionId as ACPSessionId, sessionResponse };
};

/**
 * Terminate a child from `spawnAcpProcess` together with everything it
 * started: SIGTERM to its process group (tree on Windows), `exitTimeoutMs` of
 * grace, SIGKILL, then a bounded wait. Rejects with `TerminationFailed` when
 * the tree cannot be proven gone.
 *
 * TEMPORARY facade: auxiliary ACP agents become scoped processes once the
 * ACP connection layer is an Effect.
 */
export async function terminateAcpProcessTree(
  child: ChildProcess,
  options: {
    logger: Logger;
    sessionLabel: string;
    exitTimeoutMs: number;
    /** Skip SIGTERM: for probes whose output no longer matters. */
    force?: boolean;
    nodeProcess?: NodeProcessApi;
  }
): Promise<void> {
  await terminateChildTree(
    child,
    {
      graceMs: options.force ? 0 : options.exitTimeoutMs,
      killWaitMs: options.exitTimeoutMs,
      processGroup: true,
    },
    {
      logger: options.logger,
      logPrefix: `[${options.sessionLabel}]`,
      nodeProcess: options.nodeProcess,
    }
  );
}

export type SpawnAcpProcessOptions = {
  cliType: AgentConfigCliType;
  agentType: string;
  customAcp?: CustomAcpLaunchSpec;
  runtimeOverrides?: BuiltinRuntimeOverrides;
  workdir: string;
  env: NodeJS.ProcessEnv;
  args?: string[];
  command?: string;
  spawnImpl?: NodeProcessApi['spawn'];
};

export const spawnAcpProcess = (options: SpawnAcpProcessOptions): ChildProcess => {
  // Resolve defaults only when the caller did not already supply both command and
  // args. Binary-distribution agents are resolved asynchronously upstream (they
  // pass explicit command/args here), so we must NOT call the synchronous
  // resolver for them — it throws for binary-only agents.
  let command = options.command;
  let args = options.args;
  if (command === undefined || args === undefined) {
    const launch = resolveACPProcessLaunch({
      cliType: options.cliType,
      agentType: options.agentType,
      customAcp: options.customAcp,
      runtimeOverrides: options.runtimeOverrides,
    });
    command = command ?? launch.command;
    args = args ?? launch.args;
  }
  const executable = resolveDeepSeekHarnessSpawn({
    command,
    args,
    env: options.env,
    workdir: options.workdir,
  });

  // Its own process group on POSIX (a tree rooted at it on Windows), so
  // `terminateAcpProcessTree` reaches everything the agent starts.
  return startProcess(
    {
      command: executable.command,
      args: executable.args,
      options: { cwd: options.workdir, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] },
      processGroup: true,
    },
    withSpawn(options.spawnImpl)
  ).child;
};

export type StartLocalAcpAgentOptions = {
  codexProfile?: CodexProfileExecution;
  cliType: AgentConfigCliType;
  agentType: string;
  customAcp?: CustomAcpLaunchSpec;
  runtimeOverrides?: BuiltinRuntimeOverrides;
  workdir: string;
  env?: NodeJS.ProcessEnv;
  logger: Logger;
  terminalManager: TerminalManager;
  /** Set to false to disable terminal capability advertisement. Defaults to true. */
  terminalEnabled?: boolean;
  onUpdateMessage(message: AcpSessionNotification): void;
  onRequestPermission(
    requestId: string,
    request: RequestPermissionRequest
  ): Promise<RequestPermissionResponse>;
  onManagedRuntimeProgress?: ManagedRuntimeProgressCallback;
  signal?: AbortSignal;
  extraArgs?: string[];
  spawnImpl?: NodeProcessApi['spawn'];
};

const CodexConfigOverrideSchema = z.record(z.string(), z.unknown());

function prepareCodexHomeEnv(
  options: Pick<StartLocalAcpAgentOptions, 'cliType' | 'agentType' | 'workdir'>,
  baseEnv: NodeJS.ProcessEnv
): {
  env: NodeJS.ProcessEnv;
  isTitleAgentCodexRun: boolean;
  shouldUseWorkdirCodexHome: boolean;
} {
  const isBuiltinCodex = options.cliType === 'builtin' && options.agentType === 'codex';
  const isTitleAgentCodexRun = isBuiltinCodex && baseEnv.LODY_TITLE_AGENT === '1';
  const shouldUseWorkdirCodexHome =
    isBuiltinCodex && !baseEnv.CODEX_HOME && (baseEnv.LODY_E2E === '1' || isTitleAgentCodexRun);

  return {
    env: shouldUseWorkdirCodexHome
      ? { ...baseEnv, CODEX_HOME: path.join(options.workdir, '.codex') }
      : baseEnv,
    isTitleAgentCodexRun,
    shouldUseWorkdirCodexHome,
  };
}

function withTitleAgentCodexConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const existingConfig = env.CODEX_CONFIG
    ? CodexConfigOverrideSchema.parse(JSON.parse(env.CODEX_CONFIG))
    : {};

  return {
    ...env,
    CODEX_CONFIG: JSON.stringify({
      ...existingConfig,
      project_doc_max_bytes: 0,
      include_environment_context: false,
      skills: {
        include_instructions: false,
        bundled: { enabled: false },
      },
    }),
  };
}

function copyTitleAgentCodexConfig(sourcePath: string, destinationPath: string): void {
  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, destinationPath);
  }
}

export const __test__ = {
  copyTitleAgentCodexConfig,
  prepareCodexHomeEnv,
  withTitleAgentCodexConfig,
};

export const startLocalAcpAgent = async (options: StartLocalAcpAgentOptions) => {
  options.signal?.throwIfAborted();
  // Async resolve so registry agents distributed as a platform binary are
  // downloaded/unpacked on demand before spawn (no-op for builtin/npx/uvx/local).
  const launch = await resolveACPProcessLaunchAsync({
    cliType: options.cliType,
    agentType: options.agentType,
    customAcp: options.customAcp,
    runtimeOverrides: options.runtimeOverrides,
    env: options.env,
    extraArgs: options.extraArgs,
    onManagedRuntimeProgress: options.onManagedRuntimeProgress
      ? (event) => {
          if (!options.signal?.aborted) {
            options.onManagedRuntimeProgress?.(event);
          }
        }
      : undefined,
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  const launcher: AcpLauncher = resolveAcpLauncher(launch.command);
  const spawnAnalyticsProps = {
    cliType: options.cliType,
    agentType: options.agentType,
    launcher,
    isResume: false,
  };

  const baseEnv = withoutElectronBootstrapCredentials(
    options.codexProfile
      ? codexProfileEnvironment(options.codexProfile.profile, options.env ?? process.env)
      : (options.env ?? process.env)
  );
  // Codex CLI reads config from `~/.codex` by default. E2E and title-agent runs use a temporary,
  // repo-local Codex home so their rollout/history state stays isolated. A title agent copies the
  // user's config into that home because custom model-provider routing and authentication must stay
  // together; title-specific restrictions are then applied through the adapter's per-session
  // CODEX_CONFIG overlay.
  //
  // Docs: Codex checks the "Codex home" dir (default `~/.codex`, overridable with `CODEX_HOME`)
  // for `config.toml` and other profile state.
  const { env, isTitleAgentCodexRun, shouldUseWorkdirCodexHome } = prepareCodexHomeEnv(
    options,
    baseEnv
  );
  // Spawning ACP agents from a GUI/daemon launch inherits a minimal PATH that
  // omits user tool dirs, so resolve the login-shell env and overlay it before
  // merging the agent-specific env. withDefaultAcpPathEntries still runs as a
  // last-resort fallback for environments where the shell probe yields nothing.
  const loginShellEnv = await getLoginShellEnv();
  // withLoopbackNoProxy runs outermost so a proxy contributed by the login
  // shell is covered too: the agent reaches Lody's MCP HTTP host over
  // loopback, and a proxy that intercepts that kills MCP entirely.
  const mergedStartupEnv = withLoopbackNoProxy(
    withoutElectronBootstrapCredentials(
      withLodyNpmCacheForNpx(
        launch.command,
        withDefaultAcpPathEntries(
          mergeACPProcessEnv(launch, mergeLoginShellEnv(env, loginShellEnv)),
          options.agentType
        )
      )
    )
  );
  const envWithAcpStartup = isTitleAgentCodexRun
    ? withTitleAgentCodexConfig(mergedStartupEnv)
    : mergedStartupEnv;

  const keepCodexHome = env.LODY_KEEP_CODEX_HOME === '1';
  const defaultCodexHome = path.join(os.homedir(), '.codex');
  const defaultAuthPath = path.join(defaultCodexHome, 'auth.json');
  const defaultConfigPath = path.join(defaultCodexHome, 'config.toml');
  const localAuthPath = env.CODEX_HOME ? path.join(env.CODEX_HOME, 'auth.json') : null;
  const localConfigPath = env.CODEX_HOME ? path.join(env.CODEX_HOME, 'config.toml') : null;
  // One spawn + startup attempt. Self-contained so the npx self-heal path can retry it
  // cleanly: the codex CODEX_HOME setup/cleanup lives inside, so a failed attempt's
  // teardown does not leak into the retry.
  let lastStderrTail = '';
  const attemptStart = async (
    attemptArgs: readonly string[],
    startupTimeouts?: AcpStartupTimeoutOptions
  ) => {
    options.signal?.throwIfAborted();
    lastStderrTail = '';
    if (shouldUseWorkdirCodexHome) {
      fs.mkdirSync(env.CODEX_HOME!, { recursive: true });
      if (isTitleAgentCodexRun && localConfigPath && fs.existsSync(defaultConfigPath)) {
        copyTitleAgentCodexConfig(defaultConfigPath, localConfigPath);
      }
      // Codex often expects `auth.json` in CODEX_HOME even when running via ACP in tests.
      // Copy it from the user's default Codex home if it exists, then delete it on exit to
      // avoid leaving credentials in temporary directories.
      if (localAuthPath && fs.existsSync(defaultAuthPath) && !fs.existsSync(localAuthPath)) {
        try {
          fs.copyFileSync(defaultAuthPath, localAuthPath);
        } catch {
          // Best-effort: let Codex fail with a clear auth error if copy is not possible.
        }
      }
    }

    const cleanupCodexHome = () => {
      if (!shouldUseWorkdirCodexHome || !env.CODEX_HOME || keepCodexHome) {
        return;
      }
      try {
        fs.rmSync(env.CODEX_HOME, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    captureAcpSpawnStarted(spawnAnalyticsProps);
    let agentProcess: ChildProcess;
    const releaseProfile =
      options.codexProfile?.profile.profile.mode === 'chatgpt'
        ? await registerCodexProfileProcess(options.codexProfile.profile)
        : undefined;
    let closeBroker: (() => Promise<void>) | undefined;
    const releaseResources = async () => {
      await closeBroker?.();
      await releaseProfile?.();
    };
    try {
      const prepared = options.codexProfile
        ? await codexProfileSpawnEnvironment(options.codexProfile, envWithAcpStartup)
        : { env: envWithAcpStartup, close: undefined };
      closeBroker = prepared.close;
      if (releaseProfile) prepared.env.LODY_CODEX_PROCESS_TOKEN = releaseProfile.token;
      agentProcess = spawnAcpProcess({
        cliType: options.cliType,
        agentType: options.agentType,
        workdir: options.workdir,
        env: prepared.env,
        command: launch.command,
        args: [...attemptArgs],
        spawnImpl: options.spawnImpl,
      });
      agentProcess.once('exit', () => {
        void releaseResources().catch(() => {});
      });
      agentProcess.once('error', () => {
        void (
          agentProcess.pid === undefined ? releaseProfile?.abandonBeforeSpawn() : releaseResources()
        )?.catch(() => {});
      });
    } catch (error) {
      await releaseProfile?.abandonBeforeSpawn();
      await releaseResources();
      // Synchronous spawn failure (e.g. spawnImpl throws). Async ENOENT/EACCES
      // surface later via the startup monitor and are captured in the catch below.
      cleanupCodexHome();
      captureAcpSpawnFailed({ ...spawnAnalyticsProps, reason: classifyCliSpawnReason(error) });
      throw error;
    }
    agentProcess.once('exit', cleanupCodexHome);
    agentProcess.once('error', cleanupCodexHome);
    options.logger.debug(
      `[acp-startup] spawned ACP process (cliType=${options.cliType} agentType=${options.agentType} workdir=${options.workdir})`
    );

    const stderrStream = agentProcess.stderr;
    let stderrTail = '';
    if (stderrStream) {
      stderrStream.setEncoding('utf8');
      stderrStream.on('data', (chunk: string) => {
        if (!chunk) return;
        stderrTail = appendStderrTail(stderrTail, chunk);
        lastStderrTail = stderrTail;
        options.logger.debug(
          `[acp-startup] stderr (${chunk.length} chars): ${truncateLogText(chunk, {
            maxChars: 1200,
            headChars: 900,
            tailChars: 180,
          })}`
        );
      });
    }

    const startupMonitor = createAcpStartupMonitor(
      {
        onExit: (listener) => {
          agentProcess.on('exit', listener);
          return () => {
            agentProcess.off('exit', listener);
          };
        },
        onError: (listener) => {
          agentProcess.on('error', listener);
          return () => {
            agentProcess.off('error', listener);
          };
        },
      },
      {
        sessionId: 'acp-startup',
        command: launch.command,
        args: [...attemptArgs],
        getStderrTail: () => stderrTail,
      }
    );

    // Create streams with proper buffering and backpressure handling.
    // See utils/stream.ts for details on race condition and backpressure fixes.
    if (!agentProcess.stdout) {
      throw new Error('Agent process stdout is not available');
    }
    if (!agentProcess.stdin) {
      throw new Error('Agent process stdin is not available');
    }

    const output = createStdoutReadableStream(agentProcess.stdout);
    const input = createStdinWritableStream(agentProcess.stdin);
    const stream = ndJsonStream(input, output);

    let rejectSignalAbort: ((error: DOMException) => void) | undefined;
    const signalAbort = options.signal
      ? new Promise<never>((_resolve, reject) => {
          rejectSignalAbort = reject;
        })
      : null;
    const handleSignalAbort = (): void => {
      rejectSignalAbort?.(new DOMException('ACP startup was cancelled', 'AbortError'));
    };
    options.signal?.addEventListener('abort', handleSignalAbort, { once: true });
    try {
      options.signal?.throwIfAborted();
      options.logger.debug('[acp-startup] creating ACP client');
      const started = await createAcpClient({
        stream,
        workdir: options.workdir,
        logger: options.logger,
        terminalManager: options.terminalManager,
        agentConfig: {
          cliType: options.cliType,
          agentType: options.agentType,
        },
        launcher,
        terminalEnabled: options.terminalEnabled,
        onUpdateMessage: options.onUpdateMessage,
        onRequestPermission: options.onRequestPermission,
        startupTimeouts,
        startupAbort: signalAbort
          ? Promise.race([startupMonitor.abortPromise, signalAbort])
          : startupMonitor.abortPromise,
      });
      options.signal?.throwIfAborted();
      options.logger.debug(`[acp-startup] ACP client ready (acpSessionId=${started.acpSessionId})`);
      return {
        agentProcess,
        client: started.client as AgentClient,
        acpSessionId: started.acpSessionId as ACPSessionId,
        sessionResponse: started.sessionResponse,
        capabilitySourceVersion: launch.capabilitySourceVersion,
      };
    } catch (error) {
      // The process died/failed to spawn before startup completed (the startup
      // monitor surfaces async ENOENT/EACCES/early-exit here). Protocol-level
      // failures are captured inside AgentClient.startSession, so only
      // spawn-level monitor errors are reported here to avoid double-counting.
      if (error instanceof AcpStartupProcessExitError || error instanceof AcpStartupProcessError) {
        captureAcpSpawnFailed({ ...spawnAnalyticsProps, reason: classifyCliSpawnReason(error) });
      }
      // Report a survivor, but keep the startup error: it is why the call failed.
      await terminateAcpProcessTree(agentProcess, {
        logger: options.logger,
        sessionLabel: 'acp-startup',
        exitTimeoutMs: 3000,
      }).catch((terminationError: unknown) => {
        options.logger.warn(
          `[acp-startup] ACP agent process could not be terminated after a failed start: ${formatErrorMessage(terminationError)}`
        );
      });

      throw error;
    } finally {
      options.signal?.removeEventListener('abort', handleSignalAbort);
      startupMonitor.dispose();
    }
  };

  return await withAcpSessionStartSlot(
    {
      label: `acp-startup:${options.agentType}`,
      logger: options.logger,
      abortSignal: options.signal,
      // This path is a capability refresh or a title run: both sit inside a
      // client-visible budget, and the queue ahead of them emits no progress
      // frame. Without a deadline here that wait is silence the client counts
      // against a machine that has not started working yet. Session restore
      // deliberately has no such bound — see the gate's options.
      waitTimeoutMs: ACP_STARTUP_QUEUE_WAIT_TIMEOUT_MS,
    },
    async () =>
      await runNpxStartupWithRecovery({
        command: launch.command,
        args: launch.args,
        env: envWithAcpStartup,
        logger: options.logger,
        logPrefix: '[acp-startup]',
        attempt: ({ args, startupTimeouts }) => attemptStart(args, startupTimeouts),
        getStderrTail: () => lastStderrTail,
      })
  );
};

export type ShutdownLocalAcpAgentOptions = {
  agentProcess: ChildProcess;
  client?: AgentClient | null;
  acpSessionId?: ACPSessionId | null;
  logger: Logger;
  sessionLabel: string;
  closeSessionTimeoutMs?: number;
  exitTimeoutMs?: number;
  /** Test seam for the OS process table. */
  nodeProcess?: NodeProcessApi;
};

export async function shutdownLocalAcpAgent(options: ShutdownLocalAcpAgentOptions): Promise<void> {
  const closeSessionTimeoutMs = Math.max(0, options.closeSessionTimeoutMs ?? 5000);
  const exitTimeoutMs = Math.max(1, options.exitTimeoutMs ?? 3000);

  if (options.client && options.acpSessionId) {
    try {
      await options.client.closeSession(options.acpSessionId, closeSessionTimeoutMs);
    } catch (error) {
      options.logger.debug(
        `[${options.sessionLabel}] ACP session close failed during local agent shutdown: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  try {
    await terminateAcpProcessTree(options.agentProcess, {
      logger: options.logger,
      sessionLabel: options.sessionLabel,
      exitTimeoutMs,
      nodeProcess: options.nodeProcess,
    });
  } catch (error) {
    // These probe, title, and login agents are never reused, so a survivor
    // cannot receive new work; it is a leak to surface, not a caller failure.
    options.logger.warn(
      `[${options.sessionLabel}] ACP agent process could not be terminated: ${formatErrorMessage(error)}`
    );
  }
}
import {
  codexProfileEnvironment,
  codexProfileSpawnEnvironment,
  registerCodexProfileProcess,
  type CodexProfileExecution,
} from './codex-profile-runtime';

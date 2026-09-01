import type { ChildProcess } from 'child_process';
import os from 'os';
import spawn from 'cross-spawn';
import type { AuthMethod } from '@agentclientprotocol/sdk';
import type {
  AgentConfigCliType,
  BuiltinCliType,
  BuiltinRuntimeOverrides,
  CustomAcpLaunchSpec,
} from '@lody/shared';
import {
  getManagedBuiltinRuntimeByAgentType,
  hasBuiltinEnvAuthentication,
  isManagedBuiltinAgentType,
} from '@lody/shared';

import { withoutElectronBootstrapCredentials } from '@/electron-bootstrap-env';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import {
  AcpAgentAuthorizationOutputParser,
  BuiltinAuthenticationOutputParser,
} from './acp-authentication-output';
import type {
  AcpAuthenticationControlResult,
  AcpAuthenticationProgressEvent,
  AcpAuthenticationResult,
} from './acp-authentication-types';
import {
  describeAcpAuthMethod,
  runAcpProtocolAuthentication,
  type AcpAdvertisedAuthMethod,
} from './acp-protocol-authentication';
import { shutdownLocalAcpAgent } from './acp-runner';
import { getLoginShellEnv } from './login-shell-env';
import { withLodyNpmCacheForNpx } from './npx-cache';
import {
  mergeACPProcessEnv,
  mergeLoginShellEnv,
  resolveACPProcessLaunchAsync,
  resolveBuiltinAuthenticationProcessLaunch,
  type ResolvedACPProcessLaunch,
  withDefaultAcpPathEntries,
} from './setting';

export type {
  AcpAuthenticationControlResult,
  AcpAuthenticationProgressEvent,
  AcpAuthenticationResult,
} from './acp-authentication-types';

// Finish before the UI/RPC 300s deadline, leaving enough time for graceful
// termination, SIGKILL escalation, and the final response to travel back.
const DEFAULT_AUTHENTICATION_TIMEOUT_MS = 285_000;
const DEFAULT_TERMINATION_GRACE_MS = 3_000;
const DEFAULT_STATUS_PROBE_TIMEOUT_MS = 15_000;

const BUILTIN_AUTH_METHODS = {
  kimi: [
    {
      id: 'login',
      name: 'Kimi Code',
      description: 'Sign in with Kimi Code',
      type: 'terminal',
      args: ['--login'],
    },
  ],
  grok: [
    {
      id: 'xai-device-login',
      name: 'xAI',
      description: 'Sign in with an xAI account',
      type: 'terminal',
      args: ['login', '--device-auth'],
    },
  ],
  claude: [
    {
      id: 'claude-ai-login',
      name: 'Claude subscription',
      description: 'Sign in with a Claude Pro, Max, Team, or Enterprise subscription',
      type: 'terminal',
      args: ['auth', 'login', '--claudeai'],
    },
  ],
  codex: [
    {
      id: 'chat-gpt',
      name: 'ChatGPT',
      description: 'Sign in with a ChatGPT account',
    },
  ],
} satisfies Record<BuiltinCliType, readonly AuthMethod[]>;

type RunningAuthentication = {
  child?: ChildProcess;
  requestId: string;
  cancelled: boolean;
  timedOut: boolean;
  terminating: boolean;
  acceptsAuthorizationCode: boolean;
  authorizationCodeSubmitted: boolean;
  /**
   * Aborts protocol authentication, whose work spans several processes and a
   * live JSON-RPC connection rather than a single login child.
   */
  readonly abort: AbortController;
};

type AcpAuthenticationManagerOptions = {
  authenticationTimeoutMs?: number;
  terminationGraceMs?: number;
  spawnProcess?: typeof spawn;
  resolveLoginShellEnv?: typeof getLoginShellEnv;
};

export type BuiltinAuthenticationProbeResult =
  | { status: 'authenticated' }
  | { status: 'unauthenticated'; authMethods: readonly AuthMethod[] }
  | { status: 'unknown' };

type ProbeBuiltinAuthenticationOptions = {
  cliType: AgentConfigCliType;
  agentType: string;
  runtimeOverrides?: BuiltinRuntimeOverrides;
  env?: NodeJS.ProcessEnv;
  onManagedRuntimeProgress?: Parameters<
    typeof resolveBuiltinAuthenticationProcessLaunch
  >[0]['onManagedRuntimeProgress'];
  logger: Logger;
  signal?: AbortSignal;
  statusProbeTimeoutMs?: number;
  spawnProcess?: typeof spawn;
  resolveLoginShellEnv?: typeof getLoginShellEnv;
};

function getBuiltinDisplayName(agentType: string): string {
  return getManagedBuiltinRuntimeByAgentType(agentType)?.displayName ?? agentType;
}

function formatAuthenticationExitError(
  agentType: BuiltinCliType,
  displayName: string,
  exitCode: number | null
): string {
  const base = `${displayName} authentication exited with code ${exitCode ?? 'unknown'}`;
  if (agentType !== 'codex') return base;
  return `${base}. Make sure device-code login is enabled in your ChatGPT security settings or workspace permissions, then try again.`;
}

async function buildAuthenticationProcessEnv(options: {
  launch: ResolvedACPProcessLaunch;
  agentType: string;
  env?: NodeJS.ProcessEnv;
  resolveLoginShellEnv: typeof getLoginShellEnv;
}): Promise<NodeJS.ProcessEnv> {
  const loginShellEnv = await options.resolveLoginShellEnv();
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    NO_COLOR: '1',
  };
  delete baseEnv.FORCE_COLOR;
  return withoutElectronBootstrapCredentials(
    withDefaultAcpPathEntries(
      mergeACPProcessEnv(options.launch, mergeLoginShellEnv(baseEnv, loginShellEnv)),
      options.agentType
    )
  );
}

/**
 * Uses the provider's official status command to distinguish missing local
 * credentials from an ACP startup failure. Kimi and Grok have no equivalent
 * lightweight status command. Codex's status command only describes its OpenAI
 * credential store and cannot account for custom model providers, so those ACP
 * adapters remain the source of truth.
 */
export async function probeBuiltinAuthentication(
  options: ProbeBuiltinAuthenticationOptions
): Promise<BuiltinAuthenticationProbeResult> {
  options.signal?.throwIfAborted();
  if (options.cliType !== 'builtin' || !isManagedBuiltinAgentType(options.agentType)) {
    return { status: 'unknown' };
  }
  if (
    options.agentType === 'kimi' ||
    options.agentType === 'grok' ||
    options.agentType === 'codex'
  ) {
    return { status: 'unknown' };
  }
  const launch = await resolveBuiltinAuthenticationProcessLaunch({
    cliType: options.cliType,
    agentType: options.agentType,
    runtimeOverrides: options.runtimeOverrides,
    action: 'status',
    onManagedRuntimeProgress: options.onManagedRuntimeProgress,
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  if (!launch) return { status: 'unknown' };

  const env = await buildAuthenticationProcessEnv({
    launch,
    agentType: options.agentType,
    env: options.env,
    resolveLoginShellEnv: options.resolveLoginShellEnv ?? getLoginShellEnv,
  });
  options.signal?.throwIfAborted();
  if (hasBuiltinEnvAuthentication(options.agentType, env)) {
    return { status: 'unknown' };
  }
  const child = (options.spawnProcess ?? spawn)(launch.command, launch.args, {
    cwd: os.homedir(),
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  const timeoutMs = Math.max(1, options.statusProbeTimeoutMs ?? DEFAULT_STATUS_PROBE_TIMEOUT_MS);
  const exit = await new Promise<{
    aborted?: boolean;
    code: number | null;
    error?: unknown;
    timedOut?: boolean;
  }>((resolve) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: {
      aborted?: boolean;
      code: number | null;
      error?: unknown;
      timedOut?: boolean;
    }): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener('abort', handleAbort);
      resolve(result);
    };
    const handleAbort = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may have exited between cancellation and the kill call.
      }
      finish({ aborted: true, code: null });
    };
    options.signal?.addEventListener('abort', handleAbort, { once: true });
    if (options.signal?.aborted) {
      handleAbort();
      return;
    }
    timeoutHandle = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may have exited between the timeout and kill call.
      }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    timeoutHandle.unref?.();
    child.once('error', (error) => finish({ code: null, error }));
    child.once('exit', (code) => finish({ code }));
  });

  if (exit.aborted) {
    throw new DOMException('ACP authentication probe was cancelled', 'AbortError');
  }
  if (exit.timedOut) {
    options.logger.debug(
      `[acp-auth] ${getBuiltinDisplayName(options.agentType)} status probe timed out; falling back to ACP`
    );
    return { status: 'unknown' };
  }
  if (exit.error !== undefined) {
    throw new Error(
      `${getBuiltinDisplayName(options.agentType)} authentication status failed: ${formatErrorMessage(exit.error)}`
    );
  }
  return exit.code === 0
    ? { status: 'authenticated' }
    : {
        status: 'unauthenticated',
        authMethods: BUILTIN_AUTH_METHODS[options.agentType],
      };
}

export type AcpAuthenticateOptions = {
  requestId: string;
  cliType: AgentConfigCliType;
  agentType: string;
  customAcp?: CustomAcpLaunchSpec;
  runtimeOverrides?: BuiltinRuntimeOverrides;
  env?: Record<string, string>;
  /** Which advertised ACP method to use; only meaningful for non-builtin agents. */
  methodId?: string;
  onProgress?: (event: AcpAuthenticationProgressEvent) => void;
};

type AuthenticationRunContext = {
  options: AcpAuthenticateOptions;
  running: RunningAuthentication;
  interruptedResult: () => AcpAuthenticationResult | null;
};

export class AcpAuthenticationManager {
  // Each builtin provider has one shared credential store, so concurrent login
  // attempts are intentionally keyed by agent type.
  private readonly runningByAgentType = new Map<string, RunningAuthentication>();
  private readonly authenticationTimeoutMs: number;
  private readonly terminationGraceMs: number;
  private readonly spawnProcess: typeof spawn;
  private readonly resolveLoginShellEnv: typeof getLoginShellEnv;

  constructor(
    private readonly logger: Logger,
    options: AcpAuthenticationManagerOptions = {}
  ) {
    this.authenticationTimeoutMs = Math.max(
      1,
      options.authenticationTimeoutMs ?? DEFAULT_AUTHENTICATION_TIMEOUT_MS
    );
    this.terminationGraceMs = Math.max(
      1,
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS
    );
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.resolveLoginShellEnv = options.resolveLoginShellEnv ?? getLoginShellEnv;
  }

  async authenticate(options: AcpAuthenticateOptions): Promise<AcpAuthenticationResult> {
    const managedBuiltinAgentType =
      options.cliType === 'builtin' && isManagedBuiltinAgentType(options.agentType)
        ? options.agentType
        : null;
    const displayName = managedBuiltinAgentType
      ? getBuiltinDisplayName(managedBuiltinAgentType)
      : options.agentType;

    if (this.runningByAgentType.has(options.agentType)) {
      return {
        success: false,
        disposition: 'error',
        error: `${displayName} authentication is already running`,
      };
    }

    const running: RunningAuthentication = {
      requestId: options.requestId,
      cancelled: false,
      timedOut: false,
      terminating: false,
      acceptsAuthorizationCode: false,
      authorizationCodeSubmitted: false,
      abort: new AbortController(),
    };
    // Reserve the slot before any async launch preparation. This makes
    // concurrent starts and cancellation deterministic even before spawn.
    this.runningByAgentType.set(options.agentType, running);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const interruptedResult = (): AcpAuthenticationResult | null => {
      if (running.cancelled) {
        options.onProgress?.({ status: 'cancelled' });
        return { success: true, disposition: 'cancelled' };
      }
      if (running.timedOut) {
        const error = `${displayName} authentication timed out. Please try again.`;
        options.onProgress?.({ status: 'error', error });
        return { success: false, disposition: 'error', error };
      }
      return null;
    };

    timeoutHandle = setTimeout(() => {
      if (running.cancelled) return;
      running.timedOut = true;
      if (!running.child && this.runningByAgentType.get(options.agentType) === running) {
        this.runningByAgentType.delete(options.agentType);
      }
      this.terminateAuthentication(options.agentType, running, 'timed out');
    }, this.authenticationTimeoutMs);
    timeoutHandle.unref?.();

    try {
      const result = managedBuiltinAgentType
        ? await this.runBuiltinLogin({
            options,
            running,
            interruptedResult,
            agentType: managedBuiltinAgentType,
            displayName,
          })
        : await this.runProtocolAuthentication({ options, running, interruptedResult });
      return result;
    } catch (error) {
      const interruption = interruptedResult();
      if (interruption) return interruption;
      const message = formatErrorMessage(error);
      options.onProgress?.({ status: 'error', error: message });
      return { success: false, disposition: 'error', error: message };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (this.runningByAgentType.get(options.agentType) === running) {
        this.runningByAgentType.delete(options.agentType);
      }
    }
  }

  /**
   * Managed builtin providers keep credentials in their own store, so Lody runs
   * the provider's official login command rather than talking ACP to it.
   */
  private async runBuiltinLogin(
    ctx: AuthenticationRunContext & { agentType: BuiltinCliType; displayName: string }
  ): Promise<AcpAuthenticationResult> {
    const { options, interruptedResult, agentType, displayName } = ctx;
    const launch = await resolveBuiltinAuthenticationProcessLaunch({
      cliType: options.cliType,
      agentType: options.agentType,
      runtimeOverrides: options.runtimeOverrides,
      action: 'login',
    });
    if (!launch) {
      throw new Error(`${displayName} authentication is unavailable`);
    }
    const launchInterruption = interruptedResult();
    if (launchInterruption) return launchInterruption;

    const env = await buildAuthenticationProcessEnv({
      launch,
      agentType: options.agentType,
      env: options.env,
      resolveLoginShellEnv: this.resolveLoginShellEnv,
    });
    const preparationInterruption = interruptedResult();
    if (preparationInterruption) return preparationInterruption;

    options.onProgress?.({ status: 'starting' });
    return await this.runLoginProcess({
      ...ctx,
      displayName,
      command: launch.command,
      args: launch.args,
      env,
      parser: new BuiltinAuthenticationOutputParser(agentType),
      formatExitError: (code) => formatAuthenticationExitError(agentType, displayName, code),
      acceptsAuthorizationCodeOnStdin: true,
    });
  }

  /**
   * Standard ACP authentication for registry and custom providers: the agent
   * itself advertises what it supports, so nothing here is provider-specific.
   */
  private async runProtocolAuthentication(
    ctx: AuthenticationRunContext
  ): Promise<AcpAuthenticationResult> {
    const { options, running, interruptedResult } = ctx;
    const launch = await resolveACPProcessLaunchAsync({
      cliType: options.cliType,
      agentType: options.agentType,
      customAcp: options.customAcp,
      runtimeOverrides: options.runtimeOverrides,
      signal: running.abort.signal,
    });
    const launchInterruption = interruptedResult();
    if (launchInterruption) return launchInterruption;

    const env = await this.buildAcpAuthenticationProcessEnv(launch, options, {
      protocolStdio: true,
    });
    const preparationInterruption = interruptedResult();
    if (preparationInterruption) return preparationInterruption;

    options.onProgress?.({ status: 'starting' });
    const outcome = await runAcpProtocolAuthentication({
      launch: { command: launch.command, args: launch.args },
      cliType: options.cliType,
      agentType: options.agentType,
      workdir: os.homedir(),
      env,
      methodId: options.methodId,
      logger: this.logger,
      signal: running.abort.signal,
      onProgress: options.onProgress,
      attachProcess: (child) => {
        running.child = child;
      },
      spawnProcess: this.spawnProcess,
    });
    const outcomeInterruption = interruptedResult();
    if (outcomeInterruption) return outcomeInterruption;

    if (outcome.kind === 'authenticated') {
      options.onProgress?.({ status: 'authenticated' });
      return { success: true, disposition: 'authenticated' };
    }
    if (outcome.kind === 'method-required') {
      return {
        success: true,
        disposition: 'method-required',
        authMethods: outcome.authMethods.map((method) => ({
          type: method.type,
          id: method.id,
          ...(method.name ? { name: method.name } : {}),
          ...(method.description ? { description: method.description } : {}),
        })),
      };
    }
    if (outcome.kind === 'terminal-method') {
      // The ACP process is gone; this method runs the agent binary as a TUI.
      running.child = undefined;
      return await this.runTerminalAuthMethod(ctx, outcome.method);
    }

    options.onProgress?.({ status: 'error', error: outcome.error });
    return { success: false, disposition: 'error', error: outcome.error };
  }

  private async runTerminalAuthMethod(
    ctx: AuthenticationRunContext,
    method: AcpAdvertisedAuthMethod
  ): Promise<AcpAuthenticationResult> {
    const { options, interruptedResult } = ctx;
    const displayName = describeAcpAuthMethod(method);
    const launch = await resolveACPProcessLaunchAsync({
      cliType: options.cliType,
      agentType: options.agentType,
      customAcp: options.customAcp,
      runtimeOverrides: options.runtimeOverrides,
      extraArgs: [...(method.args ?? [])],
      signal: ctx.running.abort.signal,
    });
    const launchInterruption = interruptedResult();
    if (launchInterruption) return launchInterruption;

    const env = await this.buildAcpAuthenticationProcessEnv(launch, options, {
      methodEnv: method.env,
    });
    const preparationInterruption = interruptedResult();
    if (preparationInterruption) return preparationInterruption;

    return await this.runLoginProcess({
      ...ctx,
      displayName,
      command: launch.command,
      args: launch.args,
      env,
      parser: new AcpAgentAuthorizationOutputParser(),
      formatExitError: (code) =>
        `${options.agentType} authentication exited with code ${code ?? 'unknown'}`,
      // Third-party agents never advertise how to feed a code back, and their
      // stdin may be a protocol channel; only pinned providers opt in.
      acceptsAuthorizationCodeOnStdin: false,
    });
  }

  private async buildAcpAuthenticationProcessEnv(
    launch: ResolvedACPProcessLaunch,
    options: AcpAuthenticateOptions,
    settings: {
      methodEnv?: Readonly<Record<string, string>>;
      /** The agent's stdout carries JSON-RPC rather than text for a human. */
      protocolStdio?: boolean;
    } = {}
  ): Promise<NodeJS.ProcessEnv> {
    const env = await buildAuthenticationProcessEnv({
      launch,
      agentType: options.agentType,
      env: settings.methodEnv ? { ...options.env, ...settings.methodEnv } : options.env,
      resolveLoginShellEnv: this.resolveLoginShellEnv,
    });
    if (settings.protocolStdio) {
      // An agent starting a browser sign-in inherits this stdio, and with no
      // display it falls back to a TERMINAL browser (w3m/lynx/links) that
      // renders the Google consent page onto the JSON-RPC channel. One rendered
      // line — an empty form field, `[    ]` — parses as a JSON-RPC batch, which
      // the connection rejects and closes, so `authenticate` fails on every
      // headless machine that happens to have a text browser installed.
      // Clearing TERM is what removes those browsers from the fallback list.
      delete env.TERM;
    }
    // Registry agents commonly launch through npx; keep them on Lody's isolated
    // npm cache exactly as ACP startup does.
    return withLodyNpmCacheForNpx(launch.command, env);
  }

  /** Spawns an interactive login process and turns its output into progress. */
  private async runLoginProcess(
    ctx: AuthenticationRunContext & {
      displayName: string;
      command: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      parser: BuiltinAuthenticationOutputParser | AcpAgentAuthorizationOutputParser;
      formatExitError: (exitCode: number | null) => string;
      acceptsAuthorizationCodeOnStdin: boolean;
    }
  ): Promise<AcpAuthenticationResult> {
    // `starting` is emitted by the caller: the terminal-method path already
    // announced itself before the discovery process ran.
    const { options, running, interruptedResult, displayName } = ctx;
    const child = this.spawnProcess(ctx.command, ctx.args, {
      cwd: os.homedir(),
      env: ctx.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    running.child = child;
    // Cancel/timeout between the last interruption check and spawn would
    // otherwise leave this process running until the overall deadline.
    if (running.cancelled || running.timedOut) {
      this.terminateAuthentication(
        options.agentType,
        running,
        running.cancelled ? 'cancelled' : 'timed out'
      );
    }
    child.stdin?.on('error', (error: unknown) => {
      this.logger.debug(
        `[acp-auth] ${displayName} authorization input failed: ${formatErrorMessage(error)}`
      );
    });

    const emitOutput = (stream: 'stdout' | 'stderr', chunk: unknown): void => {
      const output = String(chunk);
      if (output.length === 0) return;
      const authorization = ctx.parser.push(output);
      if (authorization) {
        running.acceptsAuthorizationCode =
          ctx.acceptsAuthorizationCodeOnStdin && authorization.acceptsAuthorizationCode === true;
        options.onProgress?.({ status: 'authorization', ...authorization });
      }
      // Retained temporarily for older renderer versions. Current UI consumes
      // the structured authorization event and does not render terminal text.
      options.onProgress?.({
        status: 'output',
        stream,
        output: output.slice(0, 16_384),
      });
    };
    child.stdout?.on('data', (chunk) => emitOutput('stdout', chunk));
    child.stderr?.on('data', (chunk) => emitOutput('stderr', chunk));

    const exit = await new Promise<{ code: number | null; error?: unknown }>((resolve) => {
      let settled = false;
      const finish = (result: { code: number | null; error?: unknown }): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.once('error', (error) => finish({ code: null, error }));
      child.once('exit', (code) => finish({ code }));
    });

    const processInterruption = interruptedResult();
    if (processInterruption) return processInterruption;
    if (exit.error !== undefined || exit.code !== 0) {
      const error =
        exit.error !== undefined ? formatErrorMessage(exit.error) : ctx.formatExitError(exit.code);
      options.onProgress?.({ status: 'error', error });
      return { success: false, disposition: 'error', error };
    }

    options.onProgress?.({ status: 'authenticated' });
    return { success: true, disposition: 'authenticated' };
  }

  cancel(agentType: string, requestId: string): AcpAuthenticationControlResult {
    const running = this.runningByAgentType.get(agentType);
    if (!running || running.requestId !== requestId) {
      return { success: true, disposition: 'not-running' };
    }

    running.cancelled = true;
    if (!running.child && this.runningByAgentType.get(agentType) === running) {
      this.runningByAgentType.delete(agentType);
    }
    this.terminateAuthentication(agentType, running, 'cancelled');
    return { success: true, disposition: 'cancelled' };
  }

  submitAuthorizationCode(
    agentType: string,
    requestId: string,
    authorizationCode: string
  ): AcpAuthenticationControlResult {
    const running = this.runningByAgentType.get(agentType);
    if (!running || running.requestId !== requestId) {
      return { success: true, disposition: 'not-running' };
    }
    if (!running.acceptsAuthorizationCode) {
      return {
        success: false,
        disposition: 'error',
        error: `${getBuiltinDisplayName(agentType)} is not waiting for an authorization code`,
      };
    }
    if (running.authorizationCodeSubmitted) {
      return {
        success: false,
        disposition: 'error',
        error: `${getBuiltinDisplayName(agentType)} authorization code was already submitted`,
      };
    }

    const normalizedCode = authorizationCode.trim();
    if (
      normalizedCode.length === 0 ||
      normalizedCode.length > 4096 ||
      normalizedCode.includes('\n') ||
      normalizedCode.includes('\r')
    ) {
      return { success: false, disposition: 'error', error: 'Invalid authorization code' };
    }
    const stdin = running.child?.stdin;
    if (!stdin || !stdin.writable || stdin.destroyed) {
      return {
        success: false,
        disposition: 'error',
        error: `${getBuiltinDisplayName(agentType)} is no longer accepting authorization input`,
      };
    }

    try {
      running.authorizationCodeSubmitted = true;
      stdin.end(`${normalizedCode}\n`);
      return { success: true, disposition: 'input-accepted' };
    } catch (error) {
      running.authorizationCodeSubmitted = false;
      return {
        success: false,
        disposition: 'error',
        error: formatErrorMessage(error),
      };
    }
  }

  private terminateAuthentication(
    agentType: string,
    running: RunningAuthentication,
    reason: 'cancelled' | 'timed out'
  ): void {
    // Protocol authentication spans launch preparation, a JSON-RPC wait, and
    // possibly a second process, so the signal is raised even with no child yet.
    running.abort.abort();
    if (running.terminating || !running.child) return;
    running.terminating = true;
    void shutdownLocalAcpAgent({
      agentProcess: running.child,
      logger: this.logger,
      sessionLabel: `acp-auth:${agentType}:${reason}`,
      exitTimeoutMs: this.terminationGraceMs,
    }).catch((error: unknown) => {
      this.logger.debug(
        `[acp-auth] Failed to terminate authentication process: ${formatErrorMessage(error)}`
      );
    });
  }
}

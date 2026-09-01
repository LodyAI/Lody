import type { ChildProcess } from 'child_process';
import os from 'os';
import spawn from 'cross-spawn';
import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import type { AuthMethod } from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type {
  AgentConfigCliType,
  BuiltinCliType,
  BuiltinRuntimeOverrides,
  CustomAcpLaunchSpec,
  MachineAcpAuthenticationForm,
} from '@lody/shared';
import {
  ACP_AUTHENTICATION_FORM_MAX_BYTES,
  ACP_AUTH_FORM_FIELD_MAX_COUNT,
  ACP_AUTH_ID_MAX_LENGTH,
  ACP_AUTH_LABEL_MAX_LENGTH,
  ACP_AUTH_METHOD_MAX_COUNT,
  ACP_AUTH_SELECT_OPTION_MAX_COUNT,
  ACP_AUTH_TEXT_MAX_LENGTH,
  ACP_AUTHORIZATION_URL_MAX_LENGTH,
  getLodyElicitationMeta,
  getManagedBuiltinRuntimeByAgentType,
  hasBuiltinEnvAuthentication,
  isAcpAuthenticationFormWithinByteLimit,
  isManagedBuiltinAgentType,
} from '@lody/shared';

import { withoutElectronBootstrapCredentials } from '@/electron-bootstrap-env';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import {
  AcpAgentAuthorizationOutputParser,
  BuiltinAuthenticationOutputParser,
} from './acp-authentication-output';
import { shutdownLocalAcpAgent, spawnAcpProcess } from './acp-runner';
import { createStdinWritableStream, createStdoutReadableStream } from '@/utils/stream';
import { getLoginShellEnv } from './login-shell-env';
import { appendStderrTail, createAcpStartupMonitor } from './acp-startup-monitor';
import { runNpxStartupWithRecovery } from './acp-npx-startup-policy';
import { withLodyNpmCacheForNpx } from './npx-cache';
import { withAcpSessionStartSlot } from './acp-session-start-gate';
import { withLoopbackNoProxy } from '@lody/shared/proxy-env';
import {
  mergeACPProcessEnv,
  mergeLoginShellEnv,
  resolveACPProcessLaunchAsync,
  resolveBuiltinAuthenticationProcessLaunch,
  type ResolvedACPProcessLaunch,
  withDefaultAcpPathEntries,
} from './setting';

export type AcpAuthenticationProgressEvent =
  | { status: 'starting' }
  | { status: 'auth-methods'; interactionId: string; authMethods: AuthMethod[] }
  | {
      status: 'authorization';
      authorizationUrl: string;
      userCode?: string;
      acceptsAuthorizationCode?: boolean;
      expiresInSeconds?: number;
      interactionId?: string;
      message?: string;
      requiresAuthorizationConsent?: boolean;
    }
  | {
      status: 'input-required';
      interactionId: string;
      message: string;
      form: MachineAcpAuthenticationForm;
    }
  | { status: 'output'; stream: 'stdout' | 'stderr'; output: string }
  | { status: 'authenticated' }
  | { status: 'cancelled' }
  | { status: 'error'; error: string };

export type AcpAuthenticationResult =
  | {
      success: true;
      disposition: 'authenticated' | 'cancelled' | 'not-running' | 'input-accepted';
    }
  | {
      success: false;
      disposition: 'error';
      error: string;
    };

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
  abortController: AbortController;
  pendingInteraction?: {
    id: string;
    resolve: (input: AcpAuthenticationInteractionInput) => void;
  };
};

type AcpAuthenticationInteractionInput =
  | { action: 'accept'; methodId?: string; content?: Record<string, unknown> }
  | { action: 'decline' | 'cancel' };

const AcpAuthenticationInteractionInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('accept'),
      methodId: z.string().trim().min(1).max(ACP_AUTH_ID_MAX_LENGTH).optional(),
      content: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z.object({ action: z.enum(['decline', 'cancel']) }).strict(),
]);

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

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function isAllowedAuthorizationUrl(value: string): boolean {
  if (value.length > ACP_AUTHORIZATION_URL_MAX_LENGTH) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function toAuthenticationForm(
  request: acp.CreateElicitationRequest
): MachineAcpAuthenticationForm | null {
  const rawRequest = asRecord(request);
  const schema = asRecord(rawRequest?.requestedSchema);
  const properties = asRecord(schema?.properties);
  if (!rawRequest || rawRequest.mode !== 'form' || !schema || !properties) return null;
  const propertyEntries = Object.entries(properties);
  if (propertyEntries.length === 0 || propertyEntries.length > ACP_AUTH_FORM_FIELD_MAX_COUNT) {
    return null;
  }
  if (
    (typeof schema.title === 'string' && schema.title.length > ACP_AUTH_LABEL_MAX_LENGTH) ||
    (typeof schema.description === 'string' && schema.description.length > ACP_AUTH_TEXT_MAX_LENGTH)
  ) {
    return null;
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((value) => typeof value !== 'string'))
  ) {
    return null;
  }
  const required = new Set((schema.required as string[] | undefined) ?? []);
  if ([...required].some((id) => !Object.hasOwn(properties, id))) return null;
  const fields: MachineAcpAuthenticationForm['fields'] = [];
  for (const [id, rawProperty] of propertyEntries) {
    const property = asRecord(rawProperty);
    if (!property || property.type !== 'string') return null;
    const label = typeof property.title === 'string' && property.title.trim() ? property.title : id;
    const description = typeof property.description === 'string' ? property.description : undefined;
    if (
      !id.trim() ||
      id.length > ACP_AUTH_ID_MAX_LENGTH ||
      !label.trim() ||
      label.length > ACP_AUTH_LABEL_MAX_LENGTH ||
      (description?.length ?? 0) > ACP_AUTH_TEXT_MAX_LENGTH
    ) {
      return null;
    }
    const meta = asRecord(property._meta);
    const secret =
      getLodyElicitationMeta(property._meta)?.secret === true ||
      meta?.secret === true ||
      meta?.sensitive === true ||
      property.format === 'password';
    // Defaults travel in retained Machine RPC progress. Never copy a secret
    // default into that durable progress stream, even if the provider supplied one.
    const defaultValue =
      !secret && typeof property.default === 'string' ? property.default : undefined;
    if ((defaultValue?.length ?? 0) > ACP_AUTH_TEXT_MAX_LENGTH) return null;
    if (
      (property.oneOf !== undefined && !Array.isArray(property.oneOf)) ||
      (property.enum !== undefined && !Array.isArray(property.enum))
    ) {
      return null;
    }
    const titledOptions = Array.isArray(property.oneOf)
      ? property.oneOf.map((rawOption) => {
          const option = asRecord(rawOption);
          if (!option || typeof option.const !== 'string' || !option.const) return null;
          const optionLabel =
            typeof option.title === 'string' && option.title.trim() ? option.title : option.const;
          return { value: option.const, label: optionLabel };
        })
      : [];
    const enumOptions = Array.isArray(property.enum)
      ? property.enum.map((value) =>
          typeof value === 'string' && value ? { value, label: value } : null
        )
      : [];
    if (
      titledOptions.some((option) => option === null) ||
      enumOptions.some((option) => option === null)
    ) {
      return null;
    }
    const options = titledOptions.length > 0 ? titledOptions : enumOptions;
    if (
      ((Array.isArray(property.oneOf) || Array.isArray(property.enum)) && options.length === 0) ||
      options.length > ACP_AUTH_SELECT_OPTION_MAX_COUNT ||
      options.some(
        (option) =>
          option === null ||
          option.value.length > ACP_AUTH_TEXT_MAX_LENGTH ||
          option.label.length > ACP_AUTH_LABEL_MAX_LENGTH
      )
    ) {
      return null;
    }
    if (options.length > 0) {
      if (new Set(options.map((option) => option?.value)).size !== options.length) {
        return null;
      }
      if (defaultValue !== undefined && !options.some((option) => option?.value === defaultValue)) {
        return null;
      }
      fields.push({
        id,
        type: 'select',
        label,
        ...(description !== undefined ? { description } : {}),
        required: required.has(id),
        options: options.filter((option): option is { value: string; label: string } => !!option),
        ...(defaultValue !== undefined ? { defaultValue } : {}),
      });
      continue;
    }
    fields.push(
      secret
        ? {
            id,
            type: 'secret',
            label,
            ...(description !== undefined ? { description } : {}),
            required: required.has(id),
          }
        : {
            id,
            type: 'text',
            label,
            ...(description !== undefined ? { description } : {}),
            required: required.has(id),
            ...(defaultValue !== undefined ? { defaultValue } : {}),
          }
    );
  }
  if (fields.length === 0) return null;
  const form = {
    title: typeof schema.title === 'string' ? schema.title : undefined,
    description: typeof schema.description === 'string' ? schema.description : undefined,
    fields,
  };
  return isAcpAuthenticationFormWithinByteLimit(form) ? form : null;
}

function getAuthMethodType(method: AuthMethod): 'agent' | 'env_var' | 'terminal' {
  const type = asRecord(method)?.type;
  return type === 'env_var' || type === 'terminal' ? type : 'agent';
}

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
  return withLoopbackNoProxy(
    withoutElectronBootstrapCredentials(
      withLodyNpmCacheForNpx(
        options.launch.command,
        withDefaultAcpPathEntries(
          mergeACPProcessEnv(options.launch, mergeLoginShellEnv(baseEnv, loginShellEnv)),
          options.agentType
        )
      )
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

  async authenticate(options: {
    requestId: string;
    cliType: AgentConfigCliType;
    agentType: string;
    customAcp?: CustomAcpLaunchSpec;
    runtimeOverrides?: BuiltinRuntimeOverrides;
    env?: Record<string, string>;
    methodId?: string;
    onProgress?: (event: AcpAuthenticationProgressEvent) => void;
  }): Promise<AcpAuthenticationResult> {
    const isBuiltinAuthentication =
      options.cliType === 'builtin' && isManagedBuiltinAgentType(options.agentType);
    const displayName = isBuiltinAuthentication
      ? getBuiltinDisplayName(options.agentType)
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
      abortController: new AbortController(),
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
      running.abortController.abort();
      running.pendingInteraction?.resolve({ action: 'cancel' });
      running.pendingInteraction = undefined;
      if (!running.child && this.runningByAgentType.get(options.agentType) === running) {
        this.runningByAgentType.delete(options.agentType);
      }
      this.terminateAuthentication(options.agentType, running, 'timed out');
    }, this.authenticationTimeoutMs);
    timeoutHandle.unref?.();

    try {
      if (!isBuiltinAuthentication) {
        return await this.authenticateProtocolDrivenAcp(options, running);
      }
      const agentType = options.agentType as BuiltinCliType;
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
      const child = this.spawnProcess(launch.command, launch.args, {
        cwd: os.homedir(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      running.child = child;
      child.stdin?.on('error', (error: unknown) => {
        this.logger.debug(
          `[acp-auth] ${displayName} authorization input failed: ${formatErrorMessage(error)}`
        );
      });

      const outputParser = new BuiltinAuthenticationOutputParser(agentType);

      const emitOutput = (stream: 'stdout' | 'stderr', chunk: unknown): void => {
        const output = String(chunk);
        if (output.length === 0) return;
        const authorization = outputParser.push(output);
        if (authorization) {
          running.acceptsAuthorizationCode = authorization.acceptsAuthorizationCode === true;
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
          exit.error !== undefined
            ? formatErrorMessage(exit.error)
            : formatAuthenticationExitError(agentType, displayName, exit.code);
        options.onProgress?.({ status: 'error', error });
        return { success: false, disposition: 'error', error };
      }

      options.onProgress?.({ status: 'authenticated' });
      return { success: true, disposition: 'authenticated' };
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

  cancel(agentType: string, requestId: string): AcpAuthenticationResult {
    const running = this.runningByAgentType.get(agentType);
    if (!running || running.requestId !== requestId) {
      return { success: true, disposition: 'not-running' };
    }

    running.cancelled = true;
    running.abortController.abort();
    running.pendingInteraction?.resolve({ action: 'cancel' });
    running.pendingInteraction = undefined;
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
  ): AcpAuthenticationResult {
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

  submitAuthenticationInput(
    agentType: string,
    requestId: string,
    interactionId: string,
    authenticationInput: string
  ): AcpAuthenticationResult {
    const running = this.runningByAgentType.get(agentType);
    if (!running || running.requestId !== requestId) {
      return { success: true, disposition: 'not-running' };
    }
    const pending = running.pendingInteraction;
    if (!pending || pending.id !== interactionId) {
      return {
        success: false,
        disposition: 'error',
        error: `${getBuiltinDisplayName(agentType)} is not waiting for this authentication input`,
      };
    }
    const parsedJson = (() => {
      try {
        return JSON.parse(authenticationInput) as unknown;
      } catch {
        return null;
      }
    })();
    const parsed = AcpAuthenticationInteractionInputSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return { success: false, disposition: 'error', error: 'Invalid authentication input' };
    }
    running.pendingInteraction = undefined;
    pending.resolve(parsed.data);
    return { success: true, disposition: 'input-accepted' };
  }

  private waitForAuthenticationInput(
    running: RunningAuthentication,
    interactionId: string
  ): Promise<AcpAuthenticationInteractionInput> | null {
    // The renderer presents one authentication interaction at a time. Decline
    // a concurrent request instead of replacing the active resolver and
    // leaving the first ACP request hung until the global timeout.
    if (running.pendingInteraction) {
      return null;
    }
    return new Promise((resolve) => {
      running.pendingInteraction = { id: interactionId, resolve };
      if (running.abortController.signal.aborted) {
        running.pendingInteraction = undefined;
        resolve({ action: 'cancel' });
      }
    });
  }

  private async authenticateProtocolDrivenAcp(
    options: {
      requestId: string;
      cliType: AgentConfigCliType;
      agentType: string;
      customAcp?: CustomAcpLaunchSpec;
      runtimeOverrides?: BuiltinRuntimeOverrides;
      env?: Record<string, string>;
      methodId?: string;
      onProgress?: (event: AcpAuthenticationProgressEvent) => void;
    },
    running: RunningAuthentication
  ): Promise<AcpAuthenticationResult> {
    const launch = await resolveACPProcessLaunchAsync({
      cliType: options.cliType,
      agentType: options.agentType,
      customAcp: options.customAcp,
      runtimeOverrides: options.runtimeOverrides,
      signal: running.abortController.signal,
    });
    const env = await buildAuthenticationProcessEnv({
      launch,
      agentType: options.agentType,
      env: options.env,
      resolveLoginShellEnv: this.resolveLoginShellEnv,
    });
    // The process stdout is the ACP JSON-RPC channel. In a headless shell,
    // TERM can make browser launchers fall back to w3m/lynx and render HTML
    // onto stdout, corrupting that channel.
    delete env.TERM;
    running.abortController.signal.throwIfAborted();
    let lastStderrTail = '';
    await withAcpSessionStartSlot(
      {
        label: `acp-auth:${options.agentType}`,
        logger: this.logger,
        abortSignal: running.abortController.signal,
      },
      async () =>
        await runNpxStartupWithRecovery({
          command: launch.command,
          args: launch.args,
          env,
          logger: this.logger,
          logPrefix: '[acp-auth]',
          getStderrTail: () => lastStderrTail,
          attempt: async ({ args }) => {
            running.abortController.signal.throwIfAborted();
            lastStderrTail = '';
            options.onProgress?.({ status: 'starting' });
            const child = spawnAcpProcess({
              cliType: options.cliType,
              agentType: options.agentType,
              customAcp: options.customAcp,
              runtimeOverrides: options.runtimeOverrides,
              workdir: process.cwd(),
              env,
              command: launch.command,
              args: [...args],
              spawnImpl: this.spawnProcess,
            });
            running.child = child;
            running.terminating = false;
            child.stderr?.setEncoding('utf8');
            const authorizationParser = new AcpAgentAuthorizationOutputParser();
            child.stderr?.on('data', (chunk: string) => {
              // Keep only an in-memory tail for the existing npx recovery
              // classifier. Authentication process output is never forwarded
              // into retained Machine RPC progress.
              lastStderrTail = appendStderrTail(lastStderrTail, chunk);
              const authorization = authorizationParser.push(chunk);
              if (authorization && isAllowedAuthorizationUrl(authorization.authorizationUrl)) {
                options.onProgress?.({ status: 'authorization', ...authorization });
              }
            });
            const startupMonitor = createAcpStartupMonitor(
              {
                onExit: (listener) => {
                  child.on('exit', listener);
                  return () => child.off('exit', listener);
                },
                onError: (listener) => {
                  child.on('error', listener);
                  return () => child.off('error', listener);
                },
              },
              {
                sessionId: `acp-auth:${options.agentType}`,
                command: launch.command,
                args: [...args],
                // Do not attach provider output to an error that crosses the
                // Machine RPC boundary.
                getStderrTail: () => '',
              }
            );

            try {
              running.abortController.signal.throwIfAborted();
              if (!child.stdin || !child.stdout) {
                throw new Error(`${options.agentType} ACP authentication streams are unavailable`);
              }
              let interactionError: string | undefined;
              const app = acp
                .client({ name: 'lody-authentication' })
                .onRequest(acp.methods.client.elicitation.create, async ({ params }) => {
                  const raw = asRecord(params);
                  if (raw?.mode === 'url') {
                    if (typeof raw.url !== 'string' || !isAllowedAuthorizationUrl(raw.url)) {
                      const error = `${options.agentType} requested an unsafe authentication URL. Lody only opens HTTP and HTTPS authorization pages.`;
                      interactionError = error;
                      this.logger.debug(`[acp-auth] ${error}`);
                      options.onProgress?.({ status: 'error', error });
                      return { action: 'decline' as const };
                    }
                    const interactionId = randomUUID();
                    const inputPromise = this.waitForAuthenticationInput(running, interactionId);
                    if (!inputPromise) return { action: 'decline' as const };
                    options.onProgress?.({
                      status: 'authorization',
                      authorizationUrl: raw.url,
                      interactionId,
                      message:
                        typeof raw.message === 'string'
                          ? raw.message.slice(0, ACP_AUTH_TEXT_MAX_LENGTH)
                          : undefined,
                      requiresAuthorizationConsent: true,
                    });
                    const input = await inputPromise;
                    return input.action === 'accept'
                      ? { action: 'accept' as const }
                      : { action: input.action };
                  }
                  const form = toAuthenticationForm(params);
                  if (!form) {
                    const error = `${options.agentType} requested an unsupported authentication form or one larger than Lody's ${ACP_AUTHENTICATION_FORM_MAX_BYTES / 1024} KiB limit. Lody currently supports text, secret, and single-select fields.`;
                    interactionError = error;
                    this.logger.debug(`[acp-auth] ${error}`);
                    options.onProgress?.({ status: 'error', error });
                    return { action: 'decline' as const };
                  }
                  const interactionId = randomUUID();
                  const inputPromise = this.waitForAuthenticationInput(running, interactionId);
                  if (!inputPromise) return { action: 'decline' as const };
                  options.onProgress?.({
                    status: 'input-required',
                    interactionId,
                    message:
                      typeof raw?.message === 'string'
                        ? raw.message.slice(0, ACP_AUTH_TEXT_MAX_LENGTH)
                        : `Enter the information requested by ${options.agentType}`,
                    form,
                  });
                  const input = await inputPromise;
                  return input.action === 'accept'
                    ? { action: 'accept' as const, content: input.content ?? {} }
                    : { action: input.action };
                });
              const stream = acp.ndJsonStream(
                createStdinWritableStream(child.stdin),
                createStdoutReadableStream(child.stdout)
              );
              await Promise.race([
                app.connectWith(stream, async (context) => {
                  const initialized = await context.request(
                    acp.methods.agent.initialize,
                    {
                      protocolVersion: acp.PROTOCOL_VERSION,
                      clientCapabilities: {
                        auth: { terminal: false },
                        elicitation: { form: {}, url: {} },
                      },
                      clientInfo: { name: 'lody', title: 'Lody', version: '1' },
                    },
                    { cancellationSignal: running.abortController.signal }
                  );
                  const advertisedMethods = [...(initialized.authMethods ?? [])];
                  const methods = advertisedMethods.filter(
                    (method) => getAuthMethodType(method) === 'agent'
                  );
                  if (methods.length === 0) {
                    const unsupportedTypes = new Set(
                      advertisedMethods.map((method) => getAuthMethodType(method))
                    );
                    const hasDeprecatedEnv = unsupportedTypes.has('env_var');
                    const hasUnsupportedTerminal = unsupportedTypes.has('terminal');
                    throw new Error(
                      hasDeprecatedEnv && hasUnsupportedTerminal
                        ? `${options.agentType} only advertised deprecated env_var and unsupported terminal authentication methods`
                        : hasDeprecatedEnv
                          ? `${options.agentType} only advertised the deprecated ACP env_var authentication method`
                          : hasUnsupportedTerminal
                            ? `${options.agentType} only advertised terminal authentication, which requires an interactive terminal that is not available over Machine RPC`
                            : `${options.agentType} did not advertise an authentication method`
                    );
                  }
                  if (
                    methods.length > ACP_AUTH_METHOD_MAX_COUNT ||
                    new Set(methods.map((method) => method.id)).size !== methods.length ||
                    methods.some(
                      (method) =>
                        typeof method.id !== 'string' ||
                        !method.id.trim() ||
                        method.id.length > ACP_AUTH_ID_MAX_LENGTH
                    )
                  ) {
                    throw new Error(
                      `${options.agentType} advertised too many or invalid authentication methods`
                    );
                  }
                  let methodId = options.methodId;
                  if (!methodId && methods.length === 1) {
                    methodId = methods[0]?.id;
                  }
                  if (!methodId) {
                    const interactionId = randomUUID();
                    const inputPromise = this.waitForAuthenticationInput(running, interactionId);
                    if (!inputPromise) {
                      throw new Error(
                        `${options.agentType} requested overlapping authentication interactions`
                      );
                    }
                    options.onProgress?.({
                      status: 'auth-methods',
                      interactionId,
                      authMethods: methods,
                    });
                    const input = await inputPromise;
                    if (input.action !== 'accept' || !input.methodId) {
                      throw new DOMException('ACP authentication was cancelled', 'AbortError');
                    }
                    methodId = input.methodId;
                  }
                  const selectedMethod = methods.find((method) => method.id === methodId);
                  if (!selectedMethod) {
                    const advertisedMethod = advertisedMethods.find(
                      (method) => method.id === methodId
                    );
                    if (advertisedMethod) {
                      throw new Error(
                        getAuthMethodType(advertisedMethod) === 'env_var'
                          ? `${options.agentType} authentication method ${methodId} uses deprecated env_var authentication`
                          : `${options.agentType} authentication method ${methodId} requires an interactive terminal that is not available over Machine RPC`
                      );
                    }
                    throw new Error(
                      `${options.agentType} no longer advertises authentication method ${methodId}`
                    );
                  }
                  await context.request(
                    acp.methods.agent.authenticate,
                    { methodId },
                    { cancellationSignal: running.abortController.signal }
                  );
                  if (interactionError) {
                    throw new Error(interactionError);
                  }
                }),
                startupMonitor.abortPromise,
              ]);
            } finally {
              running.pendingInteraction?.resolve({ action: 'cancel' });
              running.pendingInteraction = undefined;
              startupMonitor.dispose();
              await shutdownLocalAcpAgent({
                agentProcess: child,
                logger: this.logger,
                sessionLabel: `acp-auth:${options.agentType}:protocol`,
                exitTimeoutMs: this.terminationGraceMs,
              }).catch((error: unknown) => {
                this.logger.debug(
                  `[acp-auth] Failed to terminate protocol authentication process: ${formatErrorMessage(error)}`
                );
              });
              if (running.child === child) running.child = undefined;
            }
          },
        })
    );

    // Process shutdown is part of the bounded authentication workflow. A
    // cancellation or timeout that lands during cleanup must not be overwritten
    // by a late authenticated result.
    running.abortController.signal.throwIfAborted();
    options.onProgress?.({ status: 'authenticated' });
    return { success: true, disposition: 'authenticated' };
  }

  private terminateAuthentication(
    agentType: string,
    running: RunningAuthentication,
    reason: 'cancelled' | 'timed out'
  ): void {
    // Protocol authentication spans launch preparation, a JSON-RPC wait, and
    // possibly a second process, so the signal is raised even with no child yet.
    running.abortController.abort();
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

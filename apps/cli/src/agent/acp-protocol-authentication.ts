/**
 * Standard ACP authentication (`initialize` → `authenticate`) for agents Lody
 * does not ship a pinned login command for: registry and custom ACP providers.
 *
 * Managed builtin providers keep their own flow in `acp-authentication.ts` —
 * they authenticate through the provider's official CLI, whose credential store
 * the ACP adapter only reads. Everything else advertises what it supports in the
 * `initialize` response, so the method list is discovered from the agent rather
 * than hardcoded per provider.
 */
import type { ChildProcess } from 'child_process';
import * as acp from '@agentclientprotocol/sdk';
import type spawn from 'cross-spawn';

import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { createStdinWritableStream, createStdoutReadableStream } from '@/utils/stream';
import { AcpAgentAuthorizationOutputParser } from './acp-authentication-output';
import type { AcpAuthenticationProgressEvent } from './acp-authentication-types';
import { shutdownLocalAcpAgent, spawnAcpProcess } from './acp-runner';
import { appendStderrTail } from './acp-startup-monitor';

const ACP_AUTHENTICATION_INITIALIZE_TIMEOUT_MS = 60_000;
const AUTHENTICATION_TERMINATION_GRACE_MS = 3_000;

type SpawnProcess = typeof spawn;

/** Normalized view of an advertised method; `type` defaults to `agent` per spec. */
export type AcpAdvertisedAuthMethod = {
  readonly type: 'agent' | 'env_var' | 'terminal';
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
};

export type AcpProtocolAuthenticationOutcome =
  /** `authenticate` returned successfully. */
  | { readonly kind: 'authenticated' }
  /** The agent advertises several methods and the caller did not pick one. */
  | { readonly kind: 'method-required'; readonly authMethods: readonly AcpAdvertisedAuthMethod[] }
  /**
   * The selected method runs the agent binary in a terminal instead of going
   * over the protocol. The ACP process has already been shut down; the caller
   * runs the login command.
   */
  | { readonly kind: 'terminal-method'; readonly method: AcpAdvertisedAuthMethod }
  | { readonly kind: 'error'; readonly error: string };

export type RunAcpProtocolAuthenticationOptions = {
  /** Already-resolved executable; process env is built by the caller. */
  readonly launch: { command: string; args: string[] };
  readonly cliType: 'builtin' | 'registry' | 'custom';
  readonly agentType: string;
  readonly workdir: string;
  readonly env: NodeJS.ProcessEnv;
  /** Explicit user choice; omitted on the first attempt. */
  readonly methodId?: string;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: AcpAuthenticationProgressEvent) => void;
  /** Publishes the live child so the caller can terminate it on cancel/timeout. */
  readonly attachProcess?: (child: ChildProcess) => void;
  readonly initializeTimeoutMs?: number;
  readonly spawnProcess?: SpawnProcess;
};

function normalizeAcpAuthMethod(method: acp.AuthMethod): AcpAdvertisedAuthMethod | null {
  const record = method as unknown as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;
  const type =
    record.type === 'terminal' || record.type === 'env_var' ? record.type : ('agent' as const);
  const args =
    Array.isArray(record.args) && record.args.every((arg) => typeof arg === 'string')
      ? (record.args as string[])
      : undefined;
  const env =
    typeof record.env === 'object' && record.env !== null
      ? Object.fromEntries(
          Object.entries(record.env as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      : undefined;
  return {
    type,
    id,
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ...(args ? { args } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
  };
}

export function describeAcpAuthMethod(method: AcpAdvertisedAuthMethod): string {
  return method.name?.trim() ? method.name : method.id;
}

/** Environment-variable methods are configured on the agent, not signed into. */
function formatEnvVarAuthMethodError(
  method: acp.AuthMethod,
  normalized: AcpAdvertisedAuthMethod
): string {
  const vars = (method as unknown as { vars?: unknown }).vars;
  const names = Array.isArray(vars)
    ? vars
        .map((entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { name?: unknown }).name === 'string'
            ? (entry as { name: string }).name
            : null
        )
        .filter((name): name is string => Boolean(name))
    : [];
  const suffix = names.length > 0 ? `: ${names.join(', ')}` : '';
  return `${describeAcpAuthMethod(normalized)} authenticates through environment variables. Add them to this agent's environment in its settings${suffix}.`;
}

function selectAuthMethod(
  methods: readonly acp.AuthMethod[],
  methodId: string | undefined
): { method: acp.AuthMethod; normalized: AcpAdvertisedAuthMethod } | null {
  for (const method of methods) {
    const normalized = normalizeAcpAuthMethod(method);
    if (!normalized) continue;
    if (methodId === undefined || normalized.id === methodId) {
      return { method, normalized };
    }
  }
  return null;
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs
    );
    timeoutHandle.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });
}

/**
 * Spawns the agent, runs `initialize`, and — once a single method is settled on
 * — `authenticate`. The process is always shut down before returning: the agent
 * persists its own credentials, and the session that follows starts a fresh one.
 */
export async function runAcpProtocolAuthentication(
  options: RunAcpProtocolAuthenticationOptions
): Promise<AcpProtocolAuthenticationOutcome> {
  options.signal?.throwIfAborted();

  const child = spawnAcpProcess({
    cliType: options.cliType,
    agentType: options.agentType,
    workdir: options.workdir,
    env: options.env,
    command: options.launch.command,
    args: options.launch.args,
    spawnImpl: options.spawnProcess,
  });
  options.attachProcess?.(child);

  let stderrTail = '';
  const parser = new AcpAgentAuthorizationOutputParser();
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (!chunk) return;
    stderrTail = appendStderrTail(stderrTail, chunk);
    const authorization = parser.push(chunk);
    if (authorization) {
      options.onProgress?.({ status: 'authorization', ...authorization });
    }
  });

  // The child dying mid-request would otherwise leave the JSON-RPC call pending
  // until the caller's overall timeout, hiding the actual startup failure.
  let rejectProcessFailure: ((error: Error) => void) | undefined;
  const processFailure = new Promise<never>((_resolve, reject) => {
    rejectProcessFailure = reject;
  });
  const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    rejectProcessFailure?.(
      new Error(
        `${options.agentType} exited during authentication (code ${code ?? 'null'}${
          signal ? `, signal ${signal}` : ''
        })${stderrTail ? `: ${stderrTail}` : ''}`
      )
    );
  };
  const handleError = (error: Error): void => {
    rejectProcessFailure?.(new Error(`${options.agentType} failed to start: ${error.message}`));
  };
  child.once('exit', handleExit);
  child.once('error', handleError);
  processFailure.catch(() => undefined);

  const handleAbort = (): void => {
    rejectProcessFailure?.(new DOMException('ACP authentication was cancelled', 'AbortError'));
  };
  options.signal?.addEventListener('abort', handleAbort, { once: true });

  const terminate = (): void => {
    child.off('exit', handleExit);
    child.off('error', handleError);
    options.signal?.removeEventListener('abort', handleAbort);
    // The agent persists its own credentials, so nothing is lost by stopping it
    // here; the session that follows starts a fresh process.
    void shutdownLocalAcpAgent({
      agentProcess: child,
      logger: options.logger,
      sessionLabel: `acp-auth-protocol:${options.agentType}`,
      exitTimeoutMs: AUTHENTICATION_TERMINATION_GRACE_MS,
    }).catch((error: unknown) => {
      options.logger.debug(
        `[acp-auth] Failed to stop ${options.agentType} after authentication: ${formatErrorMessage(error)}`
      );
    });
  };

  try {
    if (!child.stdout || !child.stdin) {
      throw new Error('Agent process stdio is not available');
    }
    const stream = acp.ndJsonStream(
      createStdinWritableStream(child.stdin),
      createStdoutReadableStream(child.stdout)
    );
    // No session is created here, so the agent has nothing to report progress
    // on and nothing to request permission for.
    const connection = new acp.ClientSideConnection(
      () => ({
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
        sessionUpdate: () => {},
      }),
      stream
    );

    const initializeResponse = await Promise.race([
      withDeadline(
        connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            terminal: false,
            fs: { readTextFile: false, writeTextFile: false },
            auth: { terminal: true },
          },
        }),
        Math.max(1, options.initializeTimeoutMs ?? ACP_AUTHENTICATION_INITIALIZE_TIMEOUT_MS),
        `${options.agentType} initialize`
      ),
      processFailure,
    ]);
    options.signal?.throwIfAborted();

    const advertised = initializeResponse.authMethods ?? [];
    if (advertised.length === 0) {
      return {
        kind: 'error',
        error: `${options.agentType} does not advertise an authentication method. Check the agent's own setup instructions or configure its credentials in this agent's environment.`,
      };
    }

    const selected = selectAuthMethod(advertised, options.methodId);
    if (!selected) {
      if (options.methodId !== undefined) {
        return {
          kind: 'error',
          error: `${options.agentType} no longer advertises the authentication method "${options.methodId}"`,
        };
      }
      return {
        kind: 'error',
        error: `${options.agentType} advertised no usable authentication method`,
      };
    }

    // Only an explicit choice resolves an ambiguous list: picking for the user
    // could sign them into the wrong account or the wrong billing path.
    const normalizedMethods = advertised
      .map(normalizeAcpAuthMethod)
      .filter((method): method is AcpAdvertisedAuthMethod => method !== null);
    if (options.methodId === undefined && normalizedMethods.length > 1) {
      return { kind: 'method-required', authMethods: normalizedMethods };
    }

    if (selected.normalized.type === 'env_var') {
      return {
        kind: 'error',
        error: formatEnvVarAuthMethodError(selected.method, selected.normalized),
      };
    }
    if (selected.normalized.type === 'terminal') {
      return { kind: 'terminal-method', method: selected.normalized };
    }

    options.logger.debug(
      `[acp-auth] ${options.agentType} authenticate methodId=${selected.normalized.id}`
    );
    await Promise.race([
      connection.authenticate({ methodId: selected.normalized.id }),
      processFailure,
    ]);
    // No abort check after this point: the agent has already stored the
    // credential, and reporting a cancellation would send the user back through
    // a sign-in that already succeeded.
    return { kind: 'authenticated' };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    return { kind: 'error', error: formatErrorMessage(error) };
  } finally {
    terminate();
  }
}

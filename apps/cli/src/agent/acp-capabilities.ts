import {
  type AgentConfigCliType,
  type BuiltinRuntimeOverrides,
  type CustomAcpLaunchSpec,
  isRegistryCursorAgent,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { shutdownLocalAcpAgent, startLocalAcpAgent } from '@/agent/acp-runner';
import { scrubInheritedClaudeAuthEnv, shouldScrubClaudeAuthEnv } from '@/agent/claude-env-conflict';
import type { ManagedRuntimeProgressCallback } from '@/agent/managed-agent-runtime';
import { AcpAuthenticationRequiredError } from '@/agent/agent-client';
import { probeBuiltinAuthentication } from '@/agent/acp-authentication';
import {
  normalizeAcpSessionCapabilities,
  type AcpCapabilitiesResult,
} from '@/agent/acp-capability-normalization';
import { fetchCursorModelCatalog } from '@/agent/cursor-acp';
import type { AcpCapabilityCatalogWrite } from '@/lib/loro/doc';

export { normalizeConfigOptions } from '@/agent/acp-capability-normalization';
export type { AcpCapabilitiesResult } from '@/agent/acp-capability-normalization';

export type FetchAcpCapabilitiesOptions = {
  onManagedRuntimeProgress?: ManagedRuntimeProgressCallback;
  signal?: AbortSignal;
};

export type FetchedAcpCapabilities = AcpCapabilitiesResult & {
  capabilitySourceVersion?: string;
  /**
   * Registry Cursor catalog write for `updateAcpCapabilities`:
   * a map replaces the stored catalog, `null` clears it after a confirmed
   * JSON-RPC `-32601`, and the field is omitted for non-Cursor agents so the
   * stored catalog is inherited.
   */
  configOptionsByModel?: AcpCapabilityCatalogWrite;
};

/**
 * Spawns a temporary ACP agent to discover the capabilities returned by session/new.
 * The agent is killed as soon as the NewSessionResponse has been normalized.
 * Registry Cursor also fetches `cursor/list_available_models`: a catalog map
 * replaces the stored one, a confirmed `-32601` becomes `null` so the write
 * clears a stale catalog, and any other catalog failure rejects the probe.
 */
export async function fetchAcpCapabilities(
  cliType: AgentConfigCliType,
  agentType: string,
  logger: Logger,
  env?: Record<string, string>,
  customAcp?: CustomAcpLaunchSpec,
  runtimeOverrides?: BuiltinRuntimeOverrides,
  options: FetchAcpCapabilitiesOptions = {}
): Promise<FetchedAcpCapabilities> {
  options.signal?.throwIfAborted();
  const workdir = process.cwd();
  const mergedProbeEnv: NodeJS.ProcessEnv = env ? { ...process.env, ...env } : process.env;
  const probeEnv: NodeJS.ProcessEnv =
    shouldScrubClaudeAuthEnv(cliType, agentType) && env
      ? scrubInheritedClaudeAuthEnv(mergedProbeEnv, env)
      : mergedProbeEnv;
  const authentication = await probeBuiltinAuthentication({
    cliType,
    agentType,
    runtimeOverrides,
    env: probeEnv,
    onManagedRuntimeProgress: options.onManagedRuntimeProgress,
    signal: options.signal,
    logger,
  });
  options.signal?.throwIfAborted();
  if (authentication.status === 'unauthenticated') {
    throw new AcpAuthenticationRequiredError(authentication.authMethods);
  }
  const noopTerminalManager = {
    createTerminal: async () => {
      throw new Error('Terminal not supported in ACP capability refresh');
    },
    terminalOutput: async () => {
      throw new Error('Terminal not supported in ACP capability refresh');
    },
    releaseTerminal: async () => {},
    waitForTerminalExit: async () => ({ exitCode: null, signal: null }),
    killTerminal: async () => {},
  };
  const { agentProcess, client, acpSessionId, sessionResponse, capabilitySourceVersion } =
    await startLocalAcpAgent({
      cliType,
      agentType,
      customAcp,
      runtimeOverrides,
      workdir,
      env: probeEnv,
      onManagedRuntimeProgress: options.onManagedRuntimeProgress,
      signal: options.signal,
      logger,
      terminalManager: noopTerminalManager,
      terminalEnabled: false,
      onUpdateMessage: () => {},
      onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    });

  try {
    const normalized = normalizeAcpSessionCapabilities(sessionResponse, {
      sessionFork: client.supportsSessionFork?.() === true,
      acknowledgedSteer: client.supportsAcknowledgedSteer(),
      agent: { cliType, agentType },
    });
    const configOptionsByModel = isRegistryCursorAgent({ cliType, agentType })
      ? ((await fetchCursorModelCatalog({ client, signal: options.signal, logger })) ?? null)
      : undefined;
    return {
      ...normalized,
      capabilitySourceVersion,
      ...(configOptionsByModel !== undefined ? { configOptionsByModel } : {}),
    };
  } finally {
    await shutdownLocalAcpAgent({
      agentProcess,
      client,
      acpSessionId,
      logger,
      sessionLabel: `acp-capabilities:${cliType}/${agentType}`,
    });
  }
}

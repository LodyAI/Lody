import {
  type AgentConfigCliType,
  type BuiltinRuntimeOverrides,
  type CustomAcpLaunchSpec,
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

export { normalizeConfigOptions } from '@/agent/acp-capability-normalization';
export type { AcpCapabilitiesResult } from '@/agent/acp-capability-normalization';

export type FetchAcpCapabilitiesOptions = {
  onManagedRuntimeProgress?: ManagedRuntimeProgressCallback;
  signal?: AbortSignal;
};

export type FetchedAcpCapabilities = AcpCapabilitiesResult & {
  capabilitySourceVersion?: string;
};

/**
 * Spawns a temporary ACP agent to discover the capabilities returned by session/new.
 * The agent is killed as soon as the NewSessionResponse has been normalized.
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
    return {
      ...normalizeAcpSessionCapabilities(sessionResponse, {
        sessionFork: client.supportsSessionFork?.() === true,
        acknowledgedSteer: client.supportsAcknowledgedSteer(),
      }),
      capabilitySourceVersion,
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

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
import type { CodexProfileExecution } from './codex-profile-runtime';
import { startCodexCredentialBroker } from './codex-credential-broker';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { probeBuiltinAuthentication } from '@/agent/acp-authentication';
import {
  normalizeAcpSessionCapabilities,
  type AcpCapabilitiesResult,
} from '@/agent/acp-capability-normalization';

export { normalizeConfigOptions } from '@/agent/acp-capability-normalization';
export type { AcpCapabilitiesResult } from '@/agent/acp-capability-normalization';

export type FetchAcpCapabilitiesOptions = {
  codexProfile?: CodexProfileExecution;
  verifyCodexCredential?: boolean;
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
  const isolatedWorkdir = options.codexProfile
    ? await mkdtemp(path.join(os.tmpdir(), 'lody-codex-verify-'))
    : undefined;
  const workdir = isolatedWorkdir ?? process.cwd();
  const { agentProcess, client, acpSessionId, sessionResponse, capabilitySourceVersion } =
    await startLocalAcpAgent({
      codexProfile: options.codexProfile,
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
    }).catch(async (error: unknown) => {
      if (isolatedWorkdir) await rm(isolatedWorkdir, { recursive: true, force: true });
      throw error;
    });

  try {
    if (options.verifyCodexCredential && options.codexProfile?.profile.profile.mode === 'api-key') {
      const key = options.codexProfile.candidateKey;
      if (!key) throw new Error('Codex credential verification requires a candidate key');
      const broker = await startCodexCredentialBroker({
        baseUrl: options.codexProfile.profile.profile.baseUrl,
        apiKey: key,
        signal: options.signal,
      });
      try {
        const models = normalizeAcpSessionCapabilities(sessionResponse, {
          agent: { cliType, agentType },
        }).models;
        const model = models[0]?.modelId.replace(/\[[^\]]+\]$/, '');
        if (!model) throw new Error('Codex endpoint did not advertise a model');
        const response = await fetch(`${broker.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${broker.capability}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            input: 'Reply with OK only.',
            max_output_tokens: 16,
            tools: [],
            store: false,
          }),
          redirect: 'error',
          signal: options.signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Codex endpoint could not verify this API Key');
        }
        const reader = response.body?.getReader();
        let text = '';
        const decoder = new TextDecoder();
        if (reader) {
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              text += decoder.decode(part.value, { stream: true });
              if (text.length > 65_536) throw new Error('Codex verification response is too large');
            }
          } finally {
            await reader.cancel();
          }
        }
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          throw new Error('Codex endpoint did not return a Responses result');
        }
        if (
          !value ||
          typeof value !== 'object' ||
          !('object' in value) ||
          value.object !== 'response' ||
          !('output' in value) ||
          !Array.isArray(value.output)
        ) {
          throw new Error('Codex endpoint did not return a Responses result');
        }
      } finally {
        await broker.close();
      }
    }
    return {
      ...normalizeAcpSessionCapabilities(sessionResponse, {
        sessionFork: client.supportsSessionFork?.() === true,
        sessionTitle: client.supportsSessionTitleGeneration(),
        acknowledgedSteer: client.supportsAcknowledgedSteer(),
        goalActions: client.getGoalCapability()?.actions.slice(),
        agent: { cliType, agentType },
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
    if (isolatedWorkdir) await rm(isolatedWorkdir, { recursive: true, force: true });
  }
}

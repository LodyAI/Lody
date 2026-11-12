import {
  getAcpConfigOptionsModelId,
  type ACPSessionId,
  type AcpConfigOptionSummary,
  type AgentConfigCliType,
  type BuiltinRuntimeOverrides,
  type CustomAcpLaunchSpec,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import type { AuthMethod } from '@agentclientprotocol/sdk';
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
  normalizeConfigOptions,
  type AcpCapabilitiesResult,
} from '@/agent/acp-capability-normalization';
import type { AgentClient } from '@/agent/agent-client';

export { normalizeConfigOptions } from '@/agent/acp-capability-normalization';
export type { AcpCapabilitiesResult } from '@/agent/acp-capability-normalization';

export type FetchAcpCapabilitiesOptions = {
  agentConfigId?: string;
  magpieGatewayUrl?: string;
  codexProfile?: CodexProfileExecution;
  verifyCodexCredential?: boolean;
  onManagedRuntimeProgress?: ManagedRuntimeProgressCallback;
  signal?: AbortSignal;
  /**
   * Switch the probe session to every advertised model and record the option
   * list the agent reports for each. Only a refresh a person asked for sets
   * this: it costs one `session/set_config_option` round trip per model.
   */
  readModelOptions?: {
    onProgress?: (progress: AcpModelOptionsReadProgress) => void;
  };
};

/** The model whose options are being read, `index` of `total` (1-based). */
export type AcpModelOptionsReadProgress = {
  modelId: string;
  modelName: string;
  index: number;
  total: number;
};

/**
 * Upper bound for one model switch. The read has no overall deadline, because
 * a person is watching its progress; this only stops an agent that never
 * answers from holding the refresh forever.
 */
export const ACP_MODEL_OPTIONS_SWITCH_TIMEOUT_MS = 60_000;

export type FetchedAcpCapabilities = AcpCapabilitiesResult & {
  capabilitySourceVersion?: string;
  /**
   * Sign-in methods the agent advertised during `initialize`.
   *
   * Reading them here is what lets the account panel offer the agent's own
   * methods before anyone starts an authentication attempt. Empty means the
   * agent was asked and advertised none; absent means the caller did not ask
   * (older test doubles and adapters that cannot report them).
   */
  authMethods?: readonly AuthMethod[];
  /** Each model's own option list, when `readModelOptions` was requested. */
  modelConfigOptions?: Record<string, AcpConfigOptionSummary[]>;
};

class ModelSwitchTimeoutError extends Error {}

const withSwitchTimeout = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ModelSwitchTimeoutError('Model switch timed out')),
          ACP_MODEL_OPTIONS_SWITCH_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Switches the probe session to each advertised model in turn and keeps the
 * list the agent answers with. The `session/new` snapshot is the current
 * model's answer. A model whose switch fails or answers without a list for
 * that model is skipped; an unanswered switch ends the read, since every later
 * switch would wait on the same agent. What was read so far is kept.
 */
export async function readEveryModelConfigOptions(args: {
  client: Pick<AgentClient, 'setSessionConfigOption'>;
  acpSessionId: ACPSessionId;
  snapshot: AcpConfigOptionSummary[] | undefined;
  onProgress?: (progress: AcpModelOptionsReadProgress) => void;
  logger: Logger;
  signal?: AbortSignal;
}): Promise<Record<string, AcpConfigOptionSummary[]> | undefined> {
  const modelOption = args.snapshot?.find(
    (option) => option.category === 'model' && option.type === 'select'
  );
  const currentModelId = getAcpConfigOptionsModelId(args.snapshot);
  if (!args.snapshot || !modelOption || !currentModelId) return undefined;
  const read: Record<string, AcpConfigOptionSummary[]> = { [currentModelId]: args.snapshot };
  const total = modelOption.options.length;
  const ordered = [
    ...modelOption.options.filter((choice) => choice.value === currentModelId),
    ...modelOption.options.filter((choice) => choice.value !== currentModelId),
  ];
  for (const [position, choice] of ordered.entries()) {
    args.signal?.throwIfAborted();
    args.onProgress?.({
      modelId: choice.value,
      modelName: choice.name,
      index: position + 1,
      total,
    });
    if (choice.value === currentModelId) continue;
    try {
      const reported = normalizeConfigOptions(
        await withSwitchTimeout(
          args.client.setSessionConfigOption(args.acpSessionId, modelOption.id, choice.value)
        )
      );
      if (reported && getAcpConfigOptionsModelId(reported) === choice.value) {
        read[choice.value] = reported;
      }
    } catch (error) {
      args.signal?.throwIfAborted();
      args.logger.debug(
        `[acp-capabilities] Could not read options for model ${choice.value}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      if (error instanceof ModelSwitchTimeoutError) break;
    }
  }
  return read;
}

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
  // Providers may create workspace-local files during session/new. Never use
  // the daemon's inherited cwd (which can be /) or a user's project for probes.
  const workdir = await mkdtemp(path.join(os.tmpdir(), 'lody-acp-capabilities-'));
  try {
    options.signal?.throwIfAborted();
    const { agentProcess, client, acpSessionId, sessionResponse, capabilitySourceVersion } =
      await startLocalAcpAgent({
        codexProfile: options.codexProfile,
        cliType,
        agentType,
        customAcp,
        runtimeOverrides,
        agentConfigId: options.agentConfigId,
        magpieGatewayUrl: options.magpieGatewayUrl,
        workdir,
        env: probeEnv,
        onManagedRuntimeProgress: options.onManagedRuntimeProgress,
        signal: options.signal,
        logger,
        terminalManager: noopTerminalManager,
        terminalEnabled: false,
        discoverAuthenticationMethods: cliType === 'builtin' && agentType === 'sorbet',
        onUpdateMessage: () => {},
        onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      });

    try {
      if (
        options.verifyCodexCredential &&
        options.codexProfile?.profile.profile.mode === 'api-key'
      ) {
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
                if (text.length > 65_536)
                  throw new Error('Codex verification response is too large');
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
      const capabilities = normalizeAcpSessionCapabilities(sessionResponse, {
        sessionFork: client.supportsSessionFork?.() === true,
        sessionTitle: client.supportsSessionTitleGeneration(),
        rateLimits: client.getRateLimitsCapability(),
        acknowledgedSteer: client.supportsAcknowledgedSteer(),
        goalActions: client.getGoalCapability()?.actions.slice(),
        agent: { cliType, agentType },
      });
      const modelConfigOptions = options.readModelOptions
        ? await readEveryModelConfigOptions({
            client,
            acpSessionId,
            snapshot: capabilities.configOptions,
            onProgress: options.readModelOptions.onProgress,
            logger,
            signal: options.signal,
          })
        : undefined;
      return {
        ...capabilities,
        capabilitySourceVersion,
        authMethods: client.getAuthMethods(),
        ...(modelConfigOptions ? { modelConfigOptions } : {}),
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
  } finally {
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      // Workspace cleanup must not replace a startup/auth error or discard
      // discovered capabilities. A later probe always allocates a fresh path.
      try {
        logger.warn('[acp-capabilities] Failed to remove temporary probe workspace');
      } catch {
        // A failing diagnostic sink must not change the probe result either.
      }
    }
  }
}

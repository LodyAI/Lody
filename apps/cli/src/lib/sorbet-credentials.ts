import type { AgentConfigId, MachineId } from '@lody/shared';
import type { SorbetCustomProviderInput } from '@lody/shared/local-machine-rpc';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import {
  AcpQuotaCleanupError,
  runLocalSorbetCredentials,
  terminateAcpProcessTree,
} from '@/agent/acp-runner';
import { acquireSorbetCredentialMutation } from '@/agent/sorbet-credential-mutation';

/** Resolve identity on the local machine; persisted launch fields never reach this operation. */
export function createSorbetCredentialsHandler(
  document: Pick<LoroDocumentManager, 'getAgentConfigById'>,
  machineId: MachineId,
  logger: Logger
) {
  async function validate(configId: AgentConfigId) {
    const config = await document.getAgentConfigById(configId, machineId);
    if (
      !config ||
      config.id !== configId ||
      config.machineId !== machineId ||
      config.cliType !== 'builtin' ||
      config.agentType !== 'sorbet'
    ) {
      throw new Error('Sorbet credentials configuration unavailable');
    }
  }

  /**
   * Mutations run under the daemon-wide Sorbet lease: one process owns the data directory
   * at a time, and an unconfirmed cleanup fences the next mutation until it recovers.
   */
  async function mutate<T>(
    configId: AgentConfigId,
    signal: AbortSignal | undefined,
    run: () => Promise<T>
  ): Promise<T> {
    await validate(configId);
    signal?.throwIfAborted();
    const lease = await acquireSorbetCredentialMutation(signal);
    try {
      return await run();
    } catch (error) {
      if (error instanceof AcpQuotaCleanupError) {
        lease.retain(error.child, () =>
          terminateAcpProcessTree(error.child, {
            logger,
            sessionLabel: 'sorbet-credentials-recovery',
            exitTimeoutMs: 3000,
          })
        );
      }
      throw error;
    } finally {
      lease.release();
    }
  }

  return {
    async list(configId: AgentConfigId, signal?: AbortSignal) {
      await validate(configId);
      signal?.throwIfAborted();
      const outcome = await runLocalSorbetCredentials(logger, { type: 'list' }, signal);
      return outcome.kind === 'credentials' ? outcome.credentials : [];
    },
    async logout(configId: AgentConfigId, providerId: string, signal?: AbortSignal) {
      await mutate(configId, signal, async () => {
        await runLocalSorbetCredentials(logger, { type: 'logout', providerId }, signal);
      });
    },
    /** Custom Providers are definitions Sorbet persists; listing starts a process too. */
    async listProviders(configId: AgentConfigId, signal?: AbortSignal) {
      await validate(configId);
      signal?.throwIfAborted();
      const outcome = await runLocalSorbetCredentials(logger, { type: 'providers-list' }, signal);
      return outcome.kind === 'providers' ? outcome.providers : [];
    },
    async createProvider(
      configId: AgentConfigId,
      provider: SorbetCustomProviderInput,
      signal?: AbortSignal
    ) {
      return await mutate(configId, signal, async () => {
        const outcome = await runLocalSorbetCredentials(
          logger,
          { type: 'providers-create', provider },
          signal
        );
        if (outcome.kind !== 'provider') throw new Error('Sorbet custom provider create failed');
        return outcome.provider;
      });
    },
    async deleteProvider(configId: AgentConfigId, providerId: string, signal?: AbortSignal) {
      await mutate(configId, signal, async () => {
        await runLocalSorbetCredentials(logger, { type: 'providers-delete', providerId }, signal);
      });
    },
  };
}

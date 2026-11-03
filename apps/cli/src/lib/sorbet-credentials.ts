import type { AgentConfigId, MachineId } from '@lody/shared';
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
  return {
    async list(configId: AgentConfigId, signal?: AbortSignal) {
      await validate(configId);
      signal?.throwIfAborted();
      return await runLocalSorbetCredentials(logger, { type: 'list' }, signal);
    },
    async logout(configId: AgentConfigId, providerId: string, signal?: AbortSignal) {
      await validate(configId);
      signal?.throwIfAborted();
      const lease = await acquireSorbetCredentialMutation(signal);
      try {
        await runLocalSorbetCredentials(logger, { type: 'logout', providerId }, signal);
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
    },
  };
}

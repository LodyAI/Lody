import { join } from 'node:path';
import { openSorbetControl } from '@sorbetai/control';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import type { SorbetCustomProviderInput } from '@lody/shared/local-machine-rpc';
import type { LoroDocumentManager } from '@/lib/loro/doc';

/** Resolve identity on the local machine; persisted launch fields never reach this operation. */
export function createSorbetCredentialsHandler(
  document: Pick<LoroDocumentManager, 'getAgentConfigForMachineLaunch'>,
  machineId: MachineId
) {
  async function validate(configId: AgentConfigId) {
    const config = await document.getAgentConfigForMachineLaunch(configId, machineId);
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

  const dataDirectory = join(getLodyDataDir(), 'sorbet');

  return {
    async list(configId: AgentConfigId, signal?: AbortSignal) {
      await validate(configId);
      const control = await openSorbetControl({ dataDirectory, signal });
      try {
        return [...(await control.credentials.list({ signal }))];
      } finally {
        await control.close();
      }
    },
    async logout(configId: AgentConfigId, providerId: string, signal?: AbortSignal) {
      await validate(configId);
      const control = await openSorbetControl({ dataDirectory, signal });
      try {
        await control.credentials.logout(providerId, { signal });
      } finally {
        await control.close();
      }
    },
    async listProviders(configId: AgentConfigId, signal?: AbortSignal) {
      await validate(configId);
      const control = await openSorbetControl({ dataDirectory, signal });
      try {
        return (await control.providers.listCustom({ signal })).map((provider) => ({
          ...provider,
          models: provider.models.map((model) => ({ ...model })),
        }));
      } finally {
        await control.close();
      }
    },
    async createProvider(
      configId: AgentConfigId,
      provider: SorbetCustomProviderInput,
      signal?: AbortSignal
    ) {
      await validate(configId);
      const control = await openSorbetControl({ dataDirectory, signal });
      try {
        const created = await control.providers.createCustom(provider, { signal });
        return { ...created, models: created.models.map((model) => ({ ...model })) };
      } finally {
        await control.close();
      }
    },
    async deleteProvider(configId: AgentConfigId, providerId: string, signal?: AbortSignal) {
      await validate(configId);
      const control = await openSorbetControl({ dataDirectory, signal });
      try {
        await control.providers.deleteCustom(providerId, { signal });
      } finally {
        await control.close();
      }
    },
    async refreshProviders(configId: AgentConfigId, providerId?: string, signal?: AbortSignal) {
      await validate(configId);
      const control = await openSorbetControl({ dataDirectory, signal });
      try {
        await control.providers.refresh({
          ...(providerId ? { providers: [providerId] } : {}),
          signal,
        });
      } finally {
        await control.close();
      }
    },
    async listModels(configId: AgentConfigId, providerId?: string, signal?: AbortSignal) {
      await validate(configId);
      const control = await openSorbetControl({ dataDirectory, signal });
      try {
        return [...(await control.providers.availableModels({ providerId, signal }))];
      } finally {
        await control.close();
      }
    },
  };
}

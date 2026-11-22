import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { SorbetProvidersResultSchema } from '@lody/shared/local-machine-rpc';
import { createSorbetCredentialsHandler } from './sorbet-credentials';

const openSorbetControl = vi.hoisted(() => vi.fn());
vi.mock('@sorbetai/control', () => ({ openSorbetControl }));

const id = 'provider' as AgentConfigId;
const machine = 'machine' as MachineId;

function control(overrides: Record<string, unknown> = {}) {
  return {
    credentials: {
      list: vi.fn(async () => []),
      logout: vi.fn(async () => {}),
    },
    providers: {
      listCustom: vi.fn(async () => []),
      createCustom: vi.fn(async (provider) => ({ ...provider, id: 'custom' })),
      updateCustom: vi.fn(async (providerId, provider) => ({ ...provider, id: providerId })),
      deleteCustom: vi.fn(async () => {}),
      refresh: vi.fn(async () => ({ refreshed: [], errors: new Map() })),
      availableModels: vi.fn(async () => []),
    },
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('daemon Sorbet credentials', () => {
  beforeEach(() => openSorbetControl.mockReset());

  it('uses only the selected local builtin identity and calls Sorbet control directly', async () => {
    const config = {
      id,
      machineId: machine,
      cliType: 'builtin',
      agentType: 'sorbet',
      env: { SECRET: 'private' },
      customAcp: { command: 'untrusted' },
      runtimeOverrides: { command: 'untrusted' },
    };
    const document = { getAgentConfigForMachineLaunch: vi.fn(async () => config as never) };
    const first = control({
      credentials: {
        list: vi.fn(async () => [{ providerId: 'x', type: 'oauth' }]),
        logout: vi.fn(async () => {}),
      },
    });
    const second = control();
    openSorbetControl.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const handler = createSorbetCredentialsHandler(document, machine);

    expect(await handler.list(id)).toEqual([{ providerId: 'x', type: 'oauth' }]);
    await handler.logout(id, 'x');

    expect(document.getAgentConfigForMachineLaunch).toHaveBeenCalledWith(id, machine);
    expect(openSorbetControl).toHaveBeenCalledTimes(2);
    expect(openSorbetControl).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ dataDirectory: expect.stringMatching(/sorbet$/) })
    );
    expect(first.credentials.list).toHaveBeenCalledWith({ signal: undefined });
    expect(second.credentials.logout).toHaveBeenCalledWith('x', { signal: undefined });
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('uses Sorbet control for custom Provider operations', async () => {
    const config = { id, machineId: machine, cliType: 'builtin', agentType: 'sorbet' };
    const document = { getAgentConfigForMachineLaunch: async () => config as never };
    const provider = {
      name: 'Example',
      protocol: 'openai-completions' as const,
      baseUrl: 'https://example.com/v1',
      models: [],
    };
    const create = control();
    const list = control({
      providers: {
        listCustom: vi.fn(async () => [{ ...provider, id: 'custom' }]),
        createCustom: vi.fn(),
        deleteCustom: vi.fn(),
        refresh: vi.fn(),
        availableModels: vi.fn(),
      },
    });
    openSorbetControl.mockResolvedValueOnce(create).mockResolvedValueOnce(list);
    const handler = createSorbetCredentialsHandler(document, machine);

    expect(await handler.createProvider(id, provider)).toEqual({ ...provider, id: 'custom' });
    expect(await handler.listProviders(id)).toEqual([{ ...provider, id: 'custom' }]);
    expect(create.providers.createCustom).toHaveBeenCalledWith(provider, { signal: undefined });
    expect(list.providers.listCustom).toHaveBeenCalledWith({ signal: undefined });
  });

  it('edits an endpoint over its stored definition, keeping what Sorbet discovered', async () => {
    const config = { id, machineId: machine, cliType: 'builtin', agentType: 'sorbet' };
    const document = { getAgentConfigForMachineLaunch: async () => config as never };
    const stored = {
      id: 'custom',
      name: 'Gateway',
      protocol: 'openai-completions' as const,
      baseUrl: 'https://old.example/v1',
      models: [{ id: 'm-1', name: 'Meridian', reasoning: true, contextWindow: 200_000 }],
      catalogRefs: ['meridian'],
    };
    const instance = control();
    instance.providers.listCustom = vi.fn(async () => [stored]);
    openSorbetControl.mockResolvedValueOnce(instance);
    const handler = createSorbetCredentialsHandler(document, machine);

    const updated = await handler.updateProvider(id, 'custom', {
      name: 'Team gateway',
      protocol: 'openai-responses',
      baseUrl: 'https://new.example/v1',
    });

    expect(instance.providers.updateCustom).toHaveBeenCalledWith(
      'custom',
      {
        name: 'Team gateway',
        protocol: 'openai-responses',
        baseUrl: 'https://new.example/v1',
        models: stored.models,
        catalogRefs: ['meridian'],
      },
      { signal: undefined }
    );
    expect(
      SorbetProvidersResultSchema.parse({ type: 'sorbet/providers-update', provider: updated })
    ).toEqual({
      type: 'sorbet/providers-update',
      provider: {
        id: 'custom',
        name: 'Team gateway',
        protocol: 'openai-responses',
        baseUrl: 'https://new.example/v1',
        models: [{ id: 'm-1', name: 'Meridian' }],
      },
    });
    expect(instance.close).toHaveBeenCalledOnce();
  });

  it('refuses to edit an endpoint the machine does not store', async () => {
    const config = { id, machineId: machine, cliType: 'builtin', agentType: 'sorbet' };
    const document = { getAgentConfigForMachineLaunch: async () => config as never };
    const instance = control();
    openSorbetControl.mockResolvedValueOnce(instance);
    await expect(
      createSorbetCredentialsHandler(document, machine).updateProvider(id, 'missing', {
        name: 'x',
        protocol: 'openai-completions',
        baseUrl: 'https://example.test',
      })
    ).rejects.toThrow('not found');
    expect(instance.providers.updateCustom).not.toHaveBeenCalled();
    expect(instance.close).toHaveBeenCalledOnce();
  });

  it('refreshes Providers and reads the control model catalog', async () => {
    const config = { id, machineId: machine, cliType: 'builtin', agentType: 'sorbet' };
    const document = { getAgentConfigForMachineLaunch: async () => config as never };
    const refresh = control();
    const models = control({
      providers: {
        listCustom: vi.fn(),
        createCustom: vi.fn(),
        deleteCustom: vi.fn(),
        refresh: vi.fn(),
        availableModels: vi.fn(async () => [
          {
            selector: 'example/model',
            providerId: 'example',
            modelId: 'model',
            displayName: 'Model',
          },
        ]),
      },
    });
    openSorbetControl.mockResolvedValueOnce(refresh).mockResolvedValueOnce(models);
    const handler = createSorbetCredentialsHandler(document, machine);

    await handler.refreshProviders(id, 'example');
    expect(await handler.listModels(id)).toEqual([
      {
        selector: 'example/model',
        providerId: 'example',
        modelId: 'model',
        displayName: 'Model',
      },
    ]);
    expect(refresh.providers.refresh).toHaveBeenCalledWith({
      providers: ['example'],
      signal: undefined,
    });
    expect(models.providers.availableModels).toHaveBeenCalledWith({
      providerId: undefined,
      signal: undefined,
    });
  });

  it('closes control after an operation failure', async () => {
    const config = { id, machineId: machine, cliType: 'builtin', agentType: 'sorbet' };
    const document = { getAgentConfigForMachineLaunch: async () => config as never };
    const failure = new Error('failed');
    const instance = control({
      credentials: {
        list: vi.fn(async () => {
          throw failure;
        }),
        logout: vi.fn(),
      },
    });
    openSorbetControl.mockResolvedValueOnce(instance);

    await expect(createSorbetCredentialsHandler(document, machine).list(id)).rejects.toBe(failure);
    expect(instance.close).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { id, machineId: 'other', cliType: 'builtin', agentType: 'sorbet' },
    { id, machineId: machine, cliType: 'custom', agentType: 'sorbet' },
    { id, machineId: machine, cliType: 'builtin', agentType: 'other' },
    { id: 'other', machineId: machine, cliType: 'builtin', agentType: 'sorbet' },
  ])('rejects an unavailable or untrusted provider before opening control', async (config) => {
    const document = { getAgentConfigForMachineLaunch: async () => config as never };
    const handler = createSorbetCredentialsHandler(document, machine);
    await expect(handler.list(id)).rejects.toThrow('configuration unavailable');
    await expect(handler.logout(id, 'x')).rejects.toThrow('configuration unavailable');
    await expect(handler.listProviders(id)).rejects.toThrow('configuration unavailable');
    await expect(handler.deleteProvider(id, 'x')).rejects.toThrow('configuration unavailable');
    await expect(handler.refreshProviders(id)).rejects.toThrow('configuration unavailable');
    await expect(handler.listModels(id)).rejects.toThrow('configuration unavailable');
    expect(openSorbetControl).not.toHaveBeenCalled();
  });
});

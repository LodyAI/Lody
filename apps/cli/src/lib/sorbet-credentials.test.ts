import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigId, MachineId } from '@lody/shared';
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
      deleteCustom: vi.fn(async () => {}),
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
      },
    });
    openSorbetControl.mockResolvedValueOnce(create).mockResolvedValueOnce(list);
    const handler = createSorbetCredentialsHandler(document, machine);

    expect(await handler.createProvider(id, provider)).toEqual({ ...provider, id: 'custom' });
    expect(await handler.listProviders(id)).toEqual([{ ...provider, id: 'custom' }]);
    expect(create.providers.createCustom).toHaveBeenCalledWith(provider, { signal: undefined });
    expect(list.providers.listCustom).toHaveBeenCalledWith({ signal: undefined });
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
    expect(openSorbetControl).not.toHaveBeenCalled();
  });
});

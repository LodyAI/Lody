import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigId, MachineId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { createSorbetCredentialsHandler } from './sorbet-credentials';
import { acquireSorbetCredentialMutation } from '@/agent/sorbet-credential-mutation';

const run = vi.hoisted(() => vi.fn());
vi.mock('@/agent/acp-runner', () => ({ runLocalSorbetCredentials: run }));

const id = 'provider' as AgentConfigId;
const machine = 'machine' as MachineId;
const logger = {} as Logger;

describe('daemon Sorbet credentials', () => {
  // Queued once-values would otherwise leak into the next test's first call.
  beforeEach(() => run.mockReset());

  it('uses only the selected local builtin identity, never persisted launch inputs', async () => {
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
    const handler = createSorbetCredentialsHandler(document, machine, logger);
    run
      .mockResolvedValueOnce({
        kind: 'credentials',
        credentials: [{ providerId: 'x', type: 'oauth' }],
      })
      .mockResolvedValueOnce({ kind: 'credentials', credentials: [] });
    expect(await handler.list(id)).toEqual([{ providerId: 'x', type: 'oauth' }]);
    await handler.logout(id, 'x');
    expect(document.getAgentConfigForMachineLaunch).toHaveBeenCalledWith(id, machine);
    expect(run).toHaveBeenNthCalledWith(1, logger, { type: 'list' }, undefined);
    expect(run).toHaveBeenNthCalledWith(2, logger, { type: 'logout', providerId: 'x' }, undefined);
  });

  it('allows custom endpoint creation for an unpublished setup resolved by the daemon', async () => {
    const config = { id, machineId: machine, cliType: 'builtin', agentType: 'sorbet' };
    const document = {
      getAgentConfigById: async () => null,
      getAgentConfigForMachineLaunch: async () => config as never,
    };
    const handler = createSorbetCredentialsHandler(document, machine, logger);
    const provider = {
      name: 'Example',
      protocol: 'openai-completions' as const,
      baseUrl: 'https://example.com/v1',
      models: [],
    };
    run.mockResolvedValueOnce({ kind: 'provider', provider: { ...provider, id: 'custom' } });
    expect(await handler.createProvider(id, provider)).toEqual({ ...provider, id: 'custom' });
    run.mockResolvedValueOnce({ kind: 'providers', providers: [{ ...provider, id: 'custom' }] });
    expect(await handler.listProviders(id)).toEqual([{ ...provider, id: 'custom' }]);
  });

  it('holds the shared mutation owner after disconnect until the logout runner finishes cleanup', async () => {
    const config = { id, machineId: machine, cliType: 'builtin', agentType: 'sorbet' };
    const document = { getAgentConfigForMachineLaunch: async () => config as never };
    const handler = createSorbetCredentialsHandler(document, machine, logger);
    const otherWorkspace = createSorbetCredentialsHandler(document, machine, logger);
    const signal = new AbortController();
    let onStart: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      onStart = resolve;
    });
    const cleanup = new Promise<void>((resolve) => {
      finish = resolve;
    });
    run.mockImplementationOnce(async (_logger, _operation, requestSignal) => {
      onStart?.();
      await new Promise<void>((resolve) =>
        requestSignal.addEventListener('abort', resolve, { once: true })
      );
      await cleanup;
      return { kind: 'credentials', credentials: [] };
    });
    const logout = handler.logout(id, 'example', signal.signal);
    await started;
    signal.abort();
    await expect(otherWorkspace.logout(id, 'example')).rejects.toThrow('busy');
    await expect(acquireSorbetCredentialMutation()).rejects.toThrow('busy');
    finish?.();
    await logout;
    (await acquireSorbetCredentialMutation()).release();
  });

  it.each([
    null,
    { id, machineId: 'other', cliType: 'builtin', agentType: 'sorbet' },
    { id, machineId: machine, cliType: 'custom', agentType: 'sorbet' },
    { id, machineId: machine, cliType: 'builtin', agentType: 'other' },
    { id: 'other', machineId: machine, cliType: 'builtin', agentType: 'sorbet' },
  ])('rejects an unavailable or untrusted provider before launching', async (config) => {
    run.mockClear();
    const document = { getAgentConfigForMachineLaunch: async () => config as never };
    const handler = createSorbetCredentialsHandler(document, machine, logger);
    await expect(handler.list(id)).rejects.toThrow('configuration unavailable');
    await expect(handler.logout(id, 'x')).rejects.toThrow('configuration unavailable');
    await expect(handler.listProviders(id)).rejects.toThrow('configuration unavailable');
    await expect(handler.deleteProvider(id, 'x')).rejects.toThrow('configuration unavailable');
    expect(run).not.toHaveBeenCalled();
  });
});

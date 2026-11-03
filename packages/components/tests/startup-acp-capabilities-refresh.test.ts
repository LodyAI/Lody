import { describe, expect, it, vi } from 'vitest';
import type { AgentConfigMeta, MachineId } from '@lody/shared';
import { runStartupAcpCapabilitiesRefresh } from '../src/providers/startup-acp-capabilities-refresh';

const config = (id: string, machineId: MachineId): AgentConfigMeta => ({
  id: id as AgentConfigMeta['id'],
  machineId,
  name: id,
  cliType: 'builtin',
  agentType: id,
  env: {},
  prompt: '',
});

describe('runStartupAcpCapabilitiesRefresh', () => {
  it('refreshes every config and continues after per-config failures', async () => {
    const machine1 = 'machine-1' as MachineId;
    const machine2 = 'machine-2' as MachineId;
    const configs = new Map([
      [machine1, [config('first', machine1), config('second', machine1)]],
      [machine2, [config('third', machine2)]],
    ]);
    const refreshed: string[] = [];
    const onError = vi.fn();

    await runStartupAcpCapabilitiesRefresh(
      {
        listMachineIds: async () => [machine1, machine2],
        isMachineOnline: () => true,
        listAgentConfigs: async (machineId) => configs.get(machineId) ?? [],
        refreshAgentConfig: async (_machineId, agentConfig) => {
          refreshed.push(agentConfig.id);
          if (agentConfig.id === 'first') {
            throw new Error('probe failed');
          }
        },
        onError,
      },
      { refreshedConfigKeys: new Set() }
    );

    expect(refreshed).toEqual(expect.arrayContaining(['first', 'second', 'third']));
    expect(refreshed.indexOf('second')).toBeGreaterThan(refreshed.indexOf('first'));
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      machineId: machine1,
      configId: 'first',
    });
  });

  it('does not route a config through a different machine than its owning document', async () => {
    const sourceMachineId = 'machine-source' as MachineId;
    const targetMachineId = 'machine-target' as MachineId;
    const refreshed: Array<{ machineId: MachineId; configId: string }> = [];
    const errors: Array<{ machineId: MachineId; configId?: string }> = [];

    await runStartupAcpCapabilitiesRefresh(
      {
        listMachineIds: async () => [sourceMachineId],
        isMachineOnline: () => true,
        listAgentConfigs: async () => [config('foreign-config', targetMachineId)],
        refreshAgentConfig: async (machineId, agentConfig) => {
          refreshed.push({ machineId, configId: agentConfig.id });
        },
        onError: (_error, context) => errors.push(context),
      },
      { refreshedConfigKeys: new Set() }
    );

    expect(refreshed).toEqual([]);
    expect(errors).toEqual([{ machineId: sourceMachineId, configId: 'foreign-config' }]);
  });

  it('stops refreshing a machine when it goes offline during the pass', async () => {
    const machineId = 'machine-online-then-offline' as MachineId;
    let online = true;
    const refreshed: string[] = [];

    await runStartupAcpCapabilitiesRefresh(
      {
        listMachineIds: async () => [machineId],
        isMachineOnline: () => online,
        listAgentConfigs: async () => [config('first', machineId), config('second', machineId)],
        refreshAgentConfig: async (_machineId, agentConfig) => {
          refreshed.push(agentConfig.id);
          online = false;
        },
      },
      { refreshedConfigKeys: new Set() }
    );

    expect(refreshed).toEqual(['first']);
  });
  it('does not re-probe configs an aborted pass already refreshed, and retries the ones that failed', async () => {
    const machineId = 'machine-reconnecting' as MachineId;
    const refreshedConfigKeys = new Set<string>();
    const configs = [
      config('answered', machineId),
      config('failed', machineId),
      config('never-reached', machineId),
    ];
    const attempts: string[] = [];
    const abortController = new AbortController();
    let markSecondFailed!: () => void;
    const secondFailed = new Promise<void>((resolve) => {
      markSecondFailed = resolve;
    });

    const ports = {
      listMachineIds: async () => [machineId],
      isMachineOnline: () => true,
      listAgentConfigs: async () => configs,
      refreshAgentConfig: async (_machineId: MachineId, agentConfig: AgentConfigMeta) => {
        attempts.push(agentConfig.id);
        if (agentConfig.id === 'failed') {
          markSecondFailed();
          throw new Error('probe failed');
        }
      },
      onError: () => {},
    };

    const firstPass = runStartupAcpCapabilitiesRefresh(ports, {
      refreshedConfigKeys,
      signal: abortController.signal,
    });
    await secondFailed;
    abortController.abort();
    await firstPass;

    expect(attempts).toEqual(['answered', 'failed']);

    await runStartupAcpCapabilitiesRefresh(ports, { refreshedConfigKeys });

    expect(attempts).toEqual(['answered', 'failed', 'failed', 'never-reached']);
  });
});

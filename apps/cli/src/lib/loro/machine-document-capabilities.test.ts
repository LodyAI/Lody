import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  machineFlockKeys,
  getMachineFlockAcpCapabilities,
  getMachineFlockAgentConfigs,
  readMachineFlockRowsFromFlock,
  type AgentConfigMeta,
  type AgentConfigId,
  type MachineFlockKey,
  type MachineFlockWritableFlock,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';
import { MachineDocument } from './doc';

class FakeMachineFlock implements MachineFlockWritableFlock {
  readonly rows = new Map<string, { key: MachineFlockKey; value: unknown }>();
  commits = 0;

  scan(options?: { prefix?: readonly unknown[] }) {
    return [...this.rows.values()].filter((row) =>
      options?.prefix ? options.prefix.every((part, index) => row.key[index] === part) : true
    );
  }

  set(key: MachineFlockKey, value: unknown): void {
    this.rows.set(JSON.stringify(key), { key: [...key] as MachineFlockKey, value });
  }

  delete(key: MachineFlockKey): void {
    this.rows.delete(JSON.stringify(key));
  }

  commit(): void {
    this.commits += 1;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MachineDocument ACP capabilities', () => {
  it('keeps advertised sign-in methods when the writer did not ask the agent again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00.000Z'));
    const flock = new FakeMachineFlock();
    const repo = {
      openFlockDoc: vi.fn(async () => ({ flock, syncOnce: vi.fn(async () => undefined) })),
      flush: vi.fn(async () => undefined),
    } as unknown as LoroRepo;
    const document = new MachineDocument(
      repo,
      'workspace-1' as WorkspaceId,
      'machine-1' as MachineId
    );
    const write = (authMethods?: { type: 'agent'; id: string; name: string }[]) =>
      document.updateAcpCapabilities(
        'config-1' as AgentConfigId,
        'registry',
        'opencode',
        [],
        [{ modelId: 'model-a', name: 'Model A' }],
        undefined,
        undefined,
        false,
        'opencode@1.0.0',
        undefined,
        true,
        undefined,
        { authMethods }
      );

    await write([{ type: 'agent', id: 'oauth', name: 'OAuth' }]);
    // A session-created capability update never asked the agent again.
    await expect(write()).resolves.toMatchObject({
      authMethods: [{ type: 'agent', id: 'oauth', name: 'OAuth' }],
    });
    // A probe that did ask, and found none, clears the list.
    await expect(write([])).resolves.toMatchObject({ authMethods: [] });
  });
});

describe('MachineDocument per-model option lists', () => {
  const effort = (values: string[], currentValue = values[0] ?? '') => ({
    id: 'thought_level',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select' as const,
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  });
  const model = (currentValue: string) => ({
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select' as const,
    currentValue,
    options: ['mimo', 'deepseek-flash'].map((value) => ({ value, name: value })),
  });

  it('keeps every model’s own answer and writes only when what it offers changes', async () => {
    const flock = new FakeMachineFlock();
    const flush = vi.fn(async () => undefined);
    const repo = {
      openFlockDoc: vi.fn(async () => ({ flock, syncOnce: vi.fn(async () => undefined) })),
      flush,
    } as unknown as LoroRepo;
    const document = new MachineDocument(
      repo,
      'workspace-1' as WorkspaceId,
      'machine-1' as MachineId
    );
    const configId = 'config-1' as AgentConfigId;
    const observed = () =>
      getMachineFlockAcpCapabilities(readMachineFlockRowsFromFlock(flock))[configId]
        ?.observedModelConfigOptions;
    const refresh = (
      sourceVersion: string,
      modelConfigOptions?: Record<string, ReturnType<typeof effort>[]>
    ) =>
      document.updateAcpCapabilities(
        configId,
        'builtin',
        'dimcode',
        [],
        [],
        [model('mimo'), effort(['auto', 'none', 'low'])],
        undefined,
        false,
        sourceVersion,
        undefined,
        false,
        undefined,
        { modelConfigOptions }
      );

    // A refresh that read every model stores each answer; the snapshot is
    // its own model's answer.
    await refresh('dimcode@0.5.25', {
      'deepseek-flash': [model('deepseek-flash'), effort(['auto', 'low', 'max'])],
    });
    expect(observed()).toEqual({
      mimo: [effort(['auto', 'none', 'low'])],
      'deepseek-flash': [effort(['auto', 'low', 'max'])],
    });

    // A later answer that changes only a current value costs no write.
    flush.mockClear();
    await refresh('dimcode@0.5.25', {
      'deepseek-flash': [model('deepseek-flash'), effort(['auto', 'low', 'max'], 'max')],
    });
    expect(flush).not.toHaveBeenCalled();

    // A snapshot-only write (a created session) keeps the other models' answers.
    await refresh('dimcode@0.5.25');
    expect(observed()?.['deepseek-flash']).toEqual([effort(['auto', 'low', 'max'])]);

    // A new ladder, or a new runtime version, replaces the stored answer.
    await refresh('dimcode@0.5.26', {
      'deepseek-flash': [model('deepseek-flash'), effort(['auto', 'low', 'high', 'max'])],
    });
    expect(observed()?.['deepseek-flash']).toEqual([effort(['auto', 'low', 'high', 'max'])]);
  });
});

describe('MachineDocument quota publication', () => {
  it('publishes custom quota only while its persisted config and push fence still match', async () => {
    const flock = new FakeMachineFlock();
    const configId = 'quota-provider' as AgentConfigId;
    const config: AgentConfigMeta = {
      id: configId,
      machineId: 'machine-1' as MachineId,
      cliType: 'custom',
      agentType: 'example/agent',
      name: 'Example',
      env: {},
      customAcp: { command: 'example', args: [] },
    };
    flock.set(machineFlockKeys.agentConfig(configId), config);
    const expected = getMachineFlockAgentConfigs(readMachineFlockRowsFromFlock(flock))[configId]!;
    expect(expected).toBeDefined();
    const repo = {
      openFlockDoc: async () => ({ flock, syncOnce: async () => {} }),
      flush: async () => {},
    } as unknown as LoroRepo;
    const document = new MachineDocument(
      repo,
      'workspace-1' as WorkspaceId,
      'machine-1' as MachineId,
      () => {}
    );
    const limit = {
      limitId: 'account',
      scope: { providerId: 'example' },
      windows: [{ usedPercent: 20, windowDurationSeconds: 3600, resetsAtEpochSeconds: null }],
    };
    const quotaKey = machineFlockKeys.rateLimit(configId, config.agentType, 'account');
    await document.updateRateLimits(configId, config.agentType, limit, () => true, expected);
    expect(flock.rows.get(JSON.stringify(quotaKey))?.value).toEqual(limit);
    await document.updateRateLimits(
      configId,
      config.agentType,
      { ...limit, windows: [] },
      () => false,
      expected
    );
    expect(flock.rows.get(JSON.stringify(quotaKey))?.value).toEqual(limit);
    flock.delete(machineFlockKeys.agentConfig(configId));
    await document.updateRateLimits(
      configId,
      config.agentType,
      { ...limit, windows: [] },
      () => true,
      expected
    );
    expect(flock.rows.get(JSON.stringify(quotaKey))?.value).toEqual(limit);
  });
});

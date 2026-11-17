import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  machineFlockKeys,
  getMachineFlockAcpCapabilities,
  getMachineFlockAgentConfigs,
  getMachineFlockRateLimits,
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
import { normalizeAcpSessionCapabilities } from '@/agent/acp-capability-normalization';
import {
  canShowSubscriptionRateLimits,
  getAgentRateLimitEntries,
} from '../../../../../packages/components/src/lib/session-usage';

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
  it.each([
    { cliType: 'builtin' as const, agentType: 'antigravity' },
    { cliType: 'registry' as const, agentType: 'antigravity-acp' },
  ])(
    'keeps all Antigravity quota windows visible after $cliType session snapshots',
    async (agent) => {
      const flock = new FakeMachineFlock();
      const document = new MachineDocument(
        {
          openFlockDoc: async () => ({ flock, syncOnce: async () => {} }),
          flush: async () => {},
        } as unknown as LoroRepo,
        'workspace-1' as WorkspaceId,
        'machine-1' as MachineId
      );
      const configId = 'quota-provider' as AgentConfigId;
      const windows = ['Gemini Models', 'Claude and GPT models'].flatMap((label) =>
        [604_800, 18_000].map((windowDurationSeconds) => ({
          label,
          windowDurationSeconds,
          usedPercent: 25,
          resetsAtEpochSeconds: null,
        }))
      );
      await document.updateRateLimits(configId, agent.agentType, {
        limitId: agent.agentType,
        scope: { providerId: 'antigravity' },
        windows,
      });
      const write = async (rateLimits?: { version: 1; query?: boolean }) => {
        await document.updateAcpCapabilities(
          configId,
          agent.cliType,
          agent.agentType,
          [],
          [],
          undefined,
          undefined,
          false,
          'same-runtime',
          undefined,
          false,
          undefined,
          { rateLimits }
        );
        const rows = readMachineFlockRowsFromFlock(flock);
        const capability = getMachineFlockAcpCapabilities(rows)[configId]?.rateLimits;
        expect(capability).toEqual({ version: 1, query: true });
        expect(
          canShowSubscriptionRateLimits({
            ...agent,
            config: { env: { LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://localhost:8080' } },
            capability,
          })
        ).toBe(true);
        expect(
          getAgentRateLimitEntries(getMachineFlockRateLimits(rows), agent.agentType, configId)[0]
            ?.limits.windows
        ).toEqual(windows);
      };
      // Capability probing first records Lody's compatibility reader.
      await write({ version: 1, query: true });
      // Both a new session and a resumed session report no native Core quota extension.
      for (const modelId of ['model-a', 'model-b']) {
        const session = normalizeAcpSessionCapabilities(
          {
            models: { currentModelId: modelId, availableModels: [{ modelId, name: modelId }] },
          },
          { agent }
        );
        await write(session.rateLimits);
      }
    }
  );

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

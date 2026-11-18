import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACP_CAPABILITY_FETCH_TIME_RENEW_AFTER_MS,
  machineFlockKeys,
  type AcpConfigOptionSummary,
  type SessionGoalAction,
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
import { Flock } from '@loro-dev/flock-wasm';
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
  it('publishes no native Flock delta for session selections, but persists real changes and renewal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T00:00:00Z'));
    const flock = new Flock();
    const document = new MachineDocument(
      { openFlockDoc: async () => ({ flock }), flush: async () => {} } as unknown as LoroRepo,
      'workspace-1' as WorkspaceId,
      'machine-1' as MachineId,
      () => {}
    );
    const configId = 'provider' as AgentConfigId;
    const selections = (model: string, mode: string, effort: string): AcpConfigOptionSummary[] =>
      [
        { id: 'model', category: 'model', values: ['a', 'b'], currentValue: model },
        { id: 'mode', category: 'mode', values: ['normal', 'plan'], currentValue: mode },
        { id: 'effort', category: 'thought_level', values: ['low', 'high'], currentValue: effort },
      ].map(({ values, ...option }) => ({
        ...option,
        name: option.id,
        type: 'select',
        options: values.map((value) => ({ value, name: value })),
      }));
    const commands = [{ name: 'help', description: 'Synthetic command catalog '.repeat(1000) }];
    const write = (
      configOptions: AcpConfigOptionSummary[],
      sourceVersion = 'runtime-1',
      goalActions?: SessionGoalAction[]
    ) =>
      document.updateAcpCapabilities(
        configId,
        'registry',
        'example',
        [],
        [],
        configOptions,
        commands,
        false,
        sourceVersion,
        undefined,
        false,
        goalActions
      );
    const defaults = selections('a', 'normal', 'low');
    await write(defaults);
    // Record both model declarations first; new observations are legitimate writes.
    await write(selections('b', 'plan', 'high'));
    const checkpoint = flock.version();
    const initial = await document.getAcpCapabilities(configId);
    for (const options of [selections('a', 'plan', 'high'), selections('b', 'normal', 'low')]) {
      expect(await write(options)).toEqual(initial);
      expect(flock.version()).toEqual(checkpoint);
    }
    expect(initial?.configOptions).toEqual(defaults);
    // Renewal must retain the defaults and complete legacy row for older readers.
    vi.advanceTimersByTime(ACP_CAPABILITY_FETCH_TIME_RENEW_AFTER_MS);
    const renewed = await write(selections('b', 'plan', 'high'));
    expect(renewed.fetchedAt).toBeGreaterThan(initial?.fetchedAt ?? 0);
    expect(renewed.configOptions).toEqual(defaults);
    expect(flock.version()).not.toEqual(checkpoint);
    expect(flock.get(machineFlockKeys.acpCapability(configId))).toEqual(
      JSON.parse(JSON.stringify(renewed))
    );
    const goals = await write(defaults, 'runtime-1', ['pause']);
    expect((await document.getAcpCapabilities(configId))?.goalActions).toEqual(['pause']);
    expect(goals.goalActions).toEqual(['pause']);
    await write(defaults);
    expect((await document.getAcpCapabilities(configId))?.goalActions).toBeUndefined();
    const nextDefaults = selections('b', 'plan', 'high');
    await write(nextDefaults, 'runtime-2');
    expect((await document.getAcpCapabilities(configId))?.configOptions).toEqual(nextDefaults);
    const changed = nextDefaults.map((option) =>
      option.id === 'effort'
        ? { ...option, options: [...option.options, { value: 'max', name: 'Max' }] }
        : option
    );
    await write(changed, 'runtime-2');
    expect((await document.getAcpCapabilities(configId))?.configOptions).toEqual(changed);
    await document.updateAcpAuthMethods(configId, []);
    expect((await document.getAcpCapabilities(configId))?.authMethods).toEqual([]);
    const authenticatedCheckpoint = flock.version();
    await document.updateAcpAuthMethods(configId, []);
    expect(flock.version()).toEqual(authenticatedCheckpoint);
    await document.updateAcpAuthMethods(configId, [{ type: 'agent', id: 'login', name: 'Login' }]);
    expect((await document.getAcpCapabilities(configId))?.authMethods).toEqual([
      { type: 'agent', id: 'login', name: 'Login' },
    ]);
    expect((await document.getAcpCapabilities(configId))?.availableCommands).toEqual(commands);
  });

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
      const write = async (rateLimits?: { version: 1; query?: true }) => {
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
            configOptions: [
              {
                id: 'model',
                name: 'Model',
                category: 'model',
                type: 'select',
                currentValue: modelId,
                options: [{ value: modelId, name: modelId }],
              },
            ],
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
  it('keeps the persisted quota checkpoint for reset jitter and publishes real quota changes', async () => {
    const flock = new Flock();
    const document = new MachineDocument(
      { openFlockDoc: async () => ({ flock }), flush: async () => {} } as unknown as LoroRepo,
      'workspace-1' as WorkspaceId,
      'machine-1' as MachineId,
      () => {}
    );
    const configId = 'quota-provider' as AgentConfigId;
    const quota = (reset: number, usedPercent = 25) => ({
      limitId: 'account',
      scope: { providerId: 'example' },
      windows: [{ usedPercent, windowDurationSeconds: 3600, resetsAtEpochSeconds: reset }],
    });
    await document.updateRateLimits(configId, 'example', quota(1000));
    const checkpoint = flock.version();
    for (const reset of [1001, 999, 1002]) {
      await document.updateRateLimits(configId, 'example', quota(reset));
      expect(flock.version()).toEqual(checkpoint);
    }
    await document.updateRateLimits(configId, 'example', quota(1003));
    expect(flock.version()).not.toEqual(checkpoint);
    await document.updateRateLimits(configId, 'example', quota(1004, 26));
    expect(Object.values(getMachineFlockRateLimits(readMachineFlockRowsFromFlock(flock)))).toEqual([
      quota(1004, 26),
    ]);
  });

  it('publishes custom quota only while its persisted config and push fence still match', async () => {
    const flock = new FakeMachineFlock();
    const configId = 'quota-provider' as AgentConfigId;
    const config: AgentConfigMeta = {
      id: configId,
      machineId: 'machine-1' as MachineId,
      cliType: 'custom',
      agentType: 'example/agent',
      name: 'Example',
      description: '',
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

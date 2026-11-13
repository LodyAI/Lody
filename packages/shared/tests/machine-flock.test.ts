import { describe, expect, it } from 'vitest';

import {
  applyMachineFlockRowEvents,
  applyProviderSetupCancellationToFlock,
  deleteAgentConfigFromFlock,
  getMachineFlockAcpCapabilities,
  getMachineFlockAgentConfigs,
  getMachineFlockBuiltinAgentOptOuts,
  getMachineFlockLocalProjects,
  getMachineFlockRateLimits,
  getSessionLaunchConfigLegacyFields,
  machineFlockKeys,
  readMachineFlockRowsFromFlock,
  serializeMachineFlockKey,
  writeAcpModelConfigOptionsToFlock,
  writeAgentConfigToFlock,
  writeMachineFlockRowToFlock,
  type AgentConfigMeta,
  type MachineFlockKey,
  type MachineFlockWritableFlock,
} from '../src/machine-flock';
import {
  getRateLimitEntryKey,
  parseRateLimitEntryKey,
  getAcpCapabilityCacheKey,
  type AgentConfigId,
  type LocalProjectId,
  type MachineId,
  type SessionId,
  type SessionLegacyMetaFields,
  type SessionMeta,
} from '../src';

class FakeMachineFlock implements MachineFlockWritableFlock {
  readonly rows = new Map<string, { key: MachineFlockKey; value: unknown }>();
  readonly scanOptions: Array<{ prefix?: readonly unknown[] } | undefined> = [];
  commits = 0;

  scan(options?: { prefix?: readonly unknown[] }): Iterable<{
    readonly key: readonly unknown[];
    readonly value: unknown;
  }> {
    this.scanOptions.push(options);
    return [...this.rows.values()]
      .filter((row) => {
        const prefix = options?.prefix;
        return !prefix || prefix.every((part, index) => row.key[index] === part);
      })
      .map((row) => ({
        key: row.key,
        value: row.value,
      }));
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

describe('machine Flock helpers', () => {
  it('reads legacy launch config fields from old session meta', () => {
    expect(
      getSessionLaunchConfigLegacyFields({
        id: 'session-1' as SessionId,
        machineId: 'machine-1' as MachineId,
        userId: 'user-1',
        createdAt: '2026-04-19T00:00:00.000Z',
        cliType: 'custom',
        agentType: 'custom-agent',
        customAcp: { command: 'node' },
        env: { TOKEN: 'legacy' },
      } as SessionMeta & SessionLegacyMetaFields)
    ).toEqual({
      customAcp: { command: 'node' },
      env: { TOKEN: 'legacy' },
    });
  });

  it('keeps a well-formed GitHub remote on a local project and drops a malformed one', () => {
    const flock = new FakeMachineFlock();
    const value = (id: string, githubRepoFullName: unknown) => ({
      id,
      name: id,
      rootPath: `/Users/developer/Code/${id}`,
      createdAtMs: 1,
      githubRepoFullName,
    });
    flock.set(machineFlockKeys.localProject('a' as LocalProjectId), value('a', 'acme/api'));
    flock.set(machineFlockKeys.localProject('b' as LocalProjectId), value('b', '/Users/x/api'));
    const projects = getMachineFlockLocalProjects(readMachineFlockRowsFromFlock(flock));
    expect(projects['a' as LocalProjectId]?.githubRepoFullName).toBe('acme/api');
    expect(projects['b' as LocalProjectId]).toBeDefined();
    expect(projects['b' as LocalProjectId]?.githubRepoFullName).toBeUndefined();
  });

  it('extracts ACP capability rows independently for configs sharing a provider', () => {
    const configId = 'config-1' as AgentConfigId;
    const secondConfigId = 'config-2' as AgentConfigId;
    const row = {
      key: machineFlockKeys.acpCapability(configId),
      value: {
        cliType: 'custom',
        agentType: 'agent',
        cacheVersion: 2,
        sourceVersion: 'v1',
        modes: [],
        models: [],
        fetchedAt: 1,
      },
    } as const;
    const secondRow = {
      key: machineFlockKeys.acpCapability(secondConfigId),
      value: { ...row.value, fetchedAt: 2 },
    } as const;

    expect(
      getMachineFlockAcpCapabilities({
        [serializeMachineFlockKey(row.key)]: row,
        [serializeMachineFlockKey(secondRow.key)]: secondRow,
      })
    ).toEqual({
      [getAcpCapabilityCacheKey(configId)]: row.value,
      [getAcpCapabilityCacheKey(secondConfigId)]: secondRow.value,
    });
  });

  it('attaches declared per-model controls only for the matching source version', () => {
    const flock = new FakeMachineFlock();
    const configId = 'config-1' as AgentConfigId;
    const capability = {
      cliType: 'builtin',
      agentType: 'codex',
      cacheVersion: 2,
      sourceVersion: 'v1',
      modes: [],
      models: [],
      fetchedAt: 1,
    } as const;
    const models = { 'gpt-6': { effortValues: ['low', 'max'], fastMode: true } };
    writeMachineFlockRowToFlock(flock, {
      key: machineFlockKeys.acpCapability(configId),
      value: capability,
    });
    writeMachineFlockRowToFlock(flock, {
      key: machineFlockKeys.acpModelCapability(configId),
      value: { version: 1, sourceVersion: 'v1', models },
    });
    const key = getAcpCapabilityCacheKey(configId);

    expect(
      getMachineFlockAcpCapabilities(readMachineFlockRowsFromFlock(flock))[key]
        ?.declaredModelControls
    ).toEqual(models);
    // The stored capability row itself never carries the per-model controls.
    expect(
      getMachineFlockAcpCapabilities(
        readMachineFlockRowsFromFlock(flock, { families: ['acpCapability'] })
      )[key]?.declaredModelControls
    ).toBeUndefined();

    writeMachineFlockRowToFlock(flock, {
      key: machineFlockKeys.acpModelCapability(configId),
      value: { version: 1, sourceVersion: 'v0', models },
    });
    expect(
      getMachineFlockAcpCapabilities(readMachineFlockRowsFromFlock(flock))[key]
        ?.declaredModelControls
    ).toBeUndefined();
  });

  describe('per-model option lists', () => {
    const configId = 'config-1' as AgentConfigId;
    const key = getAcpCapabilityCacheKey(configId);
    const effort = (values: string[], currentValue = values[0] ?? '') => ({
      id: 'thought_level',
      name: 'Thinking',
      category: 'thought_level',
      type: 'select' as const,
      currentValue,
      options: values.map((value) => ({ value, name: value, description: `${value} effort` })),
    });
    const permission = {
      id: 'mode',
      name: 'Permission',
      category: 'mode',
      type: 'select' as const,
      currentValue: 'ask',
      options: ['ask', 'auto', 'full'].map((value) => ({
        value,
        name: value,
        description: `Runs tools with ${value} approval and a description long enough to matter`,
      })),
    };
    const withCapability = () => {
      const flock = new FakeMachineFlock();
      writeMachineFlockRowToFlock(flock, {
        key: machineFlockKeys.acpCapability(configId),
        value: {
          cliType: 'builtin',
          agentType: 'devin',
          cacheVersion: 2,
          sourceVersion: 'v2',
          modes: [],
          models: [],
          fetchedAt: 1,
        },
      });
      return flock;
    };
    const observed = (flock: FakeMachineFlock) =>
      getMachineFlockAcpCapabilities(readMachineFlockRowsFromFlock(flock))[key]
        ?.observedModelConfigOptions;
    const ladders = [['medium', 'high', 'max'], ['low', 'medium', 'high', 'xhigh', 'max'], []];
    const answers = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => {
        const ladder = ladders[index % ladders.length] ?? [];
        return [`model-${index}`, ladder.length ? [permission, effort(ladder)] : [permission]];
      })
    );

    it('stores identical lists once and resolves every model to its own list', () => {
      const flock = withCapability();
      expect(writeAcpModelConfigOptionsToFlock(flock, configId, 'v2', answers)).toBe(true);

      const shapeRows = [...flock.rows.values()].filter(
        (row) => row.key[0] === 'acpModelConfigOptionsShape'
      );
      const pointerRows = [...flock.rows.values()].filter(
        (row) => row.key[0] === 'acpModelConfigOptions'
      );
      expect(shapeRows).toHaveLength(3);
      expect(pointerRows).toHaveLength(100);
      const storedBytes = JSON.stringify([...shapeRows, ...pointerRows]).length;
      const perModelBytes = JSON.stringify(Object.values(answers)).length;
      // One list per model would store every list in full; sharing stores three.
      expect(storedBytes).toBeLessThan(perModelBytes / 4);
      expect(observed(flock)?.['model-1']).toEqual([
        permission,
        effort(['low', 'medium', 'high', 'xhigh', 'max']),
      ]);
      expect(observed(flock)?.['model-2']).toEqual([permission]);
      // An unchanged read keeps the merged entry's identity for React consumers.
      expect(getMachineFlockAcpCapabilities(readMachineFlockRowsFromFlock(flock))[key]).toBe(
        getMachineFlockAcpCapabilities(readMachineFlockRowsFromFlock(flock))[key]
      );
    });

    it('skips current-value-only changes and removes lists no model uses', () => {
      const flock = withCapability();
      writeAcpModelConfigOptionsToFlock(flock, configId, 'v2', {
        a: [effort(['low', 'max'])],
        b: [effort(['high'])],
      });
      const commits = flock.commits;
      expect(
        writeAcpModelConfigOptionsToFlock(flock, configId, 'v2', {
          a: [effort(['low', 'max'], 'max')],
        })
      ).toBe(false);
      expect(flock.commits).toBe(commits);

      // b now shares a's list, so b's old list has no model left.
      writeAcpModelConfigOptionsToFlock(flock, configId, 'v2', { b: [effort(['low', 'max'])] });
      expect(
        [...flock.rows.values()].filter((row) => row.key[0] === 'acpModelConfigOptionsShape')
      ).toHaveLength(1);
      expect(observed(flock)).toEqual({ a: [effort(['low', 'max'])], b: [effort(['low', 'max'])] });
    });

    it('keeps an older source version’s answer and ignores rows without a capability', () => {
      const flock = withCapability();
      writeAcpModelConfigOptionsToFlock(flock, configId, 'v1', { a: [effort(['low'])] });
      writeAcpModelConfigOptionsToFlock(flock, 'other' as AgentConfigId, 'v2', {
        a: [effort(['high'])],
      });

      const capabilities = getMachineFlockAcpCapabilities(readMachineFlockRowsFromFlock(flock));
      expect(capabilities[key]?.observedModelConfigOptions).toEqual({ a: [effort(['low'])] });
      expect(Object.keys(capabilities)).toEqual([key]);
    });
  });

  it('rejects an agent config whose value id does not match its row key', () => {
    const flock = new FakeMachineFlock();
    flock.set(machineFlockKeys.agentConfig('trusted-config' as AgentConfigId), {
      id: 'different-config',
      machineId: 'machine-1',
      name: 'Mismatched provider',
      cliType: 'custom',
      agentType: 'custom-agent',
      customAcp: { command: '/tmp/untrusted-acp' },
      env: {},
    });

    expect(readMachineFlockRowsFromFlock(flock, { families: ['agentConfig'] })).toEqual({});
  });

  it('round-trips arbitrary ACP provider names through scoped quota rows', () => {
    const flock = new FakeMachineFlock();
    const configId = 'example-provider' as AgentConfigId;
    const agentType = 'example::custom/agent';
    const key = machineFlockKeys.rateLimit(configId, agentType, 'weekly');
    const value = { limitId: 'weekly', scope: { providerId: 'example' }, windows: [] };
    writeMachineFlockRowToFlock(flock, { key, value });
    const limits = getMachineFlockRateLimits(
      readMachineFlockRowsFromFlock(flock, { families: ['rateLimit'] })
    );
    const entryKey = getRateLimitEntryKey(agentType, 'weekly', configId);
    expect(limits[entryKey]).toEqual(value);
    expect(parseRateLimitEntryKey(entryKey)).toEqual({
      agentConfigId: configId,
      cliType: agentType,
      limitId: 'weekly',
    });
  });

  describe('builtin agent opt-out rows', () => {
    const machineId = 'machine-1' as MachineId;

    const kimi = (id: string): AgentConfigMeta =>
      ({
        id: id as AgentConfigId,
        machineId,
        name: 'Kimi',
        cliType: 'builtin',
        agentType: 'kimi',
        env: {},
      }) as AgentConfigMeta;
    const optOuts = (flock: FakeMachineFlock) =>
      getMachineFlockBuiltinAgentOptOuts(
        readMachineFlockRowsFromFlock(flock, { families: ['builtinAgentOptOut'] })
      );

    it('deleting the last config of a type records the opt-out in one commit', () => {
      const flock = new FakeMachineFlock();
      writeAgentConfigToFlock(flock, kimi('a'));
      flock.commits = 0;

      expect(deleteAgentConfigFromFlock(flock, kimi('a'), 1700)).toBe(true);

      expect(flock.commits).toBe(1);
      expect(getMachineFlockAgentConfigs(readMachineFlockRowsFromFlock(flock))).toEqual({});
      expect(optOuts(flock)).toEqual(new Set(['kimi']));
    });

    it('deleting one of several configs of a type does not record an opt-out', () => {
      // One Kimi is left, so the user did not remove Kimi, startup adds nothing back and no
      // opt-out should be recorded.
      const flock = new FakeMachineFlock();
      writeAgentConfigToFlock(flock, kimi('a'));
      writeAgentConfigToFlock(flock, kimi('b'));

      deleteAgentConfigFromFlock(flock, kimi('a'), 1700);

      expect(optOuts(flock)).toEqual(new Set());
    });

    it('deleting a provider removes only its scoped rate limits', () => {
      const flock = new FakeMachineFlock();
      const first = kimi('a');
      const second = kimi('b');
      writeAgentConfigToFlock(flock, first);
      writeAgentConfigToFlock(flock, second);
      writeMachineFlockRowToFlock(flock, {
        key: machineFlockKeys.rateLimit(first.id, 'kimi', 'kimi'),
        value: { limitId: 'kimi', scope: { providerId: 'kimi' }, windows: [] },
      });
      writeMachineFlockRowToFlock(flock, {
        key: machineFlockKeys.rateLimit(second.id, 'kimi', 'kimi'),
        value: { limitId: 'kimi', scope: { providerId: 'kimi' }, windows: [] },
      });

      deleteAgentConfigFromFlock(flock, first, 1700);

      expect(getMachineFlockRateLimits(readMachineFlockRowsFromFlock(flock))).toEqual({
        [getRateLimitEntryKey('kimi', 'kimi', second.id)]: {
          limitId: 'kimi',
          scope: { providerId: 'kimi' },
          windows: [],
        },
      });
    });

    it('writing a config of an opted-out type retracts the opt-out in the same commit', () => {
      const flock = new FakeMachineFlock();
      deleteAgentConfigFromFlock(flock, kimi('a'), 1700);
      flock.commits = 0;

      expect(writeAgentConfigToFlock(flock, kimi('b'))).toBe(true);

      expect(flock.commits).toBe(1);
      expect(optOuts(flock)).toEqual(new Set());
      expect(
        Object.keys(getMachineFlockAgentConfigs(readMachineFlockRowsFromFlock(flock)))
      ).toEqual(['b']);
    });

    it('cancelling a published provider setup records the opt-out', () => {
      // Cancelling a published setup is also removing the provider; without the opt-out the CLI
      // adds it back on the next startup.
      const flock = new FakeMachineFlock();
      const config = kimi('setup-1');
      writeAgentConfigToFlock(flock, config);
      writeMachineFlockRowToFlock(flock, {
        key: machineFlockKeys.rateLimit(config.id, 'kimi', 'kimi'),
        value: { limitId: 'kimi', scope: { providerId: 'kimi' }, windows: [] },
      });

      applyProviderSetupCancellationToFlock(flock, {
        v: 1,
        id: 'setup-1' as AgentConfigId,
        machineId,
        cancelledAt: 1700,
      });

      expect(getMachineFlockAgentConfigs(readMachineFlockRowsFromFlock(flock))).toEqual({});
      expect(getMachineFlockRateLimits(readMachineFlockRowsFromFlock(flock))).toEqual({});
      expect(optOuts(flock)).toEqual(new Set(['kimi']));
    });

    it('cancelling an unpublished provider setup records no opt-out', () => {
      // It was never published, so it was never in the list and there is nothing to remove.
      const flock = new FakeMachineFlock();
      applyProviderSetupCancellationToFlock(flock, {
        v: 1,
        id: 'setup-1' as AgentConfigId,
        machineId,
        cancelledAt: 1700,
      });

      expect(optOuts(flock)).toEqual(new Set());
    });
  });
});

it('reads, updates and deletes validated memory association rows without mixing machine scope', async () => {
  const { getMachineFlockMemories } = await import('../src/machine-flock');
  const flock = new FakeMachineFlock();
  const entry = {
    providerId: 'nowledge-mem',
    memoryId: 'reviewer',
    machineId: 'a',
    name: 'Reviewer',
    description: 'Lessons',
  };
  const key = machineFlockKeys.memory(entry.providerId, entry.memoryId);
  writeMachineFlockRowToFlock(flock, { key, value: entry });
  flock.set(machineFlockKeys.memory('nowledge-mem', 'wrong-key'), entry);
  flock.set(machineFlockKeys.memory('nowledge-mem', 'secret'), {
    ...entry,
    memoryId: 'secret',
    token: 'not-allowed',
  });
  const rows = readMachineFlockRowsFromFlock(flock, { families: ['memory'] });
  expect(getMachineFlockMemories(rows, 'a' as MachineId)).toEqual([entry]);
  expect(getMachineFlockMemories(rows, 'b' as MachineId)).toEqual([]);
  const updated = applyMachineFlockRowEvents(rows, [{ key, value: { ...entry, name: 'Edited' } }]);
  expect(getMachineFlockMemories(updated, 'a' as MachineId)).toEqual([
    { ...entry, name: 'Edited' },
  ]);
  expect(
    getMachineFlockMemories(applyMachineFlockRowEvents(updated, [{ key }]), 'a' as MachineId)
  ).toEqual([]);
});

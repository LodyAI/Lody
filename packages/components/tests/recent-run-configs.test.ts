// @vitest-environment jsdom

// Coverage for the "Recently used" run-config list: what counts as the SAME
// combination, what a row is allowed to offer (only agents that are still
// selectable), and that the currently selected combination never appears —
// picking it would be a no-op row at the top of the menu.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';

import type { AcpConfigOptionSelector } from '../src/components/shared/acp-selector-options';
import {
  appendRecentRunConfig,
  buildRecentRunConfigItems,
  describeRunConfigSelection,
  getRecentRunConfigKey,
  MAX_STORED_RECENT_RUN_CONFIGS,
  readRecentRunConfigs,
  recordRecentRunConfig,
  resolveApplicableConfigOptionValues,
  sanitizeConfigOptionValues,
  type RecentRunConfigRecord,
} from '../src/lib/recent-run-configs';

const MACHINE = 'machine-1' as MachineId;

const agentConfig = (id: string, name: string): AgentConfigMeta => ({
  id: id as AgentConfigId,
  machineId: MACHINE,
  name,
  description: undefined,
  cliType: 'builtin',
  agentType: 'claude',
  env: {},
});

const record = (overrides: Partial<RecentRunConfigRecord> = {}): RecentRunConfigRecord => ({
  agentId: 'agent-1',
  machineId: MACHINE,
  modelId: 'opus',
  modelLabel: 'Opus 5',
  reasoningLabel: 'High',
  planOn: false,
  fastOn: false,
  configOptionValues: { reasoning_effort: 'high' },
  usedAt: 1,
  ...overrides,
});

describe('recent run config identity', () => {
  it('treats the same knobs in a different key order as one combination', () => {
    const left = record({ configOptionValues: { a: 'x', b: true } });
    const right = record({ configOptionValues: { b: true, a: 'x' } });
    expect(getRecentRunConfigKey(left)).toBe(getRecentRunConfigKey(right));
  });

  it('separates entries that differ in any single knob', () => {
    const base = record();
    const keys = new Set(
      [
        base,
        record({ modelId: 'sonnet' }),
        record({ agentId: 'agent-2' }),
        record({ machineId: 'machine-2' as MachineId }),
        record({ configOptionValues: { reasoning_effort: 'low' } }),
        record({ configOptionValues: {} }),
      ].map(getRecentRunConfigKey)
    );
    expect(keys.size).toBe(6);
  });

  it('drops unresolved option values so they never enter the key', () => {
    expect(sanitizeConfigOptionValues({ a: 'x', b: undefined, c: false })).toEqual({
      a: 'x',
      c: false,
    });
  });
});

describe('appendRecentRunConfig', () => {
  it('moves a repeated combination back to the front without duplicating it', () => {
    const first = record({ modelId: 'opus', usedAt: 1 });
    const second = record({ modelId: 'sonnet', usedAt: 2 });
    const repeated = record({ modelId: 'opus', usedAt: 3 });
    const next = appendRecentRunConfig(appendRecentRunConfig([first], second), repeated);
    expect(next.map((entry) => entry.modelId)).toEqual(['opus', 'sonnet']);
    expect(next[0]?.usedAt).toBe(3);
  });

  it('caps the stored history', () => {
    let records: RecentRunConfigRecord[] = [];
    for (let index = 0; index < MAX_STORED_RECENT_RUN_CONFIGS + 5; index += 1) {
      records = appendRecentRunConfig(records, record({ modelId: `model-${index}` }));
    }
    expect(records).toHaveLength(MAX_STORED_RECENT_RUN_CONFIGS);
    expect(records[0]?.modelId).toBe(`model-${MAX_STORED_RECENT_RUN_CONFIGS + 4}`);
  });
});

describe('storage', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips per workspace and ignores corrupt payloads', () => {
    recordRecentRunConfig('ws-1', record(), 10);
    expect(readRecentRunConfigs('ws-1')).toHaveLength(1);
    expect(readRecentRunConfigs('ws-2')).toHaveLength(0);

    localStorage.setItem('lody:recentRunConfigs:ws-1', '{not json');
    expect(readRecentRunConfigs('ws-1')).toEqual([]);
  });

  it('reads nothing for a workspace that is not resolved yet', () => {
    recordRecentRunConfig(null, record(), 10);
    expect(readRecentRunConfigs(null)).toEqual([]);
  });
});

describe('buildRecentRunConfigItems', () => {
  const agentConfigs = [agentConfig('agent-1', 'Claude'), agentConfig('agent-2', 'Codex')];

  it('hides the combination that is already selected', () => {
    const selected = record({ modelId: 'opus' });
    const other = record({ modelId: 'sonnet', modelLabel: 'Sonnet 5' });
    const items = buildRecentRunConfigItems({
      records: [selected, other],
      agentConfigs,
      currentKey: getRecentRunConfigKey(selected),
    });
    expect(items.map((item) => item.modelLabel)).toEqual(['Sonnet 5']);
  });

  it('drops records whose agent is no longer selectable', () => {
    const items = buildRecentRunConfigItems({
      records: [
        record({ agentId: 'agent-2', modelLabel: 'Codex model' }),
        record({ agentId: 'deleted-agent', modelLabel: 'Gone' }),
        record({ machineId: 'other-machine' as MachineId, modelLabel: 'Other machine' }),
      ],
      agentConfigs,
      currentKey: null,
    });
    expect(items.map((item) => item.modelLabel)).toEqual(['Codex model']);
    expect(items[0]?.agent.name).toBe('Codex');
  });

  it('caps the visible rows', () => {
    const records = ['a', 'b', 'c', 'd'].map((model) => record({ modelId: model }));
    expect(buildRecentRunConfigItems({ records, agentConfigs, currentKey: null })).toHaveLength(3);
  });
});

describe('applying a record to the current selectors', () => {
  const reasoning: AcpConfigOptionSelector = {
    configId: 'reasoning_effort',
    label: 'Reasoning',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
  };

  it('skips values the provider no longer offers', () => {
    expect(
      resolveApplicableConfigOptionValues(
        { configOptionValues: { reasoning_effort: 'xhigh', gone: 'x' } },
        [reasoning]
      )
    ).toEqual([]);
    expect(
      resolveApplicableConfigOptionValues({ configOptionValues: { reasoning_effort: 'high' } }, [
        reasoning,
      ])
    ).toEqual([{ configId: 'reasoning_effort', value: 'high' }]);
  });

  it('keeps the recorded effort when the entry also moves the model', () => {
    // The selectors still carry the outgoing model's ladder, so `xhigh` is not
    // theirs to reject — the incoming model may well offer it.
    expect(
      resolveApplicableConfigOptionValues(
        { configOptionValues: { reasoning_effort: 'xhigh', gone: 'x' } },
        [reasoning],
        { switchesModel: true }
      )
    ).toEqual([{ configId: 'reasoning_effort', value: 'xhigh' }]);
  });

  it('describes the selection the way the run-config trigger reads it', () => {
    const face = describeRunConfigSelection({
      modelOptions: [{ value: 'opus', label: 'Opus 5' }],
      selectedModelId: 'opus',
      configOptionSelectors: [reasoning],
      configOptionValues: { reasoning_effort: 'high' },
    });
    expect(face).toEqual({
      modelId: 'opus',
      modelLabel: 'Opus 5',
      reasoningLabel: 'High',
      planOn: false,
      fastOn: false,
    });
  });

  it('keeps a provider that exposes its model as a config option out of modelId', () => {
    const modelSelector: AcpConfigOptionSelector = {
      configId: 'model',
      label: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'grok-4',
      options: [{ value: 'grok-4', label: 'Grok 4' }],
    };
    const face = describeRunConfigSelection({
      modelOptions: [],
      selectedModelId: null,
      configOptionSelectors: [modelSelector],
      configOptionValues: { model: 'grok-4' },
    });
    expect(face.modelId).toBeNull();
    expect(face.modelLabel).toBe('Grok 4');
  });
});

describe('recent Agent Role entries', () => {
  const role = (id: string, name: string): AgentRole => ({
    v: AGENT_ROLE_VERSION,
    id: id as AgentRoleId,
    ownerUserId: 'user-1',
    visibility: 'private',
    name,
    emoji: '\u{1F50D}',
    machineId: MACHINE,
    agentConfigId: 'agent-1' as AgentConfigId,
    runConfig: {},
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  const agentConfigs = [agentConfig('agent-1', 'Claude')];

  // The same knobs picked by hand and picked through a Role are not the same
  // run: the Role also carries its instruction and its provenance.
  it('is a different combination from the same values picked by hand', () => {
    expect(getRecentRunConfigKey(record({ agentRoleId: 'role-1' }))).not.toBe(
      getRecentRunConfigKey(record())
    );
  });

  it('reads as the Role, not as the agent it is bound to', () => {
    const items = buildRecentRunConfigItems({
      records: [record({ agentRoleId: 'role-1' })],
      agentConfigs,
      agentRoles: [role('role-1', 'Code Reviewer')],
      currentKey: null,
    });
    expect(items[0]?.role).toEqual({ name: 'Code Reviewer', emoji: '\u{1F50D}' });
    expect(items[0]?.agent.name).toBe('Claude');
  });

  // A Role never falls back, so an entry whose Role is gone or cannot run must
  // drop out rather than quietly re-running its values without it.
  it('drops an entry whose Role can no longer run', () => {
    const records = [record({ agentRoleId: 'role-1' })];
    expect(
      buildRecentRunConfigItems({ records, agentConfigs, agentRoles: [], currentKey: null })
    ).toHaveLength(0);
    expect(buildRecentRunConfigItems({ records, agentConfigs, currentKey: null })).toHaveLength(0);
  });

  it('leaves plain entries alone when no Roles are passed', () => {
    const items = buildRecentRunConfigItems({
      records: [record()],
      agentConfigs,
      currentKey: null,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.role).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import type { AgentConfigMeta, MachineMeta } from '@lody/shared';
import {
  applyEnvUpdates,
  inferAgentConfigCliType,
  parseEnvAssignments,
  parseEnvFileText,
  resolveMachineOrThrow,
  resolveAgentConfigSelector,
  sortAgentConfigs,
} from './agent-config';

const createAgentConfig = (overrides: Partial<AgentConfigMeta> = {}): AgentConfigMeta => ({
  id: 'agent-config-id',
  machineId: 'machine-id',
  name: 'Codex Default',
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
  description: undefined,
  ...overrides,
});

const createMachine = (overrides: Partial<MachineMeta> = {}): MachineMeta => ({
  id: 'machine-id',
  name: 'Machine',
  cliVersion: '0.0.0',
  os: 'linux',
  sessions: [],
  ...overrides,
});

describe('agent-config command helpers', () => {
  it('sorts agent configs by name then id', () => {
    const configs = [
      createAgentConfig({ id: 'b', name: 'Beta' }),
      createAgentConfig({ id: 'c', name: 'Alpha' }),
      createAgentConfig({ id: 'a', name: 'Alpha' }),
    ];

    expect(sortAgentConfigs(configs).map((config) => config.id)).toEqual(['a', 'c', 'b']);
  });

  it('resolves agent config selectors from id, name, or env fallback', () => {
    const configs = [
      createAgentConfig({ id: 'cfg-1', name: 'Codex Default' }),
      createAgentConfig({ id: 'cfg-2', name: 'Claude' }),
    ];

    expect(resolveAgentConfigSelector(configs, { selector: 'cfg-2' }).id).toBe('cfg-2');
    expect(resolveAgentConfigSelector(configs, { selector: 'Claude' }).id).toBe('cfg-2');
    expect(resolveAgentConfigSelector([configs[0]!], { envSelector: 'cfg-1' }).id).toBe('cfg-1');
  });

  it('rejects ambiguous agent config names', () => {
    expect(() =>
      resolveAgentConfigSelector(
        [
          createAgentConfig({ id: 'cfg-1', name: 'Shared' }),
          createAgentConfig({ id: 'cfg-2', name: 'Shared' }),
        ],
        { selector: 'Shared' }
      )
    ).toThrow(/ambiguous/i);
  });

  it('rejects ambiguous machine names', () => {
    expect(() =>
      resolveMachineOrThrow(
        [
          createMachine({ id: 'machine-1', name: 'Shared' }),
          createMachine({ id: 'machine-2', name: 'Shared' }),
        ],
        {
          selector: 'Shared',
          authMachineId: 'machine-1',
        }
      )
    ).toThrow(/ambiguous/i);
  });

  it('parses inline and file env entries and applies updates in the correct order', () => {
    expect(parseEnvAssignments(['OPENAI_API_KEY=abc', 'FOO=bar'])).toEqual({
      OPENAI_API_KEY: 'abc',
      FOO: 'bar',
    });

    expect(
      parseEnvFileText(`
# comment
OPENAI_API_KEY=from-file
FOO=from-file
`)
    ).toEqual({
      OPENAI_API_KEY: 'from-file',
      FOO: 'from-file',
    });

    expect(
      applyEnvUpdates(
        { BASE: '1', FOO: 'old' },
        { FOO: 'from-file', BAR: 'from-file' },
        { FOO: 'from-flag', BAZ: 'from-flag' },
        ['BASE']
      )
    ).toEqual({
      FOO: 'from-flag',
      BAR: 'from-file',
      BAZ: 'from-flag',
    });
  });

  it('infers cli type from agent type', () => {
    expect(inferAgentConfigCliType('codex')).toBe('builtin');
    expect(inferAgentConfigCliType('claude')).toBe('builtin');
    expect(inferAgentConfigCliType('grok')).toBe('builtin');
    expect(inferAgentConfigCliType('bub')).toBe('builtin');
    expect(inferAgentConfigCliType('claude-p')).toBe('registry');
    expect(inferAgentConfigCliType('opencode')).toBe('registry');
    expect(inferAgentConfigCliType('kimi')).toBe('registry');
    expect(inferAgentConfigCliType('kimi-code')).toBe('registry');
  });
});

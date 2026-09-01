import { describe, expect, it } from 'vitest';
import type { AgentConfigId, AgentConfigMeta, MachineId, MachineMeta, WorkspaceId } from '@lody/shared';
import {
  applyEnvUpdates,
  buildRefreshCapabilitiesPayload,
  inferAgentConfigCliType,
  parseEnvAssignments,
  parseEnvFileText,
  resolveMachineOrThrow,
  resolveAgentConfigSelector,
  sortAgentConfigs,
} from './agent-config';

const createAgentConfig = (overrides: Partial<AgentConfigMeta> = {}): AgentConfigMeta => ({
  id: 'agent-config-id' as AgentConfigId,
  machineId: 'machine-id' as MachineId,
  name: 'Codex Default',
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
  description: undefined,
  ...overrides,
});

const createMachine = (overrides: Partial<MachineMeta> = {}): MachineMeta => ({
  id: 'machine-id' as MachineId,
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
    expect(inferAgentConfigCliType('claude-p')).toBe('registry');
    expect(inferAgentConfigCliType('opencode')).toBe('registry');
    expect(inferAgentConfigCliType('kimi')).toBe('registry');
    expect(inferAgentConfigCliType('kimi-code')).toBe('registry');
  });
});

describe('buildRefreshCapabilitiesPayload', () => {
  it('forwards customAcp for custom cliType agents', () => {
    const config = createAgentConfig({
      cliType: 'custom',
      agentType: 'ohmypi',
      customAcp: {
        command: '/usr/local/bin/omp',
        args: ['acp'],
      },
    });

    const payload = buildRefreshCapabilitiesPayload(
      config,
      'machine-id' as MachineId,
      'workspace-id' as WorkspaceId
    );

    expect(payload.type).toBe('machine/acp-capabilities-refresh');
    expect(payload.machineId).toBe('machine-id');
    expect(payload.workspaceId).toBe('workspace-id');
    expect(payload.configId).toBe(config.id);
    expect(payload.cliType).toBe('custom');
    expect(payload.agentType).toBe('ohmypi');
    expect(payload.customAcp).toEqual({
      command: '/usr/local/bin/omp',
      args: ['acp'],
    });
    expect(payload.runtimeOverrides).toBeUndefined();
  });

  it('forwards runtimeOverrides for builtin agents', () => {
    const config = createAgentConfig({
      cliType: 'builtin',
      agentType: 'codex',
      runtimeOverrides: {
        codexPath: '/custom/path/to/codex',
      },
    });

    const payload = buildRefreshCapabilitiesPayload(
      config,
      'machine-id' as MachineId,
      'workspace-id' as WorkspaceId
    );

    expect(payload.runtimeOverrides).toEqual({
      codexPath: '/custom/path/to/codex',
    });
    expect(payload.customAcp).toBeUndefined();
  });

  it('omits optional fields when the config has none', () => {
    const config = createAgentConfig({
      cliType: 'builtin',
      agentType: 'codex',
      env: { FOO: 'bar' },
    });

    const payload = buildRefreshCapabilitiesPayload(
      config,
      'machine-id' as MachineId,
      'workspace-id' as WorkspaceId
    );

    expect(payload.customAcp).toBeUndefined();
    expect(payload.runtimeOverrides).toBeUndefined();
    expect(payload.env).toEqual({ FOO: 'bar' });
  });
});
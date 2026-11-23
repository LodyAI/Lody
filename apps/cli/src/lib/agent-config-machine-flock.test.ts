import { describe, expect, it } from 'vitest';
import { type AgentConfigMeta } from '@lody/shared';
import { mergeAgentConfigs } from './agent-config-machine-flock';

const createAgentConfig = (overrides: Partial<AgentConfigMeta> = {}): AgentConfigMeta => ({
  id: 'agent-config-id',
  machineId: 'machine-id',
  name: 'Codex Default',
  description: undefined,
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
  ...overrides,
});

describe('agent-config machine flock helpers', () => {
  it('merges loro-repo meta configs with machine flock configs and prefers machine flock', () => {
    const legacyConfig = createAgentConfig({
      id: 'shared',
      name: 'Legacy',
      env: { SOURCE: 'legacy' },
    });
    const machineFlockConfig = createAgentConfig({
      id: 'shared',
      name: 'Machine Flock',
      env: { SOURCE: 'machine-flock' },
    });
    const otherLegacyConfig = createAgentConfig({
      id: 'legacy-only',
      name: 'Legacy Only',
    });

    expect(mergeAgentConfigs([legacyConfig, otherLegacyConfig], [machineFlockConfig])).toEqual([
      machineFlockConfig,
      otherLegacyConfig,
    ]);
  });
});

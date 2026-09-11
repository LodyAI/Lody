import { describe, expect, it } from 'vitest';

import {
  classifyPermissionModeFace,
  getBuiltinDefaultModeId,
  getManagedBuiltinRuntimeByAgentType,
  getManagedBuiltinRuntimeByRuntimeName,
  getStaticBuiltinAcpCapabilities,
  hasBuiltinRuntimeOverrideValues,
  isBuiltinAgentType,
} from '../src/ai';

describe('builtin Grok shared contract', () => {
  it('maps the Grok agent to its managed runtime in both directions', () => {
    expect(isBuiltinAgentType('grok')).toBe(true);
    expect(getManagedBuiltinRuntimeByAgentType('grok')).toEqual({
      runtimeName: 'grok-build',
      agentType: 'grok',
      displayName: 'Grok',
    });
    expect(getManagedBuiltinRuntimeByRuntimeName('grok-build')?.agentType).toBe('grok');
  });

  it('mirrors the config options exposed by the official-runtime compatibility adapter', () => {
    const capabilities = getStaticBuiltinAcpCapabilities('builtin', 'grok');

    expect(capabilities?.modes.map((mode) => mode.id)).toEqual(['default', 'plan']);
    expect(capabilities?.models).toEqual([
      {
        modelId: 'grok-4.6',
        name: 'Grok 4.6',
        description: "SpaceXAI's latest frontier model",
      },
      { modelId: 'grok-4.5', name: 'Grok 4.5' },
    ]);
    expect(capabilities?.configOptions.map((option) => option.id)).toEqual([
      'plan_mode',
      'permission_mode',
      'model',
      'reasoning_effort',
    ]);
    expect(capabilities?.configOptions[0]).toMatchObject({ type: 'boolean', currentValue: false });
    expect(capabilities?.configOptions[1]?.options.map((option) => option.value)).toEqual([
      'ask',
      'always-approve',
    ]);
    expect(capabilities?.configOptions[2]?.currentValue).toBe('grok-4.6');
    expect(capabilities?.configOptions[2]?.options.map((option) => option.value)).toEqual([
      'grok-4.6',
      'grok-4.5',
    ]);
    expect(capabilities?.configOptions[3]?.currentValue).toBe('high');
    expect(capabilities?.configOptions[3]?.options.map((option) => option.value)).toEqual([
      'xhigh',
      'high',
      'medium',
      'low',
    ]);
    expect(getBuiltinDefaultModeId('builtin', 'grok')).toBe('default');
    expect(classifyPermissionModeFace('always-approve')).toEqual({
      kind: 'full-access',
      tone: 'warning',
      render: 'icon',
    });
  });

  it('invalidates static capabilities when a Grok override is present', () => {
    expect(hasBuiltinRuntimeOverrideValues({ grokPath: ' /opt/grok ' })).toBe(true);
    expect(
      getStaticBuiltinAcpCapabilities('builtin', 'grok', { grokPath: '/opt/grok' })
    ).toBeUndefined();
  });
});

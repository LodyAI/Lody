import { describe, expect, it } from 'vitest';

import {
  MANAGED_BUILTIN_RUNTIMES,
  classifyPermissionModeFace,
  getBuiltinDefaultModeId,
  getManagedBuiltinRuntimeByAgentType,
  getManagedBuiltinRuntimeByRuntimeName,
  getStaticBuiltinAcpCapabilities,
  hasBuiltinRuntimeOverrideValues,
  isBuiltinAgentType,
} from '../src/ai';

describe('builtin Kimi shared contract', () => {
  it('is the first managed builtin and maps both directions', () => {
    expect(MANAGED_BUILTIN_RUNTIMES[0]).toEqual({
      runtimeName: 'kimi-code',
      agentType: 'kimi',
      displayName: 'Kimi Code',
    });
    expect(isBuiltinAgentType('kimi')).toBe(true);
    expect(getManagedBuiltinRuntimeByAgentType('kimi')?.runtimeName).toBe('kimi-code');
    expect(getManagedBuiltinRuntimeByRuntimeName('kimi-code')?.agentType).toBe('kimi');
  });

  it('provides stable modes without pretending to know account-specific models', () => {
    const capabilities = getStaticBuiltinAcpCapabilities('builtin', 'kimi');

    expect(capabilities?.modes.map((mode) => mode.id)).toEqual(['default', 'auto', 'yolo']);
    expect(capabilities?.models).toEqual([]);
    expect(capabilities?.configOptions.map((option) => option.id)).toEqual([
      'plan_mode',
      'permission_mode',
    ]);
    expect(capabilities?.configOptions[1]?.currentValue).toBe('auto');
    expect(classifyPermissionModeFace('yolo')).toEqual({
      kind: 'full-access',
      tone: 'warning',
      render: 'icon',
    });
  });

  it('uses automatic approval modes as the defaults for builtin agents only', () => {
    expect(getBuiltinDefaultModeId('builtin', 'codex')).toBe('agent-auto-review');
    expect(getBuiltinDefaultModeId('builtin', 'claude')).toBe('auto');
    expect(getBuiltinDefaultModeId('builtin', 'kimi')).toBe('auto');
    expect(getBuiltinDefaultModeId('registry', 'codex')).toBeUndefined();
    expect(getBuiltinDefaultModeId('builtin', 'other')).toBeUndefined();
  });

  it('invalidates static capabilities when a Kimi override is present', () => {
    expect(hasBuiltinRuntimeOverrideValues({ kimiPath: ' /opt/kimi ' })).toBe(true);
    expect(
      getStaticBuiltinAcpCapabilities('builtin', 'kimi', { kimiPath: '/opt/kimi' })
    ).toBeUndefined();
  });
});

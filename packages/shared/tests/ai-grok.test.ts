import { describe, expect, it } from 'vitest';

import {
  classifyPermissionModeFace,
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

  it('warns when approval is always granted', () => {
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

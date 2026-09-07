import { describe, expect, it } from 'vitest';

import {
  getBuiltinAgentByAgentType,
  getManagedBuiltinRuntimeByAgentType,
  getStaticBuiltinAcpCapabilities,
  isBuiltinAgentType,
  isManagedBuiltinAgentType,
} from '../src/ai';
import { supportsBuiltinAuthentication } from '../src/agent-authentication';

describe('builtin DeepSeek Harness shared contract', () => {
  it('is builtin without being a managed-download runtime', () => {
    expect(isBuiltinAgentType('deepseek')).toBe(true);
    expect(isManagedBuiltinAgentType('deepseek')).toBe(false);
    expect(getManagedBuiltinRuntimeByAgentType('deepseek')).toBeUndefined();
    expect(getBuiltinAgentByAgentType('deepseek')).toEqual({
      agentType: 'deepseek',
      displayName: 'DeepSeek Harness',
    });
  });

  it('uses environment credentials instead of managed interactive authentication', () => {
    expect(
      supportsBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'deepseek',
        env: { DEEPSEEK_API_KEY: 'test-key' },
      })
    ).toBe(false);
  });

  it('waits for a live probe before advertising endpoint-dependent model options', () => {
    const capabilities = getStaticBuiltinAcpCapabilities('builtin', 'deepseek');
    expect(capabilities?.models).toEqual([]);
    expect(capabilities?.configOptions.map((option) => option.id)).toEqual([
      'mode',
      'agent_preset',
    ]);
  });
});

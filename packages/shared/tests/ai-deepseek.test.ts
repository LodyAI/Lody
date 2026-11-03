import { describe, expect, it } from 'vitest';

import { getStaticBuiltinAcpCapabilities } from '../src/ai';

describe('builtin DeepSeek Harness shared contract', () => {
  it('waits for a live probe before advertising endpoint-dependent model options', () => {
    const capabilities = getStaticBuiltinAcpCapabilities('builtin', 'deepseek');
    expect(capabilities?.models).toEqual([]);
    expect(capabilities?.configOptions.map((option) => option.id)).toEqual([
      'plan_mode',
      'mode',
      'agent_preset',
    ]);
  });
});

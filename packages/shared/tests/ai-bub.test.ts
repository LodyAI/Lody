import { describe, expect, it } from 'vitest';

import { getBuiltinDefaultModeId, getStaticBuiltinAcpCapabilities } from '../src/ai';

describe('builtin Bub shared contract', () => {
  it('waits for a live probe before advertising modes, models, or config options', () => {
    expect(getStaticBuiltinAcpCapabilities('builtin', 'bub')).toBeUndefined();
    expect(getBuiltinDefaultModeId('builtin', 'bub')).toBeUndefined();
  });
});

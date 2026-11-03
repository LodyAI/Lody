import { describe, expect, it } from 'vitest';

import {
  getBuiltinDefaultModeId,
  getStaticBuiltinAcpCapabilities,
  isBuiltinAgentType,
  isManagedBuiltinAgentType,
  supportsBuiltinProviderSetup,
} from '../src/ai';

describe('builtin Bub shared contract', () => {
  it('accepts Sorbet into the verification queue without treating it as a managed runtime', () => {
    expect(isBuiltinAgentType('sorbet')).toBe(true);
    expect(isManagedBuiltinAgentType('sorbet')).toBe(false);
    expect(supportsBuiltinProviderSetup('sorbet')).toBe(true);
    expect(supportsBuiltinProviderSetup('unknown')).toBe(false);
  });

  it('waits for a live probe before advertising modes, models, or config options', () => {
    expect(getStaticBuiltinAcpCapabilities('builtin', 'bub')).toBeUndefined();
    expect(getBuiltinDefaultModeId('builtin', 'bub')).toBeUndefined();
  });
});

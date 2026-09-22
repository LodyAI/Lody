import { describe, expect, it } from 'vitest';

import {
  getBuiltinDefaultModeId,
  getStaticBuiltinAcpCapabilities,
  isBuiltinAgentType,
  isManagedBuiltinAgentType,
  supportsBuiltinProviderSetup,
} from '../src/ai';

describe('builtin Bub shared contract', () => {
  it('is builtin without being a managed-download runtime', () => {
    expect(isBuiltinAgentType('bub')).toBe(true);
    expect(isManagedBuiltinAgentType('bub')).toBe(false);
    expect(supportsBuiltinProviderSetup('bub')).toBe(true);
  });

  it('waits for a live probe before advertising modes, models, or config options', () => {
    expect(getStaticBuiltinAcpCapabilities('builtin', 'bub')).toBeUndefined();
    expect(getBuiltinDefaultModeId('builtin', 'bub')).toBeUndefined();
  });
});

describe('builtin Sorbet shared contract', () => {
  it('is bundled and live-probed without entering managed runtime download', () => {
    expect(isBuiltinAgentType('sorbet')).toBe(true);
    expect(isManagedBuiltinAgentType('sorbet')).toBe(false);
    expect(supportsBuiltinProviderSetup('sorbet')).toBe(true);
    expect(getStaticBuiltinAcpCapabilities('builtin', 'sorbet')).toBeUndefined();
    expect(getBuiltinDefaultModeId('builtin', 'sorbet')).toBeUndefined();
  });
});

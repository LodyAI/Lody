import { describe, expect, it } from 'vitest';
import { isLegacyPiProvider, migratePiProvider } from '../src/pi-provider-migration';

describe('Pi provider migration', () => {
  const legacy = {
    id: 'provider',
    machineId: 'machine',
    cliType: 'registry',
    agentType: 'pi-acp',
    name: 'My Pi',
    env: { API_KEY: 'synthetic-secret' },
    prompt: 'Instructions',
    titleGeneration: { enabled: false },
    futureField: 'preserved',
  };

  it('preserves identity, credentials and unknown configuration fields', () => {
    const upgraded = migratePiProvider(legacy);
    expect(upgraded).toEqual({ ...legacy, cliType: 'builtin', agentType: 'pi' });
    expect(legacy.cliType).toBe('registry');
    expect(migratePiProvider(upgraded)).toBeUndefined();
  });

  it('does not recreate deleted rows or overwrite a changed provider', () => {
    for (const value of [
      undefined,
      null,
      { ...legacy, agentType: 'codex-acp' },
      { ...legacy, cliType: 'custom' },
      { ...legacy, agentType: 'pi' },
    ]) {
      expect(isLegacyPiProvider(value)).toBe(false);
      expect(migratePiProvider(value)).toBeUndefined();
    }
  });
});

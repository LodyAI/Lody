import { describe, expect, it } from 'vitest';
import { createManagedPiProvider, isLegacyPiProvider } from '../src/pi-provider-migration';

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

  it('creates a separate managed provider without changing the self-managed provider', () => {
    const managed = createManagedPiProvider(legacy);
    expect(managed).toEqual({
      id: 'builtin-pi:machine',
      machineId: 'machine',
      name: 'Pi',
      description: undefined,
      cliType: 'builtin',
      agentType: 'pi',
      env: {},
    });
    expect(legacy.cliType).toBe('registry');
    expect(legacy.agentType).toBe('pi-acp');
    expect(legacy.env).toEqual({ API_KEY: 'synthetic-secret' });
    expect(createManagedPiProvider(managed)).toBeUndefined();
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
      expect(createManagedPiProvider(value)).toBeUndefined();
    }
  });

  it('uses one managed provider identity per machine across retries', () => {
    expect(createManagedPiProvider(legacy)?.id).toBe(createManagedPiProvider(legacy)?.id);
  });
});

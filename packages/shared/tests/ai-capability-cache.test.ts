import { describe, expect, it } from 'vitest';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  getAcpCapabilityCacheEntryAuthority,
  getAcpCapabilityCacheStaleReason,
  getReadableAcpCapabilityCacheEntry,
  getReadableAcpCapabilityCacheEntryForRuntimeOverrides,
  isAcpCapabilityCacheEntryCurrent,
  type AcpCapabilityCacheEntry,
} from '../src/ai';
import { CURRENT_MACHINE_PROTOCOL_CAPABILITIES } from '../src/machine-protocol-capabilities';

const entry = (cacheVersion?: number): AcpCapabilityCacheEntry => ({
  cliType: 'builtin',
  agentType: 'codex',
  cacheVersion,
  provenance: 'runtime',
  sourceVersion: 'builtin-codex:test+override:{"codexPath":"/opt/codex"}',
  modes: [],
  models: [{ modelId: 'gpt-6-astra', name: 'GPT-6 Astra' }],
  fetchedAt: 1,
});

describe('ACP capability cache compatibility', () => {
  it.each([undefined, ACP_CAPABILITY_CACHE_VERSION - 1, ACP_CAPABILITY_CACHE_VERSION + 1])(
    'keeps a parsed cache-version %s entry readable',
    (cacheVersion) => {
      const capability = entry(cacheVersion);

      expect(getReadableAcpCapabilityCacheEntry(capability, undefined)).toBeDefined();
      expect(getAcpCapabilityCacheEntryAuthority(capability, undefined, undefined)).toBe(
        'authoritative'
      );
    }
  );

  it('keeps freshness separate from readability', () => {
    const capability = entry(ACP_CAPABILITY_CACHE_VERSION - 1);

    expect(isAcpCapabilityCacheEntryCurrent(capability, undefined)).toBe(false);
    expect(getAcpCapabilityCacheStaleReason(capability, capability.sourceVersion!, undefined)).toBe(
      'cache-version-mismatch'
    );
    expect(getReadableAcpCapabilityCacheEntry(capability, undefined)).toBeDefined();
  });

  it('retains the runtime-override applicability gate for readable entries', () => {
    const capability = entry(ACP_CAPABILITY_CACHE_VERSION - 1);

    expect(
      getReadableAcpCapabilityCacheEntryForRuntimeOverrides(
        capability,
        {
          codexPath: '/opt/codex',
        },
        undefined
      )
    ).toBeDefined();
    expect(
      getReadableAcpCapabilityCacheEntryForRuntimeOverrides(
        capability,
        {
          codexPath: '/different/codex',
        },
        undefined
      )
    ).toBeUndefined();
  });

  it('drops only the known-incompatible derived field from pre-v7 non-Codex entries', () => {
    const capability: AcpCapabilityCacheEntry = {
      ...entry(ACP_CAPABILITY_CACHE_VERSION - 1),
      agentType: 'claude',
      models: [{ modelId: 'opus[1m]', name: 'Opus 1M' }],
      modelReasoningEfforts: { opus: ['1m'] },
    };
    const { modelReasoningEfforts: _incompatibleModelReasoningEfforts, ...compatible } = capability;

    expect(getReadableAcpCapabilityCacheEntry(capability, undefined)).toEqual(compatible);
  });
});

describe('Cursor cache compatibility follows the owning machine protocol', () => {
  const pickerMachine = { protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES };
  it.each([
    undefined,
    ACP_CAPABILITY_CACHE_VERSION - 1,
    ACP_CAPABILITY_CACHE_VERSION,
    ACP_CAPABILITY_CACHE_VERSION + 1,
  ])(
    'keeps compatible Cursor cache version %s readable while rejecting pre-picker IDs',
    (cacheVersion) => {
      const unmarked: AcpCapabilityCacheEntry = {
        ...entry(cacheVersion),
        cliType: 'registry',
        agentType: 'cursor',
        sourceVersion: 'cursor@test',
      };
      const marked = { ...unmarked, sourceVersion: 'cursor@test+parameterized-model-picker' };
      expect(getReadableAcpCapabilityCacheEntry(marked, pickerMachine)).toEqual(marked);
      expect(getAcpCapabilityCacheEntryAuthority(marked, undefined, pickerMachine)).toBe(
        'authoritative'
      );
      expect(isAcpCapabilityCacheEntryCurrent(marked, pickerMachine)).toBe(
        cacheVersion === ACP_CAPABILITY_CACHE_VERSION
      );
      expect(getReadableAcpCapabilityCacheEntry(unmarked, pickerMachine)).toBeUndefined();
      expect(getAcpCapabilityCacheEntryAuthority(unmarked, undefined, pickerMachine)).toBe(
        'unavailable'
      );
      expect(
        getReadableAcpCapabilityCacheEntryForRuntimeOverrides(unmarked, undefined, pickerMachine)
      ).toBeUndefined();
      expect(getReadableAcpCapabilityCacheEntry(unmarked, undefined)).toEqual(unmarked);
      const custom = { ...unmarked, cliType: 'custom' as const };
      expect(getReadableAcpCapabilityCacheEntry(custom, pickerMachine)).toEqual(custom);
    }
  );
});

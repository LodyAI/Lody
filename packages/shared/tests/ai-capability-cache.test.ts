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
  it('invalidates Pi plugin catalogs when selections change or become empty', () => {
    const capability: AcpCapabilityCacheEntry = {
      ...entry(ACP_CAPABILITY_CACHE_VERSION),
      agentType: 'pi',
      sourceVersion: 'builtin-pi:test+override:{"piExtensions":["/fixture/plugin.ts"]}',
    };
    expect(
      getReadableAcpCapabilityCacheEntryForRuntimeOverrides(capability, {
        piExtensions: ['/fixture/plugin.ts'],
      })
    ).toEqual(capability);
    for (const overrides of [
      undefined,
      { piExtensions: [] },
      { piExtensions: ['/fixture/other.ts'] },
    ]) {
      expect(
        getReadableAcpCapabilityCacheEntryForRuntimeOverrides(capability, overrides)
      ).toBeUndefined();
    }
    const plain = { ...capability, sourceVersion: 'builtin-pi:test' };
    expect(getReadableAcpCapabilityCacheEntryForRuntimeOverrides(plain, undefined)).toEqual(plain);
  });
  it.each([undefined, ACP_CAPABILITY_CACHE_VERSION - 1, ACP_CAPABILITY_CACHE_VERSION + 1])(
    'keeps a parsed cache-version %s entry readable',
    (cacheVersion) => {
      const capability = entry(cacheVersion);

      expect(getReadableAcpCapabilityCacheEntry(capability)).toBeDefined();
      expect(getAcpCapabilityCacheEntryAuthority(capability, undefined)).toBe('authoritative');
    }
  );

  it('keeps freshness separate from readability', () => {
    const capability = entry(ACP_CAPABILITY_CACHE_VERSION - 1);

    expect(isAcpCapabilityCacheEntryCurrent(capability)).toBe(false);
    expect(getAcpCapabilityCacheStaleReason(capability, capability.sourceVersion!)).toBe(
      'cache-version-mismatch'
    );
    expect(getReadableAcpCapabilityCacheEntry(capability)).toBeDefined();
  });

  it('retains the runtime-override applicability gate for readable entries', () => {
    const capability = entry(ACP_CAPABILITY_CACHE_VERSION - 1);

    expect(
      getReadableAcpCapabilityCacheEntryForRuntimeOverrides(capability, {
        codexPath: '/opt/codex',
      })
    ).toBeDefined();
    expect(
      getReadableAcpCapabilityCacheEntryForRuntimeOverrides(capability, {
        codexPath: '/different/codex',
      })
    ).toBeUndefined();
  });

  it('drops only the known-incompatible derived field from pre-v7 non-Codex entries', () => {
    // Pinned to 6: the guard keys on "older than v7", not on the current
    // version, so a later bump must not quietly stop exercising it.
    const capability: AcpCapabilityCacheEntry = {
      ...entry(6),
      agentType: 'claude',
      models: [{ modelId: 'opus[1m]', name: 'Opus 1M' }],
      modelReasoningEfforts: { opus: ['1m'] },
    };
    const { modelReasoningEfforts: _incompatibleModelReasoningEfforts, ...compatible } = capability;

    expect(getReadableAcpCapabilityCacheEntry(capability)).toEqual(compatible);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  ACP_CAPABILITY_REFRESH_CACHE_TTL_MS,
  decideAcpCapabilityRefreshCache,
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

describe('ACP capability refresh cache decision', () => {
  const currentEntry = (
    overrides: Partial<AcpCapabilityCacheEntry> = {}
  ): AcpCapabilityCacheEntry => ({
    ...entry(ACP_CAPABILITY_CACHE_VERSION),
    fetchedAt: 1_000_000,
    ...overrides,
  });
  const expectedSourceVersion = entry().sourceVersion;

  it('reuses an entry whose source version and age still match', () => {
    const capability = currentEntry();

    expect(
      decideAcpCapabilityRefreshCache({
        entry: capability,
        expectedSourceVersion,
        nowMs: capability.fetchedAt + ACP_CAPABILITY_REFRESH_CACHE_TTL_MS,
      })
    ).toEqual({ hit: true, entry: capability });
  });

  it('refuses to reuse an entry once it is older than the cache lifetime', () => {
    const capability = currentEntry();

    expect(
      decideAcpCapabilityRefreshCache({
        entry: capability,
        expectedSourceVersion,
        nowMs: capability.fetchedAt + ACP_CAPABILITY_REFRESH_CACHE_TTL_MS + 1,
      })
    ).toEqual({ hit: false, reason: 'expired' });
  });

  it('treats an entry stamped ahead of the reader as fresh rather than re-probing', () => {
    const capability = currentEntry();

    expect(
      decideAcpCapabilityRefreshCache({
        entry: capability,
        expectedSourceVersion,
        nowMs: capability.fetchedAt - 60_000,
      })
    ).toEqual({ hit: true, entry: capability });
  });

  it.each([
    {
      name: 'a changed runtime override',
      args: { expectedSourceVersion: 'builtin-codex:test+override:{"codexPath":"/other"}' },
      reason: 'source-version-mismatch',
    },
    {
      name: 'an unknowable expected version',
      args: { expectedSourceVersion: undefined },
      reason: 'source-version-unresolved',
    },
  ])('misses on $name', ({ args, reason }) => {
    expect(
      decideAcpCapabilityRefreshCache({
        entry: currentEntry(),
        nowMs: 1_000_000,
        ...args,
      })
    ).toEqual({ hit: false, reason });
  });

  it('never answers a refresh with an entry no probe produced', () => {
    expect(
      decideAcpCapabilityRefreshCache({
        entry: currentEntry({ provenance: undefined }),
        expectedSourceVersion,
        nowMs: 1_000_000,
      })
    ).toEqual({ hit: false, reason: 'not-runtime-provenance' });
  });

  it('misses when nothing has been persisted yet', () => {
    expect(
      decideAcpCapabilityRefreshCache({
        entry: undefined,
        expectedSourceVersion,
        nowMs: 1_000_000,
      })
    ).toEqual({ hit: false, reason: 'missing' });
  });
});

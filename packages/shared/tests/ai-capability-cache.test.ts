import { describe, expect, it } from 'vitest';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  ACP_CAPABILITY_FETCH_TIME_RENEW_AFTER_MS,
  ACP_CAPABILITY_REFRESH_CACHE_TTL_MS,
  decideAcpCapabilityRefreshCache,
  shouldRenewAcpCapabilityFetchTime,
  getAcpCapabilityCacheEntryAuthority,
  getAcpCapabilityCacheStaleReason,
  getReadableAcpCapabilityCacheEntry,
  getReadableAcpCapabilityCacheEntryForRuntimeOverrides,
  isAcpCapabilityCacheEntryCurrent,
  type AcpCapabilityCacheEntry,
} from '../src/ai';
import {
  applyAcpCommandScopeDelta,
  computeAcpCommandScopeDelta,
  getAcpCommandScopeKey,
} from '../src/acp-command-scope';

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
        launchInputs: 'matching',
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
        launchInputs: 'matching',
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
        launchInputs: 'matching',
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
    {
      name: 'launch inputs this process never saw produce the entry',
      args: { expectedSourceVersion: entry().sourceVersion, launchInputs: 'unknown' as const },
      reason: 'launch-inputs-unknown',
    },
    {
      name: 'an edited environment, which the source version does not cover',
      args: { expectedSourceVersion: entry().sourceVersion, launchInputs: 'changed' as const },
      reason: 'launch-inputs-changed',
    },
  ])('misses on $name', ({ args, reason }) => {
    expect(
      decideAcpCapabilityRefreshCache({
        entry: currentEntry(),
        launchInputs: 'matching',
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
        launchInputs: 'matching',
        nowMs: 1_000_000,
      })
    ).toEqual({ hit: false, reason: 'not-runtime-provenance' });
  });

  it('misses when nothing has been persisted yet', () => {
    expect(
      decideAcpCapabilityRefreshCache({
        entry: undefined,
        expectedSourceVersion,
        launchInputs: 'matching',
        nowMs: 1_000_000,
      })
    ).toEqual({ hit: false, reason: 'missing' });
  });
});

describe('ACP capability fetch-time renewal', () => {
  it('renews an unchanged entry well before it could expire', () => {
    expect(ACP_CAPABILITY_FETCH_TIME_RENEW_AFTER_MS).toBeLessThan(
      ACP_CAPABILITY_REFRESH_CACHE_TTL_MS
    );
    expect(
      shouldRenewAcpCapabilityFetchTime(
        { fetchedAt: 0 },
        ACP_CAPABILITY_FETCH_TIME_RENEW_AFTER_MS - 1
      )
    ).toBe(false);
    expect(
      shouldRenewAcpCapabilityFetchTime({ fetchedAt: 0 }, ACP_CAPABILITY_FETCH_TIME_RENEW_AFTER_MS)
    ).toBe(true);
  });
});

describe('ACP command scope deltas', () => {
  const base = [
    { name: 'help', description: 'Help' },
    { name: 'review', description: 'Review' },
  ];

  it('rebuilds a project list from the base, including overrides and removals', () => {
    const project = [
      { name: 'help', description: 'Project help' },
      { name: 'deploy', description: 'Deploy' },
    ];
    const delta = computeAcpCommandScopeDelta(base, project, 'v1');

    expect(delta).toEqual({
      sourceVersion: 'v1',
      added: project,
      removed: ['review'],
    });
    expect(applyAcpCommandScopeDelta(base, 'v1', delta)).toEqual(project);
  });

  it('keeps no delta for a project whose commands equal the base', () => {
    expect(computeAcpCommandScopeDelta(base, [...base].reverse(), 'v1')).toBeUndefined();
  });

  it('ignores a delta computed against another source version', () => {
    const delta = computeAcpCommandScopeDelta(base, [...base, { name: 'deploy' }], 'v1');

    expect(applyAcpCommandScopeDelta(base, 'v2', delta)).toEqual(base);
  });

  it('shares one scope across worktrees and GitHub name casing', () => {
    expect(getAcpCommandScopeKey({ kind: 'github', repoFullName: 'LodyAI/Lody' })).toBe(
      getAcpCommandScopeKey({ kind: 'github', repoFullName: 'lodyai/lody' })
    );
    expect(getAcpCommandScopeKey(undefined)).toBeUndefined();
  });
});

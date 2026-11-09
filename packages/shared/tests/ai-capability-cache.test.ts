import { describe, expect, it } from 'vitest';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  decideAcpCapabilityRefreshCache,
  getAcpCapabilityCacheEntryAuthority,
  getAcpCapabilityCacheStaleReason,
  getReadableAcpCapabilityCacheEntry,
  getReadableAcpCapabilityCacheEntryForRuntimeOverrides,
  hasEmptyModelSelectOption,
  isAcpCapabilityCacheEntryCurrent,
  type AcpCapabilityCacheEntry,
} from '../src/ai';
import { getModelEffortChoices, resolveDeclaredEffortSupport } from '../src/acp-model-capabilities';

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
  it('discards project-contaminated pre-v11 commands while retaining models and modes', () => {
    const legacy = { ...entry(10), availableCommands: [{ name: 'other-project' }] };
    const { availableCommands: _commands, ...rest } = legacy;
    expect(getReadableAcpCapabilityCacheEntry(legacy)).toEqual(rest);
    const preview = {
      ...legacy,
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
      availableCommands: [],
    };
    expect(getReadableAcpCapabilityCacheEntry(preview)).toBe(preview);
  });

  it('retires only the Sorbet builds that could not discover methods', () => {
    const stale = {
      ...entry(ACP_CAPABILITY_CACHE_VERSION),
      agentType: 'sorbet',
      sourceVersion: 'builtin-sorbet:@sorbetai/acp@0.1.0-alpha.4',
      authMethods: [],
    };
    const { authMethods: _methods, ...retained } = stale;
    // Both the bare build and a suffixed source version name the same bad build.
    expect(getReadableAcpCapabilityCacheEntry(stale)).toEqual(retained);
    const suffixed = { ...stale, sourceVersion: `${stale.sourceVersion}+auth-discovery:1` };
    const { authMethods: _suffixedMethods, ...suffixedRetained } = suffixed;
    expect(getReadableAcpCapabilityCacheEntry(suffixed)).toEqual(suffixedRetained);
    // Later builds, and entries whose build the npx cache could not name, keep the list.
    for (const version of ['0.1.0-alpha.5', '0.1.0-alpha.6', 'alpha']) {
      const current = {
        ...stale,
        sourceVersion: `builtin-sorbet:@sorbetai/acp@${version}+auth-discovery:1`,
      };
      expect(getReadableAcpCapabilityCacheEntry(current)).toEqual(current);
    }
    const other = { ...stale, agentType: 'devin' };
    expect(getReadableAcpCapabilityCacheEntry(other)).toEqual(other);
  });

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

  it('misses with empty-model-catalog when the persisted select has no options', () => {
    const degraded = currentEntry({
      models: [],
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'model-a',
          options: [],
        },
      ],
    });
    expect(getAcpCapabilityCacheStaleReason(degraded, expectedSourceVersion!)).toBe(
      'empty-model-catalog'
    );
    expect(
      decideAcpCapabilityRefreshCache({
        entry: degraded,
        expectedSourceVersion,
        launchInputs: 'matching',
        nowMs: degraded.fetchedAt + 1000,
      })
    ).toEqual({ hit: false, reason: 'empty-model-catalog' });
    expect(getAcpCapabilityCacheEntryAuthority(degraded, undefined)).toBe('degraded');
  });

  it('does not flag empty non-model selects or non-empty model selects', () => {
    expect(
      hasEmptyModelSelectOption([
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'agent',
          options: [],
        },
      ])
    ).toBe(false);
    expect(
      hasEmptyModelSelectOption([
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'model-a',
          options: [{ value: 'model-a', name: 'Model A' }],
        },
      ])
    ).toBe(false);
    expect(hasEmptyModelSelectOption(undefined)).toBe(false);
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
});

describe('declared per-model controls', () => {
  const response = (modelCapabilities: unknown) => ({ _meta: { lody: { modelCapabilities } } });

  it('prefers a model declaration over the legacy per-model map', () => {
    const capability = {
      cliType: 'builtin',
      agentType: 'codex',
      declaredModelControls: { 'gpt-6': { effortValues: ['low', 'ultra'] } },
      modelReasoningEfforts: { 'gpt-6': ['low'], 'gpt-5': ['medium'] },
    };
    expect(getModelEffortChoices(capability, 'gpt-6')).toEqual(['low', 'ultra']);
    expect(getModelEffortChoices(capability, 'gpt-5')).toEqual(['medium']);
    expect(getModelEffortChoices(capability, 'other')).toBeUndefined();
  });

  it("adds Claude's provider default and tells unsupported from unknown per adapter", () => {
    const declaredModelControls = {
      opus: { effortValues: ['low', 'high'], fastMode: true },
      haiku: { fastMode: false },
      empty: { effortValues: [] },
    };
    const claude = { cliType: 'builtin', agentType: 'claude', declaredModelControls };
    const codex = { cliType: 'builtin', agentType: 'codex', declaredModelControls };

    expect(resolveDeclaredEffortSupport(claude, 'opus')).toEqual({
      state: 'supported',
      values: ['default', 'low', 'high'],
      fallbackValue: 'default',
    });
    expect(resolveDeclaredEffortSupport(codex, 'opus')).toEqual({
      state: 'supported',
      values: ['low', 'high'],
      fallbackValue: 'low',
    });
    // Claude omits the list exactly when a model has no effort; Codex's omission says nothing.
    expect(resolveDeclaredEffortSupport(claude, 'haiku')).toEqual({ state: 'unsupported' });
    expect(resolveDeclaredEffortSupport(codex, 'haiku')).toEqual({ state: 'unknown' });
    expect(resolveDeclaredEffortSupport(codex, 'empty')).toEqual({ state: 'unsupported' });
    expect(resolveDeclaredEffortSupport(claude, 'undeclared')).toEqual({ state: 'unknown' });
  });
});

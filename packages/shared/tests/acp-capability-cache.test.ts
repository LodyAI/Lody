import { describe, expect, it } from 'vitest';

import {
  ACP_CAPABILITY_CACHE_VERSION,
  CURSOR_PARAMETERIZED_MODEL_PICKER_SOURCE_VERSION_SUFFIX,
  getAcpCapabilityCacheEntryAuthority,
  isAcpCapabilityCacheEntryCurrent,
  isRegistryCursorAgent,
  type AcpCapabilityCacheEntry,
} from '../src/ai';

const cacheEntry = (
  fields: Pick<AcpCapabilityCacheEntry, 'cliType' | 'agentType'> &
    Partial<Pick<AcpCapabilityCacheEntry, 'cacheVersion' | 'sourceVersion'>>
): AcpCapabilityCacheEntry => ({
  cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
  provenance: 'runtime',
  modes: [],
  models: [],
  fetchedAt: 1,
  ...fields,
});

describe('isRegistryCursorAgent', () => {
  it('is true only for registry Cursor identity', () => {
    expect(isRegistryCursorAgent({ cliType: 'registry', agentType: 'cursor' })).toBe(true);
    expect(isRegistryCursorAgent({ cliType: 'custom', agentType: 'cursor' })).toBe(false);
    expect(isRegistryCursorAgent({ cliType: 'builtin', agentType: 'claude' })).toBe(false);
    expect(isRegistryCursorAgent({ cliType: undefined, agentType: undefined })).toBe(false);
  });
});

describe('isAcpCapabilityCacheEntryCurrent', () => {
  it('rejects a pre-opt-in registry Cursor row without the marker', () => {
    const entry = cacheEntry({
      cliType: 'registry',
      agentType: 'cursor',
      sourceVersion: 'cursor@2026.08.31',
    });
    expect(isAcpCapabilityCacheEntryCurrent(entry)).toBe(false);
    expect(getAcpCapabilityCacheEntryAuthority(entry, undefined)).toBe('unavailable');
  });

  it('rejects a registry Cursor row with no sourceVersion', () => {
    const entry = cacheEntry({
      cliType: 'registry',
      agentType: 'cursor',
      sourceVersion: undefined,
    });
    expect(isAcpCapabilityCacheEntryCurrent(entry)).toBe(false);
  });

  it('accepts a registry Cursor row that carries the marker', () => {
    const entry = cacheEntry({
      cliType: 'registry',
      agentType: 'cursor',
      sourceVersion: `cursor@2026.08.31${CURSOR_PARAMETERIZED_MODEL_PICKER_SOURCE_VERSION_SUFFIX}`,
    });
    expect(isAcpCapabilityCacheEntryCurrent(entry)).toBe(true);
    expect(getAcpCapabilityCacheEntryAuthority(entry, undefined)).toBe('authoritative');
  });

  it('does not require the marker for a registry non-Cursor agent', () => {
    const entry = cacheEntry({
      cliType: 'registry',
      agentType: 'gemini',
      sourceVersion: 'gemini@1.0.0',
    });
    expect(isAcpCapabilityCacheEntryCurrent(entry)).toBe(true);
  });

  it('does not require the marker for a custom Cursor agent', () => {
    const entry = cacheEntry({
      cliType: 'custom',
      agentType: 'cursor',
      sourceVersion: 'custom:{"command":"cursor-agent"}',
    });
    expect(isAcpCapabilityCacheEntryCurrent(entry)).toBe(true);
  });

  it('still rejects a marked registry Cursor row with a stale cache version', () => {
    const entry = cacheEntry({
      cliType: 'registry',
      agentType: 'cursor',
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION - 1,
      sourceVersion: `cursor@2026.08.31${CURSOR_PARAMETERIZED_MODEL_PICKER_SOURCE_VERSION_SUFFIX}`,
    });
    expect(isAcpCapabilityCacheEntryCurrent(entry)).toBe(false);
  });
});

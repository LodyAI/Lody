import { describe, expect, it } from 'vitest';

import {
  ACP_CAPABILITY_CACHE_VERSION,
  CURSOR_PARAMETERIZED_MODEL_PICKER_SOURCE_VERSION_SUFFIX,
  getAcpCapabilityCacheEntryAuthority,
  getAcpCapabilityCacheStaleReason,
  isAcpCapabilityCacheEntryCurrent,
  isRegistryCursorAgent,
  type AcpCapabilityCacheEntry,
} from '../src/ai';
import {
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  CURSOR_PARAMETERIZED_MODEL_PICKER_PROTOCOL_VERSION,
  MACHINE_PROTOCOL_CAPABILITIES,
  machineSupportsCursorParameterizedModelPicker,
} from '../src/machine-protocol-capabilities';

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

/** A daemon that launches registry Cursor with the parameterized model picker. */
const pickerMachine = { protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES };
/** A daemon from before the opt-in: it still runs Cursor in variants mode. */
const legacyMachine = {
  protocolCapabilities: { [MACHINE_PROTOCOL_CAPABILITIES.providerSetup]: 1 },
};

const unmarkedCursorRow = () =>
  cacheEntry({
    cliType: 'registry',
    agentType: 'cursor',
    sourceVersion: 'cursor@2026.08.31',
  });
const markedCursorRow = () =>
  cacheEntry({
    cliType: 'registry',
    agentType: 'cursor',
    sourceVersion: `cursor@2026.08.31${CURSOR_PARAMETERIZED_MODEL_PICKER_SOURCE_VERSION_SUFFIX}`,
  });

describe('isRegistryCursorAgent', () => {
  it('is true only for registry Cursor identity', () => {
    expect(isRegistryCursorAgent({ cliType: 'registry', agentType: 'cursor' })).toBe(true);
    expect(isRegistryCursorAgent({ cliType: 'custom', agentType: 'cursor' })).toBe(false);
    expect(isRegistryCursorAgent({ cliType: 'builtin', agentType: 'claude' })).toBe(false);
    expect(isRegistryCursorAgent({ cliType: undefined, agentType: undefined })).toBe(false);
  });
});

describe('cursorParameterizedModelPicker protocol capability', () => {
  it('shares one version binding between advertisement and negotiation', () => {
    expect(
      CURRENT_MACHINE_PROTOCOL_CAPABILITIES[
        MACHINE_PROTOCOL_CAPABILITIES.cursorParameterizedModelPicker
      ]
    ).toBe(CURSOR_PARAMETERIZED_MODEL_PICKER_PROTOCOL_VERSION);
    expect(machineSupportsCursorParameterizedModelPicker(pickerMachine)).toBe(true);
  });

  it('treats a missing capability as a legacy daemon', () => {
    expect(machineSupportsCursorParameterizedModelPicker(legacyMachine)).toBe(false);
    expect(machineSupportsCursorParameterizedModelPicker(undefined)).toBe(false);
    expect(machineSupportsCursorParameterizedModelPicker(null)).toBe(false);
  });
});

describe('isAcpCapabilityCacheEntryCurrent', () => {
  it('rejects a pre-opt-in registry Cursor row on a machine that launches the picker', () => {
    const entry = unmarkedCursorRow();
    expect(isAcpCapabilityCacheEntryCurrent(entry, pickerMachine)).toBe(false);
    expect(getAcpCapabilityCacheEntryAuthority(entry, undefined, pickerMachine)).toBe(
      'unavailable'
    );
    expect(
      getAcpCapabilityCacheStaleReason(
        entry,
        `cursor@2026.08.31${CURSOR_PARAMETERIZED_MODEL_PICKER_SOURCE_VERSION_SUFFIX}`,
        pickerMachine
      )
    ).toBe('cache-version-mismatch');
  });

  it('rejects a registry Cursor row with no sourceVersion on a picker machine', () => {
    const entry = cacheEntry({
      cliType: 'registry',
      agentType: 'cursor',
      sourceVersion: undefined,
    });
    expect(isAcpCapabilityCacheEntryCurrent(entry, pickerMachine)).toBe(false);
  });

  it('accepts a registry Cursor row that carries the marker', () => {
    const entry = markedCursorRow();
    expect(isAcpCapabilityCacheEntryCurrent(entry, pickerMachine)).toBe(true);
    expect(getAcpCapabilityCacheEntryAuthority(entry, undefined, pickerMachine)).toBe(
      'authoritative'
    );
  });

  it('accepts an unmarked registry Cursor row from a daemon without the picker capability', () => {
    // That daemon still launches Cursor in variants mode, so its row describes what it runs.
    const entry = unmarkedCursorRow();
    expect(isAcpCapabilityCacheEntryCurrent(entry, legacyMachine)).toBe(true);
    expect(isAcpCapabilityCacheEntryCurrent(entry, undefined)).toBe(true);
    expect(getAcpCapabilityCacheEntryAuthority(entry, undefined, legacyMachine)).toBe(
      'authoritative'
    );
    expect(getAcpCapabilityCacheStaleReason(entry, 'cursor@2026.08.31', legacyMachine)).toBe(
      undefined
    );
  });

  it('does not require the marker for a registry non-Cursor agent', () => {
    const entry = cacheEntry({
      cliType: 'registry',
      agentType: 'gemini',
      sourceVersion: 'gemini@1.0.0',
    });
    expect(isAcpCapabilityCacheEntryCurrent(entry, pickerMachine)).toBe(true);
  });

  it('does not require the marker for a custom Cursor agent', () => {
    const entry = cacheEntry({
      cliType: 'custom',
      agentType: 'cursor',
      sourceVersion: 'custom:{"command":"cursor-agent"}',
    });
    expect(isAcpCapabilityCacheEntryCurrent(entry, pickerMachine)).toBe(true);
  });

  it('still rejects a marked registry Cursor row with a stale cache version', () => {
    const entry = cacheEntry({
      cliType: 'registry',
      agentType: 'cursor',
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION - 1,
      sourceVersion: `cursor@2026.08.31${CURSOR_PARAMETERIZED_MODEL_PICKER_SOURCE_VERSION_SUFFIX}`,
    });
    expect(isAcpCapabilityCacheEntryCurrent(entry, pickerMachine)).toBe(false);
    expect(isAcpCapabilityCacheEntryCurrent(entry, legacyMachine)).toBe(false);
  });
});

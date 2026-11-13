import { beforeAll, describe, expect, it } from 'vitest';
import i18next, { type TFunction } from 'i18next';
import type { CliApiKeyRecord } from '@lody/shared';
import en from '../../../locales/en.json';
import {
  describeCliApiKey,
  formatCliApiKeyTimestamp,
} from '../src/components/settings/cli-api-key-display';

let t: TFunction;
beforeAll(async () => {
  t = await i18next.createInstance({ lng: 'en', resources: { en: { translation: en } } }).init();
});

const EXPIRES = Date.UTC(2027, 1, 10, 12, 0);

function key(overrides: Partial<CliApiKeyRecord>): CliApiKeyRecord {
  return {
    id: 'key',
    name: 'Lody CLI Token',
    keyStart: null,
    keyPreview: null,
    note: null,
    source: 'auto',
    createdAt: null,
    lastRequest: null,
    expiresAt: null,
    enabled: true,
    ...overrides,
  };
}

function describeKey(apiKey: CliApiKeyRecord, currentMachineId: string | null = null) {
  return describeCliApiKey(apiKey, {
    machineNamesById: new Map([
      ['mac', 'Office MacBook'],
      ['server', 'Home server'],
    ]),
    currentMachineId,
    language: 'en',
    t,
  });
}

describe('CLI token rows say which machine uses a token and how long it lasts', () => {
  it('names an auto token by its machine, marks this computer and gives its idle deadline', () => {
    const display = describeKey(key({ machineIds: ['mac'], expiresAt: EXPIRES }), 'mac');
    expect(display.title).toBe('Office MacBook');
    expect(display.isCurrentMachine).toBe(true);
    expect(display.sourceLabel).toBe('Auto');
    expect(display.lifetime).toBe(`Expires ${formatCliApiKeyTimestamp(EXPIRES, 'en')} unless used`);
  });

  it('says "Other device" for a machine outside this workspace and is not this computer', () => {
    const display = describeKey(key({ machineIds: ['elsewhere'], expiresAt: EXPIRES }), 'mac');
    expect(display.title).toBe('Other device');
    expect(display.isCurrentMachine).toBe(false);
  });

  it('lists every machine a token signs in, known names first', () => {
    const display = describeKey(
      key({ source: 'pairing', machineIds: ['elsewhere', 'server'], expiresAt: null })
    );
    expect(display.title).toBe('Home server, Other device');
    expect(display.sourceLabel).toBe('Pairing');
    expect(display.lifetime).toBe('Never expires');
  });

  it('keeps manual tokens identified by their note, falling back to an untitled name', () => {
    expect(describeKey(key({ source: 'manual', note: 'CI runner', machineIds: [] })).title).toBe(
      'CI runner'
    );
    const untitled = describeKey(key({ source: 'manual', note: '', machineIds: [] }));
    expect(untitled.title).toBe('Untitled token');
    expect(untitled.lifetime).toBe('Never expires');
  });

  it('shows no lifetime for records from a backend that does not report one', () => {
    // An older backend sends an auto key's raw null expiry; "Never expires" would be false.
    const display = describeKey(key({ source: 'auto', note: null }), 'mac');
    expect(display.lifetime).toBeNull();
    expect(display.isCurrentMachine).toBe(false);
    expect(display.title).toBe('Untitled token');
  });
});

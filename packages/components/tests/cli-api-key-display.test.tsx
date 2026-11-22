// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import i18next, { type TFunction } from 'i18next';
import type { CliApiKeyRecord } from '@lody/shared';
import en from '../../../locales/en.json';
import {
  describeCliApiKey,
  formatCliApiKeyTimestamp,
} from '../src/components/settings/cli-api-key-display';
import { initI18n } from '../src/i18n';
import { PlatformContext } from '@lody/platform/react';
import { TEST_CLOUD_PLATFORM } from './test-platform';
import {
  AccountSettingsPure,
  type AccountSettingsPureProps,
} from '../src/components/settings/account-setting-pure';
import { ForceDesktopLayoutProvider, ForceMobileLayoutProvider } from '../src/hooks/use-mobile';

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

describe('CLI token list folds sign-in tokens into a closed group', () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  const tokens: CliApiKeyRecord[] = [
    key({ id: 'ci', source: 'manual', note: 'CI runner', keyPreview: 'lody_ci…', machineIds: [] }),
    key({ id: 'phone', source: 'pairing', machineIds: ['server'], keyPreview: 'lody_ph…' }),
    key({ id: 'laptop', source: 'auto', machineIds: ['mac'], keyPreview: 'lody_mac…' }),
    key({ id: 'old', source: 'auto', note: 'Old login', machineIds: [], keyPreview: 'lody_old…' }),
  ];

  async function renderTokens(mobile: boolean, revoked: string[]) {
    const change = async () => {};
    const props: AccountSettingsPureProps = {
      surface: 'account',
      currentUser: { id: 'me', name: 'Me' },
      organization: { id: 'workspace', name: 'Team' },
      role: 'owner',
      hasAdminPermission: true,
      members: [],
      pendingInvitations: [],
      onSignOut: change,
      onInviteMember: async () => null,
      onRemoveMember: change,
      onUpdateRole: change,
      onCopyInviteLink: change,
      onCancelInvitation: change,
      onLeaveOrganization: change,
      onDeleteOrganization: change,
      onDeleteAccount: change,
      getInviteLink: () => '',
      canGenerateCliApiKey: true,
      cliApiKeys: tokens,
      cliApiKeyMachineNames: new Map([
        ['mac', 'Office MacBook'],
        ['server', 'Home server'],
      ]),
      currentMachineId: 'mac',
      onGenerateCliApiKey: change,
      onRevokeCliApiKey: (keyId) => {
        revoked.push(keyId);
      },
    };
    const page = <AccountSettingsPure {...props} />;
    await act(async () =>
      root.render(
        <PlatformContext.Provider value={TEST_CLOUD_PLATFORM}>
          {mobile ? (
            <ForceMobileLayoutProvider force>{page}</ForceMobileLayoutProvider>
          ) : (
            <ForceDesktopLayoutProvider>{page}</ForceDesktopLayoutProvider>
          )}
        </PlatformContext.Provider>
      )
    );
  }

  const groupTrigger = () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Created at sign-in')
    );
  const revokeButtons = () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) => button.textContent === 'Revoke'
    );

  for (const mobile of [false, true]) {
    it(`${mobile ? 'on a phone' : 'on desktop'} keeps manual and paired tokens listed, sign-in tokens behind the group, and revokes from inside it`, async () => {
      const revoked: string[] = [];
      await renderTokens(mobile, revoked);

      expect(container.textContent).toContain('CI runner');
      expect(container.textContent).toContain('Home server');
      expect(container.textContent).not.toContain('lody_mac…');
      expect(container.textContent).not.toContain('Old login');
      expect(revokeButtons()).toHaveLength(2);
      const trigger = groupTrigger();
      expect(trigger?.getAttribute('aria-expanded')).toBe('false');
      expect(trigger?.textContent).toContain('2 tokens created automatically');
      expect(trigger?.textContent).toContain('This computer');

      await act(async () => trigger!.click());
      expect(groupTrigger()?.getAttribute('aria-expanded')).toBe('true');
      expect(container.textContent).toContain('Office MacBook');
      expect(container.textContent).toContain('lody_mac…');
      expect(container.textContent).toContain('Old login');
      expect(revokeButtons()).toHaveLength(4);

      await act(async () => revokeButtons()[2]!.click());
      expect(revoked).toEqual([]);
      const dialog = document.querySelector('[role="alertdialog"]');
      expect(dialog?.textContent).toContain('Office MacBook');
      expect(dialog?.textContent).toContain('This computer signs in with this token');
      const confirm = [...dialog!.querySelectorAll('button')].find(
        (button) => button.textContent === 'Revoke token'
      );
      await act(async () => confirm!.click());
      expect(revoked).toEqual(['laptop']);

      await act(async () => groupTrigger()!.click());
      expect(groupTrigger()?.getAttribute('aria-expanded')).toBe('false');
      expect(container.textContent).not.toContain('Old login');
    });
  }
});

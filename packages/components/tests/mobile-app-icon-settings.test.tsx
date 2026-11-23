// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../src/i18n';
import {
  MobileAppIconSettings,
  type AppIconBridge,
  type AppIconState,
} from '../src/components/mobile/mobile-app-icon-settings';
import { PlatformContext } from '@lody/platform/react';
import { TEST_CLOUD_PLATFORM } from './test-platform';
import { MobileAccountSettings } from '../src/components/mobile/mobile-account-settings';
import type { AccountSettingsPureProps } from '../src/components/settings/account-setting-pure';
import i18n from 'i18next';
import { flushSync } from 'react-dom';
import type { MachineId } from '@lody/shared';
import { MobileProjectScreen } from '../src/components/mobile/mobile-project-screen';
import { MobileSettingsFoldPanels } from '../src/components/mobile/mobile-settings-fold-panels';
import { MobileProjectSettings } from '../src/components/mobile/mobile-project-settings';

describe('mobile-app-icon-settings', () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  describe('app icon settings', () => {
    let container: HTMLDivElement;
    let root: Root;
    let current: string;
    let bridge: AppIconBridge;

    beforeEach(async () => {
      await initI18n('en');
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      current = 'default';
      bridge = {
        icons: [
          { name: 'default', previewUrl: '/default.png' },
          { name: 'alternate', previewUrl: '/alternate.png' },
        ],
        getState: async () => ({ supported: true, name: current }),
        setIcon: async ({ name }) => {
          current = name;
          return { supported: true, name };
        },
      };
    });

    afterEach(async () => {
      await act(async () => root.unmount());
      container.remove();
    });

    function button(label: string) {
      const found = Array.from(container.querySelectorAll('button')).find(
        (element) => element.textContent === label
      );
      if (!found) throw new Error(`Missing button: ${label}`);
      return found;
    }

    it('keeps the old selection and blocks overlapping changes until native completion', async () => {
      let finish!: (state: AppIconState) => void;
      bridge.setIcon = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      await act(async () => root.render(<MobileAppIconSettings bridge={bridge} />));
      await act(async () => button('Icon 2').click());
      expect(button('Default').getAttribute('aria-pressed')).toBe('true');
      expect(button('Default').disabled).toBe(true);
      expect(button('Icon 2').disabled).toBe(true);
      await act(async () => finish({ supported: true, name: 'alternate' }));
      expect(button('Icon 2').getAttribute('aria-pressed')).toBe('true');
      expect(button('Default').disabled).toBe(false);
    });

    it('retains the installed selection on rejection and lets the user retry', async () => {
      bridge.setIcon = async () => {
        throw new Error('Native rejection');
      };
      await act(async () => root.render(<MobileAppIconSettings bridge={bridge} />));
      await act(async () => button('Icon 2').click());
      expect(button('Default').getAttribute('aria-pressed')).toBe('true');
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      bridge.setIcon = async ({ name }) => ({ supported: true, name });
      await act(async () => button('Icon 2').click());
      expect(button('Icon 2').getAttribute('aria-pressed')).toBe('true');
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });

    it('hides the picker when the native capability is absent or unsupported', async () => {
      await act(async () => root.render(<MobileAppIconSettings />));
      expect(container.textContent).toBe('');
      bridge.getState = async () => ({ supported: false, name: 'default' });
      await act(async () => root.render(<MobileAppIconSettings bridge={bridge} />));
      expect(container.textContent).toBe('');
    });
  });
});

describe('mobile-seat-consequences', () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  it.each(['remove', 'leave'] as const)(
    'explains the financial consequences before mobile %s',
    async (operation) => {
      const change = vi.fn(async () => {});
      const props: AccountSettingsPureProps = {
        surface: 'workspace',
        currentUser: { id: 'me', name: 'Me' },
        organization: { id: 'workspace', name: 'Team' },
        role: operation === 'remove' ? 'owner' : 'member',
        hasAdminPermission: operation === 'remove',
        members: [{ id: 'membership', userId: 'other', role: 'member', user: { name: 'Other' } }],
        pendingInvitations: [],
        billingUiAvailable: true,
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
      };
      await act(async () =>
        root.render(
          <PlatformContext.Provider value={TEST_CLOUD_PLATFORM}>
            <MobileAccountSettings {...props} />
          </PlatformContext.Provider>
        )
      );
      const label =
        operation === 'remove'
          ? i18n.t('workspace.removeMember.title')
          : i18n.t('workspace.danger.leaveWorkspace.title');
      const button = [...container.querySelectorAll('button')].find(
        (candidate) =>
          candidate.getAttribute('aria-label') === label || candidate.textContent?.includes(label)
      );
      expect(button).toBeTruthy();
      await act(async () => button!.click());
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
        i18n.t('billing.seatRemovalConsequences')
      );
      expect(change).not.toHaveBeenCalled();
    }
  );
});

describe('mobile-project-settings', () => {
  const studio = 'machine-studio' as MachineId;

  describe('mobile project settings', () => {
    let root: Root | undefined;
    let container: HTMLDivElement | undefined;

    beforeEach(async () => {
      await initI18n('en');
      (
        globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(() => {
      if (root) flushSync(() => root?.unmount());
      root = undefined;
      container?.remove();
      container = undefined;
      delete window.__LODY_HORIZONTAL_DIVISION__;
      document.documentElement.style.removeProperty('--native-keyboard-height');
      vi.restoreAllMocks();
    });

    it('splits project settings on the fold and keeps their content mounted when the keyboard opens', async () => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        top: 100,
        bottom: 900,
        left: 0,
        right: 669,
        width: 669,
        height: 800,
        x: 0,
        y: 100,
        toJSON: () => ({}),
      });
      window.__LODY_HORIZONTAL_DIVISION__ = { top: 455, height: 40, viewportHeight: 951 };
      await act(async () =>
        root?.render(
          <MobileProjectScreen
            project={{ kind: 'github', fullName: 'org/repo', name: 'repo', ownerHandle: 'org' }}
            conversations={[]}
            filesTabContent={<div>Files</div>}
            onBack={() => {}}
            labels={{ settingsTab: 'Settings' }}
            settingsTabContent={
              <MobileSettingsFoldPanels
                upper={<input aria-label="Project draft" defaultValue="unsaved" />}
                lower={<div>Project skills</div>}
              />
            }
          />
        )
      );
      const settings = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.includes('Settings')
      )!;
      await act(async () => settings.click());
      const upper = container!.querySelector<HTMLElement>('[data-settings-fold-upper]')!;
      const lower = container!.querySelector<HTMLElement>('[data-settings-fold-lower]')!;
      const draft = upper.querySelector<HTMLInputElement>('input')!;
      expect(upper.style.flexBasis).toBe('355px');
      expect(lower.textContent).toContain('Project skills');
      const gap = lower.previousElementSibling as HTMLElement;
      expect(gap.style.flexBasis).toBe('40px');
      expect(gap.style.display).toBe('');
      await act(async () => {
        document.documentElement.style.setProperty('--native-keyboard-height', '300px');
        window.dispatchEvent(new Event('lody:keyboard-resize'));
      });
      expect(upper.style.flexBasis).toBe('');
      expect(gap.style.display).toBe('none');
      expect(container!.querySelector('[data-settings-fold-lower]')).toBe(lower);
      expect(upper.querySelector('input')).toBe(draft);
      expect(draft.value).toBe('unsaved');
    });

    it('lists multi-repository projects like the sidebar and offers creating one', () => {
      const onCreateMultiRepoProject = vi.fn();
      const onOpenMultiRepoProject = vi.fn();
      flushSync(() => {
        root?.render(
          <MobileProjectSettings
            sections={[]}
            githubSections={[]}
            isLoading={false}
            githubProjectsLoading={false}
            addableMachines={[
              { machineId: studio, machineName: 'Studio', online: true, sharedWithTeam: false },
            ]}
            onAddLocalProject={() => undefined}
            multiRepoProjects={[
              { id: 'shop', name: 'Shop', memberCount: 3, boundMachineId: studio, canManage: true },
              { id: 'docs', name: 'Docs', memberCount: 2, boundMachineId: null, canManage: true },
            ]}
            onCreateMultiRepoProject={onCreateMultiRepoProject}
            onOpenMultiRepoProject={onOpenMultiRepoProject}
          />
        );
      });
      const sections = Array.from(container?.querySelectorAll('section') ?? []);
      const sectionOf = (text: string) =>
        sections.find((section) => section.textContent?.includes(text));
      // Shop needs Studio, so it sits with Studio's folders; Docs runs anywhere.
      expect(sectionOf('Shop')).toBe(sectionOf('Add folder'));
      expect(sectionOf('Docs')?.textContent).toContain('Any machine');
      expect(sectionOf('Docs')).not.toBe(sectionOf('Shop'));

      const button = (text: string) =>
        Array.from(container?.querySelectorAll<HTMLElement>('button') ?? []).find((node) =>
          node.textContent?.includes(text)
        );
      flushSync(() => button('Shop')?.click());
      expect(onOpenMultiRepoProject).toHaveBeenCalledWith('shop');
      flushSync(() => button('Several repositories or folders')?.click());
      expect(onCreateMultiRepoProject).toHaveBeenCalledTimes(1);
    });
  });
});

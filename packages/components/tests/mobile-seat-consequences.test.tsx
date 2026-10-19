// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { PlatformContext } from '@lody/platform/react';
import { TEST_CLOUD_PLATFORM } from './test-platform';
import { MobileAccountSettings } from '../src/components/mobile/mobile-account-settings';
import type { AccountSettingsPureProps } from '../src/components/settings/account-setting-pure';
import { initI18n } from '../src/i18n';
import i18n from 'i18next';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
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

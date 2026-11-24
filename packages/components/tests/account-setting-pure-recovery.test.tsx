// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformContext } from '@lody/platform/react';
import { ForceDesktopLayoutProvider, ForceMobileLayoutProvider } from '../src/hooks/use-mobile';
import {
  AccountSettingsPure,
  type AccountSettingsPureProps,
} from '../src/components/settings/account-setting-pure';
import { TEST_CLOUD_PLATFORM } from './test-platform';

describe('AccountSettingsPure recovery section', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderAccount(options: { mobile: boolean; onOpenRecovery?: () => void }) {
    const noop = async () => {};
    const props: AccountSettingsPureProps = {
      surface: 'account',
      currentUser: { id: 'me', name: 'Me' },
      organization: { id: 'workspace', name: 'Team' },
      role: 'owner',
      hasAdminPermission: true,
      members: [],
      pendingInvitations: [],
      onSignOut: noop,
      onInviteMember: async () => null,
      onRemoveMember: noop,
      onUpdateRole: noop,
      onCopyInviteLink: noop,
      onCancelInvitation: noop,
      onLeaveOrganization: noop,
      onDeleteOrganization: noop,
      onDeleteAccount: noop,
      onOpenRecovery: options.onOpenRecovery,
      getInviteLink: () => '',
    };
    const page = <AccountSettingsPure {...props} />;
    await act(async () =>
      root.render(
        <PlatformContext.Provider value={TEST_CLOUD_PLATFORM}>
          {options.mobile ? (
            <ForceMobileLayoutProvider force>{page}</ForceMobileLayoutProvider>
          ) : (
            <ForceDesktopLayoutProvider>{page}</ForceDesktopLayoutProvider>
          )}
        </PlatformContext.Provider>
      )
    );
  }

  it.each([false, true])(
    'renders the recovery row inside Account settings only when onOpenRecovery is provided (mobile=%s)',
    async (mobile) => {
      await renderAccount({ mobile });
      expect(container.querySelector('[data-testid="e2ee-account-recovery"]')).toBeNull();

      const onOpenRecovery = vi.fn();
      await renderAccount({ mobile, onOpenRecovery });
      const button = container.querySelector<HTMLButtonElement>(
        '[data-testid="e2ee-account-recovery"]'
      );
      expect(button).not.toBeNull();
      act(() => button!.click());
      expect(onOpenRecovery).toHaveBeenCalledTimes(1);
    }
  );
});

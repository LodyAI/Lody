// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crossDomainClient } from '@convex-dev/better-auth/client/plugins';

const membershipSyncMocks = vi.hoisted(() => ({
  fingerprint: undefined as string | null | undefined,
  updateSession: vi.fn<() => void>(),
  notify: vi.fn(),
  useQuery: vi.fn(),
  isAuthenticated: true,
}));

vi.mock('../src/hooks/use-recoverable-convex-query', () => ({
  usePublicConvexQuery: () => undefined,
  useRecoverableConvexQuery: (...args: unknown[]) => {
    membershipSyncMocks.useQuery(...args);
    return args[1] === 'skip' || !membershipSyncMocks.isAuthenticated
      ? undefined
      : membershipSyncMocks.fingerprint;
  },
}));

vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({ isAuthenticated: membershipSyncMocks.isAuthenticated }),
}));

vi.mock('../src/providers/convex-provider', () => ({
  useAuthClient: () => ({
    updateSession: membershipSyncMocks.updateSession,
    $store: { notify: membershipSyncMocks.notify },
  }),
}));

const { useDesktopWorkspaceMembershipSync } =
  await import('../src/hooks/use-desktop-workspace-membership-sync');
const { TestCloudPlatformProvider } = await import('./test-platform');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function MembershipSyncProbe({ userId }: { userId: string | null }) {
  useDesktopWorkspaceMembershipSync(userId);
  return null;
}

describe('useDesktopWorkspaceMembershipSync', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    membershipSyncMocks.fingerprint = undefined;
    membershipSyncMocks.isAuthenticated = true;
    membershipSyncMocks.notify.mockReset();
    membershipSyncMocks.updateSession.mockReset();
    membershipSyncMocks.updateSession.mockImplementation(
      crossDomainClient().getActions(
        vi.fn() as never,
        {
          notify: membershipSyncMocks.notify,
        } as never
      ).updateSession
    );
    membershipSyncMocks.useQuery.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(userId: string | null) {
    await act(async () => {
      root.render(
        createElement(
          TestCloudPlatformProvider,
          null,
          createElement(MembershipSyncProbe, { userId })
        )
      );
    });
  }

  it('uses the first fingerprint as a baseline and refreshes on change', async () => {
    membershipSyncMocks.fingerprint = null;
    await render('user-1');
    expect(membershipSyncMocks.updateSession).not.toHaveBeenCalled();

    membershipSyncMocks.fingerprint = 'workspace-1';
    await render('user-1');
    expect(membershipSyncMocks.updateSession).not.toHaveBeenCalled();

    membershipSyncMocks.fingerprint = 'workspace-1\nworkspace-2';
    await render('user-1');
    expect(membershipSyncMocks.updateSession).toHaveBeenCalledTimes(1);
    expect(membershipSyncMocks.notify.mock.calls).toEqual([
      ['$sessionSignal'],
      ['$activeOrgSignal'],
    ]);

    await render('user-1');
    expect(membershipSyncMocks.updateSession).toHaveBeenCalledTimes(1);
    expect(membershipSyncMocks.notify).toHaveBeenCalledWith('$activeOrgSignal');
  });

  it('refreshes permissions when only the role changes in the same workspace', async () => {
    membershipSyncMocks.fingerprint = '["workspace-1","member"]';
    await render('user-1');
    membershipSyncMocks.fingerprint = '["workspace-1","owner"]';
    await render('user-1');
    expect(membershipSyncMocks.updateSession).toHaveBeenCalledTimes(1);
    expect(membershipSyncMocks.notify).toHaveBeenCalledWith('$activeOrgSignal');
  });

  it('resets the baseline when the authenticated user changes', async () => {
    membershipSyncMocks.fingerprint = 'workspace-1';
    await render('user-1');

    membershipSyncMocks.fingerprint = undefined;
    await render(null);
    membershipSyncMocks.fingerprint = 'workspace-2';
    await render('user-2');

    expect(membershipSyncMocks.updateSession).not.toHaveBeenCalled();
    expect(membershipSyncMocks.useQuery).toHaveBeenLastCalledWith(expect.anything(), {});
  });

  it('contains synchronous refresh errors without crashing the mounted client', async () => {
    const error = new Error('Session signal listener failed');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    membershipSyncMocks.fingerprint = 'workspace-1';
    await render('user-1');
    membershipSyncMocks.updateSession.mockImplementation(() => {
      throw error;
    });
    membershipSyncMocks.fingerprint = 'workspace-2';

    await expect(render('user-1')).resolves.toBeUndefined();
    expect(membershipSyncMocks.notify).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[Auth] Failed to refresh workspaces after membership change',
      error
    );
  });

  it('delegates auth recovery pauses to the recoverable query layer', async () => {
    membershipSyncMocks.fingerprint = 'workspace-1';
    membershipSyncMocks.isAuthenticated = false;

    await render('user-1');

    expect(membershipSyncMocks.useQuery).toHaveBeenLastCalledWith(expect.anything(), {});
    expect(membershipSyncMocks.updateSession).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom

// @vitest-environment jsdom
import { TestCloudPlatformProvider } from './test-platform';

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubSettingsView } from '../src/components/settings/github-settings-view';
import type { SettingsWorkspaceRepoWithStatus } from '../src/components/settings/settings-data-cache';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const authState = vi.hoisted(() => ({
  electron: false,
  native: false,
  mobile: false,
  available: true,
  authorization: 'missing',
  preferenceEnabled: true,
  preferenceWrites: [] as Array<{ name: string; args: unknown }>,
  canManage: false,
  openedUrls: [] as string[],
  openResult: true,
  error: '',
  linkedCallback: '',
  repos: [],
}));
vi.mock('../src/lib/electron', () => ({ isElectronRenderer: () => authState.electron }));
vi.mock('../src/lib/native-platform', () => ({ isNativeAppShell: () => authState.native }));
vi.mock('../src/lib/native-browser', () => ({
  openExternalUrl: async (url: string) => {
    authState.openedUrls.push(url);
    return authState.openResult;
  },
}));
vi.mock('../src/lib/app-platform', () => ({ useAppCapability: () => authState.available }));
vi.mock('../src/hooks/use-mobile', () => ({ useIsMobile: () => authState.mobile }));
vi.mock('../src/atoms', () => ({ currentWorkspaceSlugAtom: {} }));
vi.mock('jotai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jotai')>()),
  useAtomValue: () => 'test-workspace',
}));
vi.mock('../src/lib/github-token', () => ({ invalidateGitHubTokensForWorkspace: () => {} }));
vi.mock('../src/lib/toast', () => ({
  toast: {
    error: (message: string) => {
      authState.error = message;
    },
  },
}));
vi.mock('../src/hooks/use-convex-error-message', () => ({
  useConvexErrorMessage: () => (_: unknown, fallback: string) => fallback,
}));
vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({
    isAuthenticated: true,
    isLoading: false,
    claimAutomaticCommand: () => false,
  }),
}));
// This suite exercises the ordinary GitHub presentation/authorization flow.
vi.mock('../src/hooks/use-workspace-feature', async (original) => ({
  ...(await original<object>()),
  useLegacyWorkspaceQueriesEnabled: () => true,
  useAssertLegacyWorkspaceAccess: () => () => {},
  useLegacyWorkspaceQueryStatus: () => 'allowed',
}));
vi.mock('../src/hooks/use-personal-github-authorization', () => ({
  usePersonalGitHubAuthorization: () => async () => {
    authState.linkedCallback = 'operation-only';
  },
}));
vi.mock('../src/components/settings/settings-data-cache', () => ({
  useSettingsDataCache: () => ({
    workspaceId: 'workspace-test',
    canManageGithub: authState.canManage,
    workspaceReposWithStatus: authState.repos,
    workspaceReposLoading: false,
  }),
}));
vi.mock('@lody/platform/react', async (original) => ({
  ...(await original<typeof import('@lody/platform/react')>()),
  useCloudQuery: () => ({
    enabled: authState.preferenceEnabled,
    authorization: { state: authState.authorization },
  }),
  useCloudAction: () => async () => ({ state: 'synthetic-signed-install-state' }),
  useCloudMutation: (operation: { name: string }) => async (args: unknown) => {
    authState.preferenceWrites.push({ name: operation.name, args });
  },
}));

import { GitHubInstallationNotice } from '../src/components/settings/github-installation-notice';
import { resolveDesktopGitHubInstallDeepLinkPath } from '../src/lib/desktop-github-install-deep-link';
import { readGitHubInstallRetry } from '../src/lib/github-installation-recovery';
import { IntegrationsSettingsComponent } from '../src/components/settings/integrations-setting';
import { MobileSettingsFoldContext } from '../src/components/mobile/mobile-settings-fold-context';

const repo = (repoFullName: string, enabled: boolean): SettingsWorkspaceRepoWithStatus => ({
  repoFullName,
  name: repoFullName.split('/')[1]!,
  repositoryId: repoFullName.length,
  private: false,
  enabled,
});

const repos = [
  repo('loro-dev/loro', true),
  repo('LodyAI/lody-cloud', false),
  repo('loro-dev/lody', false),
  repo('LodyAI/acp-extension-core', true),
  repo('zxch3n/blog', false),
  repo('zxch3n/dotfiles', true),
];

describe('GitHubSettingsView', () => {
  let root: Root;
  let container: HTMLDivElement;
  const toggled: Array<[string, boolean]> = [];

  const render = async (canManage: boolean) => {
    await act(async () => {
      root.render(
        createElement(GitHubSettingsView, {
          canManage,
          workspaceReady: true,
          connecting: false,
          onConnect: () => undefined,
          identity: {
            enabled: false,
            authorizationState: 'missing',
            onToggle: () => undefined,
            onAuthorize: () => undefined,
          },
          repos,
          reposLoading: false,
          onToggleRepo: (name, enabled) => toggled.push([name, enabled]),
        })
      );
    });
  };

  const ownerHeadings = () =>
    [...container.querySelectorAll('section header p')].map((node) => node.textContent);
  const repoSwitch = (name: string) =>
    container.querySelector<HTMLElement>(`[role="switch"][aria-label="${name}"]`);

  beforeEach(async () => {
    await initI18n('en');
    toggled.length = 0;
    Object.assign(authState, {
      electron: false,
      native: false,
      mobile: false,
      available: true,
      authorization: 'missing',
      preferenceEnabled: true,
      preferenceWrites: [],
      canManage: false,
      openedUrls: [],
      openResult: true,
      error: '',
      linkedCallback: '',
    });
    vi.stubEnv('VITE_SITE_URL', 'https://preview.example.com');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllEnvs();
  });

  it('shows a member the repositories without letting them change any', async () => {
    await render(false);
    expect(container.textContent).toContain(
      'Only workspace admins can manage GitHub integrations.'
    );
    await act(async () => repoSwitch('loro-dev/loro')!.click());
    expect(toggled).toEqual([]);
  });

  const authorizeButton = () =>
    [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Authorize'
    );
  const renderSettings = async () => {
    await act(async () =>
      root.render(
        createElement(TestCloudPlatformProvider, null, createElement(IntegrationsSettingsComponent))
      )
    );
  };

  it('separates GitHub identity from repositories and keeps the search input during fold changes', async () => {
    authState.mobile = true;
    authState.native = true;
    authState.repos = repos as never[];
    const renderFold = async (fold: boolean) => {
      await act(async () =>
        root.render(
          createElement(
            TestCloudPlatformProvider,
            null,
            createElement(
              MobileSettingsFoldContext.Provider,
              { value: fold ? { messageHeight: 300, lowerTop: 340, gapHeight: 40 } : null },
              createElement(IntegrationsSettingsComponent)
            )
          )
        )
      );
    };
    await renderFold(true);
    const upper = container.querySelector('[data-settings-fold-upper]')!;
    const lower = container.querySelector('[data-settings-fold-lower]')!;
    expect(upper.textContent).toContain('Personal Identity');
    expect(lower.textContent).toContain('loro-dev/loro');
    const search = lower.querySelector('input[type="search"]');
    expect(search).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        search,
        'loro'
      );
      search!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(lower.textContent).not.toContain('zxch3n/blog');
    await renderFold(false);
    expect(container.querySelector('input[type="search"]')).toBe(search);
    expect(search!.value).toBe('loro');
    expect(lower.textContent).not.toContain('zxch3n/blog');
  });

  it.each([
    ['electron', false],
    ['native', false],
    ['native', true],
  ] as const)(
    'offers external authorization in the %s shell (mobile: %s) for missing and expired credentials',
    async (host, mobile) => {
      authState[host] = true;
      authState.mobile = mobile;
      for (const state of ['missing', 'expired']) {
        authState.authorization = state;
        await renderSettings();
        expect(container.textContent).toContain('Authorization needed');
        expect(authorizeButton()?.disabled).toBe(false);
        await act(async () => authorizeButton()!.click());
        expect(authState.openedUrls.at(-1)).toBe(
          'https://preview.example.com/test-workspace/settings/github'
        );
        expect(authState.linkedCallback).toBe('');
        expect(authorizeButton()?.disabled).toBe(false);
      }
      authState.authorization = 'authorized';
      await renderSettings();
      expect(authorizeButton()).toBeUndefined();
    }
  );

  it('reports a rejected browser handoff and lets the user retry', async () => {
    authState.electron = true;
    authState.openResult = false;
    await renderSettings();
    await act(async () => authorizeButton()!.click());
    expect(authState.error).toBe('Authorization failed');
    expect(authorizeButton()?.disabled).toBe(false);
    expect(authState.linkedCallback).toBe('');
  });

  it('starts operation-only browser authorization and keeps the local capability gate', async () => {
    await renderSettings();
    await act(async () => authorizeButton()!.click());
    expect(authState.linkedCallback).toBe('operation-only');
    expect(authState.openedUrls).toEqual([]);
    authState.available = false;
    await renderSettings();
    expect(container.textContent).toBe('');
  });
  it.each([false, true])(
    'requires personal authorization before App installation (mobile: %s)',
    async (mobile) => {
      authState.mobile = mobile;
      authState.canManage = true;
      authState.electron = true;
      const popup = vi.spyOn(window, 'open');
      await renderSettings();
      const connect = [...container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Manage'
      );
      expect(connect).toBeDefined();
      await act(async () => connect!.click());
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Authorize your personal GitHub account first'
      );
      expect(authState.openedUrls).toEqual([]);
      expect(popup).not.toHaveBeenCalled();
      // Authorization is independent of the operation preference; no App flow begins yet.
      await act(async () => authorizeButton()!.click());
      expect(authState.openedUrls[0]).toContain('github_install_error=authorization_required');
      authState.authorization = 'authorized';
      await renderSettings();
      const authorizedConnect = [...container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Manage'
      );
      await act(async () => authorizedConnect!.click());
      expect(authState.openedUrls.at(-1)).toContain(
        '/installations/new?state=synthetic-signed-install-state'
      );
      popup.mockRestore();
      authState.canManage = false;
    }
  );

  it('preserves a recoverable installation error and retry through the desktop deep link', async () => {
    vi.stubEnv('VITE_CONVEX_SITE_URL', 'https://synthetic.convex.site');
    const callback =
      'https://synthetic.convex.site/api/github/callback?installation_id=42&setup_action=update&state=synthetic-state';
    const hash = `#github-install-retry=${encodeURIComponent(callback)}`;
    const target = resolveDesktopGitHubInstallDeepLinkPath(
      `lody://github-install?workspaceSlug=team&installed=true&github_install_error=temporarily_unavailable${hash}`,
      '/',
      { target: 'home' }
    );
    expect(target).toBe(
      `/team/settings/github?github_install_error=temporarily_unavailable${hash}`
    );
    window.history.replaceState(null, '', target!);
    await act(async () =>
      root.render(
        createElement(
          TestCloudPlatformProvider,
          null,
          createElement(GitHubInstallationNotice, { authorized: true, onAuthorize: () => {} })
        )
      )
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'GitHub could not be reached'
    );
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry installation'
    );
    expect(retry).toBeDefined();
    authState.electron = true;
    await act(async () => retry!.click());
    expect(authState.openedUrls.at(-1)).toBe(callback);
    // An untrusted deep link can display advice but never send credentials to another host.
    expect(
      readGitHubInstallRetry(
        `#github-install-retry=${encodeURIComponent(callback.replace('synthetic.convex.site', 'attacker.example'))}`,
        'https://synthetic.convex.site'
      )
    ).toBeNull();
    expect(
      readGitHubInstallRetry(
        `#github-install-retry=${encodeURIComponent(callback + '&redirect=https://attacker.example')}`,
        'https://synthetic.convex.site'
      )
    ).toBeNull();
    window.history.replaceState(null, '', '/');
    vi.unstubAllEnvs();
  });
  it.each([false, true])(
    'personal authorization for App installation remains available with Act-as-you off and never enables that preference (mobile: %s)',
    async (mobile) => {
      authState.mobile = mobile;
      authState.preferenceEnabled = false;
      authState.repos = [];
      await renderSettings();
      const identitySwitch = container.querySelector('[role="switch"]');
      expect(identitySwitch?.getAttribute('aria-checked')).toBe('false');
      expect(authorizeButton()).toBeDefined();
      await act(async () => authorizeButton()!.click());
      expect(authState.linkedCallback).toBe('operation-only');
      expect(identitySwitch?.getAttribute('aria-checked')).toBe('false');
      expect(authState.preferenceWrites).toEqual([]);
    }
  );
});

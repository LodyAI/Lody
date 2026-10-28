// @vitest-environment jsdom

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
vi.mock('../src/hooks/use-personal-github-authorization', () => ({
  usePersonalGitHubAuthorization: () => async () => {
    authState.linkedCallback = 'operation-only';
  },
}));
vi.mock('../src/components/settings/settings-data-cache', () => ({
  useSettingsDataCache: () => ({
    workspaceId: 'workspace-test',
    canManageGithub: false,
    workspaceReposWithStatus: authState.repos,
    workspaceReposLoading: false,
  }),
}));
vi.mock('@lody/platform/react', () => ({
  useCloudQuery: () => ({ enabled: true, authorization: { state: authState.authorization } }),
  useCloudAction: () => async () => {},
  useCloudMutation: () => async () => {},
}));

import { IntegrationsSettingsComponent } from '../src/components/settings/integrations-setting';
import { MobileSettingsFoldContext } from '../src/components/mobile/mobile-settings-fold-context';
import { getPersonalGitHubAuthorizationUrl } from '../src/components/settings/github-personal-authorization';

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

  it('groups repositories under their owner, in arrival order, and summarises what is enabled', async () => {
    await render(true);
    expect(ownerHeadings()).toEqual(['loro-dev', 'LodyAI', 'zxch3n']);
    expect(container.textContent).toContain('3 of 6 repositories enabled');

    await act(async () => repoSwitch('loro-dev/lody')!.click());
    expect(toggled).toEqual([['loro-dev/lody', true]]);
  });

  it('narrows the owners to the repositories matching the search', async () => {
    await render(true);
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(search, 'dot');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(ownerHeadings()).toEqual(['zxch3n']);
    expect(repoSwitch('zxch3n/dotfiles')).not.toBeNull();
    expect(repoSwitch('zxch3n/blog')).toBeNull();
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
    await act(async () => root.render(createElement(IntegrationsSettingsComponent)));
  };

  it('separates GitHub identity from repositories and keeps the search input during fold changes', async () => {
    authState.mobile = true;
    authState.native = true;
    authState.repos = repos as never[];
    const renderFold = async (fold: boolean) => {
      await act(async () =>
        root.render(
          createElement(
            MobileSettingsFoldContext.Provider,
            { value: fold ? { messageHeight: 300, lowerTop: 340, gapHeight: 40 } : null },
            createElement(IntegrationsSettingsComponent)
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

  it('builds an encoded workspace destination and rejects non-web sites', () => {
    vi.stubEnv('VITE_SITE_URL', '');
    expect(getPersonalGitHubAuthorizationUrl('team/name')).toBe(
      'https://lody.ai/team%2Fname/settings/github'
    );
    vi.stubEnv('VITE_SITE_URL', 'file:///app');
    expect(() => getPersonalGitHubAuthorizationUrl('team')).toThrow();
  });
});

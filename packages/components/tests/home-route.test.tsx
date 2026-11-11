// @vitest-environment jsdom

import { act, useEffect, useRef } from 'react';
import { Provider, createStore } from 'jotai';
import { settingsActiveTabAtom, settingsDialogOpenAtom } from '../src/atoms/settings';
import { Route as WorkspaceSettingsRoute } from '../src/routes/$workspaceName/_auth/settings';
import { navigateToResolvedPath } from '../src/lib/deep-link-path';
import { resolveDesktopGitHubInstallDeepLinkPath } from '../src/lib/desktop-github-install-deep-link';
import { createRoot, type Root } from 'react-dom/client';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
} from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeRoute } from '../src/routes/index';
import { Route as GitHubSettingsRoute } from '../src/routes/settings.github';
import { GitHubInstallationNotice } from '../src/components/settings/github-installation-notice';
import { BootShellBoundary } from '../src/components/boot-shell-boundary';
import { BOOT_SHELL_MARKUP } from '../src/lib/boot-shell';

const getSnapshot = vi.hoisted(() => vi.fn());
vi.mock('@/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({ localPlatform: { getSnapshot } }),
}));

const state = vi.hoisted(() => ({
  local: false,
  hasLocalToken: true,
  preferredSlug: 'acme' as string | null,
  warm: false,
  signedIn: true,
  hasOrganizations: true,
  activeSlug: 'acme' as string | null,
  memberSlugs: ['acme'] as string[],
  sessionPending: false,
  organizationsLoading: false,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
  useIsCompactDesktop: () => false,
}));
vi.mock('@/lib/desktop-window', () => ({
  isWarmWindow: () => state.warm,
  isSessionWindow: () => false,
  windowStorage: () => localStorage,
}));
vi.mock('@/lib/app-platform', () => ({ isLocalAppPlatform: () => state.local }));
vi.mock('@/lib/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/workspace')>()),
  readPreferredWorkspaceSlug: () => state.preferredSlug,
}));
vi.mock('@/hooks/useStableSession', () => ({
  useStableSession: () => ({
    data: state.signedIn ? { user: { id: 'user-1' } } : null,
    hasLocalToken: state.hasLocalToken,
    isPending: state.sessionPending,
    isRetrying: false,
    error: null,
  }),
}));
vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => ({
    activeOrganization: state.activeSlug ? { id: state.activeSlug, slug: state.activeSlug } : null,
    organizations: state.hasOrganizations
      ? state.memberSlugs.map((slug) => ({ id: slug, slug }))
      : [],
    organizationsLoading: state.organizationsLoading,
    error: null,
  }),
}));
vi.mock('../src/providers/local-platform-provider', () => ({
  useLocalPlatformWorkspacesState: () => ({
    status: 'ready',
    workspaces: [{ slug: 'local' }],
  }),
  getLocalWorkspaceSlug: (workspace: { slug: string }) => workspace.slug,
}));
vi.mock('@/components/route-message', () => ({ RouteMessage: () => null }));
vi.mock('@/components/loading-placeholder', () => ({ LoadingPlaceholder: () => null }));

let root: Root | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.assign(state, {
    local: false,
    hasLocalToken: true,
    preferredSlug: 'acme',
    warm: false,
    signedIn: true,
    hasOrganizations: true,
    activeSlug: 'acme',
    memberSlugs: ['acme'],
    sessionPending: false,
    organizationsLoading: false,
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
});

describe('default app entry', () => {
  it.each([
    ['cached workspace', false, true, 'acme', true, true, '/acme/chat'],
    ['resolved workspace with local token', false, true, null, true, true, '/acme/chat'],
    ['resolved authenticated workspace', false, false, null, true, true, '/acme/chat'],
    ['local workspace', true, false, null, true, true, '/local/chat'],
    ['signed out', false, false, null, false, true, '/login'],
    ['no workspace', false, true, null, true, false, '/workspace/create'],
  ] as const)(
    'keeps the boot frame until the destination commits for %s',
    async (_label, local, hasLocalToken, preferredSlug, signedIn, hasOrganizations, expected) => {
      Object.assign(state, { local, hasLocalToken, preferredSlug, signedIn, hasOrganizations });
      let finishNavigation!: () => void;
      const destinationReady = new Promise<void>((resolve) => {
        finishNavigation = resolve;
      });
      const legacy = JSON.stringify({
        version: 1,
        path: '/acme/sessions/previous?tab=changes&pr=12',
        updatedAt: 1,
      });
      localStorage.setItem('lody:lastAppRoute', legacy);
      sessionStorage.setItem('lody:lastAppRoute', legacy);

      const rootRoute = createRootRoute({
        component: () => (
          <BootShellBoundary>
            <Outlet />
          </BootShellBoundary>
        ),
      });
      const indexRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/',
        component: HomeRoute,
      });
      const chatRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/$workspaceName/chat',
        beforeLoad: () => destinationReady,
        component: () => <div>Chat landing</div>,
      });
      const sessionRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/$workspaceName/sessions/$sessionId',
        component: () => <div>Previous session</div>,
      });
      const loginRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/login',
        beforeLoad: () => destinationReady,
        component: () => <div>Login</div>,
      });
      const createWorkspaceRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/workspace/create',
        beforeLoad: () => destinationReady,
        component: () => <div>Create workspace</div>,
      });
      const router = createRouter({
        routeTree: rootRoute.addChildren([
          indexRoute,
          chatRoute,
          sessionRoute,
          loginRoute,
          createWorkspaceRoute,
        ]),
        history: createMemoryHistory({ initialEntries: ['/'] }),
        defaultPendingMs: Infinity,
        defaultPendingMinMs: 0,
      });
      await router.load();
      const container = document.createElement('div');
      container.innerHTML = BOOT_SHELL_MARKUP;
      document.body.append(container);
      root = createRoot(container);
      await act(async () => root!.render(<RouterProvider router={router} />));

      expect(container.querySelector('[data-lody-boot-shell]')).not.toBeNull();
      expect(container.querySelector('[data-lody-boot-shell]')?.getAttribute('aria-busy')).toBe(
        'true'
      );
      expect(container.querySelector('.lody-boot-shell__mark')).not.toBeNull();
      expect(container.querySelector('[data-lody-boot-shell]')?.getAttribute('data-layout')).toBe(
        expected === '/login' || expected === '/workspace/create' ? 'plain' : 'workspace'
      );
      await act(async () => {
        finishNavigation();
        await router.load();
      });
      expect(router.state.location.pathname).toBe(expected);
      expect(container.querySelector('div')?.textContent).toBe(
        expected === '/login'
          ? 'Login'
          : expected === '/workspace/create'
            ? 'Create workspace'
            : 'Chat landing'
      );
      expect(container.querySelector('[data-lody-boot-shell]')).toBeNull();
    }
  );

  it('keeps the hidden spare neutral', async () => {
    state.warm = true;
    const container = document.createElement('div');
    container.innerHTML = BOOT_SHELL_MARKUP;
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomeRoute />));
    expect(container.querySelector('[data-lody-boot-shell]')).toBeNull();
    expect(container.querySelector('img, div')).toBeNull();
  });
});

describe('workspace-independent GitHub settings landing', () => {
  async function land(initialEntry = '/settings/github') {
    window.history.replaceState(null, '', initialEntry);
    const rootRoute = createRootRoute({ component: Outlet });
    // Mount the actual file route against the real router, including its static path
    // precedence over the dynamic workspace route.
    const alias = GitHubSettingsRoute.update({
      id: '/settings/github',
      path: '/settings/github',
      getParentRoute: () => rootRoute,
    } as never);
    const settings = createRoute({
      getParentRoute: () => rootRoute,
      path: '/$workspaceName/settings/github',
      component: () => (
        <>
          <div>GitHub settings</div>
          <GitHubInstallationNotice authorized onAuthorize={() => {}} />
        </>
      ),
    });
    const unrelated = createRoute({
      getParentRoute: () => rootRoute,
      path: '/$workspaceName/$rest',
      component: () => <div>Wrong workspace route</div>,
    });
    const login = createRoute({
      getParentRoute: () => rootRoute,
      path: '/login',
      component: () => <div>Login</div>,
    });
    const createWorkspace = createRoute({
      getParentRoute: () => rootRoute,
      path: '/workspace/create',
      component: () => <div>Create workspace</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([alias, settings, unrelated, login, createWorkspace]),
      history: createMemoryHistory({ initialEntries: [initialEntry] }),
      defaultPendingMs: Infinity,
      defaultPendingMinMs: 0,
    });
    expect(router.matchRoutes('/settings/github').at(-1)?.routeId).toBe('/settings/github');
    await router.load();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));
    return { router, container };
  }

  it('opens neutral Web GitHub settings for a live member workspace without installation success or failure advice', async () => {
    const { router, container } = await land();
    expect(router.state.location.pathname).toBe('/acme/settings/github');
    expect(router.state.location.searchStr).toBe('');
    expect(router.state.location.hash).toBe('');
    expect(container.textContent).toBe('GitHub settings');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    ['active member', 'current', ['current', 'other'], 'other', 'current'],
    ['stale active membership', 'removed', ['other'], 'removed', 'other'],
    ['missing active workspace', null, ['other', 'next'], 'next', 'next'],
  ] as const)(
    'chooses the %s only from the authenticated member list, ignoring unsigned callback targets',
    async (_label, active, members, preferred, expected) => {
      state.activeSlug = active;
      state.memberSlugs = [...members];
      state.preferredSlug = preferred;
      const { router } = await land(
        '/settings/github?workspaceSlug=attacker&workspaceId=foreign&installation_id=42&returnTarget=desktop'
      );
      expect(router.state.location.pathname).toBe(`/${expected}/settings/github`);
      expect(router.state.location.searchStr).toBe('');
      expect(router.state.location.hash).toBe('');
    }
  );

  it('preserves classified advice and a validated retry fragment without selecting a workspace from either', async () => {
    vi.stubEnv('VITE_CONVEX_SITE_URL', 'https://synthetic.convex.site');
    const retry =
      'https://synthetic.convex.site/api/github/callback?installation_id=42&setup_action=update&state=synthetic-state';
    const fragment = `github-install-retry=${encodeURIComponent(retry)}`;
    const { router } = await land(
      `/settings/github?github_install_error=authorization_required&workspaceSlug=attacker#${fragment}`
    );
    expect(router.state.location.pathname).toBe('/acme/settings/github');
    expect(router.state.location.search).toEqual({
      github_install_error: 'authorization_required',
    });
    expect(router.state.location.hash).toBe(fragment);
  });

  it.each([false, true])(
    'uses login with the original global return even when a cached token exists (%s)',
    async (cachedToken) => {
      state.signedIn = false;
      state.hasLocalToken = cachedToken;
      const { router } = await land(
        '/settings/github?github_install_error=invalid_state&workspaceSlug=attacker'
      );
      expect(router.state.location.pathname).toBe('/login');
      expect(router.state.location.search).toEqual({
        redirect: '/settings/github?github_install_error=invalid_state',
      });
    }
  );

  it('uses the existing create-workspace flow when no member workspace exists', async () => {
    state.hasOrganizations = false;
    const { router } = await land();
    expect(router.state.location.pathname).toBe('/workspace/create');
  });

  it.each(['session', 'organizations'])(
    'waits for the live %s before choosing a workspace',
    async (pending) => {
      state.sessionPending = pending === 'session';
      state.organizationsLoading = pending === 'organizations';
      const { router, container } = await land();
      expect(router.state.location.pathname).toBe('/settings/github');
      expect(container.textContent).not.toContain('GitHub settings');
    }
  );
});

describe('desktop installation recovery enters the already-open settings modal', () => {
  async function desktop(initial = '/team/chat') {
    const store = createStore();
    store.set(settingsDialogOpenAtom, true);
    let mounts = 0;
    function PersistedModal() {
      const mounted = useRef(false);
      useEffect(() => {
        if (!mounted.current) {
          mounts++;
          mounted.current = true;
        }
      }, []);
      return <GitHubInstallationNotice authorized onAuthorize={() => {}} />;
    }
    const rootRoute = createRootRoute({
      component: () => (
        <Provider store={store}>
          <PersistedModal />
          <Outlet />
        </Provider>
      ),
    });
    const workspace = createRoute({
      getParentRoute: () => rootRoute,
      path: '/$workspaceName',
      component: Outlet,
    });
    const auth = createRoute({ getParentRoute: () => workspace, id: '_auth', component: Outlet });
    const settings = WorkspaceSettingsRoute.update({
      getParentRoute: () => auth,
      id: '/settings',
      path: '/settings',
    } as never);
    const github = createRoute({
      getParentRoute: () => settings,
      path: '/github',
      component: () => null,
    });
    const chat = createRoute({
      getParentRoute: () => auth,
      path: '/chat',
      component: () => <div>Workspace chat</div>,
    });
    const onboarding = createRoute({
      getParentRoute: () => rootRoute,
      path: '/onboarding',
      component: () => <div>Onboarding projects</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        workspace.addChildren([auth.addChildren([settings.addChildren([github]), chat])]),
        onboarding,
      ]),
      history: createMemoryHistory({ initialEntries: [initial] }),
      defaultPendingMs: Infinity,
      defaultPendingMinMs: 0,
    });
    await router.load();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));
    return { router, store, container, mounts: () => mounts };
  }

  it('keeps the retry capability in the fragment across actual navigation and the settings-to-modal handoff', async () => {
    vi.stubEnv('VITE_CONVEX_SITE_URL', 'https://synthetic.convex.site');
    const { router, store, container, mounts } = await desktop();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const callback =
      'https://synthetic.convex.site/api/github/callback?installation_id=42&setup_action=update&state=NAVIGATION_CAPABILITY_SECRET';
    const fragment = `github-install-retry=${encodeURIComponent(callback)}`;
    const path = resolveDesktopGitHubInstallDeepLinkPath(
      `lody://github-install?workspaceSlug=team&github_install_error=temporarily_unavailable#${fragment}`,
      router.state.location.pathname
    )!;
    await act(async () => {
      navigateToResolvedPath(router.navigate, path);
      await router.load();
    });
    expect(router.state.location.pathname).toBe('/team/chat');
    expect(router.state.location.search).toEqual({
      github_install_error: 'temporarily_unavailable',
    });
    expect(router.state.location.searchStr).not.toContain('NAVIGATION_CAPABILITY_SECRET');
    expect(router.state.location.searchStr).not.toContain('state');
    expect(router.state.location.hash).toBe(fragment);
    expect(store.get(settingsDialogOpenAtom)).toBe(true);
    expect(store.get(settingsActiveTabAtom)).toBe('github');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'settings.integrations.github.installErrors.temporarilyUnavailable'
    );
    expect(mounts()).toBe(1);
    await act(async () => {
      await router.navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: 'team' },
        search: { github_install_error: 'installation_not_visible' },
        hash: fragment,
        replace: true,
      });
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'settings.integrations.github.installErrors.installationNotVisible'
    );
    await act(async () => {
      await router.navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: 'team' },
        search: {},
        hash: '',
        replace: true,
      });
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(mounts()).toBe(1);
  });

  it('removes legacy capability query fields during settings handoff while retaining ordinary context and the retry fragment', async () => {
    vi.stubEnv('VITE_CONVEX_SITE_URL', 'https://synthetic.convex.site');
    const { router } = await desktop();
    const retry =
      'https://synthetic.convex.site/api/github/callback?installation_id=42&setup_action=update&state=FRAGMENT_SECRET';
    const hash = `github-install-retry=${encodeURIComponent(retry)}`;
    await act(async () => {
      await router.navigate({
        to: '/$workspaceName/settings/github',
        params: { workspaceName: 'team' },
        search: {
          github_install_error: 'temporarily_unavailable',
          context: 'github',
          state: 'LEGACY_QUERY_SECRET',
          'github-install-retry': 'LEGACY_QUERY_SECRET',
          github_install_retry: 'LEGACY_QUERY_SECRET',
        } as never,
        hash,
      });
      await router.load();
    });
    expect(router.state.location.pathname).toBe('/team/chat');
    expect(router.state.location.search).toEqual({
      github_install_error: 'temporarily_unavailable',
      context: 'github',
    });
    expect(router.state.location.searchStr).not.toContain('LEGACY_QUERY_SECRET');
    expect(router.state.location.hash).toBe(hash);
  });

  it('leaves successful onboarding returns alone but takes a failed installation to recovery settings', async () => {
    const { router, container, store } = await desktop('/onboarding');
    expect(
      resolveDesktopGitHubInstallDeepLinkPath(
        'lody://github-install?workspaceSlug=team&installed=true',
        '/onboarding'
      )
    ).toBeNull();
    const failure = resolveDesktopGitHubInstallDeepLinkPath(
      'lody://github-install?workspaceSlug=team&github_install_error=authorization_required',
      '/onboarding'
    );
    expect(failure).toBe('/team/settings/github?github_install_error=authorization_required');
    await act(async () => {
      navigateToResolvedPath(router.navigate, failure!);
      await router.load();
    });
    expect(router.state.location.pathname).toBe('/team/chat');
    expect(store.get(settingsActiveTabAtom)).toBe('github');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'settings.integrations.github.installErrors.managementRequired'
    );
  });
});

it('recovers the same local provider after validation errors with capped retries and manual retry', async () => {
  state.local = true;
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { getLocalPlatformProvider, retryLocalPlatformSnapshot } = await vi.importActual<
    typeof import('../src/providers/local-platform-provider')
  >('../src/providers/local-platform-provider');
  getSnapshot.mockRejectedValue(new Error('invalid local catalog'));
  const provider = getLocalPlatformProvider();
  await vi.advanceTimersByTimeAsync(0);
  expect(provider.workspaces.state.get().status).toBe('error');
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = getSnapshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(getSnapshot.mock.calls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(getSnapshot.mock.calls.length).toBe(before + 1);
    expect(provider.workspaces.state.get().status).toBe('error');
  }
  retryLocalPlatformSnapshot();
  retryLocalPlatformSnapshot();
  await vi.advanceTimersByTimeAsync(0);
  expect(provider.workspaces.state.get().status).toBe('error');
  getSnapshot.mockResolvedValue({
    userId: 'local:user',
    workspace: { workspaceId: 'local:workspace', name: 'Local', slug: 'local', role: 'owner' },
  });
  await vi.advanceTimersByTimeAsync(30000);
  expect(provider.workspaces.state.get()).toMatchObject({
    status: 'ready',
    activeWorkspaceId: 'local:workspace',
  });
  expect(provider.identity.session.get()).toMatchObject({
    status: 'authenticated',
    user: { id: 'local:user' },
  });
  expect(getLocalPlatformProvider()).toBe(provider);
  expect(vi.getTimerCount()).toBe(0);
  error.mockRestore();
});

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeRoute } from '../src/routes/index';
import { BOOT_SHELL_MARKUP } from '../src/lib/boot-shell';

const state = vi.hoisted(() => ({
  local: false,
  hasLocalToken: true,
  preferredSlug: 'acme' as string | null,
  warm: false,
  signedIn: true,
  hasOrganizations: true,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/desktop-window', () => ({ isWarmWindow: () => state.warm }));
vi.mock('@/lib/app-platform', () => ({ isLocalAppPlatform: () => state.local }));
vi.mock('@/lib/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/workspace')>()),
  readPreferredWorkspaceSlug: () => state.preferredSlug,
}));
vi.mock('@/hooks/useStableSession', () => ({
  useStableSession: () => ({
    data: state.signedIn ? { user: { id: 'user-1' } } : null,
    hasLocalToken: state.hasLocalToken,
    isPending: false,
    isRetrying: false,
    error: null,
  }),
}));
vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => ({
    activeOrganization: { slug: 'acme' },
    organizations: state.hasOrganizations ? [{ slug: 'acme' }] : [],
    organizationsLoading: false,
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
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
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

      const rootRoute = createRootRoute();
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

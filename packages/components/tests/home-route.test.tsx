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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeRoute } from '../src/routes/index';

const state = vi.hoisted(() => ({
  local: false,
  hasLocalToken: true,
  preferredSlug: 'acme' as string | null,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/desktop-window', () => ({ isWarmWindow: () => false }));
vi.mock('@/lib/app-platform', () => ({ isLocalAppPlatform: () => state.local }));
vi.mock('@/lib/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/workspace')>()),
  readPreferredWorkspaceSlug: () => state.preferredSlug,
}));
vi.mock('@/hooks/useStableSession', () => ({
  useStableSession: () => ({
    data: { user: { id: 'user-1' } },
    hasLocalToken: state.hasLocalToken,
    isPending: false,
    isRetrying: false,
    error: null,
  }),
}));
vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => ({
    activeOrganization: { slug: 'acme' },
    organizations: [{ slug: 'acme' }],
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

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  localStorage.clear();
  sessionStorage.clear();
});

describe('default app entry', () => {
  it.each([
    ['cached workspace', false, true, 'acme', '/acme/chat'],
    ['resolved workspace with local token', false, true, null, '/acme/chat'],
    ['resolved authenticated workspace', false, false, null, '/acme/chat'],
    ['local workspace', true, false, null, '/local/chat'],
  ] as const)(
    'opens chat landing for %s despite a legacy session route',
    async (_label, local, hasLocalToken, preferredSlug, expected) => {
      Object.assign(state, { local, hasLocalToken, preferredSlug });
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
        component: () => <div>Chat landing</div>,
      });
      const sessionRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/$workspaceName/sessions/$sessionId',
        component: () => <div>Previous session</div>,
      });
      const router = createRouter({
        routeTree: rootRoute.addChildren([indexRoute, chatRoute, sessionRoute]),
        history: createMemoryHistory({ initialEntries: ['/'] }),
      });
      await router.load();
      const container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
      await act(async () => root!.render(<RouterProvider router={router} />));

      expect(router.state.location.pathname).toBe(expected);
      expect(container.textContent).toBe('Chat landing');
    }
  );
});

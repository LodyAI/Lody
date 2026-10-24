// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { createStore, Provider, useAtomValue } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  settingsActiveTabAtom,
  settingsDialogOpenAtom,
  settingsSelectedMachineIdAtom,
  settingsSelectedProjectKeyAtom,
} from '@/atoms';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/lib/native-platform', () => ({ isNativeAppShell: () => false }));
// The file route is mounted under a hand-built tree below; only its params accessor is needed.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    createFileRoute: () => (options: object) => ({
      ...options,
      useParams: () => ({ workspaceName: 'acme' }),
    }),
  };
});

const { SettingsLayoutComponent } = await import('../src/routes/$workspaceName/_auth/settings');

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom does not implement scrolling; the router restores scroll after navigation.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Stands in for the desktop settings modal: it mounts the active tab once the dialog
 * opens and records the URL that tab observes on mount, as the billing tab does when
 * it parses Stripe's `?checkout=success` return marker.
 */
function SettingsModalProbe({ observedUrls }: { observedUrls: string[] }) {
  const open = useAtomValue(settingsDialogOpenAtom);
  const tab = useAtomValue(settingsActiveTabAtom);
  return open ? <TabProbe key={tab} observedUrls={observedUrls} /> : null;
}

function TabProbe({ observedUrls }: { observedUrls: string[] }) {
  useEffect(() => {
    observedUrls.push(`${window.location.pathname}${window.location.search}`);
  }, [observedUrls]);
  return null;
}

async function renderAt(url: string) {
  window.history.replaceState(null, '', url);
  const observedUrls: string[] = [];
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <SettingsModalProbe observedUrls={observedUrls} />
        <Outlet />
      </>
    ),
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/$workspaceName/settings',
    component: SettingsLayoutComponent,
  });
  const settingsChildren = ['/billing', '/machines'].map((path) =>
    createRoute({ getParentRoute: () => settingsRoute, path, component: () => null })
  );
  const workspaceRoutes = ['/$workspaceName/chat', '/$workspaceName/sessions/$sessionId'].map(
    (path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null })
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      settingsRoute.addChildren(settingsChildren),
      ...workspaceRoutes,
    ]),
    history: createBrowserHistory(),
  });
  const store = createStore();
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <Provider store={store}>
        <RouterProvider router={router} />
      </Provider>
    );
  });
  await act(async () => {
    await router.latestLoadPromise;
  });
  return { store, observedUrls };
}

describe('desktop settings route', () => {
  it('opens a checkout return on the billing tab with its return marker intact', async () => {
    const { store, observedUrls } = await renderAt(
      '/acme/settings/billing?checkout=success&session_id=cs_test_1'
    );

    expect(window.location.pathname).toBe('/acme/chat');
    expect(store.get(settingsDialogOpenAtom)).toBe(true);
    expect(store.get(settingsActiveTabAtom)).toBe('billing');
    expect(observedUrls).toEqual(['/acme/settings/billing?checkout=success&session_id=cs_test_1']);
  });

  it('keeps the URL tab and resource target while returning to the opening page', async () => {
    const { store } = await renderAt(
      `/acme/settings/machines?machine=machine-1&from=${encodeURIComponent('/acme/sessions/s-1')}`
    );

    expect(window.location.pathname).toBe('/acme/sessions/s-1');
    expect(store.get(settingsActiveTabAtom)).toBe('machines');
    expect(store.get(settingsSelectedMachineIdAtom)).toBe('machine-1');
    expect(store.get(settingsSelectedProjectKeyAtom)).toBeNull();
  });

  it('opens the settings list on the default tab', async () => {
    const { store } = await renderAt('/acme/settings');

    expect(window.location.pathname).toBe('/acme/chat');
    expect(store.get(settingsDialogOpenAtom)).toBe(true);
    expect(store.get(settingsActiveTabAtom)).toBe('account');
  });
});

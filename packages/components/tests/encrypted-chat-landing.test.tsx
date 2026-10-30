// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'jotai';
import {
  createRouter,
  createRootRoute,
  createRoute,
  createMemoryHistory,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { createStaticStore, type CloudApi, type PlatformProvider } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TEST_CLOUD_PLATFORM } from './test-platform';
import {
  createTourStore,
  DEFAULT_TOUR_IDENTITY,
  TOUR_USER_ID,
  TOUR_WORKSPACE_ID,
  TOUR_WORKSPACE_SLUG,
  buildTourStableSession,
} from '../src/components/onboarding/tour/tour-fixtures';
import { runtimeAtom } from '../src/atoms/runtime';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import { AuthenticatedConvexContext } from '../src/hooks/use-authenticated-convex';
import { StableSessionContext } from '../src/hooks/useStableSession';
import { initI18n } from '../src/i18n';

vi.hoisted(() => {
  document.queryCommandSupported = () => false;
});
vi.mock('../src/hooks/useOrganization', () => ({
  useOrganization: () => ({
    activeOrganization: { id: 'onboarding-tour-workspace', slug: 'onboarding-tour', members: [] },
    organizations: [],
    switchOrganization: async () => {},
  }),
}));
vi.mock('../src/providers/convex-provider', async (original) => ({
  ...(await original<object>()),
  useAuthClient: () => ({ useActiveOrganization: () => ({ data: null }) }),
}));
vi.mock('../src/components/chat/chat-landing-view', () => ({
  ChatLandingView: () => <textarea aria-label="New chat" />,
}));
import { ChatLanding } from '../src/components/chat/chat-landing';

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await initI18n('en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('renders the real encrypted chat controller without legacy machines, projects, inbox or GitHub queries', async () => {
  const store = createTourStore(DEFAULT_TOUR_IDENTITY);
  store.set(runtimeAtom, {
    ...store.get(runtimeAtom)!,
    contentMode: 'e2ee',
    accountId: TOUR_USER_ID,
    setEagerSyncVisibleSessionIds: () => {},
    clearEagerSyncVisibleSessionIds: () => {},
  });
  store.set(workspaceContentModeAtom, {
    accountId: TOUR_USER_ID,
    workspaceSlug: TOUR_WORKSPACE_SLUG,
    workspaceId: TOUR_WORKSPACE_ID,
    descriptor: {
      workspaceId: TOUR_WORKSPACE_ID,
      contentMode: 'e2ee',
      activation: 'control-only',
      contentModeVersion: 1,
      genesisHash: 'ab'.repeat(32),
      cryptoOrgId: 'ab'.repeat(32),
    },
  });
  const refused: string[] = [];
  const useQuery: CloudApi['useQuery'] = (operation, args) => {
    if (args !== 'skip' && /^(machines:|localProjects:|inbox:|github:)/.test(operation.name)) {
      refused.push(operation.name);
      throw Object.assign(new Error('e2ee_control_only'), { data: { code: 'e2ee_control_only' } });
    }
    return undefined;
  };
  const platform: PlatformProvider = {
    ...TEST_CLOUD_PLATFORM,
    identity: {
      ...TEST_CLOUD_PLATFORM.identity,
      session: createStaticStore({ status: 'authenticated', user: { id: TOUR_USER_ID } }),
    },
    cloudApi: {
      useQuery,
      useMutation: () => async () => {
        throw new Error('Unexpected cloud write');
      },
      useAction: () => async () => {
        throw new Error('Unexpected cloud action');
      },
    },
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/chat'] }),
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/chat',
        component: () => <ChatLanding workspaceSlug={TOUR_WORKSPACE_SLUG} />,
      }),
    ]),
  });
  await act(async () => {
    await router.load();
    root.render(
      <PlatformContext.Provider value={platform}>
        <Provider store={store}>
          <StableSessionContext.Provider
            value={buildTourStableSession(DEFAULT_TOUR_IDENTITY) as never}
          >
            <AuthenticatedConvexContext.Provider
              value={{ isAuthenticated: true, isLoading: false } as never}
            >
              <RouterProvider router={router} />
            </AuthenticatedConvexContext.Provider>
          </StableSessionContext.Provider>
        </Provider>
      </PlatformContext.Provider>
    );
  });
  expect(refused).toEqual([]);
  expect(container.querySelector('textarea[aria-label="New chat"]')).not.toBeNull();
});

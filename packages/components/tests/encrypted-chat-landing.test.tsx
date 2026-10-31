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
import { sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import { LoroRepo } from 'loro-repo';
import {
  getSessionRoomId,
  readSessionOperationTargets,
  isLoroRepoDocDeleted,
  type SessionMeta,
  type SessionId,
} from '@lody/shared';
import { createDirectWorkspaceWriter } from '../src/providers/workspace-writer-impl';
import type { MobileHomeScreenProps } from '../src/components/mobile/mobile-home-screen';
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
const mobile = vi.hoisted(() => ({ enabled: false }));
vi.mock('../src/hooks/use-mobile', async (original) => ({
  ...(await original<object>()),
  useIsMobile: () => mobile.enabled,
}));
vi.mock('../src/components/mobile/mobile-home-screen', () => ({
  MobileHomeScreen: (props: MobileHomeScreenProps) => (
    <>
      <output>{JSON.stringify(props.chats.map((chat) => chat.id))}</output>
      <button onClick={props.onShowArchivedToggle}>Show archive</button>
      <button onClick={() => props.onChatArchive?.('private-history')}>Archive history</button>
      <button onClick={() => props.onChatRestore?.('private-history')}>Restore history</button>
      <button
        onClick={() => {
          void props.onChatPermanentDelete?.(['private-history']);
        }}
      >
        Delete history
      </button>
      <button onClick={() => props.onChatTogglePin?.('private-history', true)}>Pin history</button>
    </>
  ),
}));
import { ChatLanding } from '../src/components/chat/chat-landing';
import { ArchiveView } from '../src/components/archive/archive-view';
import { archiveScopeAtom } from '../src/atoms/sidebar-state';

const previousScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  mobile.enabled = false;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await initI18n('en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (previousScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', previousScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
});

async function renderLanding(
  configure?: (store: ReturnType<typeof createTourStore>) => void,
  surface: 'chat' | 'archive' = 'chat'
) {
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
  configure?.(store);
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
        component: () =>
          surface === 'archive' ? (
            <ArchiveView />
          ) : (
            <ChatLanding workspaceSlug={TOUR_WORKSPACE_SLUG} />
          ),
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
  return { store, refused };
}

it('renders the real encrypted chat controller without legacy machines, projects, inbox or GitHub queries', async () => {
  const { refused } = await renderLanding();
  expect(refused).toEqual([]);
  expect(container.querySelector('textarea[aria-label="New chat"]')).not.toBeNull();
});

// Derived from the independent review probe; only the mobile view leaf is replaced.
// The controller, action hook, writer, target discovery and LoroRepo are real.
it.each(['Archive', 'Restore', 'Delete', 'Pin'])(
  'mobile %s cannot manage another member’s unshared history or its child',
  async (operation) => {
    mobile.enabled = true;
    const repo = await LoroRepo.create({});
    const id = 'private-history' as SessionId;
    const meta = {
      id,
      machineId: 'unshared-owner-machine',
      userId: 'different-owner',
      title: 'Synthetic history',
      isArchived: operation === 'Restore' || operation === 'Delete',
      cliType: 'builtin',
      agentType: 'codex',
      createdAt: '2026-10-01T00:00:00Z',
    } as SessionMeta;
    const child = { ...meta, id: 'history-child' as SessionId, parentSessionId: id };
    await repo.upsertDocMeta(getSessionRoomId(id), meta);
    await repo.upsertDocMeta(getSessionRoomId(child.id), child);
    try {
      const { refused } = await renderLanding((store) => {
        store.set(sessionMetaCacheAtom, {
          [getSessionRoomId(id)]: meta,
          [getSessionRoomId(child.id)]: child,
        });
        store.set(runtimeAtom, {
          ...store.get(runtimeAtom)!,
          repo,
          writer: createDirectWorkspaceWriter({ repo } as never),
          releaseSessionStore: async () => {},
          readSessionOperationTargets: (target, kind) =>
            readSessionOperationTargets(repo, target, kind),
        });
      });
      expect(refused).toEqual([]);
      if (operation === 'Restore' || operation === 'Delete')
        await act(async () =>
          [...container.querySelectorAll('button')]
            .find((button) => button.textContent === 'Show archive')!
            .click()
        );
      expect(container.querySelector('output')?.textContent).toContain(id);
      await act(async () =>
        [...container.querySelectorAll('button')]
          .find((button) => button.textContent === `${operation} history`)!
          .click()
      );
      for (const original of [meta, child]) {
        const entry = await repo.getDocMeta(getSessionRoomId(original.id));
        expect.soft(isLoroRepoDocDeleted(entry)).toBe(false);
        expect.soft(entry?.meta).toEqual(original);
      }
    } finally {
      await repo.destroy();
    }
  }
);

it('desktop archive leaves history-only sessions and children intact when permanent delete is invoked', async () => {
  const repo = await LoroRepo.create({});
  const meta = {
    id: 'archived-private' as SessionId,
    machineId: 'unshared-owner-machine',
    userId: 'different-owner',
    title: 'Synthetic archived history',
    isArchived: true,
    cliType: 'builtin',
    agentType: 'codex',
    createdAt: '2026-10-01T00:00:00Z',
  } as SessionMeta;
  const child = { ...meta, id: 'archived-child' as SessionId, parentSessionId: meta.id };
  for (const entry of [meta, child]) await repo.upsertDocMeta(getSessionRoomId(entry.id), entry);
  try {
    await renderLanding((store) => {
      store.set(archiveScopeAtom, 'team');
      store.set(sessionMetaCacheAtom, {
        [getSessionRoomId(meta.id)]: meta,
        [getSessionRoomId(child.id)]: child,
      });
      store.set(runtimeAtom, {
        ...store.get(runtimeAtom)!,
        repo,
        writer: createDirectWorkspaceWriter({ repo } as never),
        releaseSessionStore: async () => {},
        readSessionOperationTargets: (target, kind) =>
          readSessionOperationTargets(repo, target, kind),
      });
    }, 'archive');
    expect(container.textContent).toContain('Synthetic archived history');
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete permanently"]'
    );
    expect(remove).not.toBeNull();
    await act(async () => remove!.click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    for (const original of [meta, child])
      expect((await repo.getDocMeta(getSessionRoomId(original.id)))?.meta).toEqual(original);
  } finally {
    await repo.destroy();
  }
});

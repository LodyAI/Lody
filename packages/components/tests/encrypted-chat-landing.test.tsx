// @vitest-environment jsdom
import { useVisibleSessionMetas } from '../src/hooks/use-visible-session-metas';
import { act, type ReactNode } from 'react';
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
  TOUR_AGENT_CONFIG_ID,
  TOUR_MACHINE_ID,
  buildTourMachine,
} from '../src/components/onboarding/tour/tour-fixtures';
import { runtimeAtom } from '../src/atoms/runtime';
import {
  docMetaCacheScopeAtom,
  machineMetaCacheAtom,
  sessionMetaCacheAtom,
} from '../src/atoms/doc-meta';
import { LoroRepo } from 'loro-repo';
import {
  getMachineRoomId,
  getSessionRoomId,
  readSessionOperationTargets,
  isLoroRepoDocDeleted,
  type SessionMeta,
  type SessionId,
} from '@lody/shared';
import { createDirectWorkspaceWriter } from '../src/providers/workspace-writer-impl';
import type { MobileHomeScreenProps } from '../src/components/mobile/mobile-home-screen';
import type { ChatLandingViewProps } from '../src/components/chat/chat-landing-view';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import { AuthenticatedConvexContext } from '../src/hooks/use-authenticated-convex';
import { StableSessionContext } from '../src/hooks/useStableSession';
import { initI18n } from '../src/i18n';
import {
  buildChatLandingDraftKey,
  buildChatLandingSurfaceDraftKey,
  chatLandingDraftSessionIdAtomFamily,
  chatLandingPendingFilesAtomFamily,
  chatLandingPendingImagesAtomFamily,
} from '../src/atoms/chat-landing-draft';
import { chatLandingSessionStateAtomFamily } from '../src/atoms/local-storage-cache';
import { createSessionSendResources } from '../src/lib/session-send-resources';
import { writeChatLandingDefaults } from '../src/lib/chat-landing-defaults';
import type { WorkspaceWriter } from '../src/providers/workspace-writer';

vi.hoisted(() => {
  document.queryCommandSupported = () => false;
});
vi.mock('../src/hooks/useOrganization', () => ({
  useOrganization: () => ({
    activeOrganization: { id: 'onboarding-tour-workspace', slug: 'your-workspace', members: [] },
    organizations: [
      { id: 'onboarding-tour-workspace', slug: 'your-workspace', name: 'Synthetic workspace' },
    ],
    switchOrganization: async () => {},
  }),
}));
vi.mock('../src/providers/convex-provider', async (original) => ({
  ...(await original<object>()),
  useAuthClient: () => ({ useActiveOrganization: () => ({ data: null }) }),
}));
// The view leaf is replaced by its controlled contract: the prompt, submit and Cancel.
vi.mock('../src/components/chat/chat-landing-view', () => ({
  ChatLandingView: (props: ChatLandingViewProps) => (
    <div data-layout={props.layout ?? 'page'}>
      <textarea
        aria-label="New chat"
        id={props.promptId}
        value={props.submissionPending ? '' : props.promptValue}
        onChange={(event) => props.onPromptChange(event.target.value)}
      />
      <button
        type="button"
        data-testid="composer-send"
        disabled={props.submitDisabled}
        onClick={props.onSubmit}
      >
        {props.submitLabel}
      </button>
      {props.onCancel ? (
        <button
          type="button"
          data-testid="composer-cancel"
          disabled={props.submissionPending}
          onClick={props.onCancel}
        >
          {props.cancelLabel}
        </button>
      ) : null}
      <p data-composer-status>{props.composerStatusMessage}</p>
    </div>
  ),
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
import { TodayConvertDialog } from '../src/components/today/today-convert-dialog';
import { ArchiveView } from '../src/components/archive/archive-view';
import { LoroAppSidebar } from '../src/components/loro-app-sidebar';
import { chatScopeAtom, archiveScopeAtom } from '../src/atoms/sidebar-state';

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

function SidebarReadAccessProbe() {
  const access = useVisibleSessionMetas();
  return <output data-read-only-ids>{JSON.stringify([...access.historyOnlySessionIds])}</output>;
}

async function renderLanding(
  configure?: (store: ReturnType<typeof createTourStore>) => void,
  surface: 'chat' | 'archive' | 'sidebar' = 'chat',
  landing: ReactNode = <ChatLanding workspaceSlug={TOUR_WORKSPACE_SLUG} />
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
  if (surface === 'sidebar')
    store.set(docMetaCacheScopeAtom, {
      runtime: store.get(runtimeAtom)!,
      workspaceId: TOUR_WORKSPACE_ID,
      workspaceSlug: TOUR_WORKSPACE_SLUG,
      ready: true,
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
    sessionAccess: {
      list: async () => [
        {
          machineId: 'unshared-owner-machine',
          canManage: false,
          readSharedSessionIds: ['private-history', 'archived-private'],
        },
      ],
      read: async (_workspace, machineId) => ({
        machineId,
        canManage: false,
        readSharedSessionIds: ['private-history', 'archived-private'],
      }),
      set: async () => {
        throw new Error('not-owner');
      },
      subscribe: () => () => {},
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
          surface === 'sidebar' ? (
            <>
              <SidebarReadAccessProbe />
              <LoroAppSidebar />
            </>
          ) : surface === 'archive' ? (
            <ArchiveView />
          ) : (
            landing
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
  return { store, refused, router };
}

it('renders the real encrypted chat controller without legacy machines, projects, inbox or GitHub queries', async () => {
  const { refused } = await renderLanding();
  expect(refused).toEqual([]);
  expect(container.querySelector('textarea[aria-label="New chat"]')).not.toBeNull();
});

// Derived from the independent review probe; only the mobile view leaf is replaced.
// The controller, action hook, writer, target discovery and LoroRepo are real.
it.each(['Archive', 'Restore', 'Delete', 'Pin'])(
  'mobile %s applies only permitted read preferences to shared history',
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
        expect.soft(entry?.meta).toEqual(
          operation === 'Pin' && original.id === id
            ? // Pinning also records the pin position (specs/pinned-session-sections.md).
              { ...original, isPinned: true, orderKey: expect.stringMatching(/^[0-9A-F]+$/) }
            : original
        );
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

it('desktop sidebar read-only pin and unread actions reach the checked preference writer', async () => {
  const repo = await LoroRepo.create({});
  const id = 'private-history' as SessionId;
  const meta = {
    id,
    machineId: 'unshared-owner-machine',
    userId: 'different-owner',
    title: 'Shared sidebar history',
    lastMessageAt: 100,
    lastReadAt: 100,
    cliType: 'builtin',
    agentType: 'codex',
    createdAt: '2026-10-01T00:00:00Z',
  } as SessionMeta;
  await repo.upsertDocMeta(getSessionRoomId(id), meta);
  const writer = createDirectWorkspaceWriter({ repo } as never);
  try {
    await renderLanding((store) => {
      store.set(chatScopeAtom, 'team');
      store.set(sessionMetaCacheAtom, { [getSessionRoomId(id)]: meta });
      store.set(runtimeAtom, {
        ...store.get(runtimeAtom)!,
        repo,
        writer,
        releaseSessionStore: async () => {},
        readSessionOperationTargets: (target, kind) =>
          readSessionOperationTargets(repo, target, kind),
      });
    }, 'sidebar');
    expect(container.querySelector('[data-read-only-ids]')?.textContent).toContain(id);
    for (const label of ['Pin Session', 'Mark as unread']) {
      const row = container.querySelector(
        '[data-sidebar-session-id="private-history"], [data-sidebar-updated-id="private-history"]'
      );
      expect(row).not.toBeNull();
      await act(async () =>
        row!.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 10,
            clientY: 10,
          })
        )
      );
      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      expect(items.some((item) => /Rename|Archive|Delete/.test(item.textContent ?? ''))).toBe(
        false
      );
      const action = items.find((item) => item.textContent === label);
      expect(action).toBeDefined();
      await act(async () => action!.click());
    }
    expect((await repo.getDocMeta(getSessionRoomId(id)))?.meta).toMatchObject({
      title: meta.title,
      isPinned: true,
      lastReadAt: 99,
    });
  } finally {
    await repo.destroy();
  }
});

const PAGE_DRAFT_KEY = buildChatLandingDraftKey(TOUR_USER_ID, TOUR_WORKSPACE_SLUG);
const SURFACE_DRAFT_KEY = buildChatLandingSurfaceDraftKey(
  TOUR_USER_ID,
  'today-convert',
  TOUR_WORKSPACE_SLUG
);
const RESERVED_ID = 'today-convert-reserved' as SessionId;

/**
 * The real controller embedded as Today's "Convert to task" landing, over the
 * encrypted runtime above, whose writer is real except for `appendSessionTurn`,
 * which the test makes accept or reject.
 */
async function renderEmbeddedLanding(
  appendSessionTurn: WorkspaceWriter['appendSessionTurn'],
  seed?: (store: ReturnType<typeof createTourStore>) => void,
  host?: (accepted: SessionId[]) => ReactNode
) {
  const repo = await LoroRepo.create({});
  const accepted: SessionId[] = [];
  const pending: boolean[] = [];
  const rendered = await renderLanding(
    (store) => {
      store.set(runtimeAtom, {
        ...store.get(runtimeAtom)!,
        repo,
        writer: { ...createDirectWorkspaceWriter({ repo } as never), appendSessionTurn },
        sendResources: createSessionSendResources({
          acquire: async () => ({ getState: () => ({}), setState: () => {} }) as never,
          releaseRef: () => {},
        }),
        ensureDocStream: async () => {},
        requestSessionDispatchTurn: async () => {},
        // The owner machine's signed intent, which an encrypted first turn carries.
        prepareEncryptedDispatch: async () => ({ original: { e2eeIntent: 'signed-intent' } }),
      } as never);
      store.set(chatLandingSessionStateAtomFamily(PAGE_DRAFT_KEY), {
        prompt: 'page draft stays',
        pastedTextDrafts: [],
        mentionRanges: [],
      });
      store.set(chatLandingDraftSessionIdAtomFamily(PAGE_DRAFT_KEY), 'page-reserved' as SessionId);
      store.set(chatLandingSessionStateAtomFamily(SURFACE_DRAFT_KEY), {
        prompt: 'Ship the outline',
        pastedTextDrafts: [],
        mentionRanges: [],
      });
      store.set(chatLandingDraftSessionIdAtomFamily(SURFACE_DRAFT_KEY), RESERVED_ID);
      // The user's own machine, so the encrypted index lists it.
      store.set(machineMetaCacheAtom, {
        [getMachineRoomId(TOUR_MACHINE_ID)]: {
          ...buildTourMachine(DEFAULT_TOUR_IDENTITY),
          ownerUserId: TOUR_USER_ID,
        },
      });
      // The dialog starts from the page's last new-chat choice.
      writeChatLandingDefaults(TOUR_WORKSPACE_ID, {
        contextType: 'chat',
        agentId: TOUR_AGENT_CONFIG_ID,
        machineId: TOUR_MACHINE_ID,
      });
      seed?.(store);
    },
    'chat',
    host?.(accepted) ?? (
      <ChatLanding
        workspaceSlug={TOUR_WORKSPACE_SLUG}
        embedding={{
          surface: 'today-convert',
          onSessionAccepted: ({ sessionId }) => accepted.push(sessionId),
          onPendingChange: (next) => pending.push(next),
        }}
      />
    )
  );
  const send = async () => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
  };
  const expectPageDraftUntouched = () => {
    expect(rendered.store.get(chatLandingSessionStateAtomFamily(PAGE_DRAFT_KEY)).prompt).toBe(
      'page draft stays'
    );
    expect(rendered.store.get(chatLandingDraftSessionIdAtomFamily(PAGE_DRAFT_KEY))).toBe(
      'page-reserved'
    );
  };
  return { ...rendered, repo, accepted, pending, send, expectPageDraftUntouched };
}

it('an embedded landing hands the accepted session to its host instead of navigating', async () => {
  const turns: SessionId[] = [];
  const landing = await renderEmbeddedLanding(async (sessionId) => {
    turns.push(sessionId as SessionId);
  });
  try {
    const prompt = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="New chat"]')!;
    expect(prompt.closest('[data-layout]')?.getAttribute('data-layout')).toBe('dialog');
    expect(prompt.id).toBe('today-convert-prompt');
    expect(prompt.value).toBe('Ship the outline');

    await landing.send();
    expect(container.querySelector('[data-composer-status]')?.textContent).toBe('');

    expect(landing.accepted).toEqual([RESERVED_ID]);
    expect(turns).toEqual([RESERVED_ID]);
    expect((await landing.repo.getDocMeta(getSessionRoomId(RESERVED_ID)))?.meta).toMatchObject({
      id: RESERVED_ID,
      title: 'Ship the outline',
    });
    expect(landing.router.state.location.pathname).toBe('/chat');
    expect(landing.pending).toContain(true);
    expect(landing.pending.at(-1)).toBe(false);
    expect(landing.store.get(chatLandingSessionStateAtomFamily(SURFACE_DRAFT_KEY)).prompt).toBe('');
    landing.expectPageDraftUntouched();
  } finally {
    await landing.repo.destroy();
  }
});

it('the Convert-to-task dialog includes parent nodes by default and switches them while the prompt is unedited', async () => {
  const landing = await renderEmbeddedLanding(
    async () => {},
    undefined,
    () => (
      <TodayConvertDialog
        open
        prompt={'Write the guide'}
        promptWithAncestors={'- Launch\n  - Write the guide'}
        onAccepted={() => {}}
        onOpenChange={() => {}}
      />
    )
  );
  try {
    const dialog = document.querySelector('[data-testid="today-convert-dialog"]')!;
    const prompt = () => dialog.querySelector<HTMLTextAreaElement>('#today-convert-prompt')!.value;
    const box = () =>
      dialog.querySelector<HTMLElement>(
        '[data-testid="today-convert-ancestors"] [role="checkbox"]'
      )!;
    expect(prompt()).toBe('- Launch\n  - Write the guide');
    expect(box().getAttribute('aria-checked')).toBe('true');
    await act(async () => box().click());
    expect(prompt()).toBe('Write the guide');
    expect(box().getAttribute('aria-checked')).toBe('false');
    await act(async () => box().click());
    expect(prompt()).toBe('- Launch\n  - Write the guide');
    await act(async () => {
      landing.store.set(chatLandingSessionStateAtomFamily(SURFACE_DRAFT_KEY), (previous) => ({
        ...previous,
        prompt: 'my own words',
      }));
    });
    expect(box().hasAttribute('data-disabled')).toBe(true);
    expect(dialog.textContent).toContain('Prompt edited');
  } finally {
    await landing.repo.destroy();
  }
});

it('a rejected embedded start keeps the dialog draft and reports nothing to the host', async () => {
  const attempts: SessionId[] = [];
  const landing = await renderEmbeddedLanding(async (sessionId) => {
    attempts.push(sessionId as SessionId);
    throw new Error('Workspace storage unavailable');
  });
  try {
    await landing.send();

    expect(attempts).toEqual([RESERVED_ID]);
    expect(landing.accepted).toEqual([]);
    const prompt = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="New chat"]')!;
    expect(prompt.value).toBe('Ship the outline');
    expect(landing.store.get(chatLandingDraftSessionIdAtomFamily(SURFACE_DRAFT_KEY))).toBe(
      RESERVED_ID
    );
    expect(landing.router.state.location.pathname).toBe('/chat');
    landing.expectPageDraftUntouched();
  } finally {
    await landing.repo.destroy();
  }
});

it('unmounting an embedded landing releases its attachments and draft, not the page draft', async () => {
  const revoked: string[] = [];
  const previousRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  const imageUpload = new AbortController();
  const fileUpload = new AbortController();
  const landing = await renderEmbeddedLanding(
    async () => {},
    (store) => {
      store.set(chatLandingPendingImagesAtomFamily(SURFACE_DRAFT_KEY), [
        {
          localId: 'image-1',
          previewUrl: 'blob:today-convert/1',
          file: new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' }),
          status: 'uploading',
          progress: 0.5,
          abort: imageUpload,
        },
      ]);
      store.set(chatLandingPendingFilesAtomFamily(SURFACE_DRAFT_KEY), [
        {
          localId: 'file-1',
          file: new File([new Uint8Array([2])], 'notes.txt', { type: 'text/plain' }),
          status: 'uploading',
          progress: 0.5,
          abort: fileUpload,
        },
      ]);
    }
  );
  try {
    await act(async () => root.unmount());
    root = createRoot(container);

    expect(revoked).toEqual(['blob:today-convert/1']);
    expect(imageUpload.signal.aborted).toBe(true);
    expect(fileUpload.signal.aborted).toBe(true);
    expect(landing.store.get(chatLandingPendingImagesAtomFamily(SURFACE_DRAFT_KEY))).toEqual([]);
    expect(landing.store.get(chatLandingPendingFilesAtomFamily(SURFACE_DRAFT_KEY))).toEqual([]);
    expect(landing.store.get(chatLandingDraftSessionIdAtomFamily(SURFACE_DRAFT_KEY))).toBeNull();
    expect(landing.store.get(chatLandingSessionStateAtomFamily(SURFACE_DRAFT_KEY)).prompt).toBe('');
    landing.expectPageDraftUntouched();
  } finally {
    URL.revokeObjectURL = previousRevoke;
    await landing.repo.destroy();
  }
});

it('the Convert-to-task dialog seeds its draft, holds while sending and closes on acceptance', async () => {
  let releaseWrite!: () => void;
  const written: SessionId[] = [];
  const openChanges: boolean[] = [];
  const landing = await renderEmbeddedLanding(
    async (sessionId) => {
      written.push(sessionId as SessionId);
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
    },
    undefined,
    (accepted) => (
      <TodayConvertDialog
        open
        prompt={'Plan the launch\n  Draft the notes'}
        onAccepted={(sessionId) => accepted.push(sessionId)}
        onOpenChange={(open) => openChanges.push(open)}
      />
    )
  );
  const escape = async (isComposing: boolean) => {
    await act(async () => {
      document
        .querySelector('#today-convert-prompt')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing }));
    });
  };
  try {
    const dialog = document.querySelector('[data-testid="today-convert-dialog"]')!;
    expect(dialog.textContent).toContain('Convert to task');
    const prompt = dialog.querySelector<HTMLTextAreaElement>('#today-convert-prompt')!;
    // The node's text replaces whatever the dialog last held; the page draft is not it.
    expect(prompt.value).toBe('Plan the launch\n  Draft the notes');

    // The dialog names its action and offers Cancel beside it.
    const cancel = dialog.querySelector<HTMLButtonElement>('[data-testid="composer-cancel"]')!;
    expect(dialog.querySelector('[data-testid="composer-send"]')?.textContent).toBe('Start task');

    await escape(true);
    expect(openChanges).toEqual([]);
    await escape(false);
    expect(openChanges).toEqual([false]);
    openChanges.length = 0;
    await act(async () => cancel.click());
    expect(openChanges).toEqual([false]);
    openChanges.length = 0;

    await landing.send();
    expect(written).toHaveLength(1);
    await escape(false);
    expect(cancel.disabled).toBe(true);
    // Even a Cancel that reaches the host mid-send cannot release the draft.
    await act(async () => cancel.click());
    expect(openChanges).toEqual([]);

    await act(async () => releaseWrite());
    expect(landing.accepted).toEqual(written);
    expect(openChanges).toEqual([false]);
    expect(landing.router.state.location.pathname).toBe('/chat');
    landing.expectPageDraftUntouched();
  } finally {
    await landing.repo.destroy();
  }
});

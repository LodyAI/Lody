import { describe, expect, it } from 'vitest';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';

import {
  buildChatLandingPreSelectionKey,
  getChatLandingSelectionSearch,
  getSelectedLocalProjectKey,
  parseChatLandingSearch,
  type ChatLandingEffectiveSelection,
  type ChatLandingSearch,
} from '../src/components/chat/chat-landing-derived';

const WORKSPACE = 'acme';

/**
 * Headless router over the real chat-route search contract
 * (`parseChatLandingSearch`), driving the same navigations the app wires
 * together: sidebar project-row clicks push ordinary pre-selection intents,
 * and the landing's selection mirror replaces the URL with
 * `getChatLandingSelectionSearch` output when the composer steers away — so
 * these tests pin the push/replace/Back semantics of that loop.
 */
function createChatRouter() {
  const rootRoute = createRootRoute();
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '$workspaceName',
  });
  const chatRoute = createRoute({
    getParentRoute: () => workspaceRoute,
    path: 'chat',
    validateSearch: parseChatLandingSearch,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([workspaceRoute.addChildren([chatRoute])]),
    history: createMemoryHistory({ initialEntries: [`/${WORKSPACE}/chat`] }),
  });
}

type ChatRouter = ReturnType<typeof createChatRouter>;

/** Mirrors `LoroAppSidebar`'s `handleNavigateToProject` wiring. */
async function activateProjectRow(router: ChatRouter, machineId: string, localProjectId: string) {
  await router.navigate({
    to: '/$workspaceName/chat',
    params: { workspaceName: WORKSPACE },
    search: { context: 'local' as const, machine: machineId, project: localProjectId },
  });
}

/** Mirrors `ChatRoute`'s `onSelectionUrlSync` handler fed by the landing. */
async function syncComposerSelection(router: ChatRouter, selection: ChatLandingEffectiveSelection) {
  await router.navigate({
    to: '/$workspaceName/chat',
    params: { workspaceName: WORKSPACE },
    search: getChatLandingSelectionSearch(selection),
    replace: true,
  });
}

function currentChatSearch(router: ChatRouter): ChatLandingSearch {
  return parseChatLandingSearch(router.state.location.search);
}

/** The chat search at the history's CURRENT entry, bypassing router load state. */
function historyChatSearch(router: ChatRouter): ChatLandingSearch {
  return parseChatLandingSearch(
    Object.fromEntries(new URLSearchParams(router.history.location.search))
  );
}

function preSelectionKeyOf(search: ChatLandingSearch): string {
  return buildChatLandingPreSelectionKey({
    context: search.context,
    machine: search.machine,
    project: search.project,
    repo: search.repo,
  });
}

describe('chat landing selection URL loop', () => {
  it('pushes a project-row click as a fresh pre-selection intent', async () => {
    const router = createChatRouter();
    await router.load();
    const plainKey = preSelectionKeyOf(currentChatSearch(router));

    await activateProjectRow(router, 'machine-1', 'project-a');

    expect(router.history.length).toBe(2);
    const search = currentChatSearch(router);
    expect(search).toMatchObject({ context: 'local', machine: 'machine-1', project: 'project-a' });
    expect(preSelectionKeyOf(search)).not.toBe(plainKey);
  });

  it('treats re-activating the still-selected project as an identical-URL no-op', async () => {
    const router = createChatRouter();
    await router.load();
    await activateProjectRow(router, 'machine-1', 'project-a');

    await activateProjectRow(router, 'machine-1', 'project-a');

    expect(router.history.length).toBe(2);
    expect(currentChatSearch(router)).toMatchObject({ project: 'project-a' });
  });

  it('keeps the URL truthful when the composer steers away, so the row works again', async () => {
    const router = createChatRouter();
    await router.load();
    await activateProjectRow(router, 'machine-1', 'project-a');

    // The user picks "Only chats" in the composer; the mirror replaces in
    // place, so no history entry appears and the row highlight clears.
    await syncComposerSelection(router, {
      contextType: 'chat',
      machineId: null,
      localProjectId: null,
      repoFullName: null,
    });
    expect(router.history.length).toBe(2);
    expect(currentChatSearch(router)).toEqual({ context: 'chat' });
    expect(
      getSelectedLocalProjectKey(
        router.state.location.pathname,
        WORKSPACE,
        router.state.location.search
      )
    ).toBeNull();

    // Clicking the same project row is now an ordinary search change that the
    // pre-selection effect applies.
    const clearedKey = preSelectionKeyOf(currentChatSearch(router));
    await activateProjectRow(router, 'machine-1', 'project-a');
    expect(router.history.length).toBe(3);
    expect(preSelectionKeyOf(currentChatSearch(router))).not.toBe(clearedKey);

    // Back walks real states: the cleared selection, then the plain landing.
    router.history.back();
    expect(historyChatSearch(router)).toEqual({ context: 'chat' });
    router.history.back();
    expect(historyChatSearch(router)).toEqual({});
  });

  it('replaces an incomplete selection with a URL that names nothing', async () => {
    const router = createChatRouter();
    await router.load();
    await activateProjectRow(router, 'machine-1', 'project-a');

    // E.g. the project became unavailable and was cleared before any
    // replacement selection existed.
    await syncComposerSelection(router, {
      contextType: 'github',
      machineId: null,
      localProjectId: null,
      repoFullName: null,
    });

    expect(router.history.length).toBe(2);
    expect(currentChatSearch(router)).toEqual({});
  });
});

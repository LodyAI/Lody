import { describe, expect, it } from 'vitest';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';

import {
  buildChatLandingPreSelectionKey,
  buildChatLandingProjectSelectionNavigation,
  getSelectedLocalProjectKey,
  parseChatLandingSearch,
  type ChatLandingSearch,
} from '../src/components/chat/chat-landing-derived';

const WORKSPACE = 'acme';

/**
 * Headless router over the real chat-route search contract
 * (`parseChatLandingSearch`), so these tests exercise the same chain the app
 * wires together: project-row activation → URL search → validated route
 * search → composer pre-selection key — including real push/replace history
 * semantics.
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
    ...buildChatLandingProjectSelectionNavigation({
      machineId,
      localProjectId,
      selectedLocalProjectKey: getSelectedLocalProjectKey(
        router.state.location.pathname,
        WORKSPACE,
        router.state.location.search
      ),
    }),
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
    projectSelectionKey: search.projectSelection,
  });
}

describe('project-row activation history semantics', () => {
  it('pushes the first selection as a complete pre-selection intent', async () => {
    const router = createChatRouter();
    await router.load();
    expect(router.history.length).toBe(1);

    await activateProjectRow(router, 'machine-1', 'project-a');

    expect(router.history.length).toBe(2);
    const search = currentChatSearch(router);
    expect(search.context).toBe('local');
    expect(search.machine).toBe('machine-1');
    expect(search.project).toBe('project-a');
    expect(search.projectSelection).toBeTruthy();
  });

  it('re-activating the selected project refreshes the intent without stacking history', async () => {
    const router = createChatRouter();
    await router.load();
    await activateProjectRow(router, 'machine-1', 'project-a');
    const first = currentChatSearch(router);

    await activateProjectRow(router, 'machine-1', 'project-a');
    const second = currentChatSearch(router);

    // A fresh intent, so the landing re-applies the visible project…
    expect(second.projectSelection).toBeTruthy();
    expect(second.projectSelection).not.toBe(first.projectSelection);
    expect(preSelectionKeyOf(second)).not.toBe(preSelectionKeyOf(first));
    // …but in place: no second history entry for the same page.
    expect(router.history.length).toBe(2);

    // Back therefore leaves the project page instead of replaying older nonces.
    router.history.back();
    const afterBack = historyChatSearch(router);
    expect(afterBack.project).toBeUndefined();
    expect(afterBack.projectSelection).toBeUndefined();
  });

  it('switching projects pushes so Back returns to the previous project', async () => {
    const router = createChatRouter();
    await router.load();
    await activateProjectRow(router, 'machine-1', 'project-a');
    await activateProjectRow(router, 'machine-1', 'project-b');

    expect(router.history.length).toBe(3);
    expect(currentChatSearch(router).project).toBe('project-b');

    router.history.back();
    expect(historyChatSearch(router).project).toBe('project-a');
  });
});

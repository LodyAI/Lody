// @vitest-environment jsdom
import { Provider, createStore } from 'jotai';
import { developerModeEnabledAtom, promptShortcutsBetaEnabledAtom } from '../src/atoms/settings';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  projectShortcutIndex,
  type PromptShortcut,
  type PromptShortcutRuntime,
} from '@lody/shared/prompt-shortcuts';
import type { usePromptShortcuts } from '../src/providers/prompt-shortcut-provider';
import { PromptShortcutsSetting } from '../src/components/settings/prompt-shortcuts-setting';
import { TooltipProvider } from '../src/ui/tooltip';
import { initI18n } from '../src/i18n';

vi.mock('../src/providers/prompt-shortcut-provider', () => ({ usePromptShortcuts: () => state }));
vi.mock('@lody/platform/react', () => ({
  useCloudQuery: () => [],
  usePlatformCapability: () => false,
}));
vi.mock('../src/atoms/agents', async () => {
  const { atom } = await import('jotai');
  return { getAllAgentConfigAtom: atom([]) };
});
vi.mock('../src/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({ machines: new Map() }),
}));
vi.mock('../src/hooks/use-visible-local-projects', () => ({
  useVisibleLocalProjectsFromMachineIndex: () => ({ projects: new Map() }),
}));
vi.mock('../src/hooks/use-machine-flock-agent-configs', () => ({
  useMachineFlockAgentConfigsForMachineIds: () => {},
}));
vi.mock('../src/components/mentions/combined-mention-textarea', () => ({
  CombinedMentionTextarea: () => null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const shortcut: PromptShortcut = {
  v: 1,
  id: 'shortcut',
  workspaceId: 'ws',
  ownerUserId: 'alice',
  revision: 'r1',
  visibility: 'private',
  name: 'Private review',
  slug: 'review',
  prompt: 'Private content',
  scope: {},
  mentions: [],
  createdAt: 1,
  updatedAt: 1,
};
const sharedByOther: PromptShortcut = {
  ...shortcut,
  id: 'shared',
  ownerUserId: 'bob',
  visibility: 'workspace',
  name: 'Team review',
  slug: 'team-review',
  prompt: 'Shared content',
};
let state: ReturnType<typeof usePromptShortcuts>;
let root: Root, container: HTMLDivElement;
let store: ReturnType<typeof createStore>;
function runtime(workspaceId: string, userId: string, read = async () => shortcut) {
  return { workspaceId, userId, canShare: true, read } as unknown as PromptShortcutRuntime;
}
beforeEach(async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  // `useIsMobile` reads matchMedia; jsdom has none. Fixed desktop width, no listeners.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  localStorage.clear();
  store = createStore();
  store.set(developerModeEnabledAtom, true);
  store.set(promptShortcutsBetaEnabledAtom, true);
  await initI18n('en');
  state = {
    runtime: runtime('ws', 'alice'),
    entries: [projectShortcutIndex(shortcut, 'body')],
    pendingIds: [],
    errors: {},
    loading: false,
    retry: () => {},
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <Provider store={store}>
        <TooltipProvider>
          <PromptShortcutsSetting />
        </TooltipProvider>
      </Provider>
    )
  );
}
async function open(name: string) {
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes(name))!
      .click();
  });
}
describe('Prompt Shortcut settings identity fencing', () => {
  it('stays optimistic about publication and keeps the local actions', async () => {
    state = {
      ...state,
      pendingIds: [shortcut.id],
      errors: { [shortcut.id]: new Error('offline') },
    };
    await render();
    // A local save is already durable and the runtime retries on its own, so a
    // row says nothing about either; what must never happen is losing the
    // actions over a background upload.
    expect(container.textContent).not.toContain('Publishing');
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Delete shortcut"]')?.disabled
    ).toBe(false);
    await open('Private review');
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      false
    );
  });

  it('offers a first Shortcut when the catalog is empty', async () => {
    state = { ...state, entries: [] };
    await render();
    expect(container.textContent).toContain('No Prompt Shortcuts yet');
    const create = [...container.querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('New Prompt Shortcut')
    );
    expect(create.length).toBeGreaterThan(0);
    await act(async () => create.at(-1)!.click());
    expect(document.querySelector<HTMLInputElement>('#shortcut-name')?.value).toBe('');
  });

  it("shows another member's shared Shortcut read-only, with no delete action", async () => {
    state = {
      ...state,
      runtime: runtime('ws', 'alice', async () => sharedByOther),
      entries: [projectShortcutIndex(sharedByOther, 'body-shared')],
    };
    await render();
    expect(container.querySelector('button[aria-label="Delete shortcut"]')).toBeNull();
    await open('Team review');
    expect(document.querySelector('#shortcut-name')).toBeNull();
    expect(document.body.textContent).toContain('Shared content');
    expect(document.body.textContent).toContain('Only its author can change it');
  });

  it.each([
    ['other-ws', 'alice'],
    ['ws', 'bob'],
  ])('drops the private editor when switching to %s / %s', async (workspaceId, userId) => {
    await render();
    await open('Private review');
    expect(document.querySelector<HTMLInputElement>('#shortcut-name')?.value).toBe(
      'Private review'
    );
    state = { ...state, runtime: runtime(workspaceId, userId), entries: [] };
    await render();
    expect(document.querySelector('#shortcut-name')).toBeNull();
    expect(document.body.textContent).not.toContain('Private review');
  });

  it('ignores a body read that completes after a workspace switch', async () => {
    let complete!: (value: PromptShortcut) => void;
    const body = new Promise<PromptShortcut>((resolve) => {
      complete = resolve;
    });
    state = { ...state, runtime: runtime('ws', 'alice', () => body) };
    await render();
    await open('Private review');
    state = { ...state, runtime: runtime('other', 'alice'), entries: [] };
    await render();
    await act(async () => {
      complete(shortcut);
      await body;
    });
    expect(document.querySelector('#shortcut-name')).toBeNull();
    expect(document.body.textContent).not.toContain('Private review');
  });
});

it('hides an already-open editor when the beta is disabled and guards direct access', async () => {
  await render();
  await open('Private review');
  expect(document.querySelector('button[type="submit"]')).not.toBeNull();
  await act(async () => store.set(promptShortcutsBetaEnabledAtom, false));
  expect(document.querySelector('button[type="submit"]')).toBeNull();
  expect(container.textContent).toContain('Enable Prompt Shortcuts under Developer mode');
  expect(container.textContent).not.toContain('Private review');
  await render();
  expect(container.querySelector('button')).toBeNull();
});

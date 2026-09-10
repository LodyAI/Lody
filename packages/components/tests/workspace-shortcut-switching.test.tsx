// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://lody.local/" }

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceId } from '@lody/shared';
import {
  currentWorkspaceIdAtom,
  currentWorkspaceSlugAtom,
} from '../src/atoms/workspace-context';
import { userAtom } from '../src/atoms';
import { KeyboardShortcutsSetting } from '../src/components/settings/keyboard-shortcuts-setting';
import { WorkspaceShortcutCommands } from '../src/components/app-commands';
import { initI18n } from '../src/i18n';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';
import { commands } from '../src/lib/commands';
import { CommandShortcutHost } from '../src/lib/commands/shortcut-host';
import { readPreferredWorkspaceSlug } from '../src/lib/workspace';
import {
  __resetWorkspaceShortcutSlotsForTests,
  getWorkspaceShortcutSlots,
  getWorkspaceShortcutSlotsStorageKey,
  reconcileWorkspaceShortcutSlots,
  setWorkspaceShortcutSlot,
  subscribeWorkspaceShortcutSlots,
} from '../src/lib/workspace-shortcut-slots';
import { useWorkspaceSwitcher } from '../src/hooks/use-workspace-switcher';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const workspaceState = vi.hoisted(() => ({
  activeId: 'workspace-a',
  path: '/alpha/sessions/current',
  organizations: [
    { id: 'workspace-a', name: 'Alpha', slug: 'alpha' },
    { id: 'workspace-b', name: 'Beta', slug: 'beta' },
  ],
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useRouter: () => ({
      navigate: ({ params }: { params: { workspaceName: string } }) => {
        workspaceState.path = `/${params.workspaceName}/chat`;
      },
    }),
  };
});

vi.mock('../src/hooks/useOrganization', () => ({
  useOrganization: () => ({
    organizations: workspaceState.organizations,
    switchOrganization: async (workspaceId: string) => {
      workspaceState.activeId = workspaceId;
    },
  }),
}));

vi.mock('../src/hooks/use-global-shortcuts', () => ({
  useGlobalShortcuts: () => ({
    shortcuts: [],
    setBinding: async () => ({ ok: true }),
  }),
}));

describe('workspace shortcut slots', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetWorkspaceShortcutSlotsForTests();
  });

  it('pins initial catalog order to stable ids without shifting surviving slots', () => {
    expect(reconcileWorkspaceShortcutSlots('user-a', ['a', 'b', 'c'])).toEqual([
      'a',
      'b',
      'c',
      null,
      null,
      null,
      null,
      null,
      null,
    ]);

    expect(reconcileWorkspaceShortcutSlots('user-a', ['c', 'a', 'b'])).toEqual([
      'a',
      'b',
      'c',
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(reconcileWorkspaceShortcutSlots('user-a', ['c', 'a'])).toEqual([
      'a',
      null,
      'c',
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('moves a workspace between slots and keeps different users isolated', () => {
    reconcileWorkspaceShortcutSlots('user-a', ['a', 'b']);
    reconcileWorkspaceShortcutSlots('user-b', ['x', 'y']);

    expect(setWorkspaceShortcutSlot('user-a', 4, 'a')).toEqual([
      null,
      'b',
      null,
      'a',
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(getWorkspaceShortcutSlots('user-b')).toEqual([
      'x',
      'y',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('publishes a storage change from another renderer to live subscribers', () => {
    reconcileWorkspaceShortcutSlots('user-a', ['a', 'b']);
    let observed = getWorkspaceShortcutSlots('user-a');
    const unsubscribe = subscribeWorkspaceShortcutSlots('user-a', () => {
      observed = getWorkspaceShortcutSlots('user-a');
    });
    const remoteSlots = ['b', 'a', null, null, null, null, null, null, null];
    const storageKey = getWorkspaceShortcutSlotsStorageKey('user-a');

    sessionStorage.setItem(storageKey, JSON.stringify({ version: 1, slots: remoteSlots }));
    window.dispatchEvent(
      new StorageEvent('storage', { key: storageKey, storageArea: sessionStorage })
    );
    expect(observed).toEqual(['a', 'b', null, null, null, null, null, null, null]);

    localStorage.setItem(storageKey, JSON.stringify({ version: 1, slots: remoteSlots }));
    window.dispatchEvent(
      new StorageEvent('storage', { key: storageKey, storageArea: localStorage })
    );

    expect(observed).toEqual(remoteSlots);

    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(observed).toEqual([null, null, null, null, null, null, null, null, null]);
    unsubscribe();
  });

  it('clears invalid and duplicate ids without shifting another slot', () => {
    const storageKey = getWorkspaceShortcutSlotsStorageKey('user-a');
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        slots: ['a', 'missing', 'a', 'b', null, null, null, null, null],
      })
    );

    expect(reconcileWorkspaceShortcutSlots('user-a', ['b', 'a'])).toEqual([
      'a',
      null,
      null,
      'b',
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

describe('unified workspace switching', () => {
  let container: HTMLDivElement;
  let root: Root;
  const store = createStore();

  beforeEach(() => {
    localStorage.clear();
    workspaceState.activeId = 'workspace-a';
    workspaceState.path = '/alpha/sessions/current';
    store.set(currentWorkspaceSlugAtom, 'alpha');
    store.set(currentWorkspaceIdAtom, 'workspace-a' as WorkspaceId);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function Harness({ targetId }: { targetId: string }) {
    const { switchWorkspace } = useWorkspaceSwitcher();
    return <button onClick={() => switchWorkspace(targetId)}>Switch</button>;
  }

  it('publishes one coherent identity and route transition for every entry point', async () => {
    await act(async () => {
      root.render(
        <Provider store={store}>
          <Harness targetId="workspace-b" />
        </Provider>
      );
    });
    await act(async () => {
      container.querySelector('button')?.click();
    });

    expect({
      workspaceId: store.get(currentWorkspaceIdAtom),
      workspaceSlug: store.get(currentWorkspaceSlugAtom),
      preferredSlug: readPreferredWorkspaceSlug(),
      activeId: workspaceState.activeId,
      path: workspaceState.path,
    }).toEqual({
      workspaceId: 'workspace-b',
      workspaceSlug: 'beta',
      preferredSlug: 'beta',
      activeId: 'workspace-b',
      path: '/beta/chat',
    });
  });

  it('leaves the current route and identity untouched for the active or unknown workspace', async () => {
    await act(async () => {
      root.render(
        <Provider store={store}>
          <Harness targetId="workspace-a" />
        </Provider>
      );
    });
    act(() => container.querySelector('button')?.click());

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Harness targetId="missing" />
        </Provider>
      );
    });
    act(() => container.querySelector('button')?.click());

    expect({
      workspaceId: store.get(currentWorkspaceIdAtom),
      workspaceSlug: store.get(currentWorkspaceSlugAtom),
      preferredSlug: readPreferredWorkspaceSlug(),
      activeId: workspaceState.activeId,
      path: workspaceState.path,
    }).toEqual({
      workspaceId: 'workspace-a',
      workspaceSlug: 'alpha',
      preferredSlug: null,
      activeId: 'workspace-a',
      path: '/alpha/sessions/current',
    });
  });
});

describe('workspace shortcut settings', () => {
  let container: HTMLDivElement;
  let root: Root;
  const store = createStore();

  beforeEach(async () => {
    await initI18n('en');
    localStorage.clear();
    __resetWorkspaceShortcutSlotsForTests();
    Object.assign(window, {
      __LODY_ELECTRON__: true,
      __LODY_PLATFORM__: { os: 'darwin' },
    });
    __resetPlatformCacheForTests();
    store.set(userAtom, { id: 'user-a', email: 'user@example.test', name: 'User' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    for (const command of commands.list()) commands.unregister(command.id);
    delete window.__LODY_ELECTRON__;
    delete window.__LODY_PLATFORM__;
    __resetPlatformCacheForTests();
  });

  it('shows stable workspace assignments for all nine desktop slots', async () => {
    await act(async () => {
      root.render(
        <Provider store={store}>
          <KeyboardShortcutsSetting />
        </Provider>
      );
    });

    const selectors = container.querySelectorAll('[data-workspace-shortcut-slot]');
    expect(selectors).toHaveLength(9);
    expect(selectors[0]?.textContent).toContain('Alpha');
    expect(selectors[1]?.textContent).toContain('Beta');
    expect(selectors[2]?.textContent).toContain('Unassigned');
  });

  it('dispatches Mod+2 through the command host and unified switch boundary', async () => {
    store.set(currentWorkspaceSlugAtom, 'alpha');
    store.set(currentWorkspaceIdAtom, 'workspace-a' as WorkspaceId);
    workspaceState.activeId = 'workspace-a';
    workspaceState.path = '/alpha/sessions/current';

    await act(async () => {
      root.render(
        <Provider store={store}>
          <CommandShortcutHost />
          <WorkspaceShortcutCommands />
        </Provider>
      );
    });
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '2',
          code: 'Digit2',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect({
      workspaceId: store.get(currentWorkspaceIdAtom),
      workspaceSlug: store.get(currentWorkspaceSlugAtom),
      activeId: workspaceState.activeId,
      path: workspaceState.path,
    }).toEqual({
      workspaceId: 'workspace-b',
      workspaceSlug: 'beta',
      activeId: 'workspace-b',
      path: '/beta/chat',
    });
  });
});

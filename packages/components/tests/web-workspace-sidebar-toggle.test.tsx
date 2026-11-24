// @vitest-environment jsdom
import React, { act, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, Provider, useSetAtom } from 'jotai';

import {
  archiveScopeAtom,
  chatScopeAtom,
  chatsCollapsedAtom,
  githubWorktreesSectionCollapsedAtom,
  localProjectCollapseStateAtom,
  localProjectsSectionCollapseStateAtom,
  pinSectionsCollapsedAtom,
  pinSectionsHiddenAtom,
  pinnedSectionCollapsedAtom,
  repoCollapseStateAtom,
  sidebarCollapsedAtom,
  sidebarHideEmptyProjectsAtom,
  sidebarLastWidthAtom,
  sidebarOrganizeModeAtom,
  sidebarShowBranchNamesAtom,
  sidebarUpdatedBucketCollapseStateAtom,
  sidebarUpdatedShowProjectNamesAtom,
  todayPinnedAtom,
  todayPinnedTargetAtom,
} from '../src/atoms/sidebar-state';
import { experimentalFeaturesEnabledAtom, todayExperimentEnabledAtom } from '../src/atoms/settings';
import { WORKSPACE_FOCUS_SCOPES } from '../src/atoms/focus-layer';
import { WebWorkspaceLayout } from '../src/components/web-workspace-layout';
import { COMPACT_NAVIGATION_CLOSE_SETTLE_MS } from '../src/components/compact-navigation-dialog';
import { compactDesktopLayoutAtom, syncCompactDesktopLayoutAtom } from '../src/atoms/layout-state';
import { useOpenToday } from '../src/components/today/use-open-today';

const layout = vi.hoisted(() => ({ compact: false }));
const navigations = vi.hoisted((): unknown[] => []);

vi.mock('@tanstack/react-router', () => ({
  useLocation: ({ select }: { select: (location: { pathname: string }) => string }) =>
    select({ pathname: '/workspace/chat' }),
  useNavigate: () => (options: unknown) => {
    navigations.push(options);
    return Promise.resolve();
  },
}));
vi.mock('../src/hooks/use-keyboard-navigation', () => ({ useKeyboardNavigation: () => {} }));
vi.mock('../src/hooks/use-mobile', () => ({ useIsCompactDesktop: () => layout.compact }));
vi.mock('../src/ui/window-drag-region', () => ({ WindowDragStrip: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../src/components/loro-app-sidebar', () => ({
  LoroAppSidebar: () => (
    <div data-sidebar-identity="">
      <input defaultValue="retained draft" />
      <div data-sidebar-viewport="" />
    </div>
  ),
}));

vi.mock('../src/components/today/today-pinned-column', () => ({
  TodayPinnedColumn: () => <section data-testid="today-column" />,
}));

describe('desktop sidebar toggle', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    layout.compact = false;
    navigations.length = 0;
    delete window.__LODY_VERTICAL_DIVISION__;
  });

  function render(node: React.ReactNode) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root?.render(node));
  }

  it('shows the pinned Today column beside the sidebar, never in compact navigation', async () => {
    const store = createStore();
    store.set(experimentalFeaturesEnabledAtom, true);
    store.set(todayExperimentEnabledAtom, true);
    store.set(todayPinnedAtom, true);
    store.set(sidebarCollapsedAtom, false);
    await act(async () =>
      render(
        <Provider store={store}>
          <WebWorkspaceLayout>
            <button>Content</button>
          </WebWorkspaceLayout>
        </Provider>
      )
    );
    expect(container!.querySelector('[data-testid="today-column"]')).not.toBeNull();
    await act(async () => store.set(todayPinnedAtom, false));
    expect(container!.querySelector('[data-testid="today-column"]')).toBeNull();
    await act(async () => store.set(todayPinnedAtom, true));
    await act(async () => store.set(todayExperimentEnabledAtom, false));
    expect(container!.querySelector('[data-testid="today-column"]')).toBeNull();
  });

  it('opens a Today day in the pinned column without navigating the main area', async () => {
    const store = createStore();
    store.set(experimentalFeaturesEnabledAtom, true);
    store.set(todayExperimentEnabledAtom, true);
    store.set(todayPinnedAtom, true);
    let openToday: ReturnType<typeof useOpenToday> = () => undefined;
    function Opener() {
      openToday = useOpenToday();
      return null;
    }
    await act(async () =>
      render(
        <Provider store={store}>
          <Opener />
        </Provider>
      )
    );
    const day = { member: 'u1', date: '2026-11-19' };
    act(() => openToday({ workspaceSlug: 'acme', sameWorkspace: true, ...day }));
    expect(store.get(todayPinnedTargetAtom)).toEqual(day);
    expect(navigations).toEqual([]);

    // Another workspace's day, or no room for the column: the Today page opens.
    store.set(todayPinnedTargetAtom, null);
    act(() => openToday({ workspaceSlug: 'other', sameWorkspace: false, ...day }));
    layout.compact = true;
    await act(async () =>
      root?.render(
        <Provider store={store}>
          <Opener />
        </Provider>
      )
    );
    act(() => openToday({ workspaceSlug: 'acme', sameWorkspace: true }));
    expect(store.get(todayPinnedTargetAtom)).toBeNull();
    expect(navigations).toEqual([
      { to: '/$workspaceName/today', params: { workspaceName: 'other' }, search: day },
      { to: '/$workspaceName/today', params: { workspaceName: 'acme' }, search: {} },
    ]);
  });

  it('isolates compact navigation from the background content', async () => {
    layout.compact = true;
    const store = createStore();
    store.set(compactDesktopLayoutAtom, true);
    store.set(sidebarCollapsedAtom, false);
    await act(async () =>
      render(
        <Provider store={store}>
          <WebWorkspaceLayout>
            <button>Machine</button>
          </WebWorkspaceLayout>
        </Provider>
      )
    );
    const content = container!.querySelector(
      `[data-focus-scope="${WORKSPACE_FOCUS_SCOPES.content}"]`
    )!;
    expect(content.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    await act(async () => store.set(sidebarCollapsedAtom, true));
    expect(content.hasAttribute('inert')).toBe(false);
  });

  it('closes compact navigation on Escape, persists collapse and restores the opener twice', async () => {
    layout.compact = true;
    const store = createStore();
    store.set(compactDesktopLayoutAtom, true);
    store.set(sidebarCollapsedAtom, true);
    await act(async () =>
      render(
        <Provider store={store}>
          <WebWorkspaceLayout>
            <button onClick={() => store.set(sidebarCollapsedAtom, false)}>
              Show navigation sidebar
            </button>
          </WebWorkspaceLayout>
        </Provider>
      )
    );
    const opener = container!.querySelector('button')!;
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await act(async () => {
        opener.focus();
        opener.click();
      });
      const dialog = document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]')!;
      expect(dialog).not.toBeNull();
      await act(async () => {
        dialog.querySelector('input')!.focus();
        document.activeElement!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
      });
      expect(store.get(sidebarCollapsedAtom)).toBe(true);
      expect(document.activeElement).toBe(opener);
    }
  });

  it('releases background isolation when compact navigation becomes a desktop column', async () => {
    layout.compact = true;
    const store = createStore();
    store.set(compactDesktopLayoutAtom, true);
    store.set(sidebarCollapsedAtom, false);
    const node = (
      <Provider store={store}>
        <WebWorkspaceLayout>
          <button>Machine</button>
        </WebWorkspaceLayout>
      </Provider>
    );
    await act(async () => render(node));
    layout.compact = false;
    await act(async () =>
      root!.render(
        <Provider store={store}>
          <WebWorkspaceLayout>
            <button>Machine</button>
          </WebWorkspaceLayout>
        </Provider>
      )
    );
    const content = container!.querySelector(
      `[data-focus-scope="${WORKSPACE_FOCUS_SCOPES.content}"]`
    )!;
    expect(content.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container!.querySelector('[data-sidebar-identity]')).not.toBeNull();
    expect(store.get(sidebarCollapsedAtom)).toBe(false);
  });

  it('mounts a narrow window with its navigation closed and the content usable', async () => {
    layout.compact = true;
    const store = createStore();
    // The persisted preference is an open sidebar, as on a wide window before it narrowed.
    store.set(sidebarCollapsedAtom, false);
    // MainLayout's bridge syncs the viewport into atom state in a layout effect, one
    // commit after the layout first renders.
    function CompactBridge() {
      const sync = useSetAtom(syncCompactDesktopLayoutAtom);
      useLayoutEffect(() => sync(true), [sync]);
      return null;
    }
    const mounted: string[] = [];
    const observer = new MutationObserver(() => {
      if (document.querySelector('[role="dialog"]')) mounted.push('dialog');
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      await act(async () =>
        render(
          <Provider store={store}>
            <WebWorkspaceLayout>
              <button>Machine</button>
            </WebWorkspaceLayout>
            <CompactBridge />
          </Provider>
        )
      );
    } finally {
      observer.disconnect();
    }
    // Mounting open and closing before the opening frame is the exit that never ends.
    expect(mounted).toEqual([]);
    const content = container!.querySelector(
      `[data-focus-scope="${WORKSPACE_FOCUS_SCOPES.content}"]`
    )!;
    expect(content.hasAttribute('inert')).toBe(false);
    expect(store.get(sidebarCollapsedAtom)).toBe(false);
  });

  it('finishes a compact navigation close whose exit transition never ends', async () => {
    layout.compact = true;
    const store = createStore();
    store.set(compactDesktopLayoutAtom, true);
    store.set(sidebarCollapsedAtom, false);
    await act(async () =>
      render(
        <Provider store={store}>
          <WebWorkspaceLayout>
            <button>Machine</button>
          </WebWorkspaceLayout>
        </Provider>
      )
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    // A browser that reports an exit animation which never finishes, as Base UI sees a
    // close that began before the opening frame.
    const disabled = Object.getOwnPropertyDescriptor(globalThis, 'BASE_UI_ANIMATIONS_DISABLED');
    const getAnimations = Element.prototype.getAnimations;
    Object.assign(globalThis, { BASE_UI_ANIMATIONS_DISABLED: false });
    Element.prototype.getAnimations = () =>
      [{ finished: new Promise(() => {}), pending: false, playState: 'running' }] as never;
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
    });
    try {
      await act(async () => store.set(sidebarCollapsedAtom, true));
      await act(async () => vi.advanceTimersByTime(100));
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      await act(async () => vi.advanceTimersByTime(COMPACT_NAVIGATION_CLOSE_SETTLE_MS));
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.querySelector('[inert]')).toBeNull();
    } finally {
      vi.useRealTimers();
      Element.prototype.getAnimations = getAnimations;
      if (disabled) Object.defineProperty(globalThis, 'BASE_UI_ANIMATIONS_DISABLED', disabled);
    }
  });

  it('retains the same sidebar DOM and scroll state across collapse and expand', () => {
    const store = createStore();
    store.set(sidebarCollapsedAtom, false);
    render(
      <Provider store={store}>
        <WebWorkspaceLayout>
          <div data-content="" />
        </WebWorkspaceLayout>
      </Provider>
    );

    const sidebar = container!.querySelector<HTMLElement>('[data-sidebar-identity]')!;
    const wrapper = sidebar.parentElement!;
    const viewport = sidebar.querySelector<HTMLElement>('[data-sidebar-viewport]')!;
    const input = sidebar.querySelector<HTMLInputElement>('input')!;
    viewport.scrollTop = 173;
    input.value = 'unsaved filter';
    input.focus();

    flushSync(() => store.set(sidebarCollapsedAtom, true));
    expect(container!.querySelector('[data-sidebar-identity]')).toBe(sidebar);
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
    expect(wrapper.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(
      container!.querySelector(`[data-focus-scope="${WORKSPACE_FOCUS_SCOPES.content}"]`)
    );

    flushSync(() => store.set(sidebarCollapsedAtom, false));
    expect(container!.querySelector('[data-sidebar-identity]')).toBe(sidebar);
    expect(wrapper.getAttribute('aria-hidden')).toBe('false');
    expect(wrapper.hasAttribute('inert')).toBe(false);
    expect(viewport.scrollTop).toBe(173);
    expect(input.value).toBe('unsaved filter');
  });

  it('keeps workspace panes on opposite sides of a changing fold without saving its width', async () => {
    const store = createStore();
    store.set(sidebarCollapsedAtom, false);
    store.set(sidebarLastWidthAtom, 300);
    await act(async () =>
      render(
        <Provider store={store}>
          <WebWorkspaceLayout>
            <div data-content="" />
          </WebWorkspaceLayout>
        </Provider>
      )
    );
    const sidebar = container!.querySelector<HTMLElement>('[data-sidebar-identity]')!;
    const wrapper = sidebar.parentElement!;
    const content = container!.querySelector<HTMLElement>(
      `[data-focus-scope="${WORKSPACE_FOCUS_SCOPES.content}"]`
    )!;
    await act(async () => {
      window.__LODY_VERTICAL_DIVISION__ = { left: 455.5, width: 40, viewportWidth: 867 };
      window.dispatchEvent(new Event('lody:division-change'));
    });
    expect(wrapper.style.width).toBe('455.5px');
    expect(wrapper.style.marginRight).toBe('40px');
    expect(store.get(sidebarLastWidthAtom)).toBe(300);
    await act(async () => store.set(sidebarCollapsedAtom, true));
    expect(wrapper.style.marginRight).toBe('-455.5px');
    expect(content.style.marginLeft).toBe('495.5px');
    await act(async () => {
      window.__LODY_VERTICAL_DIVISION__ = null;
      window.dispatchEvent(new Event('lody:division-change'));
    });
    expect(wrapper.style.width).toBe('');
    expect(content.style.marginLeft).toBe('');
    expect(container!.querySelector('[data-sidebar-identity]')).toBe(sidebar);
  });

  it('persists sidebar collapse and filter state without live-syncing across renderers', async () => {
    const store = createStore();
    const unsubs = [
      store.sub(sidebarCollapsedAtom, () => {}),
      store.sub(sidebarLastWidthAtom, () => {}),
      store.sub(todayPinnedAtom, () => {}),
      store.sub(chatScopeAtom, () => {}),
      store.sub(archiveScopeAtom, () => {}),
      store.sub(sidebarOrganizeModeAtom, () => {}),
      store.sub(sidebarUpdatedShowProjectNamesAtom, () => {}),
      store.sub(sidebarShowBranchNamesAtom, () => {}),
      store.sub(sidebarHideEmptyProjectsAtom, () => {}),
      store.sub(repoCollapseStateAtom, () => {}),
      store.sub(chatsCollapsedAtom, () => {}),
      store.sub(pinnedSectionCollapsedAtom, () => {}),
      store.sub(pinSectionsCollapsedAtom, () => {}),
      store.sub(pinSectionsHiddenAtom, () => {}),
      store.sub(localProjectCollapseStateAtom, () => {}),
      store.sub(localProjectsSectionCollapseStateAtom, () => {}),
      store.sub(githubWorktreesSectionCollapsedAtom, () => {}),
      store.sub(sidebarUpdatedBucketCollapseStateAtom, () => {}),
    ];

    try {
      store.set(sidebarCollapsedAtom, false);
      store.set(sidebarLastWidthAtom, 320);
      store.set(todayPinnedAtom, false);
      store.set(chatScopeAtom, 'team');
      store.set(archiveScopeAtom, 'team');
      store.set(sidebarOrganizeModeAtom, 'workspace');
      store.set(sidebarUpdatedShowProjectNamesAtom, true);
      store.set(sidebarShowBranchNamesAtom, false);
      store.set(sidebarHideEmptyProjectsAtom, true);
      store.set(repoCollapseStateAtom, { 'org/repo': false });
      store.set(chatsCollapsedAtom, false);
      store.set(pinnedSectionCollapsedAtom, false);
      store.set(pinSectionsCollapsedAtom, { sec1: false });
      store.set(pinSectionsHiddenAtom, { sec1: false });
      store.set(localProjectCollapseStateAtom, { 'm1:p1': false });
      store.set(localProjectsSectionCollapseStateAtom, { m1: false });
      store.set(githubWorktreesSectionCollapsedAtom, false);
      store.set(sidebarUpdatedBucketCollapseStateAtom, { all: false });

      await act(async () =>
        render(
          <Provider store={store}>
            <WebWorkspaceLayout>
              <div data-content="" />
            </WebWorkspaceLayout>
          </Provider>
        )
      );

      const sidebar = container!.querySelector<HTMLElement>('[data-sidebar-identity]')!;
      expect(sidebar.parentElement!.getAttribute('aria-hidden')).toBe('false');

      const peerWrites: Array<[string, unknown]> = [
        ['lody-sidebar-collapsed', true],
        ['lody-sidebar-last-width', 260],
        ['lody-today-pinned', true],
        ['lody-sidebar-chat-scope', 'my'],
        ['lody-archive-scope', 'my'],
        ['lody-sidebar-organize-mode', 'status'],
        ['lody-sidebar-updated-show-project-names', false],
        ['lody-sidebar-show-branch-names', true],
        ['lody-sidebar-hide-empty-projects', false],
        ['lody-sidebar-repo-collapse', { 'org/repo': true }],
        ['lody-sidebar-chats-collapsed', true],
        ['lody-sidebar-pinned-section-collapsed', true],
        ['lody-sidebar-pin-sections-collapsed', { sec1: true }],
        ['lody-sidebar-pin-sections-hidden', { sec1: true }],
        ['lody-sidebar-local-project-collapse', { 'm1:p1': true }],
        ['lody-sidebar-local-projects-section-collapse', { m1: true }],
        ['lody-sidebar-github-worktrees-section-collapsed', true],
        ['lody-sidebar-updated-bucket-collapse', { all: true }],
      ];

      await act(async () => {
        for (const [key, value] of peerWrites) {
          const encoded = JSON.stringify(value);
          window.localStorage.setItem(key, encoded);
          window.dispatchEvent(
            new StorageEvent('storage', {
              key,
              newValue: encoded,
              storageArea: window.localStorage,
            })
          );
        }
      });
      expect(sidebar.parentElement!.getAttribute('aria-hidden')).toBe('false');
      expect(store.get(sidebarCollapsedAtom)).toBe(false);
      expect(store.get(sidebarLastWidthAtom)).toBe(320);
      expect(store.get(todayPinnedAtom)).toBe(false);
      expect(store.get(chatScopeAtom)).toBe('team');
      expect(store.get(archiveScopeAtom)).toBe('team');
      expect(store.get(sidebarOrganizeModeAtom)).toBe('workspace');
      expect(store.get(sidebarUpdatedShowProjectNamesAtom)).toBe(true);
      expect(store.get(sidebarShowBranchNamesAtom)).toBe(false);
      expect(store.get(sidebarHideEmptyProjectsAtom)).toBe(true);
      expect(store.get(repoCollapseStateAtom)).toEqual({ 'org/repo': false });
      expect(store.get(chatsCollapsedAtom)).toBe(false);
      expect(store.get(pinnedSectionCollapsedAtom)).toBe(false);
      expect(store.get(pinSectionsCollapsedAtom)).toEqual({ sec1: false });
      expect(store.get(pinSectionsHiddenAtom)).toEqual({ sec1: false });
      expect(store.get(localProjectCollapseStateAtom)).toEqual({ 'm1:p1': false });
      expect(store.get(localProjectsSectionCollapseStateAtom)).toEqual({ m1: false });
      expect(store.get(githubWorktreesSectionCollapsedAtom)).toBe(false);
      expect(store.get(sidebarUpdatedBucketCollapseStateAtom)).toEqual({ all: false });
      const freshStore = createStore();
      const freshUnsubs = [
        freshStore.sub(sidebarCollapsedAtom, () => {}),
        freshStore.sub(chatScopeAtom, () => {}),
        freshStore.sub(sidebarOrganizeModeAtom, () => {}),
        freshStore.sub(repoCollapseStateAtom, () => {}),
        freshStore.sub(chatsCollapsedAtom, () => {}),
        freshStore.sub(sidebarShowBranchNamesAtom, () => {}),
      ];
      try {
        expect(freshStore.get(sidebarCollapsedAtom)).toBe(true);
        expect(freshStore.get(chatScopeAtom)).toBe('my');
        expect(freshStore.get(sidebarOrganizeModeAtom)).toBe('status');
        expect(freshStore.get(repoCollapseStateAtom)).toEqual({ 'org/repo': true });
        expect(freshStore.get(chatsCollapsedAtom)).toBe(true);
        expect(freshStore.get(sidebarShowBranchNamesAtom)).toBe(true);
      } finally {
        for (const unsub of freshUnsubs) unsub();
      }
    } finally {
      for (const unsub of unsubs) unsub();
    }
  });
});

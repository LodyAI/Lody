// @vitest-environment jsdom

// @vitest-environment jsdom
import React, { act, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, Provider, useSetAtom } from 'jotai';

import { sidebarCollapsedAtom, sidebarLastWidthAtom } from '../src/atoms/sidebar-state';
import { WORKSPACE_FOCUS_SCOPES } from '../src/atoms/focus-layer';
import { WebWorkspaceLayout } from '../src/components/web-workspace-layout';
import { COMPACT_NAVIGATION_CLOSE_SETTLE_MS } from '../src/components/compact-navigation-dialog';
import { compactDesktopLayoutAtom, syncCompactDesktopLayoutAtom } from '../src/atoms/layout-state';

const layout = vi.hoisted(() => ({ compact: false }));

vi.mock('@tanstack/react-router', () => ({
  useLocation: ({ select }: { select: (location: { pathname: string }) => string }) =>
    select({ pathname: '/workspace/chat' }),
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

describe('desktop sidebar toggle', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    layout.compact = false;
    delete window.__LODY_VERTICAL_DIVISION__;
  });

  function render(node: React.ReactNode) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root?.render(node));
  }

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
});

// @vitest-environment jsdom

import React, { act, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, Provider } from 'jotai';

import { sidebarCollapsedAtom, sidebarLastWidthAtom } from '../src/atoms/sidebar-state';
import { WORKSPACE_FOCUS_SCOPES } from '../src/atoms/focus-layer';
import { WebWorkspaceLayout } from '../src/components/web-workspace-layout';
import { SidebarVisibilityGate } from '../src/components/sidebar-visibility-gate';

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
    expect(wrapper.style.marginRight).toBe('-280px');
    expect(wrapper.style.transform).toBe('translateX(-280px)');
    expect(wrapper.style.transitionProperty).toBe('transform, margin-right');
    expect(wrapper.style.transitionDuration).toBe('220ms');
    expect(document.activeElement).toBe(
      container!.querySelector(`[data-focus-scope="${WORKSPACE_FOCUS_SCOPES.content}"]`)
    );

    flushSync(() => store.set(sidebarCollapsedAtom, false));
    expect(container!.querySelector('[data-sidebar-identity]')).toBe(sidebar);
    expect(wrapper.getAttribute('aria-hidden')).toBe('false');
    expect(wrapper.hasAttribute('inert')).toBe(false);
    expect(wrapper.style.marginRight).toBe('0px');
    expect(wrapper.style.transform).toBe('translateX(0px)');
    expect(viewport.scrollTop).toBe(173);
    expect(input.value).toBe('unsaved filter');
  });

  it('mounts the hidden sidebar before its first open so the first toggle retains state', () => {
    const store = createStore();
    store.set(sidebarCollapsedAtom, true);
    store.set(sidebarLastWidthAtom, 900);
    render(
      <Provider store={store}>
        <WebWorkspaceLayout>
          <div data-content="" />
        </WebWorkspaceLayout>
      </Provider>
    );

    const sidebar = container!.querySelector('[data-sidebar-identity]');
    expect(sidebar).not.toBeNull();
    const wrapper = sidebar!.parentElement!;
    expect(wrapper.style.marginRight).toBe('-420px');
    expect(wrapper.style.transform).toBe('translateX(-420px)');
    flushSync(() => store.set(sidebarLastWidthAtom, 100));
    expect(wrapper.style.marginRight).toBe('-240px');
    expect(wrapper.style.transform).toBe('translateX(-240px)');
    flushSync(() => store.set(sidebarCollapsedAtom, false));
    expect(container!.querySelector('[data-sidebar-identity]')).toBe(sidebar);
  });

  it('pauses a hidden sidebar source and resumes it without unmounting the host', () => {
    const store = createStore();
    store.set(sidebarCollapsedAtom, false);
    const activeSources = new Set<string>();
    function Source() {
      useEffect(() => {
        activeSources.add('sidebar');
        return () => {
          activeSources.delete('sidebar');
        };
      }, []);
      return <div data-prefetch-source="" />;
    }
    function Host() {
      const [filterOpen, setFilterOpen] = useState(true);
      return (
        <div data-host="" data-filter-open={filterOpen}>
          <SidebarVisibilityGate disableWhenHidden onHidden={() => setFilterOpen(false)}>
            <Source />
          </SidebarVisibilityGate>
        </div>
      );
    }
    render(
      <Provider store={store}>
        <Host />
      </Provider>
    );
    const host = container!.querySelector('[data-host]');
    expect(activeSources.has('sidebar')).toBe(true);

    flushSync(() => store.set(sidebarCollapsedAtom, true));
    expect(container!.querySelector('[data-host]')).toBe(host);
    expect(container!.querySelector('[data-prefetch-source]')).toBeNull();
    expect(activeSources.has('sidebar')).toBe(false);
    expect(host?.getAttribute('data-filter-open')).toBe('false');

    flushSync(() => store.set(sidebarCollapsedAtom, false));
    expect(container!.querySelector('[data-host]')).toBe(host);
    expect(container!.querySelector('[data-prefetch-source]')).not.toBeNull();
    expect(activeSources.has('sidebar')).toBe(true);
  });
});

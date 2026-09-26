// @vitest-environment jsdom

import React, { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, Provider } from 'jotai';

import { sidebarCollapsedAtom, sidebarLastWidthAtom } from '../src/atoms/sidebar-state';
import { WORKSPACE_FOCUS_SCOPES } from '../src/atoms/focus-layer';
import { WebWorkspaceLayout } from '../src/components/web-workspace-layout';
import { SidebarVisibilityGate } from '../src/components/sidebar-visibility-gate';

vi.mock('@tanstack/react-router', () => ({
  useLocation: ({ select }: { select: (location: { pathname: string }) => string }) =>
    select({ pathname: '/workspace/chat' }),
}));
vi.mock('../src/hooks/use-keyboard-navigation', () => ({ useKeyboardNavigation: () => {} }));
vi.mock('../src/hooks/use-mobile', () => ({ useIsCompactDesktop: () => false }));
vi.mock('../src/ui/window-drag-region', () => ({ WindowDragStrip: () => null }));
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
  });

  function render(node: React.ReactNode) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root?.render(node));
  }

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

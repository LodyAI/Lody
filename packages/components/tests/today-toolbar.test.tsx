// @vitest-environment jsdom
import React, { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, Provider } from 'jotai';

import { sidebarCollapsedAtom } from '../src/atoms/sidebar-state';
import { TodayToolbar } from '../src/components/today/today-view';
import { createTestI18n, withTestI18n } from './test-i18n';

// The desktop window: the workspace drag strip covers the Today page's toolbar row.
vi.mock('../src/lib/electron', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/electron')>()),
  isElectronRenderer: () => true,
  isMacOSElectronRenderer: () => true,
  useElectronFullscreen: () => false,
}));

describe('Today toolbar window chrome', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
  });

  async function renderToolbar(pinned: boolean, collapsed: boolean, standalone = false) {
    const store = createStore();
    store.set(sidebarCollapsedAtom, collapsed);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        withTestI18n(
          <Provider store={store}>
            <TodayToolbar pinned={pinned} standalone={standalone} title={null}>
              <button type="button">Pick a date</button>
              <button type="button">Pin</button>
              <button type="button">More</button>
            </TodayToolbar>
          </Provider>,
          createTestI18n({ keyLabels: true })
        )
      )
    );
    return { store, toolbar: container.querySelector('[data-testid="today-toolbar"]')! };
  }

  /** A click lands on a control only when no drag region claims it first. */
  function clickable(button: Element, toolbar: Element) {
    for (let node: Element | null = button; node && node !== toolbar; node = node.parentElement) {
      if (node.classList.contains('app-region-no-drag')) return true;
      if (node.classList.contains('app-region-drag')) return false;
    }
    return !toolbar.classList.contains('app-region-drag');
  }

  it('keeps every page control clickable and restores the sidebar controls while it is hidden', async () => {
    const { store, toolbar } = await renderToolbar(false, true);
    expect(toolbar.classList.contains('app-region-drag')).toBe(true);
    const buttons = [...toolbar.querySelectorAll('button')];
    expect(
      buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent)
    ).toEqual([
      'commands.sidebar.toggle',
      'commands.nav.back',
      'commands.nav.forward',
      'Pick a date',
      'Pin',
      'More',
    ]);
    for (const button of buttons) expect(clickable(button, toolbar)).toBe(true);

    await act(async () => buttons[0]!.click());
    expect(store.get(sidebarCollapsedAtom)).toBe(false);
    // With the sidebar back, its own header owns Toggle, Back and Forward again.
    expect(toolbar.querySelector('[aria-label="commands.sidebar.toggle"]')).toBeNull();
  });

  it('keeps the pinned column out of the drag chrome, carrying the sidebar controls while the sidebar is hidden', async () => {
    const hidden = await renderToolbar(true, true);
    expect(hidden.toolbar.classList.contains('app-region-drag')).toBe(false);
    // Pinned with the sidebar hidden, the column is the leftmost surface.
    expect(
      [...hidden.toolbar.querySelectorAll('button')].map(
        (button) => button.getAttribute('aria-label') ?? button.textContent
      )
    ).toEqual([
      'commands.sidebar.toggle',
      'commands.nav.back',
      'commands.nav.forward',
      'Pick a date',
      'Pin',
      'More',
    ]);
    await act(async () => [...hidden.toolbar.querySelectorAll('button')][0]!.click());
    expect(hidden.store.get(sidebarCollapsedAtom)).toBe(false);
    expect(hidden.toolbar.querySelectorAll('button')).toHaveLength(3);
  });

  it('makes the standalone Today window toolbar its own drag chrome, without sidebar controls', async () => {
    // The Today window has no navigation sidebar, whatever its stored state says.
    for (const collapsed of [false, true]) {
      const { toolbar } = await renderToolbar(false, collapsed, true);
      expect(toolbar.classList.contains('app-region-drag')).toBe(true);
      const buttons = [...toolbar.querySelectorAll('button')];
      expect(buttons.map((button) => button.textContent)).toEqual(['Pick a date', 'Pin', 'More']);
      for (const button of buttons) expect(clickable(button, toolbar)).toBe(true);
      flushSync(() => root?.unmount());
      root = undefined;
      container?.remove();
    }
  });

  it('hands the sidebar controls to pinned Today: the main page no longer owns the window edge', async () => {
    const { mainPageAtWindowEdgeAtom } = await import('../src/atoms/layout-state');
    const { todayPinnedAtom } = await import('../src/atoms/sidebar-state');
    const { experimentalFeaturesEnabledAtom, todayExperimentEnabledAtom } =
      await import('../src/atoms/settings');
    const store = createStore();
    store.set(sidebarCollapsedAtom, true);
    expect(store.get(mainPageAtWindowEdgeAtom)).toBe(true);
    store.set(experimentalFeaturesEnabledAtom, true);
    store.set(todayExperimentEnabledAtom, true);
    store.set(todayPinnedAtom, true);
    expect(store.get(mainPageAtWindowEdgeAtom)).toBe(false);
    store.set(sidebarCollapsedAtom, false);
    expect(store.get(mainPageAtWindowEdgeAtom)).toBe(false);
  });
});

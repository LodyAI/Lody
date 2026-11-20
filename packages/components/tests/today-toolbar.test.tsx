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

  async function renderToolbar(pinned: boolean, collapsed: boolean) {
    const store = createStore();
    store.set(sidebarCollapsedAtom, collapsed);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        withTestI18n(
          <Provider store={store}>
            <TodayToolbar pinned={pinned} title={null}>
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

  it('leaves the pinned column out of the window chrome', async () => {
    const { toolbar } = await renderToolbar(true, true);
    expect(toolbar.classList.contains('app-region-drag')).toBe(false);
    expect(toolbar.querySelector('[aria-label="commands.sidebar.toggle"]')).toBeNull();
    expect(toolbar.querySelectorAll('button')).toHaveLength(3);
  });
});

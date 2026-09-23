import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';

import {
  getZenAwarePanelToggleState,
  navigationSidebarHiddenAtom,
  showNavigationSidebarAtom,
  toggleNavigationSidebarAtom,
  toggleZenLayoutModeAtom,
  zenLayoutModeAtom,
  zenRightPanelAtom,
} from '../src/atoms/layout-state';
import { sidebarCollapsedAtom } from '../src/atoms/sidebar-state';

describe('Zen layout state', () => {
  it.each([false, true])(
    'temporarily hides the navigation sidebar without changing collapsed=%s',
    (collapsed) => {
      const store = createStore();
      store.set(sidebarCollapsedAtom, collapsed);
      store.set(zenRightPanelAtom, { open: true, reveal: () => {} });

      store.set(toggleZenLayoutModeAtom);

      expect(store.get(zenLayoutModeAtom)).toBe(true);
      expect(store.get(navigationSidebarHiddenAtom)).toBe(true);
      expect(store.get(sidebarCollapsedAtom)).toBe(collapsed);

      store.set(toggleZenLayoutModeAtom);

      expect(store.get(zenLayoutModeAtom)).toBe(false);
      expect(store.get(navigationSidebarHiddenAtom)).toBe(collapsed);
      expect(store.get(sidebarCollapsedAtom)).toBe(collapsed);
    }
  );

  it.each([false, true])('reveals both manually closed panels with Zen=%s', (zen) => {
    const store = createStore();
    store.set(sidebarCollapsedAtom, true);
    store.set(zenLayoutModeAtom, zen);
    const panel = {
      open: false,
      reveal: () => store.set(zenRightPanelAtom, { ...panel, open: true }),
    };
    store.set(zenRightPanelAtom, panel);

    store.set(toggleZenLayoutModeAtom);

    expect(store.get(zenLayoutModeAtom)).toBe(false);
    expect(store.get(navigationSidebarHiddenAtom)).toBe(false);
    expect(store.get(zenRightPanelAtom)?.open).toBe(true);

    store.set(toggleZenLayoutModeAtom);
    expect(store.get(zenLayoutModeAtom)).toBe(true);
    expect(store.get(navigationSidebarHiddenAtom)).toBe(true);
    store.set(toggleZenLayoutModeAtom);
    expect(store.get(zenLayoutModeAtom)).toBe(false);
    expect(store.get(navigationSidebarHiddenAtom)).toBe(false);
    expect(store.get(zenRightPanelAtom)?.open).toBe(true);
  });

  it('restores a left-only layout without opening the right panel', () => {
    const store = createStore();
    store.set(sidebarCollapsedAtom, false);
    const panel = {
      open: false,
      reveal: () => store.set(zenRightPanelAtom, { ...panel, open: true }),
    };
    store.set(zenRightPanelAtom, panel);
    store.set(toggleZenLayoutModeAtom);
    expect(store.get(navigationSidebarHiddenAtom)).toBe(true);
    store.set(toggleZenLayoutModeAtom);
    expect(store.get(navigationSidebarHiddenAtom)).toBe(false);
    expect(store.get(zenRightPanelAtom)?.open).toBe(false);
  });

  it('reveals navigation when there is no mounted right panel', () => {
    const store = createStore();
    store.set(sidebarCollapsedAtom, true);
    store.set(toggleZenLayoutModeAtom);
    expect(store.get(zenLayoutModeAtom)).toBe(false);
    expect(store.get(navigationSidebarHiddenAtom)).toBe(false);
    expect(store.get(zenRightPanelAtom)).toBeNull();
  });

  it('leaves Zen and expands the navigation sidebar for an explicit show', () => {
    const store = createStore();
    store.set(sidebarCollapsedAtom, true);
    store.set(zenLayoutModeAtom, true);

    store.set(showNavigationSidebarAtom);

    expect(store.get(zenLayoutModeAtom)).toBe(false);
    expect(store.get(sidebarCollapsedAtom)).toBe(false);
    expect(store.get(navigationSidebarHiddenAtom)).toBe(false);
  });

  it('treats a navigation sidebar toggle during Zen as an explicit reveal', () => {
    const store = createStore();
    store.set(sidebarCollapsedAtom, false);
    store.set(zenLayoutModeAtom, true);

    store.set(toggleNavigationSidebarAtom);

    expect(store.get(zenLayoutModeAtom)).toBe(false);
    expect(store.get(sidebarCollapsedAtom)).toBe(false);
  });
});

describe('getZenAwarePanelToggleState', () => {
  it.each([
    [
      { zenMode: true, panelOpen: true },
      { zenMode: false, panelOpen: true },
    ],
    [
      { zenMode: true, panelOpen: false },
      { zenMode: false, panelOpen: true },
    ],
    [
      { zenMode: false, panelOpen: true },
      { zenMode: false, panelOpen: false },
    ],
    [
      { zenMode: false, panelOpen: false },
      { zenMode: false, panelOpen: true },
    ],
  ])('maps %o to %o', (current, expected) => {
    expect(getZenAwarePanelToggleState(current)).toEqual(expected);
  });
});

// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { createStore, type Store } from 'jotai';

import {
  compactDesktopLayoutAtom,
  compactSidebarSuppressedAtom,
  navigationSidebarHiddenAtom,
  navigationSidebarVisibleAtom,
  showNavigationSidebarAtom,
  syncCompactDesktopLayoutAtom,
  toggleNavigationSidebarAtom,
  zenLayoutModeAtom,
} from '../src/atoms/layout-state';
import { sidebarCollapsedAtom } from '../src/atoms/sidebar-state';

let store: Store;

beforeEach(() => {
  store = createStore();
  store.set(sidebarCollapsedAtom, false);
  store.set(zenLayoutModeAtom, false);
  store.set(compactDesktopLayoutAtom, false);
  store.set(compactSidebarSuppressedAtom, false);
});

describe('compact desktop sidebar state', () => {
  it('suppresses a visible sidebar on compact entry and restores it on exit', () => {
    expect(store.get(navigationSidebarVisibleAtom)).toBe(true);

    store.set(syncCompactDesktopLayoutAtom, true);
    // Auto-hidden for presentation only: the persisted preference stays open.
    expect(store.get(navigationSidebarVisibleAtom)).toBe(false);
    expect(store.get(navigationSidebarHiddenAtom)).toBe(false);
    expect(store.get(compactSidebarSuppressedAtom)).toBe(true);
    expect(store.get(sidebarCollapsedAtom)).toBe(false);

    store.set(syncCompactDesktopLayoutAtom, false);
    expect(store.get(navigationSidebarVisibleAtom)).toBe(true);
    expect(store.get(compactSidebarSuppressedAtom)).toBe(false);
  });

  it('does not suppress an already collapsed sidebar', () => {
    store.set(sidebarCollapsedAtom, true);

    store.set(syncCompactDesktopLayoutAtom, true);
    expect(store.get(navigationSidebarVisibleAtom)).toBe(false);
    expect(store.get(compactSidebarSuppressedAtom)).toBe(false);
  });

  it('reveals the suppressed sidebar when the user toggles it', () => {
    store.set(syncCompactDesktopLayoutAtom, true);
    expect(store.get(navigationSidebarVisibleAtom)).toBe(false);

    store.set(toggleNavigationSidebarAtom);
    // The toggle sees effective visibility, so a suppressed sidebar reveals
    // (as the overlay) instead of collapsing one level deeper.
    expect(store.get(navigationSidebarVisibleAtom)).toBe(true);
    expect(store.get(compactSidebarSuppressedAtom)).toBe(false);
    expect(store.get(sidebarCollapsedAtom)).toBe(false);

    // Widening afterwards keeps the revealed sidebar as a column.
    store.set(syncCompactDesktopLayoutAtom, false);
    expect(store.get(navigationSidebarVisibleAtom)).toBe(true);
  });

  it('persists a collapse toggled while the compact overlay is open', () => {
    store.set(syncCompactDesktopLayoutAtom, true);
    store.set(toggleNavigationSidebarAtom);
    expect(store.get(navigationSidebarVisibleAtom)).toBe(true);

    store.set(toggleNavigationSidebarAtom);
    expect(store.get(navigationSidebarVisibleAtom)).toBe(false);
    expect(store.get(sidebarCollapsedAtom)).toBe(true);

    // An explicit close stays closed after the window widens.
    store.set(syncCompactDesktopLayoutAtom, false);
    expect(store.get(navigationSidebarVisibleAtom)).toBe(false);
  });

  it('lets an explicit show request beat the suppression', () => {
    store.set(syncCompactDesktopLayoutAtom, true);
    store.set(showNavigationSidebarAtom);

    expect(store.get(navigationSidebarVisibleAtom)).toBe(true);
    expect(store.get(compactSidebarSuppressedAtom)).toBe(false);
    expect(store.get(sidebarCollapsedAtom)).toBe(false);
  });

  it('ignores a sync that does not change the compact flag', () => {
    store.set(syncCompactDesktopLayoutAtom, true);
    store.set(compactSidebarSuppressedAtom, false);

    store.set(syncCompactDesktopLayoutAtom, true);
    expect(store.get(compactSidebarSuppressedAtom)).toBe(false);
  });
});

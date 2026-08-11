// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  developerModeEnabledAtom,
  inboxBetaEnabledAtom,
  inboxFeatureEnabledAtom,
  tasksBetaEnabledAtom,
} from '../src/atoms/settings';
import { MobileAboutSettings } from '../src/components/mobile/mobile-about-settings';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(store: ReturnType<typeof createStore>): void {
  act(() => {
    root.render(
      <Provider store={store}>
        <MobileAboutSettings />
      </Provider>
    );
  });
}

/**
 * The commit-hash row is the reveal target. It is used instead of the version
 * row precisely because it always renders — the version row disappears when no
 * version is known, which would strand the gesture.
 */
function revealRow(): HTMLElement {
  const row = [...container.querySelectorAll('button, [role="button"]')].find((el) =>
    el.textContent?.includes('unknown')
  );
  if (!row) throw new Error('reveal row not found');
  return row as HTMLElement;
}

function switchLabelled(label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`);
}

beforeEach(async () => {
  localStorage.clear();
  await initI18n();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MobileAboutSettings developer mode', () => {
  it('hides the Developer mode switch until the commit row is tapped enough times', () => {
    const store = createStore();
    render(store);

    expect(switchLabelled('Developer mode')).toBeNull();

    // Six taps must not be enough — an off-by-one here would make the easter
    // egg reachable by ordinary fidgeting.
    for (let i = 0; i < 6; i += 1) {
      act(() => revealRow().click());
    }
    expect(switchLabelled('Developer mode')).toBeNull();

    act(() => revealRow().click());
    expect(switchLabelled('Developer mode')).not.toBeNull();
  });

  it('does not show beta switches until Developer mode is actually on', () => {
    const store = createStore();
    render(store);
    for (let i = 0; i < 7; i += 1) act(() => revealRow().click());

    // Revealed, but not enabled: the beta section stays away.
    expect(switchLabelled('Developer mode')).not.toBeNull();
    expect(switchLabelled('Tasks')).toBeNull();
    expect(switchLabelled('Inbox')).toBeNull();

    act(() => switchLabelled('Developer mode')?.click());

    expect(store.get(developerModeEnabledAtom)).toBe(true);
    expect(switchLabelled('Tasks')).not.toBeNull();
    expect(switchLabelled('Inbox')).not.toBeNull();
  });

  it('turns the Tasks beta on from mobile, which is the whole point of this surface', () => {
    const store = createStore();
    store.set(developerModeEnabledAtom, true);
    render(store);

    const tasks = switchLabelled('Tasks');
    expect(tasks).not.toBeNull();
    act(() => tasks?.click());

    expect(store.get(tasksBetaEnabledAtom)).toBe(true);
  });

  it('enables the mobile Inbox gate only after its beta switch is enabled', () => {
    const store = createStore();
    store.set(developerModeEnabledAtom, true);
    render(store);

    expect(store.get(inboxFeatureEnabledAtom)).toBe(false);
    const inbox = switchLabelled('Inbox');
    expect(inbox).not.toBeNull();
    act(() => inbox?.click());

    expect(store.get(inboxBetaEnabledAtom)).toBe(true);
    expect(store.get(inboxFeatureEnabledAtom)).toBe(true);
  });

  it('re-hides the switch when Developer mode is turned off, so the reveal must be earned again', () => {
    const store = createStore();
    store.set(developerModeEnabledAtom, true);
    render(store);
    expect(switchLabelled('Developer mode')).not.toBeNull();

    act(() => switchLabelled('Developer mode')?.click());

    expect(store.get(developerModeEnabledAtom)).toBe(false);
    expect(switchLabelled('Developer mode')).toBeNull();
    expect(switchLabelled('Tasks')).toBeNull();
    expect(switchLabelled('Inbox')).toBeNull();
    expect(store.get(inboxFeatureEnabledAtom)).toBe(false);
  });

  it('keeps beta opt-ins when Developer mode goes off', () => {
    const store = createStore();
    store.set(developerModeEnabledAtom, true);
    store.set(tasksBetaEnabledAtom, true);
    store.set(inboxBetaEnabledAtom, true);
    render(store);

    act(() => switchLabelled('Developer mode')?.click());

    // Same rule as desktop: each gate is a conjunction, so the features
    // disappear, but both choices survive for when Developer mode comes back.
    expect(store.get(tasksBetaEnabledAtom)).toBe(true);
    expect(store.get(inboxBetaEnabledAtom)).toBe(true);
    expect(store.get(inboxFeatureEnabledAtom)).toBe(false);
  });
});

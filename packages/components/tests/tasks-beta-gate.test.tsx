// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider, useAtomValue } from 'jotai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  developerModeEnabledAtom,
  tasksBetaEnabledAtom,
  tasksFeatureEnabledAtom,
} from '../src/atoms/settings';
import { BetaFeaturesSection } from '../src/components/settings/beta-features-setting';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  // Both atoms are localStorage-backed, so a fresh jotai store is not a fresh
  // gate — it rehydrates whatever the previous test persisted.
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

function renderWith(store: ReturnType<typeof createStore>, node: React.ReactNode): void {
  act(() => {
    root.render(<Provider store={store}>{node}</Provider>);
  });
}

describe('tasksFeatureEnabledAtom', () => {
  it('stays off until BOTH developer mode and the beta opt-in are on', () => {
    const store = createStore();
    expect(store.get(tasksFeatureEnabledAtom)).toBe(false);

    store.set(tasksBetaEnabledAtom, true);
    expect(store.get(tasksFeatureEnabledAtom)).toBe(false);

    store.set(tasksBetaEnabledAtom, false);
    store.set(developerModeEnabledAtom, true);
    expect(store.get(tasksFeatureEnabledAtom)).toBe(false);

    store.set(tasksBetaEnabledAtom, true);
    expect(store.get(tasksFeatureEnabledAtom)).toBe(true);
  });

  it('hides the feature when developer mode goes off, without discarding the opt-in', () => {
    const store = createStore();
    store.set(developerModeEnabledAtom, true);
    store.set(tasksBetaEnabledAtom, true);
    expect(store.get(tasksFeatureEnabledAtom)).toBe(true);

    store.set(developerModeEnabledAtom, false);
    expect(store.get(tasksFeatureEnabledAtom)).toBe(false);
    // The opt-in survives, so re-enabling developer mode restores the choice
    // instead of silently resetting it.
    expect(store.get(tasksBetaEnabledAtom)).toBe(true);

    store.set(developerModeEnabledAtom, true);
    expect(store.get(tasksFeatureEnabledAtom)).toBe(true);
  });
});

describe('BetaFeaturesSection', () => {
  it('renders nothing at all while developer mode is off', () => {
    const store = createStore();
    renderWith(store, <BetaFeaturesSection />);
    expect(container.textContent).toBe('');
    expect(container.querySelector('button[role="switch"]')).toBeNull();
  });

  it('exposes the Tasks switch once developer mode is on, and writes the opt-in', () => {
    const store = createStore();
    store.set(developerModeEnabledAtom, true);
    renderWith(store, <BetaFeaturesSection />);

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Tasks"]'
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(store.get(tasksFeatureEnabledAtom)).toBe(false);

    act(() => toggle?.click());

    expect(store.get(tasksBetaEnabledAtom)).toBe(true);
    expect(store.get(tasksFeatureEnabledAtom)).toBe(true);
  });
});

describe('gate consumers', () => {
  it('drives a consumer from the single derived atom', () => {
    const store = createStore();
    const seen: boolean[] = [];

    function Probe() {
      seen.push(useAtomValue(tasksFeatureEnabledAtom));
      return null;
    }

    renderWith(store, <Probe />);
    expect(seen.at(-1)).toBe(false);

    act(() => {
      store.set(developerModeEnabledAtom, true);
      store.set(tasksBetaEnabledAtom, true);
    });
    expect(seen.at(-1)).toBe(true);

    act(() => store.set(developerModeEnabledAtom, false));
    expect(seen.at(-1)).toBe(false);
  });
});

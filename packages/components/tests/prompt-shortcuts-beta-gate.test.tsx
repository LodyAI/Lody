// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import {
  projectShortcutIndex,
  type PromptShortcut,
  type PromptShortcutRuntime,
} from '@lody/shared/prompt-shortcuts';
import {
  developerModeEnabledAtom,
  promptShortcutsBetaEnabledAtom,
  promptShortcutsFeatureEnabledAtom,
} from '../src/atoms/settings';
import { BetaFeaturesSection } from '../src/components/settings/beta-features-setting';
import { useVisibleSettingsTabs } from '../src/components/settings/settings-tabs';
import { useShortcutMentionSource } from '../src/components/mentions/use-shortcut-mention-source';
import { initI18n } from '../src/i18n';

vi.mock('../src/lib/app-platform', () => ({ useAppCapabilityCheck: () => () => true }));
vi.mock('../src/providers/prompt-shortcut-provider', () => ({ usePromptShortcuts: () => catalog }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const shortcut: PromptShortcut = {
  v: 1,
  id: 'review',
  revision: 'r1',
  workspaceId: 'ws',
  ownerUserId: 'user',
  visibility: 'private',
  name: 'Review',
  slug: 'review',
  prompt: 'Review this code',
  scope: {},
  mentions: [],
  createdAt: 1,
  updatedAt: 1,
};
const entry = projectShortcutIndex(shortcut, 'body');
const read = vi.fn<PromptShortcutRuntime['read']>();
const catalog = {
  runtime: { workspaceId: 'ws', userId: 'user', read, getSnapshot: () => ({ entries: [entry] }) },
  entries: [entry],
  loading: false,
};
let store: ReturnType<typeof createStore>, root: Root, container: HTMLDivElement;
let source: ReturnType<typeof useShortcutMentionSource>;
function Probe() {
  source = useShortcutMentionSource({}, 'draft');
  const tabs = useVisibleSettingsTabs();
  return (
    <>
      <BetaFeaturesSection />
      <div data-tabs>{tabs.map((tab) => tab.id).join(',')}</div>
    </>
  );
}
beforeEach(async () => {
  localStorage.clear();
  await initI18n('en');
  read.mockReset().mockResolvedValue(shortcut);
  store = createStore();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <Provider store={store}>
        <Probe />
      </Provider>
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
});
it('requires both switches for navigation and discovery, retaining the opt-in across developer mode toggles', async () => {
  expect(store.get(promptShortcutsFeatureEnabledAtom)).toBe(false);
  expect(container.querySelector('[role=switch]')).toBeNull();
  expect(source?.enabled).toBe(false);
  expect(source?.getCandidates('')).toEqual([]);
  expect(container.querySelector('[data-tabs]')?.textContent).not.toContain('prompt-shortcuts');
  await act(async () => store.set(developerModeEnabledAtom, true));
  const toggle = container.querySelector<HTMLButtonElement>(
    '[role=switch][aria-label="Prompt Shortcuts"]'
  )!;
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(source?.enabled).toBe(false);
  await act(async () => toggle.click());
  expect(store.get(promptShortcutsFeatureEnabledAtom)).toBe(true);
  expect(source?.getCandidates('')).toHaveLength(1);
  expect(read).not.toHaveBeenCalled();
  expect(container.querySelector('[data-tabs]')?.textContent).toContain('prompt-shortcuts');
  await act(async () => store.set(developerModeEnabledAtom, false));
  expect(source?.enabled).toBe(false);
  expect(container.querySelector('[data-tabs]')?.textContent).not.toContain('prompt-shortcuts');
  expect(store.get(promptShortcutsBetaEnabledAtom)).toBe(true);
  await act(async () => store.set(developerModeEnabledAtom, true));
  expect(source?.enabled).toBe(true);
});
it('discards an in-flight body selection when the feature is disabled', async () => {
  await act(async () => {
    store.set(developerModeEnabledAtom, true);
    store.set(promptShortcutsBetaEnabledAtom, true);
  });
  let finish!: (value: PromptShortcut) => void;
  read.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const prepare = source!.getCandidates('')[0]!.onPrepare!;
  let pending!: ReturnType<typeof prepare>;
  await act(async () => {
    pending = prepare({ signal: new AbortController().signal });
  });
  expect(read).toHaveBeenCalledOnce();
  await act(async () => store.set(promptShortcutsBetaEnabledAtom, false));
  await act(async () => finish(shortcut));
  expect(await pending).toBeNull();
  expect(source?.getCandidates('review')).toEqual([]);
});

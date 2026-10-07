// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KeyboardShortcutsSetting } from '../src/components/settings/keyboard-shortcuts-setting';
import { initI18n } from '../src/i18n';
import { commands } from '../src/lib/commands';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PALETTE = 'Bravo palette opener';
const SUBMIT = 'Charlie message sender';
const WINDOW = 'Alpha window cycler';

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('KeyboardShortcutsSetting search', () => {
  let root: Root;
  let container: HTMLDivElement;
  let disposers: Array<() => void> = [];

  beforeEach(async () => {
    await initI18n('en');
    (window as { __LODY_PLATFORM__?: { os: string } }).__LODY_PLATFORM__ = { os: 'linux' };
    __resetPlatformCacheForTests();
    commands.resetAllUserKeybindings();
    disposers = [
      commands.register({
        id: 'test.search.window',
        title: WINDOW,
        category: 'Navigation',
        keybindings: ['Mod+Shift+]'],
        run: () => {},
      }),
      commands.register({
        id: 'test.search.palette',
        title: PALETTE,
        category: 'Navigation',
        keybindings: ['Mod+K', 'Mod+Shift+P'],
        run: () => {},
      }),
      commands.register({
        id: 'test.search.submit',
        title: SUBMIT,
        category: 'Editor',
        keybindings: ['Enter'],
        run: () => {},
      }),
    ];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(KeyboardShortcutsSetting)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    for (const dispose of disposers) dispose();
    // A captured combo leaves the registry paused for its settle window.
    commands.setPaused(false);
    delete (window as { __LODY_PLATFORM__?: unknown }).__LODY_PLATFORM__;
    __resetPlatformCacheForTests();
  });

  const searchInput = () =>
    container.querySelector<HTMLInputElement>('input[aria-label="Search shortcuts"]')!;
  const keySearchButton = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Search by keystroke"]')!;
  const text = () => container.textContent ?? '';

  function captureKeys(init: KeyboardEventInit) {
    act(() => keySearchButton().click());
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    });
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keyup', {
          bubbles: true,
          key: init.key,
          code: init.code,
        })
      );
    });
  }

  it('filters rows by name and hides categories left empty', () => {
    act(() => setInputValue(searchInput(), 'PALETTE'));

    expect(text()).toContain(PALETTE);
    expect(text()).not.toContain(WINDOW);
    expect(text()).not.toContain(SUBMIT);
    expect(text()).toContain('Navigation');
    expect(text()).not.toContain('Editor');
  });

  it('shows the empty note when nothing matches and clears the text on Escape', () => {
    act(() => setInputValue(searchInput(), 'no such shortcut'));
    expect(text()).toContain('No matching shortcuts');
    expect(text()).not.toContain(PALETTE);

    act(() => {
      searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(searchInput().value).toBe('');
    expect(text()).not.toContain('No matching shortcuts');
    expect(text()).toContain(PALETTE);
    expect(text()).toContain(SUBMIT);
  });

  it('filters by a recorded bare key and restores every row once cleared', () => {
    captureKeys({ key: 'Enter', code: 'Enter' });

    expect(text()).toContain(SUBMIT);
    expect(text()).not.toContain(PALETTE);
    expect(text()).not.toContain(WINDOW);

    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Clear keystroke filter"]')!
        .click()
    );

    expect(text()).toContain(SUBMIT);
    expect(text()).toContain(PALETTE);
    expect(text()).toContain(WINDOW);
  });

  it('matches a recorded combo against a non-primary binding, combined with the name', () => {
    captureKeys({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true });

    expect(text()).toContain(PALETTE);
    expect(text()).not.toContain(SUBMIT);

    act(() => setInputValue(searchInput(), 'charlie'));

    expect(text()).not.toContain(PALETTE);
    expect(text()).toContain('No matching shortcuts');
  });
});

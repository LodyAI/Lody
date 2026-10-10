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
    container.querySelector<HTMLInputElement>('input[aria-label="Search shortcuts"]');
  const keystrokeField = () =>
    container.querySelector<HTMLElement>('[role="textbox"][aria-label="Press a shortcut…"]');
  const keystrokeToggle = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Search by keystroke"]')!;
  const text = () => container.textContent ?? '';

  function pressKeys(init: KeyboardEventInit) {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    });
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keyup', { bubbles: true, key: init.key, code: init.code })
      );
    });
  }

  function expectAllRows() {
    expect(text()).toContain(SUBMIT);
    expect(text()).toContain(PALETTE);
    expect(text()).toContain(WINDOW);
  }

  it('filters rows by name and hides categories left empty', () => {
    act(() => setInputValue(searchInput()!, 'PALETTE'));

    expect(text()).toContain(PALETTE);
    expect(text()).not.toContain(WINDOW);
    expect(text()).not.toContain(SUBMIT);
    expect(text()).toContain('Navigation');
    expect(text()).not.toContain('Editor');
  });

  it('shows the empty note when nothing matches and clears the text on Escape', () => {
    act(() => setInputValue(searchInput()!, 'no such shortcut'));
    expect(text()).toContain('No matching shortcuts');
    expect(text()).not.toContain(PALETTE);

    act(() => {
      searchInput()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(searchInput()!.value).toBe('');
    expect(text()).not.toContain('No matching shortcuts');
    expectAllRows();
  });

  it('starts in text mode and swaps the typed query for a keystroke field', () => {
    expect(keystrokeToggle().getAttribute('aria-pressed')).toBe('false');
    expect(keystrokeField()).toBeNull();
    act(() => setInputValue(searchInput()!, 'charlie'));
    expect(text()).not.toContain(PALETTE);

    act(() => keystrokeToggle().click());

    expect(keystrokeToggle().getAttribute('aria-pressed')).toBe('true');
    expect(searchInput()).toBeNull();
    expect(keystrokeField()?.textContent).toContain('Press a shortcut…');
    expectAllRows();
  });

  it('filters by each pressed combo, the next one replacing the last', () => {
    act(() => keystrokeToggle().click());

    pressKeys({ key: 'Enter', code: 'Enter' });

    expect(text()).toContain(SUBMIT);
    expect(text()).not.toContain(PALETTE);
    expect(text()).not.toContain(WINDOW);
    expect(keystrokeField()?.textContent).not.toContain('Press a shortcut…');

    // A non-primary binding matches too, and no second click is needed.
    pressKeys({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true });

    expect(text()).toContain(PALETTE);
    expect(text()).not.toContain(SUBMIT);
    expect(text()).not.toContain('No matching shortcuts');
  });

  it('clears the key filter and returns to text mode when toggled off', () => {
    act(() => keystrokeToggle().click());
    pressKeys({ key: 'Enter', code: 'Enter' });
    expect(text()).not.toContain(PALETTE);

    act(() => keystrokeToggle().click());

    expect(keystrokeToggle().getAttribute('aria-pressed')).toBe('false');
    expect(keystrokeField()).toBeNull();
    expect(searchInput()!.value).toBe('');
    expectAllRows();
  });

  it('leaves keystroke mode on a bare Escape', () => {
    act(() => keystrokeToggle().click());
    pressKeys({ key: 'Enter', code: 'Enter' });
    expect(text()).not.toContain(PALETTE);

    pressKeys({ key: 'Escape', code: 'Escape' });

    expect(keystrokeToggle().getAttribute('aria-pressed')).toBe('false');
    expect(searchInput()).not.toBeNull();
    expectAllRows();
  });

  it('keeps the key filter while a filtered row records, and resumes on a click', () => {
    act(() => keystrokeToggle().click());
    pressKeys({ key: 'Enter', code: 'Enter' });

    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[title="Click to record a new shortcut"]')!
        .click()
    );

    expect(keystrokeToggle().getAttribute('aria-pressed')).toBe('true');
    expect(text()).toContain(SUBMIT);
    expect(text()).not.toContain(PALETTE);
    expect(text()).not.toContain(WINDOW);

    act(() => keystrokeField()!.click());
    pressKeys({ key: 'K', code: 'KeyK', ctrlKey: true });

    expect(text()).toContain(PALETTE);
    expect(text()).not.toContain(SUBMIT);
    // The row's capture was superseded rather than fed the combo.
    expect(commands.getKeybindingsFor('test.search.submit')).toEqual(['Enter']);
  });
});

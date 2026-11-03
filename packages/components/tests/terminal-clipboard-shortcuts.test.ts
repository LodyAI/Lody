// @vitest-environment jsdom

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  copyShortcutBinding,
  isCopyShortcut,
  isPasteShortcut,
  usesWindowsCopyPasteRightClick,
} from '../src/components/terminal/terminal-clipboard-shortcuts';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';

function keyEvent(init: Partial<KeyboardEvent> & Pick<KeyboardEvent, 'key'>): KeyboardEvent {
  return {
    type: 'keydown',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    code: '',
    ...init,
  } as KeyboardEvent;
}

function stubPlatform(os: 'win32' | 'darwin' | 'linux'): void {
  vi.stubGlobal('__LODY_PLATFORM__', { os });
  __resetPlatformCacheForTests();
}

describe('terminal clipboard shortcuts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetPlatformCacheForTests();
  });

  it('on Windows copies with Ctrl+C only when text is selected', () => {
    stubPlatform('win32');
    expect(isCopyShortcut(keyEvent({ key: 'c', code: 'KeyC', ctrlKey: true }), true)).toBe(true);
    expect(isCopyShortcut(keyEvent({ key: 'c', code: 'KeyC', ctrlKey: true }), false)).toBe(false);
    expect(copyShortcutBinding()).toBe('ctrl+c');
    expect(usesWindowsCopyPasteRightClick()).toBe(true);
  });

  it('on Linux keeps Ctrl+V for the shell and pastes with Ctrl+Shift+V', () => {
    stubPlatform('linux');
    expect(isPasteShortcut(keyEvent({ key: 'v', code: 'KeyV', ctrlKey: true }))).toBe(false);
    expect(
      isPasteShortcut(keyEvent({ key: 'v', code: 'KeyV', ctrlKey: true, shiftKey: true }))
    ).toBe(true);
    expect(isCopyShortcut(keyEvent({ key: 'c', code: 'KeyC', ctrlKey: true }), true)).toBe(false);
    expect(copyShortcutBinding()).toBe('ctrl+shift+c');
    expect(usesWindowsCopyPasteRightClick()).toBe(false);
  });
});

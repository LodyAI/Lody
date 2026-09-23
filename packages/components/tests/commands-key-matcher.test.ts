import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalizeBinding, matchesKeyboardEvent } from '../src/lib/commands/key-matcher';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';

function setPlatform(os: 'darwin' | 'linux') {
  vi.stubGlobal('window', { __LODY_PLATFORM__: { os } });
  __resetPlatformCacheForTests();
}

function ev(init: Partial<KeyboardEventInit> & { key: string; code?: string }): KeyboardEvent {
  return {
    key: init.key,
    code: init.code ?? '',
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  } as KeyboardEvent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetPlatformCacheForTests();
});

describe('canonicalizeBinding', () => {
  it('uses TanStack Hotkeys normalization for aliases, modifier order, and key casing', () => {
    setPlatform('darwin');
    expect(canonicalizeBinding('shift+cmd+b')).toBe('Mod+Shift+B');
    expect(canonicalizeBinding('Mod+Shift+B')).toBe('Mod+Shift+B');
  });

  it('normalizes the platform primary modifier to Mod', () => {
    setPlatform('linux');
    expect(canonicalizeBinding('Control+B')).toBe('Mod+B');
  });

  it('rejects an unknown modifier', () => {
    setPlatform('linux');
    expect(canonicalizeBinding('Hyper+B')).toBeNull();
  });
});

describe('matchesKeyboardEvent', () => {
  it('resolves Mod by platform and rejects extra modifiers', () => {
    setPlatform('darwin');
    expect(matchesKeyboardEvent(ev({ key: 'b', code: 'KeyB', metaKey: true }), 'Mod+B')).toBe(true);
    expect(matchesKeyboardEvent(ev({ key: 'b', code: 'KeyB', ctrlKey: true }), 'Mod+B')).toBe(
      false
    );
    expect(
      matchesKeyboardEvent(ev({ key: 'b', code: 'KeyB', metaKey: true, shiftKey: true }), 'Mod+B')
    ).toBe(false);
  });

  it('uses the engine event.code fallback for macOS Option glyphs', () => {
    setPlatform('darwin');
    expect(matchesKeyboardEvent(ev({ key: '∫', code: 'KeyB', altKey: true }), 'Alt+B')).toBe(true);
    expect(matchesKeyboardEvent(ev({ key: '¡', code: 'Digit1', altKey: true }), 'Alt+1')).toBe(
      true
    );
  });

  it('keeps number-row and numpad digits equivalent', () => {
    setPlatform('linux');
    expect(matchesKeyboardEvent(ev({ key: '1', code: 'Digit1', ctrlKey: true }), 'Mod+1')).toBe(
      true
    );
    expect(matchesKeyboardEvent(ev({ key: '1', code: 'Numpad1', ctrlKey: true }), 'Mod+1')).toBe(
      true
    );
  });

  it('uses the engine event.code fallback for shifted punctuation', () => {
    setPlatform('darwin');
    expect(
      matchesKeyboardEvent(
        ev({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true }),
        'Mod+Shift+['
      )
    ).toBe(true);
    expect(
      matchesKeyboardEvent(
        ev({ key: '<', code: 'Comma', metaKey: true, shiftKey: true }),
        'Mod+Shift+,'
      )
    ).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import {
  bindingToTinykeys,
  canonicalizeBinding,
  matchesKeyboardEvent,
  parseBinding,
} from '../src/lib/commands/key-matcher';

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

describe('parseBinding', () => {
  it('parses single keys', () => {
    expect(parseBinding('Escape')).toMatchObject({ key: 'Escape', mod: false });
    expect(parseBinding('a')).toMatchObject({ key: 'a' });
  });

  it('treats $mod, mod, cmd, command as $mod', () => {
    expect(parseBinding('$mod+b').mod).toBe(true);
    expect(parseBinding('Cmd+b').mod).toBe(true);
    expect(parseBinding('command+b').mod).toBe(true);
    expect(parseBinding('mod+b').mod).toBe(true);
  });

  it('parses explicit modifiers', () => {
    const p = parseBinding('Ctrl+Alt+Shift+k');
    expect(p).toMatchObject({ key: 'k', ctrl: true, alt: true, shift: true });
  });

  it('normalizes friendly aliases', () => {
    expect(parseBinding('Esc').key).toBe('Escape');
    expect(parseBinding('Up').key).toBe('ArrowUp');
    // 'Space' (not ' ') so it matches normalizeEventKey(' ') and the spacebar's event.code.
    expect(parseBinding('Space').key).toBe('Space');
    expect(parseBinding('Return').key).toBe('Enter');
  });

  it('lowercases single-char keys', () => {
    expect(parseBinding('B').key).toBe('b');
  });

  it('throws on unknown modifier', () => {
    expect(() => parseBinding('Hyper+b')).toThrow();
  });
});

describe('matchesKeyboardEvent', () => {
  it('$mod resolves to ⌘ on macOS', () => {
    const p = parseBinding('$mod+b');
    expect(matchesKeyboardEvent(p, ev({ key: 'b', metaKey: true }), true)).toBe(true);
    expect(matchesKeyboardEvent(p, ev({ key: 'b', ctrlKey: true }), true)).toBe(false);
  });

  it('$mod resolves to Ctrl on non-macOS', () => {
    const p = parseBinding('$mod+b');
    expect(matchesKeyboardEvent(p, ev({ key: 'b', ctrlKey: true }), false)).toBe(true);
    expect(matchesKeyboardEvent(p, ev({ key: 'b', metaKey: true }), false)).toBe(false);
  });

  it('rejects extra modifiers', () => {
    const p = parseBinding('$mod+b');
    expect(matchesKeyboardEvent(p, ev({ key: 'b', metaKey: true, shiftKey: true }), true)).toBe(
      false
    );
    expect(matchesKeyboardEvent(p, ev({ key: 'b', metaKey: true, altKey: true }), true)).toBe(
      false
    );
  });

  it('$mod+f matches only the exact find chord (no extra modifiers)', () => {
    // Session find (⌘F / Ctrl+F) must not steal chords that include other
    // modifiers — users may be aiming at OS/browser/app shortcuts.
    const find = parseBinding('$mod+f');
    expect(matchesKeyboardEvent(find, ev({ key: 'f', code: 'KeyF', metaKey: true }), true)).toBe(
      true
    );
    expect(matchesKeyboardEvent(find, ev({ key: 'f', code: 'KeyF', ctrlKey: true }), false)).toBe(
      true
    );
    // Extra modifiers
    expect(
      matchesKeyboardEvent(find, ev({ key: 'f', code: 'KeyF', metaKey: true, altKey: true }), true)
    ).toBe(false);
    expect(
      matchesKeyboardEvent(
        find,
        ev({ key: 'f', code: 'KeyF', metaKey: true, shiftKey: true }),
        true
      )
    ).toBe(false);
    expect(
      matchesKeyboardEvent(find, ev({ key: 'f', code: 'KeyF', metaKey: true, ctrlKey: true }), true)
    ).toBe(false);
    expect(
      matchesKeyboardEvent(
        find,
        ev({ key: 'f', code: 'KeyF', ctrlKey: true, metaKey: true }),
        false
      )
    ).toBe(false);
    expect(
      matchesKeyboardEvent(find, ev({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true }), false)
    ).toBe(false);
    // Wrong primary mod for the platform
    expect(matchesKeyboardEvent(find, ev({ key: 'f', code: 'KeyF', ctrlKey: true }), true)).toBe(
      false
    );
    expect(matchesKeyboardEvent(find, ev({ key: 'f', code: 'KeyF', metaKey: true }), false)).toBe(
      false
    );
  });

  it('case-insensitive letter matching', () => {
    const p = parseBinding('$mod+B');
    expect(matchesKeyboardEvent(p, ev({ key: 'b', metaKey: true }), true)).toBe(true);
    expect(matchesKeyboardEvent(p, ev({ key: 'B', metaKey: true }), true)).toBe(true);
  });

  it('matches named keys without modifiers', () => {
    const p = parseBinding('Escape');
    expect(matchesKeyboardEvent(p, ev({ key: 'Escape' }), true)).toBe(true);
    expect(matchesKeyboardEvent(p, ev({ key: 'Escape', metaKey: true }), true)).toBe(false);
  });

  it('shift+enter is distinct from enter', () => {
    const a = parseBinding('Shift+Enter');
    const b = parseBinding('Enter');
    expect(matchesKeyboardEvent(a, ev({ key: 'Enter', shiftKey: true }), false)).toBe(true);
    expect(matchesKeyboardEvent(b, ev({ key: 'Enter', shiftKey: true }), false)).toBe(false);
    expect(matchesKeyboardEvent(b, ev({ key: 'Enter' }), false)).toBe(true);
  });

  it('matches a Space binding against the spacebar event', () => {
    // key-capture saves the spacebar as the string 'Space'; the live event reports
    // key === ' ' / code === 'Space'. Both must normalize to 'Space' or the binding
    // would parse to ' ' and never fire. Regression guard for that mismatch.
    const space = parseBinding('Space');
    expect(matchesKeyboardEvent(space, ev({ key: ' ', code: 'Space' }), false)).toBe(true);
    const modSpace = parseBinding('$mod+Space');
    expect(
      matchesKeyboardEvent(modSpace, ev({ key: ' ', code: 'Space', metaKey: true }), true)
    ).toBe(true);
  });

  it('disambiguates Cmd+B vs Ctrl+B on macOS', () => {
    // When user binds explicit Ctrl, $mod still means Cmd on Mac.
    const cmdB = parseBinding('$mod+b');
    const ctrlB = parseBinding('Ctrl+b');
    expect(matchesKeyboardEvent(cmdB, ev({ key: 'b', ctrlKey: true }), true)).toBe(false);
    expect(matchesKeyboardEvent(ctrlB, ev({ key: 'b', ctrlKey: true }), true)).toBe(true);
    expect(matchesKeyboardEvent(ctrlB, ev({ key: 'b', metaKey: true }), true)).toBe(false);
  });

  it('matches Alt+letter using event.code (macOS reports glyph in event.key)', () => {
    // On macOS, ⌥B → event.key === '∫' but event.code === 'KeyB'. The matcher must
    // see this as the binding `Alt+b`, otherwise no Alt-modified letter shortcut would
    // ever fire on a Mac.
    const altB = parseBinding('Alt+b');
    expect(matchesKeyboardEvent(altB, ev({ key: '∫', code: 'KeyB', altKey: true }), true)).toBe(
      true
    );
    // Without altKey, the Mac glyph wouldn't be produced — sanity-check the inverse
    // doesn't silently fire either.
    expect(matchesKeyboardEvent(altB, ev({ key: 'b', code: 'KeyB' }), true)).toBe(false);
  });

  it('matches ⌘⇧ bracket / comma / period by physical key, not the shifted glyph', () => {
    // Shift turns '[' into '{', ',' into '<', etc. in event.key. The matcher must read
    // the physical key (event.code) so the conversation/tab-switch shortcuts still fire.
    const prevConversation = parseBinding('$mod+Shift+[');
    expect(
      matchesKeyboardEvent(
        prevConversation,
        ev({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true }),
        true
      )
    ).toBe(true);
    const nextConversation = parseBinding('$mod+Shift+]');
    expect(
      matchesKeyboardEvent(
        nextConversation,
        ev({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true }),
        true
      )
    ).toBe(true);
    const previousTab = parseBinding('$mod+Shift+,');
    expect(
      matchesKeyboardEvent(
        previousTab,
        ev({ key: '<', code: 'Comma', metaKey: true, shiftKey: true }),
        true
      )
    ).toBe(true);
    const nextTab = parseBinding('$mod+Shift+.');
    expect(
      matchesKeyboardEvent(
        nextTab,
        ev({ key: '>', code: 'Period', metaKey: true, shiftKey: true }),
        true
      )
    ).toBe(true);
    // The same combo without Shift must NOT match the Shift binding.
    expect(
      matchesKeyboardEvent(
        prevConversation,
        ev({ key: '[', code: 'BracketLeft', metaKey: true }),
        true
      )
    ).toBe(false);
  });

  it('matches Cmd+Alt+letter on macOS', () => {
    const cmdAltB = parseBinding('$mod+Alt+b');
    expect(
      matchesKeyboardEvent(
        cmdAltB,
        ev({ key: '∫', code: 'KeyB', metaKey: true, altKey: true }),
        true
      )
    ).toBe(true);
  });

  it('matches Alt+digit using event.code (option-digits report symbols in event.key)', () => {
    // ⌥1 → event.key === '¡' on Mac. Same fix applies.
    const altOne = parseBinding('Alt+1');
    expect(matchesKeyboardEvent(altOne, ev({ key: '¡', code: 'Digit1', altKey: true }), true)).toBe(
      true
    );
  });
});

describe('canonicalizeBinding', () => {
  it('is modifier-order independent (so global-shortcut conflict checks agree)', () => {
    expect(canonicalizeBinding('$mod+Shift+n')).toBe(canonicalizeBinding('Shift+$mod+n'));
  });

  it('distinguishes combos that differ only by a modifier', () => {
    expect(canonicalizeBinding('$mod+n')).not.toBe(canonicalizeBinding('$mod+Shift+n'));
  });

  it('returns null for an unparseable binding', () => {
    expect(canonicalizeBinding('Hyper+n')).toBeNull();
  });
});

describe('bindingToTinykeys', () => {
  it('uses event.code syntax for layout-stable letters, numbers, and punctuation', () => {
    expect(bindingToTinykeys('$mod+Alt+b')).toBe('$mod+Alt+KeyB');
    expect(bindingToTinykeys('Control+1')).toBe('Control+(Digit1|Numpad1)');
    expect(bindingToTinykeys('$mod+Shift+[')).toBe('$mod+Shift+BracketLeft');
    expect(bindingToTinykeys('$mod+Shift+,')).toBe('$mod+Shift+Comma');
  });

  it('preserves named keys and rejects invalid public bindings', () => {
    expect(bindingToTinykeys('Shift+Enter')).toBe('Shift+Enter');
    expect(bindingToTinykeys('Hyper+k')).toBeNull();
    expect(bindingToTinykeys('(.*)')).toBeNull();
    expect(bindingToTinykeys('a b')).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { eventToBindingString } from '../src/lib/commands/key-capture';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';

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

describe('eventToBindingString (non-mac)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { __LODY_PLATFORM__: { os: 'linux' } });
    __resetPlatformCacheForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetPlatformCacheForTests();
  });

  it('encodes ctrl as Mod', () => {
    expect(eventToBindingString(ev({ key: 'b', ctrlKey: true }))).toBe('Mod+B');
  });

  it('encodes meta as Meta (secondary on non-mac)', () => {
    expect(eventToBindingString(ev({ key: 'b', metaKey: true }))).toBe('Meta+B');
  });

  it('preserves modifier ordering: Mod, secondary, alt, shift, key', () => {
    expect(
      eventToBindingString(ev({ key: 'b', ctrlKey: true, altKey: true, shiftKey: true }))
    ).toBe('Mod+Alt+Shift+B');
  });

  it('returns null for modifier-only events', () => {
    expect(eventToBindingString(ev({ key: 'Shift', shiftKey: true }))).toBeNull();
    expect(eventToBindingString(ev({ key: 'Control', ctrlKey: true }))).toBeNull();
    expect(eventToBindingString(ev({ key: 'Meta', metaKey: true }))).toBeNull();
  });

  it('canonicalizes single-letter keys and preserves named keys', () => {
    expect(eventToBindingString(ev({ key: 'B' }))).toBe('B');
    expect(eventToBindingString(ev({ key: 'Enter' }))).toBe('Enter');
    expect(eventToBindingString(ev({ key: 'ArrowUp' }))).toBe('ArrowUp');
  });

  it('encodes Space as Space (KeyboardEvent.key=" " round-trips through parser)', () => {
    expect(eventToBindingString(ev({ key: ' ' }))).toBe('Space');
  });
});

describe('eventToBindingString (mac)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { __LODY_PLATFORM__: { os: 'darwin' } });
    __resetPlatformCacheForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetPlatformCacheForTests();
  });

  it('encodes meta as Mod', () => {
    expect(eventToBindingString(ev({ key: 'b', metaKey: true }))).toBe('Mod+B');
  });

  it('encodes ctrl as Control (secondary on mac)', () => {
    expect(eventToBindingString(ev({ key: 'b', ctrlKey: true }))).toBe('Control+B');
  });

  it('Cmd+Ctrl combo emits both', () => {
    expect(eventToBindingString(ev({ key: 'b', metaKey: true, ctrlKey: true }))).toBe(
      'Control+Meta+B'
    );
  });

  it('uses event.code for Alt+letter so ⌥B encodes as Mod+Alt+B, not the option glyph', () => {
    // The whole reason event.code resolution exists — without it, the captured binding
    // string would contain "∫" and the resulting binding would only fire when the user
    // re-pressed ⌥B AND the OS happened to produce the same glyph. Layout-fragile.
    expect(eventToBindingString(ev({ key: '∫', code: 'KeyB', metaKey: true, altKey: true }))).toBe(
      'Mod+Alt+B'
    );
  });

  it('uses event.code for Alt+digit too', () => {
    expect(eventToBindingString(ev({ key: '¡', code: 'Digit1', altKey: true }))).toBe('Alt+1');
  });
});

import { describe, expect, it } from 'vitest';

import { bindingToElectronAccelerator, migrateLegacyShortcutBinding } from '../src/electron-ipc';

describe('bindingToElectronAccelerator', () => {
  it('allows a global shortcut to be unset', () => {
    expect(bindingToElectronAccelerator(null)).toBeNull();
  });

  it('refuses modifier-less bindings (would swallow a bare key OS-wide)', () => {
    expect(bindingToElectronAccelerator('k')).toBeNull();
    expect(bindingToElectronAccelerator('Space')).toBeNull();
    expect(bindingToElectronAccelerator('F2')).toBeNull();
  });

  it('refuses Shift-only bindings that would intercept normal typing OS-wide', () => {
    expect(bindingToElectronAccelerator('Shift+n')).toBeNull();
    expect(bindingToElectronAccelerator('Shift+1')).toBeNull();
    expect(bindingToElectronAccelerator('Shift+F2')).toBeNull();
  });
});

describe('migrateLegacyShortcutBinding', () => {
  it('rewrites only the legacy primary-modifier token', () => {
    expect(migrateLegacyShortcutBinding('$mod+Shift+b')).toBe('Mod+Shift+b');
    expect(migrateLegacyShortcutBinding('Shift+$MOD+k')).toBe('Shift+Mod+k');
    expect(migrateLegacyShortcutBinding('Mod+Shift+b')).toBe('Mod+Shift+b');
  });
});

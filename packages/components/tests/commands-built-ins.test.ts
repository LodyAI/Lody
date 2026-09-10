import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commands, registerBuiltInCommands, unregisterBuiltInCommands } from '../src/lib/commands';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';

beforeEach(() => {
  __resetPlatformCacheForTests();
});

afterEach(() => {
  unregisterBuiltInCommands();
  for (const cmd of commands.list()) commands.unregister(cmd.id);
  vi.unstubAllGlobals();
  __resetPlatformCacheForTests();
});

describe('built-in commands', () => {
  it('registers web-safe session shortcut definitions for keyboard settings', () => {
    registerBuiltInCommands();

    expect(commands.get('session.archiveCurrent')?.title).toBe('Archive Current Chat');
    expect(commands.getDefaultKeybindingsFor('session.archiveCurrent')).toEqual(['$mod+Alt+a']);
    expect(commands.getDefaultKeybindingsFor('session.searchCurrent')).toEqual(['$mod+Alt+f']);
    expect(commands.getDefaultKeybindingsFor('session.focusInput')).toEqual([]);
    expect(commands.getDefaultKeybindingsFor('session.nextTab')).toEqual([]);
    expect(commands.getDefaultKeybindingsFor('session.previousVisible')).toEqual([]);
    // ⌥N works on web too (always a new tab there); ⌘[/⌘] back/forward and the terminal
    // toggle are electron-only; ⌘, settings is cross-platform (desktop's native menu shows
    // it but doesn't register it — the registry owns the binding).
    expect(commands.getDefaultKeybindingsFor('session.newTabOrTerminal')).toEqual(['Alt+n']);
    expect(commands.getDefaultKeybindingsFor('nav.back')).toEqual([]);
    expect(commands.getDefaultKeybindingsFor('session.toggleTerminal')).toEqual([]);
    expect(commands.getDefaultKeybindingsFor('workspace.openSettings')).toEqual(['$mod+,']);
    expect(commands.getDefaultKeybindingsFor('layout.toggleZenMode')).toEqual(['$mod+.']);
    // Cyclers with no default binding stay rebindable from the settings page.
    expect(commands.getDefaultKeybindingsFor('session.cycleProvider')).toEqual([]);
    expect(commands.getDefaultKeybindingsFor('mention.toggleSessionProjectScope')).toEqual([]);
    expect(commands.get('mention.toggleSessionProjectScope')?.title).toBe(
      'Toggle Session Mention Project Scope'
    );
    expect(commands.execute('mention.toggleSessionProjectScope')).toBe(false);
    expect(commands.execute('session.archiveCurrent')).toBe(false);
  });

  it('keeps browser-conflicting navigation defaults available in electron', () => {
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      __LODY_PLATFORM__: { os: 'darwin' },
    });
    __resetPlatformCacheForTests();

    registerBuiltInCommands();

    expect(commands.getDefaultKeybindingsFor('session.searchCurrent')).toEqual(['$mod+f']);
    expect(commands.getDefaultKeybindingsFor('session.focusInput')).toEqual(['$mod+l']);
    expect(commands.getDefaultKeybindingsFor('session.nextTab')).toEqual(['$mod+Shift+.']);
    expect(commands.getDefaultKeybindingsFor('session.previousTab')).toEqual(['$mod+Shift+,']);
    expect(commands.getDefaultKeybindingsFor('session.previousVisible')).toEqual(['$mod+Shift+[']);
    expect(commands.getDefaultKeybindingsFor('session.nextVisible')).toEqual(['$mod+Shift+]']);
    expect(commands.getDefaultKeybindingsFor('nav.back')).toEqual(['$mod+[']);
    expect(commands.getDefaultKeybindingsFor('nav.forward')).toEqual(['$mod+]']);
    expect(commands.getDefaultKeybindingsFor('session.toggleTerminal')).toEqual([
      'Ctrl+`',
      '$mod+j',
    ]);
    expect(commands.getDefaultKeybindingsFor('session.cycleMode')).toEqual(['Shift+Tab']);
    // ⌘, settings is now a cross-platform registry binding (the desktop native menu shows
    // ⌘, but registerAccelerator:false leaves the key to the registry), so it shows here too.
    expect(commands.getDefaultKeybindingsFor('workspace.openSettings')).toEqual(['$mod+,']);
    expect(commands.getDefaultKeybindingsFor('layout.toggleZenMode')).toEqual(['$mod+.']);
  });
});

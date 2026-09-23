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
    expect(commands.getDefaultKeybindingsFor('session.archiveCurrent')).toEqual(['Mod+Alt+a']);
    expect(commands.getDefaultKeybindingsFor('session.searchCurrent')).toEqual(['Mod+Alt+f']);
    expect(commands.getDefaultKeybindingsFor('session.focusInput')).toEqual([]);
    expect(commands.getDefaultKeybindingsFor('session.nextTab')).toEqual([]);
    expect(commands.getDefaultKeybindingsFor('session.previousVisible')).toEqual([]);
    // Direct tab jumps are electron-only too — the browser owns ⌘<digit> for its
    // own tab strip, so web shows the commands as unbound.
    expect(commands.getDefaultKeybindingsFor('session.switchToTab1')).toEqual([]);
    expect(commands.getDefaultKeybindingsFor('session.switchToTab8')).toEqual([]);
    expect(commands.getDefaultKeybindingsFor('session.switchToLastTab')).toEqual([]);
    // ⌥N works on web too (always a new tab there); ⌘[/⌘] back/forward and the terminal
    // toggle are electron-only; ⌘, settings is cross-platform (desktop's native menu shows
    // it but doesn't register it — the registry owns the binding).
    expect(commands.getDefaultKeybindingsFor('session.newTabOrTerminal')).toEqual(['Alt+n']);
    expect(commands.getDefaultKeybindingsFor('nav.back')).toEqual([]);
    expect(commands.getDefaultKeybindingsFor('session.toggleTerminal')).toEqual([]);
    expect(commands.getDefaultKeybindingsFor('workspace.openSettings')).toEqual(['Mod+,']);
    expect(commands.getDefaultKeybindingsFor('layout.toggleZenMode')).toEqual(['Mod+.']);
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

    expect(commands.getDefaultKeybindingsFor('session.searchCurrent')).toEqual(['Mod+f']);
    expect(commands.getDefaultKeybindingsFor('session.focusInput')).toEqual(['Mod+l']);
    expect(commands.getDefaultKeybindingsFor('session.nextTab')).toEqual(['Mod+Shift+.']);
    expect(commands.getDefaultKeybindingsFor('session.previousTab')).toEqual(['Mod+Shift+,']);
    expect(commands.getDefaultKeybindingsFor('session.previousVisible')).toEqual(['Mod+Shift+[']);
    expect(commands.getDefaultKeybindingsFor('session.nextVisible')).toEqual(['Mod+Shift+]']);
    expect(commands.getDefaultKeybindingsFor('session.switchToTab1')).toEqual(['Mod+1']);
    expect(commands.getDefaultKeybindingsFor('session.switchToTab2')).toEqual(['Mod+2']);
    expect(commands.getDefaultKeybindingsFor('session.switchToTab3')).toEqual(['Mod+3']);
    expect(commands.getDefaultKeybindingsFor('session.switchToTab4')).toEqual(['Mod+4']);
    expect(commands.getDefaultKeybindingsFor('session.switchToTab5')).toEqual(['Mod+5']);
    expect(commands.getDefaultKeybindingsFor('session.switchToTab6')).toEqual(['Mod+6']);
    expect(commands.getDefaultKeybindingsFor('session.switchToTab7')).toEqual(['Mod+7']);
    expect(commands.getDefaultKeybindingsFor('session.switchToTab8')).toEqual(['Mod+8']);
    expect(commands.getDefaultKeybindingsFor('session.switchToLastTab')).toEqual(['Mod+9']);
    // ⌘T is the browser-convention new-tab chord, electron-only like the digit jumps.
    expect(commands.getDefaultKeybindingsFor('session.newTabOrTerminal')).toEqual([
      'Alt+n',
      'Mod+t',
    ]);
    expect(commands.getDefaultKeybindingsFor('nav.back')).toEqual(['Mod+[']);
    expect(commands.getDefaultKeybindingsFor('nav.forward')).toEqual(['Mod+]']);
    expect(commands.getDefaultKeybindingsFor('session.toggleTerminal')).toEqual([
      'Ctrl+`',
      'Mod+j',
    ]);
    expect(commands.getDefaultKeybindingsFor('session.cycleMode')).toEqual(['Shift+Tab']);
    // ⌘, settings is now a cross-platform registry binding (the desktop native menu shows
    // ⌘, but registerAccelerator:false leaves the key to the registry), so it shows here too.
    expect(commands.getDefaultKeybindingsFor('workspace.openSettings')).toEqual(['Mod+,']);
    expect(commands.getDefaultKeybindingsFor('layout.toggleZenMode')).toEqual(['Mod+.']);
  });
});

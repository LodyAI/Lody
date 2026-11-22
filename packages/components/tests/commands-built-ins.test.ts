import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commands, registerBuiltInCommands, unregisterBuiltInCommands } from '../src/lib/commands';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';
import {
  loadUserBindings,
  subscribeUserBindings,
  USER_BINDINGS_STORAGE_KEY,
} from '../src/lib/commands/user-bindings';
import { resolveDuplicatedImeCommitEcho } from '../src/lib/ime';

describe('commands-built-ins', () => {
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
      // Direct sidebar session jumps are electron-only too — the browser owns ⌘<digit>
      // for its own tab strip, so web shows the commands as unbound.
      expect(commands.getDefaultKeybindingsFor('session.switchToVisible1')).toEqual([]);
      expect(commands.getDefaultKeybindingsFor('session.switchToVisible8')).toEqual([]);
      expect(commands.getDefaultKeybindingsFor('session.switchToVisible9')).toEqual([]);
      // ⌥N works on web too (always a new tab there); ⌘[/⌘] back/forward and the terminal
      // toggle are electron-only; ⌘, settings is cross-platform (desktop's native menu shows
      // it but doesn't register it — the registry owns the binding).
      expect(commands.getDefaultKeybindingsFor('session.newTabOrTerminal')).toEqual(['Alt+n']);
      expect(commands.getDefaultKeybindingsFor('nav.back')).toEqual([]);
      expect(commands.getDefaultKeybindingsFor('session.toggleTerminal')).toEqual([]);
      expect(commands.getDefaultKeybindingsFor('workspace.openSettings')).toEqual(['Mod+,']);
      expect(commands.getDefaultKeybindingsFor('layout.toggleZenMode')).toEqual(['Mod+.']);
      // Open Today belongs to the Today experiment: not a built-in, so it is not listed
      // while the experiment is off (TodayCommandPlaceholder lists it while on).
      expect(commands.get('today.open')).toBeUndefined();
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
      expect(commands.getDefaultKeybindingsFor('session.switchToVisible1')).toEqual(['Mod+1']);
      expect(commands.getDefaultKeybindingsFor('session.switchToVisible2')).toEqual(['Mod+2']);
      expect(commands.getDefaultKeybindingsFor('session.switchToVisible3')).toEqual(['Mod+3']);
      expect(commands.getDefaultKeybindingsFor('session.switchToVisible4')).toEqual(['Mod+4']);
      expect(commands.getDefaultKeybindingsFor('session.switchToVisible5')).toEqual(['Mod+5']);
      expect(commands.getDefaultKeybindingsFor('session.switchToVisible6')).toEqual(['Mod+6']);
      expect(commands.getDefaultKeybindingsFor('session.switchToVisible7')).toEqual(['Mod+7']);
      expect(commands.getDefaultKeybindingsFor('session.switchToVisible8')).toEqual(['Mod+8']);
      expect(commands.getDefaultKeybindingsFor('session.switchToVisible9')).toEqual(['Mod+9']);
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
});

describe('commands-user-bindings', () => {
  class MemoryStorage {
    private store = new Map<string, string>();
    getItem(key: string): string | null {
      return this.store.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
      this.store.set(key, value);
    }
    removeItem(key: string): void {
      this.store.delete(key);
    }
    clear(): void {
      this.store.clear();
    }
  }

  class FakeStorageTarget {
    private listeners = new Map<string, Set<EventListener>>();
    addEventListener(type: string, listener: EventListener): void {
      const listeners = this.listeners.get(type) ?? new Set<EventListener>();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: EventListener): void {
      this.listeners.get(type)?.delete(listener);
    }
    dispatch(type: string, event: Event): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  function ev(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
    let prevented = false;
    return {
      key: init.key,
      ctrlKey: init.ctrlKey ?? false,
      metaKey: init.metaKey ?? false,
      altKey: init.altKey ?? false,
      shiftKey: init.shiftKey ?? false,
      get defaultPrevented() {
        return prevented;
      },
      preventDefault() {
        prevented = true;
      },
    } as unknown as KeyboardEvent;
  }

  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    commands.reloadUserKeybindings();
  });

  afterEach(() => {
    commands.resetAllUserKeybindings();
    for (const cmd of commands.list()) commands.unregister(cmd.id);
    vi.unstubAllGlobals();
  });

  describe('user-bindings overrides', () => {
    it('migrates legacy $mod bindings to the engine-native Mod alias', () => {
      storage.setItem(
        USER_BINDINGS_STORAGE_KEY,
        JSON.stringify({ foo: ['$mod+b', 'Shift+$MOD+k'] })
      );

      expect(loadUserBindings()).toEqual({ foo: ['Mod+b', 'Shift+Mod+k'] });
      expect(JSON.parse(storage.getItem(USER_BINDINGS_STORAGE_KEY) ?? '{}')).toEqual({
        foo: ['Mod+b', 'Shift+Mod+k'],
      });
    });

    it('empty array unbinds the command entirely', () => {
      const run = vi.fn();
      commands.register({
        id: 'foo',
        title: 'Foo',
        keybindings: ['Mod+b'],
        run,
      });
      commands.setUserKeybindings('foo', []);
      expect(commands.getKeybindingsFor('foo')).toEqual([]);
      commands.dispatchKeybinding('Mod+b', ev({ key: 'b', ctrlKey: true }));
      expect(run).not.toHaveBeenCalled();
    });

    it('applies binding changes written by another window', () => {
      const run = vi.fn();
      commands.register({ id: 'foo', title: 'Foo', keybindings: ['Mod+b'], run });
      const target = new FakeStorageTarget();
      vi.stubGlobal('window', target);
      const unsubscribe = subscribeUserBindings(() => commands.reloadUserKeybindings());
      storage.setItem(USER_BINDINGS_STORAGE_KEY, JSON.stringify({ foo: ['Mod+j'] }));

      target.dispatch('storage', {
        key: USER_BINDINGS_STORAGE_KEY,
        storageArea: storage,
      } as unknown as StorageEvent);
      expect(commands.getKeybindingsFor('foo')).toEqual(['Mod+j']);

      unsubscribe();
      storage.setItem(USER_BINDINGS_STORAGE_KEY, JSON.stringify({ foo: ['Mod+k'] }));
      target.dispatch('storage', {
        key: USER_BINDINGS_STORAGE_KEY,
        storageArea: storage,
      } as unknown as StorageEvent);
      expect(commands.getKeybindingsFor('foo')).toEqual(['Mod+j']);

      commands.dispatchKeybinding('Mod+b', ev({ key: 'b', ctrlKey: true }));
      expect(run).not.toHaveBeenCalled();
      commands.dispatchKeybinding('Mod+j', ev({ key: 'j', ctrlKey: true }));
      expect(run).toHaveBeenCalledOnce();
    });
  });
});

describe('ime', () => {
  describe('resolveDuplicatedImeCommitEcho', () => {
    it('resolves duplicated insertFromComposition echo while composing', () => {
      expect(
        resolveDuplicatedImeCommitEcho({
          nextValue: 'tokentoken',
          lastStableComposingValue: 'token',
          inputType: 'insertFromComposition',
          isComposing: true,
        })
      ).toBe('token');
    });

    it('prefers committed data when last composing snapshot is stale', () => {
      expect(
        resolveDuplicatedImeCommitEcho({
          nextValue: '你好你好',
          lastStableComposingValue: 'ni h',
          inputType: 'insertFromComposition',
          isComposing: true,
          committedData: '你好',
        })
      ).toBe('你好');
    });
  });
});

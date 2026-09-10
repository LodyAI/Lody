import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commands } from '../src/lib/commands/registry';
import {
  subscribeUserBindings,
  USER_BINDINGS_STORAGE_KEY,
} from '../src/lib/commands/user-bindings';

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
  it('override replaces the default binding', () => {
    const run = vi.fn();
    commands.register({
      id: 'foo',
      title: 'Foo',
      keybindings: ['$mod+b'],
      run,
    });
    expect(commands.getKeybindingsFor('foo')).toEqual(['$mod+b']);

    commands.setUserKeybindings('foo', ['$mod+j']);
    expect(commands.getKeybindingsFor('foo')).toEqual(['$mod+j']);
    expect(commands.hasUserOverride('foo')).toBe(true);

    // Old binding no longer fires
    commands.dispatchKeybinding('$mod+b', ev({ key: 'b', ctrlKey: true }));
    expect(run).not.toHaveBeenCalled();
    // New binding fires
    commands.dispatchKeybinding('$mod+j', ev({ key: 'j', ctrlKey: true }));
    expect(run).toHaveBeenCalledOnce();
  });

  it('empty array unbinds the command entirely', () => {
    const run = vi.fn();
    commands.register({
      id: 'foo',
      title: 'Foo',
      keybindings: ['$mod+b'],
      run,
    });
    commands.setUserKeybindings('foo', []);
    expect(commands.getKeybindingsFor('foo')).toEqual([]);
    commands.dispatchKeybinding('$mod+b', ev({ key: 'b', ctrlKey: true }));
    expect(run).not.toHaveBeenCalled();
  });

  it('null override restores defaults', () => {
    const run = vi.fn();
    commands.register({ id: 'foo', title: 'Foo', keybindings: ['$mod+b'], run });
    commands.setUserKeybindings('foo', ['$mod+j']);
    commands.setUserKeybindings('foo', null);
    expect(commands.hasUserOverride('foo')).toBe(false);
    expect(commands.getKeybindingsFor('foo')).toEqual(['$mod+b']);
  });

  it('reloads overrides from persisted state when a renderer mounts', () => {
    commands.register({ id: 'foo', title: 'Foo', keybindings: ['$mod+b'], run: () => {} });
    commands.setUserKeybindings('foo', ['$mod+j']);
    expect(storage.getItem(USER_BINDINGS_STORAGE_KEY)).toContain('$mod+j');

    storage.setItem(USER_BINDINGS_STORAGE_KEY, JSON.stringify({ foo: ['$mod+k'] }));
    expect(commands.getKeybindingsFor('foo')).toEqual(['$mod+j']);

    commands.reloadUserKeybindings();
    expect(commands.getKeybindingsFor('foo')).toEqual(['$mod+k']);
  });

  it('applies binding changes written by another window', () => {
    const run = vi.fn();
    commands.register({ id: 'foo', title: 'Foo', keybindings: ['$mod+b'], run });
    const target = new FakeStorageTarget();
    vi.stubGlobal('window', target);
    const unsubscribe = subscribeUserBindings(() => commands.reloadUserKeybindings());
    storage.setItem(USER_BINDINGS_STORAGE_KEY, JSON.stringify({ foo: ['$mod+j'] }));

    target.dispatch('storage', {
      key: USER_BINDINGS_STORAGE_KEY,
      storageArea: storage,
    } as unknown as StorageEvent);
    expect(commands.getKeybindingsFor('foo')).toEqual(['$mod+j']);

    unsubscribe();
    storage.setItem(USER_BINDINGS_STORAGE_KEY, JSON.stringify({ foo: ['$mod+k'] }));
    target.dispatch('storage', {
      key: USER_BINDINGS_STORAGE_KEY,
      storageArea: storage,
    } as unknown as StorageEvent);
    expect(commands.getKeybindingsFor('foo')).toEqual(['$mod+j']);

    commands.dispatchKeybinding('$mod+b', ev({ key: 'b', ctrlKey: true }));
    expect(run).not.toHaveBeenCalled();
    commands.dispatchKeybinding('$mod+j', ev({ key: 'j', ctrlKey: true }));
    expect(run).toHaveBeenCalledOnce();
  });

  it('resetAllUserKeybindings clears every override', () => {
    commands.register({ id: 'a', title: 'A', keybindings: ['$mod+a'], run: () => {} });
    commands.register({ id: 'b', title: 'B', keybindings: ['$mod+b'], run: () => {} });
    commands.setUserKeybindings('a', ['$mod+x']);
    commands.setUserKeybindings('b', ['$mod+y']);
    commands.resetAllUserKeybindings();
    expect(commands.hasUserOverride('a')).toBe(false);
    expect(commands.hasUserOverride('b')).toBe(false);
    expect(commands.getKeybindingsFor('a')).toEqual(['$mod+a']);
    expect(commands.getKeybindingsFor('b')).toEqual(['$mod+b']);
  });

  it('getDefaultKeybindingsFor ignores overrides', () => {
    commands.register({ id: 'foo', title: 'Foo', keybindings: ['$mod+b'], run: () => {} });
    commands.setUserKeybindings('foo', ['$mod+j']);
    expect(commands.getDefaultKeybindingsFor('foo')).toEqual(['$mod+b']);
  });

  it('findCommandBoundTo locates collision targets', () => {
    commands.register({ id: 'a', title: 'A', keybindings: ['$mod+k'], run: () => {} });
    commands.register({ id: 'b', title: 'B', keybindings: ['$mod+x'], run: () => {} });
    expect(commands.findCommandBoundTo('$mod+k')).toBe('a');
    expect(commands.findCommandBoundTo('$mod+k', 'a')).toBeNull();
    expect(commands.findCommandBoundTo('$mod+z')).toBeNull();
  });
});

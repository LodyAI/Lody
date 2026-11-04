import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commands } from '../src/lib/commands/registry';
import {
  loadUserBindings,
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
  it('migrates legacy $mod bindings to the engine-native Mod alias', () => {
    storage.setItem(USER_BINDINGS_STORAGE_KEY, JSON.stringify({ foo: ['$mod+b', 'Shift+$MOD+k'] }));

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

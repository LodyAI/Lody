// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sidebarNavCallbacksAtom, sidebarNavItemsAtom } from '../src/atoms/focus-layer';
import { useKeyboardNavigation } from '../src/hooks/use-keyboard-navigation';
import { commands, registerBuiltInCommands, unregisterBuiltInCommands } from '../src/lib/commands';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';
import {
  getNumberShortcutTarget,
  setNumberShortcutTarget,
} from '../src/lib/commands/number-shortcuts';
import { USER_BINDINGS_STORAGE_KEY } from '../src/lib/commands/user-bindings';

vi.mock('../src/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('../src/ui/focus-scope', () => ({ useFocusScopeSwitcher: () => {} }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

function environment(os: string, electron = true) {
  Object.assign(window, { __LODY_ELECTRON__: electron, __LODY_PLATFORM__: { os } });
  __resetPlatformCacheForTests();
}

beforeEach(() => {
  environment('darwin');
  localStorage.clear();
  commands.reloadUserKeybindings();
  registerBuiltInCommands();
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  unregisterBuiltInCommands();
  commands.resetAllUserKeybindings();
  for (const command of commands.list()) commands.unregister(command.id);
  vi.unstubAllGlobals();
  delete window.__LODY_ELECTRON__;
  delete window.__LODY_PLATFORM__;
  __resetPlatformCacheForTests();
});

function dispatch(binding: string) {
  const event = new KeyboardEvent('keydown', { cancelable: true });
  commands.dispatchKeybinding(binding, event);
  return event;
}

function paint() {
  const callbacks = [...frames.values()];
  frames.clear();
  act(() => callbacks.forEach((callback) => callback(0)));
}

function mountNavigation() {
  const store = createStore();
  let selected = 'first';
  const visited: string[] = [];
  store.set(sidebarNavItemsAtom, [
    { kind: 'group-header', groupKey: 'chats', collapsed: false },
    ...['first', 'second', 'third'].map((sessionId) => ({
      kind: 'session' as const,
      sessionId,
      groupKey: 'chats',
    })),
    { kind: 'show-more', groupKey: 'chats', expanded: false },
  ]);
  store.set(sidebarNavCallbacksAtom, {
    getSelectedSessionId: () => selected,
    onNavigateToSession: (id) => {
      selected = id;
      visited.push(id);
    },
    onNavigateToNewSession: () => {},
    onToggleRepoCollapsed: () => {},
    onToggleChatsCollapsed: () => {},
    isChatLanding: () => false,
  });
  function Harness() {
    useKeyboardNavigation();
    return <textarea />;
  }
  root = createRoot(container);
  act(() =>
    root!.render(
      <Provider store={store}>
        <Harness />
      </Provider>
    )
  );
  return {
    store,
    visited,
    select: (id: string) => {
      selected = id;
    },
  };
}

describe('number shortcut presets', () => {
  it.each(['darwin', 'win32', 'linux'])('swaps, persists and resets both groups on %s', (os) => {
    environment(os);
    commands.reloadUserKeybindings();
    expect(getNumberShortcutTarget()).toBe('tabs');
    commands.setUserKeybindings('sidebar.toggle', ['Mod+Shift+b']);
    setNumberShortcutTarget('chats');
    expect(getNumberShortcutTarget()).toBe('chats');
    expect(commands.getKeybindingsFor('session.selectVisible1')).toEqual(['Mod+1']);
    expect(commands.getKeybindingsFor('session.switchToLastTab')).toEqual([
      `${os === 'darwin' ? 'Ctrl' : 'Alt'}+9`,
    ]);
    expect(commands.getKeybindingsFor('sidebar.toggle')).toEqual(['Mod+Shift+b']);
    expect(JSON.parse(localStorage.getItem(USER_BINDINGS_STORAGE_KEY)!)).toHaveProperty(
      'session.selectVisible9'
    );
    commands.reloadUserKeybindings();
    expect(getNumberShortcutTarget()).toBe('chats');
    commands.setUserKeybindings('session.selectVisible2', []);
    expect(getNumberShortcutTarget()).toBe('custom');
    setNumberShortcutTarget('tabs');
    expect(getNumberShortcutTarget()).toBe('tabs');
    commands.resetAllUserKeybindings();
    expect(getNumberShortcutTarget()).toBe('tabs');
  });

  it('keeps number defaults unavailable on the web', () => {
    environment('darwin', false);
    commands.reloadUserKeybindings();
    expect(commands.getKeybindingsFor('session.selectVisible1')).toEqual([]);
    expect(commands.getKeybindingsFor('session.switchToTab1')).toEqual([]);
  });
});

describe('numbered chat navigation', () => {
  it('uses the live visible order, skips headings, and ignores missing positions and popups', () => {
    const { store, visited } = mountNavigation();
    expect(dispatch('Ctrl+2').defaultPrevented).toBe(true);
    expect(visited).toEqual(['second']);
    paint();
    store.set(sidebarNavItemsAtom, [
      { kind: 'session', sessionId: 'new-workspace', groupKey: 'other' },
    ]);
    dispatch('Ctrl+1');
    expect(visited).toEqual(['second', 'new-workspace']);
    expect(dispatch('Ctrl+9').defaultPrevented).toBe(false);
    const popup = document.createElement('div');
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('data-state', 'open');
    container.appendChild(popup);
    expect(dispatch('Ctrl+1').defaultPrevented).toBe(false);
  });

  it('replaces queued sequential navigation within the shared frame budget and yields to clicks', () => {
    const { visited, select } = mountNavigation();
    dispatch('Mod+Shift+]'); // immediate second
    dispatch('Mod+Shift+]'); // queued third
    dispatch('Ctrl+1'); // replaces queued third
    expect(visited).toEqual(['second']);
    paint();
    expect(visited).toEqual(['second', 'first']);
    dispatch('Ctrl+3');
    select('second'); // a later click wins over the queued third
    paint();
    expect(visited).toEqual(['second', 'first']);
    dispatch('Ctrl+3');
    expect(visited).toEqual(['second', 'first', 'third']);
  });

  it('supports typing scopes and switches the active chords when the preset changes', () => {
    const { visited } = mountNavigation();
    const editor = container.querySelector('textarea')!;
    const release = commands.registerKeyScope({ id: 'editor', element: () => editor });
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    editor.addEventListener('keydown', (key) => commands.dispatchKeybinding('Mod+2', key));
    setNumberShortcutTarget('chats');
    editor.dispatchEvent(event);
    expect(visited).toEqual(['second']);
    expect(event.defaultPrevented).toBe(true);
    paint();
    dispatch('Ctrl+3'); // now belongs to tabs; placeholder cannot execute
    expect(visited).toEqual(['second']);
    release();
  });
});

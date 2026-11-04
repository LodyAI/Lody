import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commands } from '../src/lib/commands/registry';

function ev(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  let prevented = false;
  const e = {
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
  };
  return e as unknown as KeyboardEvent;
}

beforeEach(() => {
  // Force non-mac default to keep Mod = Ctrl in tests.
  vi.stubGlobal('navigator', { platform: 'Linux x86_64', userAgent: '' });
});

afterEach(() => {
  commands.setShortcutAnalyticsHandler(null);
  for (const cmd of commands.list()) commands.unregister(cmd.id);
  vi.unstubAllGlobals();
});

describe('CommandRegistry keydown dispatch', () => {
  it('most-recently-registered binding wins on collision', () => {
    const earlier = vi.fn();
    const later = vi.fn();
    commands.register({ id: 'a', title: 'A', keybindings: ['Mod+b'], run: earlier });
    commands.register({ id: 'b', title: 'B', keybindings: ['Mod+b'], run: later });
    commands.dispatchKeybinding('Mod+b', ev({ key: 'b', ctrlKey: true }));
    expect(later).toHaveBeenCalledOnce();
    expect(earlier).not.toHaveBeenCalled();
  });

  it('treats Mod and explicit Control as the same collision on non-macOS', () => {
    const earlier = vi.fn();
    const later = vi.fn();
    commands.register({ id: 'a', title: 'A', keybindings: ['Mod+b'], run: earlier });
    commands.register({ id: 'b', title: 'B', keybindings: ['Control+b'], run: later });

    commands.dispatchKeybinding('Mod+b', ev({ key: 'b', ctrlKey: true }));

    expect(later).toHaveBeenCalledOnce();
    expect(earlier).not.toHaveBeenCalled();
  });

  it('respects runtime filter', () => {
    const run = vi.fn();
    commands.register({
      id: 'electron-only',
      title: 'X',
      keybindings: [{ key: 'Mod+b', runtimes: ['electron'] }],
      run,
    });
    commands.dispatchKeybinding('Mod+b', ev({ key: 'b', ctrlKey: true }));
    // Default runtime in tests is 'web' (no __LODY_ELECTRON__).
    expect(run).not.toHaveBeenCalled();
  });

  it('skips when defaultPrevented already', () => {
    const run = vi.fn();
    commands.register({ id: 'k', title: 'K', keybindings: ['Mod+b'], run });
    const event = ev({ key: 'b', ctrlKey: true });
    event.preventDefault();
    commands.dispatchKeybinding('Mod+b', event);
    expect(run).not.toHaveBeenCalled();
  });

  it('skips dispatch entirely while paused (used by the rebinding capture flow)', () => {
    const run = vi.fn();
    commands.register({ id: 'k', title: 'K', keybindings: ['Mod+b'], run });

    commands.setPaused(true);
    expect(commands.isPaused()).toBe(true);
    commands.dispatchKeybinding('Mod+b', ev({ key: 'b', ctrlKey: true }));
    expect(run).not.toHaveBeenCalled();

    commands.setPaused(false);
    commands.dispatchKeybinding('Mod+b', ev({ key: 'b', ctrlKey: true }));
    expect(run).toHaveBeenCalledOnce();
  });
});

/** A stand-in for a DOM subtree. The registry only needs identity + `contains`. */
function fakeNode(children: object[] = []): Node {
  const node = {
    contains(other: Node) {
      return other === (node as unknown as Node) || children.includes(other as object);
    },
  };
  return node as unknown as Node;
}

function evIn(node: Node, init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return Object.assign(ev(init), { target: node }) as KeyboardEvent;
}

describe('CommandRegistry key scopes', () => {
  it('gives a focused text scope the key instead of the app command', () => {
    const run = vi.fn();
    commands.register({ id: 'sidebar.toggle', title: 'Toggle', keybindings: ['Mod+b'], run });
    const editor = fakeNode();
    commands.registerKeyScope({ id: 'editor', element: () => editor });

    commands.dispatchKeybinding('Mod+b', evIn(editor, { key: 'b', ctrlKey: true }));

    expect(run).not.toHaveBeenCalled();
  });

  it('leaves the suppressed event unprevented so the editor keymap still sees it', () => {
    // The whole point is handing the key over, not swallowing it. Calling
    // preventDefault here would mean bold never happens either.
    commands.register({
      id: 'sidebar.toggle',
      title: 'Toggle',
      keybindings: ['Mod+b'],
      run: () => {},
    });
    const editor = fakeNode();
    commands.registerKeyScope({ id: 'editor', element: () => editor });

    const event = evIn(editor, { key: 'b', ctrlKey: true });
    commands.dispatchKeybinding('Mod+b', event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('still fires commands that opt into text input', () => {
    const run = vi.fn();
    commands.register({
      id: 'palette.toggle',
      title: 'Palette',
      keybindings: ['Mod+k'],
      allowInTextInput: true,
      run,
    });
    const editor = fakeNode();
    commands.registerKeyScope({ id: 'editor', element: () => editor });

    commands.dispatchKeybinding('Mod+k', evIn(editor, { key: 'k', ctrlKey: true }));

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not suppress when the event happened outside the scope', () => {
    const run = vi.fn();
    commands.register({ id: 'sidebar.toggle', title: 'Toggle', keybindings: ['Mod+b'], run });
    const editor = fakeNode();
    commands.registerKeyScope({ id: 'editor', element: () => editor });

    commands.dispatchKeybinding('Mod+b', evIn(fakeNode(), { key: 'b', ctrlKey: true }));

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('suppresses only the listed keys when the scope declares claims', () => {
    const bold = vi.fn();
    const other = vi.fn();
    commands.register({
      id: 'sidebar.toggle',
      title: 'Toggle',
      keybindings: ['Mod+b'],
      run: bold,
    });
    commands.register({ id: 'other', title: 'Other', keybindings: ['Mod+j'], run: other });
    const editor = fakeNode();
    commands.registerKeyScope({ id: 'editor', element: () => editor, claims: ['Mod+b'] });

    commands.dispatchKeybinding('Mod+b', evIn(editor, { key: 'b', ctrlKey: true }));
    commands.dispatchKeybinding('Mod+j', evIn(editor, { key: 'j', ctrlKey: true }));

    expect(bold).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('applies to a rebound key, which a per-binding `when` could not', () => {
    // Scope activity is decided by where the event happened, so a user who
    // rebinds the sidebar onto another editor key is still covered.
    const run = vi.fn();
    commands.register({ id: 'sidebar.toggle', title: 'Toggle', keybindings: ['Mod+i'], run });
    const editor = fakeNode();
    commands.registerKeyScope({ id: 'editor', element: () => editor });

    commands.dispatchKeybinding('Mod+i', evIn(editor, { key: 'i', ctrlKey: true }));

    expect(run).not.toHaveBeenCalled();
  });

  it('keeps scopes out of the command list, palette and settings', () => {
    commands.registerKeyScope({ id: 'editor', element: () => fakeNode() });
    expect(commands.list()).toHaveLength(0);
  });
});

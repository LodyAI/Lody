// @vitest-environment jsdom

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commands, useCommand, useKeyScope } from '../src/lib/commands';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';
import { CommandShortcutHost } from '../src/lib/commands/shortcut-host';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('useCommand', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(window, {
      __LODY_ELECTRON__: true,
      __LODY_PLATFORM__: { os: 'linux' },
    });
    __resetPlatformCacheForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    commands.resetAllUserKeybindings();
    for (const command of commands.list()) commands.unregister(command.id);
    vi.unstubAllGlobals();
    delete window.__LODY_ELECTRON__;
    delete window.__LODY_PLATFORM__;
    __resetPlatformCacheForTests();
  });

  it('forwards allowInTextInput so tab commands work inside an editing scope', () => {
    const run = vi.fn();

    function Harness() {
      const editorRef = useRef<HTMLDivElement>(null);
      useKeyScope('test-editor', editorRef);
      useCommand({
        id: 'session.closeFocusedTab',
        title: 'Close Focused Tab',
        keybindings: ['$mod+w'],
        allowInTextInput: true,
        run,
      });
      return (
        <div ref={editorRef}>
          <textarea aria-label="Editor" />
        </div>
      );
    }

    act(() =>
      root.render(
        <>
          <CommandShortcutHost />
          <Harness />
        </>
      )
    );
    const editor = container.querySelector('[aria-label="Editor"]');
    const event = new KeyboardEvent('keydown', {
      key: 'w',
      code: 'KeyW',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      editor?.dispatchEvent(event);
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('updates the listener for user rebindings and removes it with the host', () => {
    const run = vi.fn();

    function Harness() {
      useCommand({
        id: 'session.closeFocusedTab',
        title: 'Close Focused Tab',
        keybindings: ['$mod+Shift+['],
        run,
      });
      return null;
    }

    act(() =>
      root.render(
        <>
          <CommandShortcutHost />
          <Harness />
        </>
      )
    );

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '{',
          code: 'BracketLeft',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(run).toHaveBeenCalledTimes(1);

    act(() => commands.setUserKeybindings('session.closeFocusedTab', ['$mod+j']));
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'j',
          code: 'KeyJ',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(run).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'j',
        code: 'KeyJ',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
    expect(run).toHaveBeenCalledTimes(2);

    root = createRoot(container);
  });

  it('preserves registry precedence when runtime-equivalent bindings collide', () => {
    const earlier = vi.fn();
    const later = vi.fn();

    function Harness() {
      useCommand({ id: 'test.mod', title: 'Mod', keybindings: ['$mod+b'], run: earlier });
      useCommand({ id: 'test.control', title: 'Control', keybindings: ['Control+b'], run: later });
      return null;
    }

    act(() =>
      root.render(
        <>
          <CommandShortcutHost />
          <Harness />
        </>
      )
    );
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'b',
          code: 'KeyB',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(later).toHaveBeenCalledOnce();
    expect(earlier).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  conversationFontSizeAtom,
  terminalFontFamilyAtom,
  terminalFontSizeAtom,
} from '../src/atoms/settings';
import { LocalTerminalPanel } from '../src/components/terminal/local-terminal-panel';
import type { TerminalChannel } from '../src/components/terminal/terminal-channel';
import { initI18n } from '../src/i18n';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  terminalInstances: [] as Array<{
    options: Record<string, unknown>;
    selection: string;
    pasted: string[];
    selectedRanges: Array<{ column: number; row: number; length: number }>;
    selectionRange?: { start: { x: number; y: number }; end: { x: number; y: number } };
    customKeyEventHandler?: (event: KeyboardEvent) => boolean;
    selectionChangeHandler?: () => void;
    dataHandler?: (data: string) => void;
  }>,
  fit: vi.fn(),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = mocks.fit;
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    selection = '';
    pasted: string[] = [];
    selectedRanges: Array<{ column: number; row: number; length: number }> = [];
    selectionRange?: { start: { x: number; y: number }; end: { x: number; y: number } };
    selectionChangeHandler?: () => void;
    buffer = {
      active: {
        cursorX: 5,
        cursorY: 2,
        baseY: 0,
        length: 24,
        getLine: () => ({ translateToString: () => 'hello world' }),
      },
    };
    customKeyEventHandler?: (event: KeyboardEvent) => boolean;
    dataHandler?: (data: string) => void;

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      mocks.terminalInstances.push(this);
    }

    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.customKeyEventHandler = handler;
    }
    hasSelection() {
      return this.selection.length > 0 || this.selectedRanges.length > 0;
    }
    getSelection() {
      return this.selection;
    }
    getSelectionPosition() {
      return this.selectionRange;
    }
    clearSelection() {
      this.selection = '';
      this.selectedRanges = [];
      this.selectionRange = undefined;
      this.selectionChangeHandler?.();
    }
    select(column: number, row: number, length: number) {
      this.selectedRanges.push({ column, row, length });
      const endOffset = row * this.cols + column + length;
      this.selectionRange = {
        start: { x: column, y: row },
        end: { x: endOffset % this.cols, y: Math.floor(endOffset / this.cols) },
      };
      this.selectionChangeHandler?.();
    }
    onSelectionChange(handler: () => void) {
      this.selectionChangeHandler = handler;
      return {
        dispose: () => {
          if (this.selectionChangeHandler === handler) this.selectionChangeHandler = undefined;
        },
      };
    }
    paste(text: string) {
      this.pasted.push(text);
    }
    write(_data: string, callback?: () => void) {
      callback?.();
    }
    onData(handler: (data: string) => void) {
      this.dataHandler = handler;
      return { dispose: vi.fn() };
    }
    onResize() {
      return { dispose: vi.fn() };
    }
    onTitleChange() {
      return { dispose: vi.fn() };
    }
  },
}));

vi.mock('../src/lib/resize-observer', () => ({
  observeResizeOnAnimationFrame: () => vi.fn(),
}));

vi.mock('../src/theme-provider', () => ({
  useResolvedTheme: () => 'light',
  useActiveVSCodeThemeId: () => null,
}));

function createChannel(): TerminalChannel {
  return {
    list: vi.fn(async () => []),
    open: vi.fn(async () => ({ terminalId: 'terminal-1', title: 'shell' })),
    attach: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    closeSession: vi.fn(),
    readClipboardText: vi.fn(() => ''),
    writeClipboardText: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onTitle: vi.fn(() => vi.fn()),
  };
}

function openTerminalContextMenu(container: HTMLDivElement | undefined): void {
  const host = container?.querySelector('.lody-terminal-panel');
  if (!host) throw new Error('Terminal host not found');
  host.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    })
  );
}

function getMenuItem(label: string): HTMLElement {
  const menuItem = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent?.includes(label)
  );
  if (!menuItem) throw new Error(`Menu item not found: ${label}`);
  return menuItem;
}

describe('LocalTerminalPanel', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    __resetPlatformCacheForTests();
    mocks.terminalInstances.length = 0;
    mocks.fit.mockClear();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container?.remove();
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
    __resetPlatformCacheForTests();
  });

  it('updates and refits the existing xterm instance', async () => {
    const store = createStore();
    store.set(conversationFontSizeAtom, 14);
    const channel = createChannel();

    await act(async () => {
      root?.render(
        <Provider store={store}>
          <LocalTerminalPanel channel={channel} terminalId="terminal-1" />
        </Provider>
      );
      await Promise.resolve();
    });

    expect(mocks.terminalInstances).toHaveLength(1);
    const terminal = mocks.terminalInstances[0];
    const initialFitCount = mocks.fit.mock.calls.length;

    await act(async () => {
      store.set(terminalFontFamilyAtom, 'Maple Mono');
      store.set(terminalFontSizeAtom, 16);
      await Promise.resolve();
    });

    expect(mocks.terminalInstances).toHaveLength(1);
    expect(terminal.options.fontFamily).toContain('"Maple Mono"');
    expect(terminal.options.fontSize).toBe(16);
    expect(mocks.fit.mock.calls.length).toBeGreaterThan(initialFitCount);

    terminal.selection = 'selected output';
    for (const size of [12, 13, 14, 15, 16]) {
      await act(async () => {
        store.set(conversationFontSizeAtom, size);
        await Promise.resolve();
      });
      expect(mocks.terminalInstances[0]).toBe(terminal);
      expect(terminal.options.fontSize).toBeCloseTo((16 * size) / 14);
      expect(terminal.options.fontFamily).toContain('"Maple Mono"');
      expect(terminal.selection).toBe('selected output');
      expect(store.get(terminalFontSizeAtom)).toBe(16);
    }
  });

  it('reports each submitted shell line without exposing command text', async () => {
    const channel = createChannel();
    const onCommandSubmitted = vi.fn();

    await act(async () => {
      root?.render(
        <LocalTerminalPanel
          channel={channel}
          terminalId="terminal-1"
          onCommandSubmitted={onCommandSubmitted}
        />
      );
      await Promise.resolve();
    });

    const terminal = mocks.terminalInstances[0];
    terminal.dataHandler?.('pnpm test\r');
    terminal.dataHandler?.('first\rsecond\r');

    expect(channel.input).toHaveBeenNthCalledWith(1, 'terminal-1', 'pnpm test\r');
    expect(channel.input).toHaveBeenNthCalledWith(2, 'terminal-1', 'first\rsecond\r');
    expect(onCommandSubmitted).toHaveBeenCalledTimes(3);
    expect(onCommandSubmitted).toHaveBeenCalledWith();
  });

  it('copies the active selection with Ctrl+Shift+C without changing Ctrl+C', async () => {
    const channel = createChannel();

    await act(async () => {
      root?.render(<LocalTerminalPanel channel={channel} terminalId="terminal-1" />);
      await Promise.resolve();
    });

    const terminal = mocks.terminalInstances[0];
    terminal.selection = 'selected output';
    const copyEvent = new KeyboardEvent('keydown', {
      key: 'c',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });

    expect(terminal.customKeyEventHandler?.(copyEvent)).toBe(false);
    expect(copyEvent.defaultPrevented).toBe(true);
    expect(channel.writeClipboardText).toHaveBeenCalledWith('selected output');

    const interruptEvent = new KeyboardEvent('keydown', {
      key: 'c',
      ctrlKey: true,
      cancelable: true,
    });
    expect(terminal.customKeyEventHandler?.(interruptEvent)).toBe(true);
    expect(channel.writeClipboardText).toHaveBeenCalledTimes(1);
  });

  it('on Windows copies with Ctrl+C when text is selected and leaves SIGINT alone', async () => {
    vi.stubGlobal('__LODY_PLATFORM__', { os: 'win32' });
    __resetPlatformCacheForTests();
    const channel = createChannel();

    await act(async () => {
      root?.render(<LocalTerminalPanel channel={channel} terminalId="terminal-1" />);
      await Promise.resolve();
    });

    const terminal = mocks.terminalInstances[0];
    terminal.selection = 'selected output';
    const copyEvent = new KeyboardEvent('keydown', {
      key: 'c',
      code: 'KeyC',
      ctrlKey: true,
      cancelable: true,
    });
    expect(terminal.customKeyEventHandler?.(copyEvent)).toBe(false);
    expect(channel.writeClipboardText).toHaveBeenCalledWith('selected output');

    terminal.selection = '';
    terminal.selectedRanges = [];
    const interruptEvent = new KeyboardEvent('keydown', {
      key: 'c',
      code: 'KeyC',
      ctrlKey: true,
      cancelable: true,
    });
    expect(terminal.customKeyEventHandler?.(interruptEvent)).toBe(true);
    expect(channel.writeClipboardText).toHaveBeenCalledTimes(1);
  });

  it('on Windows copies a selection with right-click and pastes when nothing is selected', async () => {
    vi.stubGlobal('__LODY_PLATFORM__', { os: 'win32' });
    __resetPlatformCacheForTests();
    const channel = createChannel();
    vi.mocked(channel.readClipboardText).mockResolvedValue('clipboard input');

    await act(async () => {
      root?.render(<LocalTerminalPanel channel={channel} terminalId="terminal-1" />);
      await Promise.resolve();
    });

    const terminal = mocks.terminalInstances[0];
    terminal.selection = 'selected output';
    await act(async () => {
      openTerminalContextMenu(container);
    });
    expect(channel.writeClipboardText).toHaveBeenCalledWith('selected output');
    expect(terminal.selection).toBe('');
    expect(document.querySelector('[role="menuitem"]')).toBeNull();

    await act(async () => {
      openTerminalContextMenu(container);
    });
    expect(terminal.pasted).toEqual(['clipboard input']);
  });

  it('selects buffer text with Shift+arrows instead of sending CSI to the PTY', async () => {
    const channel = createChannel();

    await act(async () => {
      root?.render(<LocalTerminalPanel channel={channel} terminalId="terminal-1" />);
      await Promise.resolve();
    });

    const terminal = mocks.terminalInstances[0];
    const shiftRight = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      shiftKey: true,
      cancelable: true,
    });
    expect(terminal.customKeyEventHandler?.(shiftRight)).toBe(false);
    expect(shiftRight.defaultPrevented).toBe(true);
    expect(terminal.selectedRanges).toEqual([{ column: 5, row: 2, length: 1 }]);
    expect(channel.input).not.toHaveBeenCalled();

    const plainRight = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      cancelable: true,
    });
    expect(terminal.customKeyEventHandler?.(plainRight)).toBe(true);
  });

  it('starts the next Shift+arrow from a mouse selection instead of the old keyboard anchor', async () => {
    const channel = createChannel();

    await act(async () => {
      root?.render(<LocalTerminalPanel channel={channel} terminalId="terminal-1" />);
      await Promise.resolve();
    });

    const terminal = mocks.terminalInstances[0];
    expect(
      terminal.customKeyEventHandler?.(
        new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, cancelable: true })
      )
    ).toBe(false);
    expect(terminal.selectedRanges).toEqual([{ column: 5, row: 2, length: 1 }]);

    terminal.selectionRange = { start: { x: 10, y: 5 }, end: { x: 14, y: 5 } };
    terminal.selectionChangeHandler?.();

    expect(
      terminal.customKeyEventHandler?.(
        new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, cancelable: true })
      )
    ).toBe(false);
    expect(terminal.selectedRanges.at(-1)).toEqual({ column: 10, row: 5, length: 5 });
  });

  it('pastes with Ctrl+V on Windows without sending the chord to the PTY', async () => {
    vi.stubGlobal('__LODY_PLATFORM__', { os: 'win32' });
    __resetPlatformCacheForTests();
    const channel = createChannel();
    vi.mocked(channel.readClipboardText).mockReturnValue('clipboard input');

    await act(async () => {
      root?.render(<LocalTerminalPanel channel={channel} terminalId="terminal-1" />);
      await Promise.resolve();
    });

    const terminal = mocks.terminalInstances[0];
    const pasteEvent = new KeyboardEvent('keydown', {
      key: 'v',
      code: 'KeyV',
      ctrlKey: true,
      cancelable: true,
    });

    expect(terminal.customKeyEventHandler?.(pasteEvent)).toBe(false);
    expect(pasteEvent.defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(terminal.pasted).toEqual(['clipboard input']);
    expect(channel.input).not.toHaveBeenCalled();
  });

  it('pastes with Ctrl+Shift+V on Windows', async () => {
    vi.stubGlobal('__LODY_PLATFORM__', { os: 'win32' });
    __resetPlatformCacheForTests();
    const channel = createChannel();
    vi.mocked(channel.readClipboardText).mockResolvedValue('shift paste');

    await act(async () => {
      root?.render(<LocalTerminalPanel channel={channel} terminalId="terminal-1" />);
      await Promise.resolve();
    });

    const terminal = mocks.terminalInstances[0];
    const pasteEvent = new KeyboardEvent('keydown', {
      key: 'V',
      code: 'KeyV',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });

    expect(terminal.customKeyEventHandler?.(pasteEvent)).toBe(false);
    await Promise.resolve();
    expect(terminal.pasted).toEqual(['shift paste']);
  });

  it('pastes with Cmd+V on macOS and leaves Ctrl+V for the PTY', async () => {
    vi.stubGlobal('__LODY_PLATFORM__', { os: 'darwin' });
    __resetPlatformCacheForTests();
    const channel = createChannel();
    vi.mocked(channel.readClipboardText).mockResolvedValue('mac paste');

    await act(async () => {
      root?.render(<LocalTerminalPanel channel={channel} terminalId="terminal-1" />);
      await Promise.resolve();
    });

    const terminal = mocks.terminalInstances[0];
    const cmdPaste = new KeyboardEvent('keydown', {
      key: 'v',
      code: 'KeyV',
      metaKey: true,
      cancelable: true,
    });
    expect(terminal.customKeyEventHandler?.(cmdPaste)).toBe(false);
    await Promise.resolve();
    expect(terminal.pasted).toEqual(['mac paste']);

    const ctrlPaste = new KeyboardEvent('keydown', {
      key: 'v',
      code: 'KeyV',
      ctrlKey: true,
      cancelable: true,
    });
    expect(terminal.customKeyEventHandler?.(ctrlPaste)).toBe(true);
    expect(terminal.pasted).toEqual(['mac paste']);
  });

  it('copies and pastes through the terminal context menu', async () => {
    const channel = createChannel();
    vi.mocked(channel.readClipboardText).mockReturnValue('clipboard input');

    await act(async () => {
      root?.render(<LocalTerminalPanel channel={channel} terminalId="terminal-1" />);
      await Promise.resolve();
    });

    const terminal = mocks.terminalInstances[0];
    terminal.selection = 'selected output';

    await act(async () => {
      openTerminalContextMenu(container);
    });

    const copyItem = getMenuItem('Copy');
    await act(async () => copyItem.click());
    expect(channel.writeClipboardText).toHaveBeenCalledWith('selected output');

    await act(async () => {
      openTerminalContextMenu(container);
    });
    const pasteItem = getMenuItem('Paste');
    await act(async () => pasteItem.click());
    expect(terminal.pasted).toEqual(['clipboard input']);
  });

  it('shows Cmd+C for the copy action on macOS', async () => {
    vi.stubGlobal('__LODY_PLATFORM__', { os: 'darwin' });
    __resetPlatformCacheForTests();
    const channel = createChannel();

    await act(async () => {
      root?.render(<LocalTerminalPanel channel={channel} terminalId="terminal-1" />);
      await Promise.resolve();
    });

    await act(async () => {
      openTerminalContextMenu(container);
    });

    const copyItem = getMenuItem('Copy');
    expect(copyItem.textContent).toContain('⌘C');
    expect(copyItem.textContent).not.toContain('Ctrl+Shift+C');
    const pasteItem = getMenuItem('Paste');
    expect(pasteItem.textContent).toContain('⌘V');
  });
});

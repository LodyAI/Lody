// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ILink, Terminal } from '@xterm/xterm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalChannel } from '../src/components/terminal/terminal-channel';
import { readTerminalUrlLinks } from '../src/components/terminal/terminal-links';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';
import { initI18n } from '../src/i18n';

const mocks = vi.hoisted(() => ({
  terminal: undefined as Terminal | undefined,
  openExternalUrl: vi.fn(async () => true),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate(terminal: Terminal) {
      mocks.terminal = terminal;
    }
    fit() {}
    dispose() {}
  },
}));
vi.mock('../src/lib/native-browser', () => ({ openExternalUrl: mocks.openExternalUrl }));
vi.mock('../src/lib/resize-observer', () => ({ observeResizeOnAnimationFrame: () => () => {} }));
vi.mock('../src/theme-provider', () => ({
  useResolvedTheme: () => 'light',
  useActiveVSCodeThemeId: () => null,
}));

let LocalTerminalPanel: (typeof import('../src/components/terminal/local-terminal-panel'))['LocalTerminalPanel'];
beforeAll(async () => {
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  ({ LocalTerminalPanel } = await import('../src/components/terminal/local-terminal-panel'));
  canvas.mockRestore();
});

type TerminalCore = {
  _mouseService: { getCoords: (event: MouseEvent) => number[] };
  linkifier: {
    currentLink?: {
      link: ILink;
      state: { decorations: { underline: boolean; pointerCursor: boolean } };
    };
    onShowLinkUnderline: (handler: (range: { x1: number; x2: number }) => void) => {
      dispose(): void;
    };
  };
  _renderService: {
    _onRenderedViewportChange: { fire(event: { start: number; end: number }): void };
  };
};

describe('Terminal link interactions', () => {
  let root: Root | undefined;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.terminal = undefined;
    mocks.openExternalUrl.mockClear();
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    __resetPlatformCacheForTests();
  });

  async function mountTerminal(os = 'darwin') {
    vi.stubGlobal('__LODY_PLATFORM__', { os });
    __resetPlatformCacheForTests();
    const channel: TerminalChannel = {
      list: async () => [],
      open: async () => ({ terminalId: 'terminal-1', title: 'shell' }),
      attach() {},
      input() {},
      resize() {},
      close() {},
      closeSession() {},
      readClipboardText: () => '',
      writeClipboardText() {},
      onData: () => () => {},
      onExit: () => () => {},
      onTitle: () => () => {},
    };
    await act(async () =>
      root?.render(<LocalTerminalPanel channel={channel} terminalId="terminal-1" />)
    );
    const terminal = mocks.terminal!;
    const core = (terminal as unknown as { _core: TerminalCore })._core;
    core._mouseService.getCoords = (event) => [event.clientX, event.clientY || 1];
    const host = terminal.element!.querySelector<HTMLElement>('.xterm-screen')!;
    return { terminal, core, host };
  }

  it.each(['darwin', 'win32', 'linux'])(
    'opens only deliberate HTTP(S) clicks on %s',
    async (os) => {
      const { terminal, core, host } = await mountTerminal(os);
      await new Promise<void>((resolve) => terminal.write('https://example.com', resolve));
      host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 2 }));
      const link = core.linkifier.currentLink!.link;
      expect(link.text).toBe('https://example.com');
      const osc = terminal.options.linkHandler!;
      expect(osc.allowNonHttpProtocols).toBeUndefined();
      const modifier = os === 'darwin' ? { metaKey: true } : { ctrlKey: true };
      for (const activate of [
        link.activate,
        (event: MouseEvent, url: string) => osc.activate(event, url, link.range),
      ]) {
        mocks.openExternalUrl.mockClear();
        for (const init of [
          {},
          { ...modifier, altKey: true },
          { metaKey: true, ctrlKey: true },
          { ...modifier, button: 1 },
          { ...modifier, button: 2 },
        ]) {
          activate(new MouseEvent('mouseup', init), link.text);
        }
        terminal.select(0, 0, 3);
        activate(new MouseEvent('mouseup', modifier), link.text);
        terminal.clearSelection();
        activate(new MouseEvent('mouseup', modifier), 'lody://session/unsafe');
        activate(new MouseEvent('mouseup', modifier), 'javascript:alert(1)');
        expect(mocks.openExternalUrl).not.toHaveBeenCalled();
        activate(new MouseEvent('mouseup', modifier), link.text);
        expect(mocks.openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://example.com');
        activate(new MouseEvent('mouseup', { ...modifier, shiftKey: true }), link.text);
        expect(mocks.openExternalUrl).toHaveBeenCalledTimes(2);
      }
    }
  );

  it('uses the real xterm Linkifier for capture, cached hover, render refresh, selection and cleanup', async () => {
    const { terminal, core, host } = await mountTerminal();
    await new Promise<void>((resolve) =>
      terminal.write('https://one.test https://two.test', resolve)
    );
    const move = (x: number, metaKey = false) =>
      host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, metaKey }));
    const underlineRanges: number[] = [];
    const subscription = core.linkifier.onShowLinkUnderline((range) =>
      underlineRanges.push(range.x1)
    );
    move(2, true);
    expect(core.linkifier.currentLink?.state.decorations).toEqual({
      underline: true,
      pointerCursor: true,
    });
    expect(host.classList.contains('xterm-cursor-pointer')).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' }));
    expect(host.classList.contains('xterm-cursor-pointer')).toBe(false);
    move(17);
    move(20);
    expect(core.linkifier.currentLink?.state.decorations).toEqual({
      underline: false,
      pointerCursor: false,
    });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
    expect(core.linkifier.currentLink?.state.decorations).toEqual({
      underline: true,
      pointerCursor: true,
    });
    expect(underlineRanges.at(-1)).toBe(17);
    move(17, true);
    move(2, true);
    expect(core.linkifier.currentLink?.state.decorations.underline).toBe(true);
    expect(underlineRanges.at(-1)).toBe(0);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' }));
    core._renderService._onRenderedViewportChange.fire({ start: 0, end: 1 });
    expect(core.linkifier.currentLink?.state.decorations.underline).toBe(false);
    const click = () => {
      host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 2, metaKey: true }));
      terminal.select(0, 0, 3);
      host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 3, metaKey: true }));
    };
    click();
    expect(mocks.openExternalUrl).not.toHaveBeenCalled();
    terminal.clearSelection();
    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 2, metaKey: true }));
    host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 2, metaKey: true }));
    expect(mocks.openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://one.test');
    window.dispatchEvent(new Event('blur'));
    expect(host.classList.contains('xterm-cursor-pointer')).toBe(false);
    terminal.reset();
    await new Promise<void>((resolve) =>
      terminal.write(
        '\x1b]8;;https://example.com/osc\x07Open target\x1b]8;;\x07\r\n\x1b]8;;lody://session/unsafe\x07Internal link\x1b]8;;\x07',
        resolve
      )
    );
    core._renderService._onRenderedViewportChange.fire({ start: 0, end: 2 });
    move(3);
    expect(core.linkifier.currentLink?.link.text).toBe('https://example.com/osc');
    expect(core.linkifier.currentLink?.state.decorations.underline).toBe(true);
    mocks.openExternalUrl.mockClear();
    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 3 }));
    host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 3 }));
    expect(mocks.openExternalUrl).not.toHaveBeenCalled();
    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 3, metaKey: true }));
    host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 3, metaKey: true }));
    expect(mocks.openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://example.com/osc');
    host.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 3, clientY: 2, metaKey: true })
    );
    expect(core.linkifier.currentLink).toBeUndefined();
    subscription.dispose();
    terminal.reset();
    await new Promise<void>((resolve) => terminal.write('https://one.test', resolve));
    core._renderService._onRenderedViewportChange.fire({ start: 0, end: 2 });
    move(3);
    const decorations = core.linkifier.currentLink!.link.decorations;
    await act(async () => root?.unmount());
    root = undefined;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
    expect(decorations?.underline).toBe(false);
    vi.restoreAllMocks();
  });
});

describe('Terminal URL buffer ranges', () => {
  let terminal: Terminal;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm');
    terminal = new actual.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  });

  afterEach(() => terminal.dispose());

  const write = (text: string) => new Promise<void>((resolve) => terminal.write(text, resolve));

  it.each([
    ['(https://example.com/foo)', 'https://example.com/foo'],
    ['https://en.wikipedia.org/wiki/Foo_(bar).', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    ['[https://example.com/[a]{b}(c)]', 'https://example.com/[a]{b}(c)'],
    ['<https://example.com/foo>', 'https://example.com/foo'],
    ['"https://example.com/foo"', 'https://example.com/foo'],
    ["'https://example.com/foo'", 'https://example.com/foo'],
    ['`https://example.com/foo`', 'https://example.com/foo'],
    ['https://[::1]:8080/a?x=1,2&b=3#tag', 'https://[::1]:8080/a?x=1,2&b=3#tag'],
    ['https://example.com/foo.,;:!?。，；：！？、', 'https://example.com/foo'],
    ['https://example.com/foo。后文', 'https://example.com/foo'],
    ['请访问https://example.com/foo查看', 'https://example.com/foo'],
    ['（https://example.com/foo）', 'https://example.com/foo'],
    ['【https://example.com/foo】', 'https://example.com/foo'],
    ['https://example.com/%E4%B8%AD', 'https://example.com/%E4%B8%AD'],
  ])('extracts the URL from %s', async (text, expected) => {
    await write(text);
    expect(readTerminalUrlLinks(terminal.buffer.active, 1).map((link) => link.text)).toEqual([
      expected,
    ]);
  });

  it('maps combining text and wide prefixes to inclusive terminal columns', async () => {
    await write('中e\u0301 https://example.com/foo');
    expect(readTerminalUrlLinks(terminal.buffer.active, 1)).toEqual([
      {
        text: 'https://example.com/foo',
        range: { start: { x: 5, y: 1 }, end: { x: 27, y: 1 } },
      },
    ]);
  });

  it('joins wrapped URLs across a wide-character padding cell from either row', async () => {
    terminal.resize(24, 24);
    await write(`${' '.repeat(23)}中 https://example.com/foo`);
    expect(terminal.buffer.active.getLine(0)?.getCell(23)?.getChars()).toBe('');
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(true);
    const expected = [
      {
        text: 'https://example.com/foo',
        range: { start: { x: 4, y: 2 }, end: { x: 2, y: 3 } },
      },
    ];
    expect(readTerminalUrlLinks(terminal.buffer.active, 2)).toEqual(expected);
    expect(readTerminalUrlLinks(terminal.buffer.active, 3)).toEqual(expected);
  });

  it('preserves null-cell boundaries and hard newlines', async () => {
    await write('https://one.test\x1b[3Chttps://two.test\r\nhttps://three.test');
    expect(readTerminalUrlLinks(terminal.buffer.active, 1).map((link) => link.text)).toEqual([
      'https://one.test',
      'https://two.test',
    ]);
    expect(readTerminalUrlLinks(terminal.buffer.active, 2).map((link) => link.text)).toEqual([
      'https://three.test',
    ]);
  });

  it('rejects oversized logical lines without exposing a truncated URL', async () => {
    terminal.resize(32, 100);
    await write(`https://example.com/${'a'.repeat(5000)}`);
    expect(readTerminalUrlLinks(terminal.buffer.active, 1)).toEqual([]);
    expect(readTerminalUrlLinks(terminal.buffer.active, 65)).toEqual([]);
    terminal.reset();
    await write('https://example.com/ok');
    expect(readTerminalUrlLinks(terminal.buffer.active, 1)[0]?.text).toBe('https://example.com/ok');
  });

  it('keeps complete short URLs inside an oversized wrapped logical line', async () => {
    terminal.resize(32, 100);
    await write(`${'x'.repeat(2200)} https://example.com/ok ${'y'.repeat(2200)}`);
    expect(readTerminalUrlLinks(terminal.buffer.active, 70)).toEqual([
      {
        text: 'https://example.com/ok',
        range: { start: { x: 26, y: 69 }, end: { x: 15, y: 70 } },
      },
    ]);
  });

  it('excludes a URL prefix that starts at the clipped beginning of another URL', async () => {
    terminal.resize(32, 100);
    const prefix = 'https://outer.test/';
    await write(`${prefix}${'x'.repeat(32 - prefix.length)}https://inner.test/${'q'.repeat(2200)}`);
    expect(readTerminalUrlLinks(terminal.buffer.active, 66)).toEqual([]);
  });

  it('does not charge unused cells in the last row against the scan window', async () => {
    terminal.resize(220, 24);
    await write(`https://example.com/ok ${'x'.repeat(1970)}`);
    expect(readTerminalUrlLinks(terminal.buffer.active, 1).map((link) => link.text)).toEqual([
      'https://example.com/ok',
    ]);
  });

  it('ignores unsupported protocols and malformed HTTP URLs', async () => {
    await write('lody://session/1 javascript:alert(1) https:// http://.');
    expect(readTerminalUrlLinks(terminal.buffer.active, 1)).toEqual([]);
  });
});

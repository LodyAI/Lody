// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getDefaultStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalDock } from '../src/components/terminal/terminal-dock';
import { terminalControllerAtom } from '../src/components/terminal/terminal-controller';
import type {
  TerminalChannel,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSnapshot,
  TerminalTitleEvent,
  Unsubscribe,
} from '../src/components/terminal/terminal-channel';

vi.mock('../src/components/terminal/local-terminal-panel', () => ({
  LocalTerminalPanel: () => null,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class EmptyTerminalChannel implements TerminalChannel {
  list = vi.fn(async () => []);
  open = vi.fn(async () => {
    throw new Error('unexpected_open');
  });
  attach = vi.fn();
  input = vi.fn();
  resize = vi.fn();
  close = vi.fn();
  closeSession = vi.fn();
  readClipboardText = vi.fn(() => '');
  writeClipboardText = vi.fn();

  onData(_handler: (event: TerminalDataEvent) => void): Unsubscribe {
    return () => {};
  }

  onExit(_handler: (event: TerminalExitEvent) => void): Unsubscribe {
    return () => {};
  }

  onTitle(_handler: (event: TerminalTitleEvent) => void): Unsubscribe {
    return () => {};
  }
}

class StaticTerminalChannel extends EmptyTerminalChannel {
  constructor(private readonly sessions: Record<string, TerminalSnapshot[]>) {
    super();
  }

  override list = vi.fn(async (sessionId: string) => this.sessions[sessionId] ?? []);
}

class DeferredTerminalChannel extends EmptyTerminalChannel {
  private resolveList: ((terminals: TerminalSnapshot[]) => void) | null = null;
  private readonly listPromise = new Promise<TerminalSnapshot[]>((resolve) => {
    this.resolveList = resolve;
  });

  override list = vi.fn(async () => this.listPromise);

  resolve(terminals: TerminalSnapshot[]): void {
    this.resolveList?.(terminals);
  }
}

async function flushReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flushReact();
}

// The dock is hidden until opened. With no visible tab strip in the closed
// state, the only entry point is the controller the dock publishes (the session
// header's toggle button + the ⌃`/⌘J command both drive it).
async function toggleDock(): Promise<void> {
  await act(async () => {
    getDefaultStore().get(terminalControllerAtom)?.toggleOpen();
  });
  await flushReact();
}

function hasOpenPanel(container: HTMLElement): boolean {
  return container.querySelector('.cursor-ns-resize') !== null;
}

function getTerminalTab(container: HTMLElement, title: string): HTMLElement {
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(title)
  );
  if (!button?.parentElement) {
    throw new Error(`terminal_tab_not_found:${title}`);
  }
  return button.parentElement;
}

function getTerminalTabButton(container: HTMLElement, title: string): HTMLButtonElement {
  const button = getTerminalTab(container, title).querySelector('button');
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`terminal_tab_button_not_found:${title}`);
  }
  return button;
}

function expectActiveTerminal(container: HTMLElement, title: string): void {
  // Active tab = a flat fill against the strip's own `bg-sidebar` canvas (no
  // border/shadow — this strip already lives inside the floating card's own
  // border+shadow, so stacking another pair on a 24px tab read as heavy
  // chrome). See the comment on `TERMINAL_TAB_ACTIVE_CLASS`.
  const tab = getTerminalTab(container, title);
  expect(tab.getAttribute('aria-selected')).toBe('true');
  const classes = tab.className.split(/\s+/);
  expect(classes).toContain('bg-background');
  expect(classes).toContain('text-tab-active-foreground');
  expect(classes).not.toContain('shadow-[0_1px_4px_-1px_rgba(0,0,0,0.18)]');
}

describe('TerminalDock', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  it('collapses the terminal panel after a session lists no terminals', async () => {
    const channel = new EmptyTerminalChannel();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<TerminalDock channel={channel} sessionId="session-1" defaultView="terminal" />);
    });
    await flushReact();
    await flushReact();

    expect(channel.list).toHaveBeenCalledWith('session-1');
    expect(container.textContent).not.toContain('No terminal open');
    expect(container.textContent).not.toContain('Loading terminals');
    // Fully collapsed: no panel body and no lingering tab strip / bottom bar.
    expect(hasOpenPanel(container)).toBe(false);
    expect(container.querySelector('[aria-label="New terminal"]')).toBeNull();
  });

  it('remembers the open terminal and active tab per session in memory', async () => {
    const channel = new StaticTerminalChannel({
      'session-memory-a': [
        { terminalId: 'a-alpha', title: 'alpha' },
        { terminalId: 'a-beta', title: 'beta' },
      ],
      'session-memory-b': [],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<TerminalDock channel={channel} sessionId="session-memory-a" />);
    });
    await flushReact();
    await flushReact();

    expect(hasOpenPanel(container)).toBe(false);
    await toggleDock();
    expect(hasOpenPanel(container)).toBe(true);
    await click(getTerminalTabButton(container, 'beta'));
    expectActiveTerminal(container, 'beta');

    await act(async () => {
      root?.render(<TerminalDock channel={channel} sessionId="session-memory-b" />);
    });
    await flushReact();
    await flushReact();
    expect(hasOpenPanel(container)).toBe(false);

    await act(async () => {
      root?.render(<TerminalDock channel={channel} sessionId="session-memory-a" />);
    });
    await flushReact();
    await flushReact();
    expect(hasOpenPanel(container)).toBe(true);
    expectActiveTerminal(container, 'beta');

    act(() => {
      root?.unmount();
    });
    root = createRoot(container);

    await act(async () => {
      root?.render(<TerminalDock channel={channel} sessionId="session-memory-a" />);
    });
    await flushReact();
    await flushReact();
    expect(hasOpenPanel(container)).toBe(true);
    expectActiveTerminal(container, 'beta');
  });

  it('keeps the current terminal mounted during same-session terminal reloads', async () => {
    const terminals = [
      { terminalId: 'stable-alpha', title: 'alpha' },
      { terminalId: 'stable-beta', title: 'beta' },
    ];
    const channel = new StaticTerminalChannel({
      'session-stable-reload': terminals,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <TerminalDock channel={channel} sessionId="session-stable-reload" defaultView="terminal" />
      );
    });
    await flushReact();
    await flushReact();
    await click(getTerminalTabButton(container, 'beta'));
    expect(hasOpenPanel(container)).toBe(true);
    expectActiveTerminal(container, 'beta');

    const reloadChannel = new DeferredTerminalChannel();
    await act(async () => {
      root?.render(
        <TerminalDock
          channel={reloadChannel}
          sessionId="session-stable-reload"
          canCreateTerminal={false}
        />
      );
    });
    await flushReact();

    expect(reloadChannel.list).toHaveBeenCalledWith('session-stable-reload');
    expect(hasOpenPanel(container)).toBe(true);
    expectActiveTerminal(container, 'beta');

    await act(async () => {
      reloadChannel.resolve(terminals);
      await Promise.resolve();
    });
    await flushReact();

    expect(hasOpenPanel(container)).toBe(true);
    expectActiveTerminal(container, 'beta');
  });
});

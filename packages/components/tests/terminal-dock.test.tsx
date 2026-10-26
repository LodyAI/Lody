// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getDefaultStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSessionRoomId,
  type ElectronCliState,
  type CliRuntimeState,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { TerminalDock } from '../src/components/terminal/terminal-dock';
import { TerminalDockHost } from '../src/components/terminal-dock-host';
import {
  terminalControllerAtom,
  terminalDockCanCreateAtom,
} from '../src/components/terminal/terminal-controller';
import { localProbeResultAtom } from '../src/atoms/local-probe';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { sessionMetaCacheAtom } from '../src/atoms/doc-meta';
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

const route = vi.hoisted(() => ({ sessionId: '' }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useParams: () => route,
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
  return container.firstElementChild?.getAttribute('aria-hidden') === 'false';
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
  const tab = getTerminalTab(container, title);
  expect(tab.getAttribute('aria-selected')).toBe('true');
  expect([...container.querySelectorAll('[role="tab"][aria-selected="true"]')]).toEqual([tab]);
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

describe('TerminalDockHost workspace readiness', () => {
  const store = getDefaultStore();
  let root: Root;
  let container: HTMLDivElement;
  let state: ElectronCliState;
  let listeners: Set<(payload: unknown) => void>;
  let openedSessions: string[];
  let sequence = 0;

  function mixedState(): ElectronCliState & { runtime: CliRuntimeState } {
    return {
      phase: 'reconnecting',
      desiredState: 'running',
      localAgentEnabled: true,
      preventSleepEnabled: false,
      updatedAtMs: 1,
      startupStage: 'ready',
      connectivity: 'reconnecting',
      runtime: {
        schemaVersion: 1,
        pid: 123,
        machineId: 'machine-local',
        updatedAtMs: 1,
        phase: 'degraded',
        startupStage: 'ready',
        connectivity: 'reconnecting',
        connectedWorkspaces: [
          { id: 'plain', name: 'Plain', slug: null, role: 'owner', backendConnection: 'connected' },
        ],
        issues: [
          {
            id: 'encrypted-start',
            code: 'workspace_start_failed:encrypted',
            severity: 'warning',
            recoverable: true,
            message: 'Synthetic EACCES',
            firstSeenAtMs: 1,
            lastSeenAtMs: 1,
            count: 1,
          },
        ],
      },
    };
  }

  async function mount(): Promise<void> {
    await act(async () => root.render(<TerminalDockHost />));
    await flushReact();
  }

  async function publish(next: ElectronCliState): Promise<void> {
    state = next;
    await act(async () => {
      for (const listener of listeners) listener(state);
    });
  }

  beforeEach(() => {
    route.sessionId = `host-readiness-${++sequence}`;
    state = mixedState();
    listeners = new Set();
    openedSessions = [];
    window.__LODY_ELECTRON__ = true;
    window.ipc = {
      invoke: async (channel, ...args) => {
        if (channel === 'cli.getState') return state;
        if (channel === 'terminal.list') return [];
        if (channel === 'terminal.open') {
          const request = args[0] as { sessionId: string };
          openedSessions.push(request.sessionId);
          return { terminalId: `terminal-${openedSessions.length}` };
        }
        throw new Error(`unexpected IPC: ${channel}`);
      },
      on: (channel, listener) => {
        if (channel === 'cli.state') listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      send: () => {},
    };
    store.set(localProbeResultAtom, { ok: true, machineId: 'machine-local' });
    store.set(runtimeAtom, { workspaceId: 'plain', workspaceSlug: 'plain' } as WorkspaceRuntime);
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(route.sessionId as SessionId)]: {
        id: route.sessionId,
        machineId: 'machine-local',
        acpSessionId: 'synthetic-acp-session',
      } as SessionMeta,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.set(runtimeAtom, null);
    store.set(localProbeResultAtom, null);
    store.set(sessionMetaCacheAtom, {});
    delete window.ipc;
    delete window.__LODY_ELECTRON__;
  });

  it('creates ordinary workspace terminals while an unrelated encrypted workspace retries', async () => {
    await mount();
    expect(store.get(terminalDockCanCreateAtom)).toBe(true);
    await toggleDock();
    expect(openedSessions).toEqual([route.sessionId]);
    expect(hasOpenPanel(container)).toBe(true);
    const add = container.querySelector('[aria-label="New terminal"]');
    if (!(add instanceof HTMLButtonElement)) throw new Error('missing new terminal button');
    expect(add.disabled).toBe(false);
    await click(add);
    expect(openedSessions).toEqual([route.sessionId, route.sessionId]);
    expect(state.connectivity).toBe('reconnecting');
  });

  it('keeps the failed workspace blocked and recovers on its next ready snapshot', async () => {
    store.set(runtimeAtom, {
      workspaceId: 'encrypted',
      workspaceSlug: 'encrypted',
    } as WorkspaceRuntime);
    await mount();
    expect(store.get(terminalDockCanCreateAtom)).toBe(false);
    await toggleDock();
    expect(openedSessions).toEqual([]);
    expect(hasOpenPanel(container)).toBe(false);
    const recovered = mixedState();
    recovered.runtime.connectedWorkspaces = [
      ...(recovered.runtime.connectedWorkspaces ?? []),
      {
        id: 'encrypted',
        name: 'Encrypted',
        slug: null,
        role: 'owner',
        backendConnection: 'connected',
      },
    ];
    await publish(recovered);
    expect(store.get(terminalDockCanCreateAtom)).toBe(true);
    await toggleDock();
    expect(openedSessions).toEqual([route.sessionId]);
  });

  it('keeps unavailable processes and incomplete local startup blocked without a sticky failure', async () => {
    const ready = mixedState();
    const unavailable: ElectronCliState[] = [
      ...(['starting', 'stopping', 'stopped', 'offline', 'fatal'] as const).map((phase) => ({
        ...ready,
        phase,
      })),
      { ...ready, runtime: undefined },
      { ...ready, desiredState: 'stopped' },
      { ...ready, localAgentEnabled: false },
      { ...ready, runtime: { ...ready.runtime, startupStage: undefined } },
      { ...ready, runtime: { ...ready.runtime, phase: 'starting' } },
      { ...ready, runtime: { ...ready.runtime, connectedWorkspaces: undefined } },
    ];
    state = { ...ready, phase: 'starting' };
    await mount();
    for (const next of unavailable) {
      await publish(next);
      expect(store.get(terminalDockCanCreateAtom)).toBe(false);
      await toggleDock();
      expect(openedSessions).toEqual([]);
    }
    await publish(ready);
    await toggleDock();
    expect(openedSessions).toEqual([route.sessionId]);
  });

  it.each(['running', 'degraded'] as const)('preserves ordinary %s behavior', async (phase) => {
    state = { ...mixedState(), phase, runtime: undefined };
    await mount();
    await toggleDock();
    expect(openedSessions).toEqual([route.sessionId]);
  });

  it('does not enable a remote session during unrelated workspace recovery', async () => {
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(route.sessionId as SessionId)]: {
        id: route.sessionId,
        machineId: 'machine-remote',
        acpSessionId: 'synthetic-acp-session',
      } as SessionMeta,
    });
    await mount();
    expect(store.get(terminalDockCanCreateAtom)).toBe(false);
    await toggleDock();
    expect(openedSessions).toEqual([]);
  });
});

// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { LodyPresenceInstanceId, SessionId, SessionMeta } from '@lody/shared';

const bridge = await vi.hoisted(async () => {
  const { atom } = await import('jotai');
  const { EventEmitter: AppEvents } = await import('node:events');
  return {
    userAtom: atom<{ id: string } | null>({ id: 'owner' }),
    workspaceAtom: atom<string | null>('workspace'),
    app: new AppEvents(),
    write: (_badge: { unread: number; waiting: number }) => {},
    fail: false,
  };
});
vi.mock('../src/atoms', () => ({ userAtom: bridge.userAtom }));
vi.mock('../src/hooks/use-resolved-workspace-scope', async () => {
  const { useAtomValue } = await import('jotai');
  return { useResolvedWorkspaceScope: () => ({ workspaceId: useAtomValue(bridge.workspaceAtom) }) };
});
vi.mock('../src/lib/electron', () => ({ isElectronRenderer: () => true }));
vi.mock('../src/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({
    app: {
      setWindowBadge: async (badge: { unread: number; waiting: number }) => {
        if (bridge.fail) throw new Error('IPC unavailable');
        bridge.write(badge);
        return { ok: true };
      },
    },
  }),
}));
// Resolve Electron from its owning package, not the shared UI package.
vi.mock('../../../apps/electron/node_modules/electron', () => ({
  app: bridge.app,
  BrowserWindow: class {},
}));

import { sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '../src/atoms/presence';
import { useWorkspaceBadge, workspaceBadgeAtom } from '../src/hooks/use-workspace-badge';
import {
  WindowBadgeService,
  bindWindowBadgeToBrowserWindows,
} from '../../../apps/electron/src/main/services/window-badge-service';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function session(id: string, patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: id as SessionId,
    machineId: 'machine' as SessionMeta['machineId'],
    userId: 'owner',
    createdAt: '2026-09-26T00:00:00Z',
    cliType: 'builtin',
    agentType: 'codex',
    lastMessageAt: 200,
    lastReadAt: 100,
    ...patch,
  };
}
function Probe() {
  useWorkspaceBadge();
  return null;
}

describe('workspace badge reconciliation', () => {
  let store: ReturnType<typeof createStore>;
  let service: WindowBadgeService;
  let dock: string;
  let root: Root;
  let container: HTMLDivElement;

  function setSessions(...sessions: SessionMeta[]) {
    store.set(
      sessionMetaCacheAtom,
      Object.fromEntries(sessions.map((s) => [`session-${s.id}`, s]))
    );
  }
  async function mount() {
    await act(async () =>
      root.render(
        <Provider store={store}>
          <Probe />
        </Provider>
      )
    );
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    store = createStore();
    dock = '';
    service = new WindowBadgeService({
      platform: 'darwin',
      getDock: () => ({
        setBadge: (value) => {
          dock = value;
        },
        bounce: () => 1,
      }),
    });
    bridge.fail = false;
    bridge.write = (badge) => service.setBadge(1, badge);
    bridge.app.removeAllListeners();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    bridge.app.removeAllListeners();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('counts owned sidebar rows once and tracks close, reopen, read and archive', async () => {
    setSessions(
      session('root'),
      session('other', { userId: 'other' }),
      session('archived', { isArchived: true })
    );
    await mount();
    expect(dock).toBe('1');
    await act(async () => setSessions(session('root', { isTabClosed: true })));
    expect(dock).toBe('');
    await act(async () => setSessions(session('root', { isTabClosed: false })));
    expect(dock).toBe('1');
    await act(async () => setSessions(session('root', { lastReadAt: 200 })));
    expect(dock).toBe('');
    await act(async () => setSessions(session('root')));
    expect(dock).toBe('1');
    await act(async () => setSessions(session('root', { isArchived: true })));
    expect(dock).toBe('');
  });

  it('rolls child and side-chat unread/waiting into one closed parent row', async () => {
    const parent = session('root', { isTabClosed: true });
    const child = session('child', { parentSessionId: parent.id });
    const side = session('side', {
      parentSessionId: parent.id,
      childSessionPlacement: 'side-panel',
    });
    setSessions(parent, child, side);
    await mount();
    expect(dock).toBe('1');
    await act(async () => {
      store.set(lodyPresenceNowMsAtom, 1_000);
      store.set(lodyPresenceStatesAtom, {
        child: {
          kind: 'session',
          sessionId: child.id,
          machineId: child.machineId,
          instanceId: 'worker' as LodyPresenceInstanceId,
          updatedAt: 1_000,
          status: { type: 'requestPermission' },
        },
      });
    });
    expect(store.get(workspaceBadgeAtom)).toEqual({ unread: 0, waiting: 1 });
    expect(dock).toBe('1');
    await act(async () => {
      setSessions(parent, { ...child, lastReadAt: 200 }, { ...side, isTabClosed: true });
      store.set(lodyPresenceNowMsAtom, 100_000);
    });
    expect(dock).toBe('');
  });

  it('reasserts an unchanged zero and retries a failed clear within 30 seconds', async () => {
    setSessions(session('root'));
    await mount();
    bridge.fail = true;
    await act(async () => setSessions(session('root', { lastReadAt: 200 })));
    expect(store.get(workspaceBadgeAtom)).toEqual({ unread: 0, waiting: 0 });
    expect(dock).toBe('1');
    bridge.fail = false;
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(dock).toBe('');
    dock = '1'; // Simulate OS state drifting without any atom change.
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(dock).toBe('');
  });

  it('does not postpone the reconciliation deadline when counts change', async () => {
    await mount();
    await act(async () => vi.advanceTimersByTime(29_000));
    await act(async () => setSessions(session('root')));
    dock = '9';
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(dock).toBe('1');
  });

  it('reconciles on focus and visibility restoration, then clears and stops on unmount', async () => {
    await mount();
    dock = '1';
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(dock).toBe('');
    dock = '1';
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(dock).toBe('');
    await act(async () => setSessions(session('root')));
    await act(async () => root.render(null));
    expect(dock).toBe('');
    dock = '2'; // A different owner's contribution must survive old timer cleanup.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      window.dispatchEvent(new Event('focus'));
    });
    expect(dock).toBe('2');
  });

  it('clears unresolved workspace and signed-out state', async () => {
    setSessions(session('root'));
    await mount();
    await act(async () => store.set(bridge.workspaceAtom, null));
    expect(dock).toBe('');
    await act(async () => store.set(bridge.workspaceAtom, 'workspace'));
    expect(dock).toBe('1');
    await act(async () => store.set(bridge.userAtom, null));
    expect(dock).toBe('');
  });

  it('removes crashed/reloaded window contributions without clearing another window', () => {
    bindWindowBadgeToBrowserWindows(service);
    const window = Object.assign(new EventEmitter(), { id: 1, webContents: new EventEmitter() });
    bridge.app.emit('browser-window-created', {}, window);
    service.setBadge(1, { unread: 1, waiting: 0 });
    service.setBadge(2, { unread: 2, waiting: 0 });
    expect(dock).toBe('3');
    window.webContents.emit('render-process-gone');
    expect(dock).toBe('2');
    service.setBadge(1, { unread: 1, waiting: 0 });
    window.webContents.emit('did-start-navigation', {}, '/', true, true);
    expect(dock).toBe('3');
    window.webContents.emit('did-start-navigation', {}, '/', false, true);
    expect(dock).toBe('2');
    service.setBadge(1, { unread: 1, waiting: 0 });
    window.emit('closed');
    expect(dock).toBe('2');
  });
});

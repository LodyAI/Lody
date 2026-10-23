// @vitest-environment jsdom
import React, { act } from 'react';
import { indexedDB, IDBObjectStore } from 'fake-indexeddb';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElectronStorageGuardState } from '@lody/shared';

const GIB = 1024 ** 3;

// The renderer talks to the real main-process guard; only the disk and the
// relaunch/quit side effects are synthetic.
const bridge = vi.hoisted(() => ({
  volume: { freeBytes: 0, totalBytes: 0 },
  listeners: new Set<(state: ElectronStorageGuardState) => void>(),
  relaunches: 0,
  quits: 0,
  initialState: null as null | Promise<ElectronStorageGuardState>,
  volumeError: false,
  guard: null as null | ReturnType<
    (typeof import('../../../apps/electron/src/main/services/storage-guard'))['createStorageGuard']
  >,
}));

vi.mock('../src/lib/electron-ipc-client', () => ({
  // Shaped like the `storageGuard` IPC group: every method is async.
  getIpcServices: () => ({
    storageGuard: {
      getState: async () => bridge.initialState ?? bridge.guard!.getState(),
      reportWriteFailure: async () => await bridge.guard!.reportWriteFailure('renderer'),
      relaunchIfSpaceFreed: async () => await bridge.guard!.relaunchIfSpaceFreed(),
      quit: async () => bridge.guard!.quit(),
    },
  }),
  onIpcEvent: (channel: string, listener: (state: ElectronStorageGuardState) => void) => {
    if (channel !== 'storageGuard.state') return () => {};
    bridge.listeners.add(listener);
    return () => bridge.listeners.delete(listener);
  },
}));

import { createStorageGuard } from '../../../apps/electron/src/main/services/storage-guard';
import { initI18n } from '../src/i18n';
import { StorageFullGuard } from '../src/components/storage-full-guard';
import { createWorkspaceRepoStorage } from '../src/providers/workspace-repo-storage';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('StorageFullGuard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(async () => {
    await initI18n('en');
  });

  beforeEach(async () => {
    bridge.volume = { freeBytes: 3.6 * GIB, totalBytes: 360 * GIB };
    bridge.relaunches = 0;
    bridge.quits = 0;
    bridge.initialState = null;
    bridge.volumeError = false;
    bridge.listeners.clear();
    bridge.guard = createStorageGuard({
      dataDirs: ['/profile'],
      readVolume: async () => {
        if (bridge.volumeError) throw new Error('EIO');
        return bridge.volume;
      },
      broadcast: (state) => {
        for (const listener of bridge.listeners) listener(state);
      },
      quitAndRelaunch: async () => {
        bridge.relaunches += 1;
        return 'quitting';
      },
      quit: () => {
        bridge.quits += 1;
      },
      log: () => {},
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<StorageFullGuard />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete window.__LODY_ELECTRON__;
  });

  const dialog = () => document.querySelector('[role="alertdialog"]');
  const button = (name: string) =>
    [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === name);

  it('stays hidden until a write failure is confirmed by a full disk', async () => {
    bridge.volume = { freeBytes: 200 * GIB, totalBytes: 500 * GIB };
    await act(async () => bridge.guard!.reportWriteFailure('renderer'));
    expect(dialog()).toBeNull();
  });

  it('blocks with a dialog that Escape cannot dismiss', async () => {
    await act(async () => bridge.guard!.reportWriteFailure('renderer'));
    expect(dialog()?.textContent).toContain('Your disk is full');
    expect(dialog()?.textContent).toContain('3.60 GB free');

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    expect(dialog()).not.toBeNull();
  });

  it('refuses to relaunch until space is freed, then relaunches', async () => {
    await act(async () => bridge.guard!.reportWriteFailure('renderer'));

    bridge.volume = { freeBytes: 5 * GIB, totalBytes: 360 * GIB };
    await act(async () => button('Check again and restart')!.click());
    expect(bridge.relaunches).toBe(0);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      'Still not enough space: 5.00 GB free'
    );

    bridge.volume = { freeBytes: 40 * GIB, totalBytes: 360 * GIB };
    await act(async () => button('Check again and restart')!.click());
    expect(bridge.relaunches).toBe(1);
  });

  it('quits on request', async () => {
    await act(async () => bridge.guard!.reportWriteFailure('cli'));
    await act(async () => button('Quit Lody')!.click());
    expect(bridge.quits).toBe(1);
  });

  it('keeps a newer blocking push when the initial state response arrives late', async () => {
    await act(async () => root.unmount());
    let resolveInitial!: (state: ElectronStorageGuardState) => void;
    bridge.initialState = new Promise((resolve) => {
      resolveInitial = resolve;
    });
    root = createRoot(container);
    await act(async () => root.render(<StorageFullGuard />));
    await act(async () => bridge.guard!.reportWriteFailure('renderer'));
    expect(dialog()).not.toBeNull();
    await act(async () => resolveInitial({ blocked: false }));
    expect(dialog()).not.toBeNull();
  });

  it('keeps the dialog and quit action available when the disk check fails', async () => {
    await act(async () => bridge.guard!.reportWriteFailure('renderer'));
    bridge.volumeError = true;
    await act(async () => button('Check again and restart')!.click());
    expect(bridge.relaunches).toBe(0);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      'Could not check disk space'
    );
    expect(dialog()).not.toBeNull();
    await act(async () => button('Quit Lody')!.click());
    expect(bridge.quits).toBe(1);
  });

  it('shows the guard from a real IndexedDB write failure and still rejects the write', async () => {
    vi.stubGlobal('indexedDB', indexedDB);
    window.__LODY_ELECTRON__ = true;
    const storage = createWorkspaceRepoStorage('disk-guard-quota');
    // Warm the schema first so this faults the write, rather than schema creation.
    await storage.save({ type: 'doc-update', docId: 'session', update: new Uint8Array([1]) });
    const quota = new DOMException('Disk is full', 'QuotaExceededError');
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw quota;
    });
    try {
      await act(async () => {
        await expect(
          storage.save({ type: 'doc-update', docId: 'session', update: new Uint8Array([2]) })
        ).rejects.toMatchObject({
          code: 'quota',
          causeName: 'QuotaExceededError',
        });
      });
      expect(dialog()?.textContent).toContain('Your disk is full');
    } finally {
      await storage.close();
    }
  });

  it('does not report IndexedDB read failures as disk-full writes', async () => {
    vi.stubGlobal('indexedDB', indexedDB);
    window.__LODY_ELECTRON__ = true;
    const storage = createWorkspaceRepoStorage('disk-guard-read');
    await storage.save({ type: 'doc-update', docId: 'session', update: new Uint8Array([1]) });
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(() => {
      throw new DOMException('Disk read failed', 'UnknownError');
    });
    try {
      await act(async () => {
        await expect(storage.loadDoc('session')).rejects.toBeDefined();
      });
      expect(dialog()).toBeNull();
    } finally {
      await storage.close();
    }
  });

  it('reports a write transaction that aborts after its request succeeds', async () => {
    vi.stubGlobal('indexedDB', indexedDB);
    window.__LODY_ELECTRON__ = true;
    const storage = createWorkspaceRepoStorage('disk-guard-abort');
    await storage.save({ type: 'doc-update', docId: 'session', update: new Uint8Array([1]) });
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      const request = put.apply(this, args);
      request.addEventListener('success', () => this.transaction.abort(), { once: true });
      return request;
    });
    try {
      await act(async () => {
        await expect(
          storage.save({ type: 'doc-update', docId: 'session', update: new Uint8Array([2]) })
        ).rejects.toMatchObject({ name: 'RepoStorageError' });
      });
      expect(dialog()?.textContent).toContain('Your disk is full');
    } finally {
      await storage.close();
    }
  });
});

// @vitest-environment jsdom

// Two rules this hook must not get wrong:
//
// 1. Reaching a shell needs a RESOLVED host path, not merely "Electron on the
//    owning machine". While that machine's path metadata loads, the local-host
//    actions can only fail — and the download that would have worked must not
//    be hidden behind them.
// 2. The remote download reads through the preview API's ONE bounded response,
//    so it cannot serve a file past those limits — exactly the file whose error
//    card sent the user looking. It must SAY that: a generic "could not
//    download" reads as a glitch worth retrying.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atom, Provider } from 'jotai';

// The machine's own path metadata: `null` is the state right after mount, when
// the Flock rows for that machine have not arrived yet.
let localHomeDir: string | null = '/home/dev';
let localMachineId: string | null = null;

vi.mock('../src/atoms/local-probe', () => ({
  localHomeDirAtom: atom(() => localHomeDir),
  localMachineIdAtom: atom(() => localMachineId),
}));

// `../src/atoms` is deliberately NOT mocked: it is a barrel half the graph
// imports, and the real machine-meta family already answers `null` for a
// machine no store knows about, which is the state under test.

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

const downloadBytesAsFile = vi.fn();
vi.mock('../src/lib/download-file', () => ({
  downloadBytesAsFile: (...args: unknown[]) => downloadBytesAsFile(...args),
  getDownloadFileName: (path: string) => path,
}));

vi.mock('../src/hooks/use-machine-flock-rows', () => ({
  useMachineFlockRows: () => ({}),
}));

import type { SessionMeta } from '@lody/shared';
import {
  useSessionFileActions,
  type SessionFileActions,
} from '../src/hooks/use-session-file-actions';
import type { FileWorkspaceOpenResult } from '../src/lib/file-workspace-provider';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const session = {
  id: 'session-download',
  machineId: 'machine-remote',
  createdAt: '2026-05-09T00:00:00.000Z',
  userId: 'user-1',
} as unknown as SessionMeta;

describe('remote file download action', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    toastError.mockClear();
    downloadBytesAsFile.mockClear();
    localHomeDir = '/home/dev';
    localMachineId = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
  });

  const runDownload = async (openResult: FileWorkspaceOpenResult): Promise<void> => {
    const fileProvider = { openFile: async () => openResult };
    let download: ((filePath: string) => void) | null = null;
    function Probe() {
      download = useSessionFileActions({ session, fileProvider }).download;
      return null;
    }
    await act(async () => {
      root?.render(createElement(Provider, null, createElement(Probe)));
    });
    expect(download).not.toBeNull();
    await act(async () => {
      download?.('docs/huge.log');
    });
  };

  it('downloads the bytes of a file the preview API can return', async () => {
    await runDownload({
      status: 'ready',
      entry: { entryType: 'file', fileId: 'docs/huge.log', path: 'docs/huge.log' },
      snapshot: { kind: 'text', text: 'hello' },
    } as unknown as FileWorkspaceOpenResult);

    expect(downloadBytesAsFile).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('names the real ceiling when the file is past what one response carries', async () => {
    await runDownload({ status: 'unavailable', reason: 'text-too-large' });

    expect(downloadBytesAsFile).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      'This file is too large to download from here. Open it on the machine that owns it.'
    );
  });

  it('treats a binary snapshot with no bytes as the same ceiling', async () => {
    // The machine declined to send the bytes, which is that same situation.
    await runDownload({
      status: 'ready',
      entry: { entryType: 'file', fileId: 'assets/clip.mov', path: 'assets/clip.mov' },
      snapshot: { kind: 'binary' },
    } as unknown as FileWorkspaceOpenResult);

    expect(downloadBytesAsFile).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      'This file is too large to download from here. Open it on the machine that owns it.'
    );
  });
});

describe('local-host actions vs a resolvable host path', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    localMachineId = session.machineId;
    localHomeDir = '/home/dev';
    (window as { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__ = true;
    (window as { __LODY_PLATFORM__?: { os: string } }).__LODY_PLATFORM__ = { os: 'darwin' };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
    delete (window as { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__;
    delete (window as { __LODY_PLATFORM__?: { os: string } }).__LODY_PLATFORM__;
    localMachineId = null;
    localHomeDir = '/home/dev';
  });

  const resolveActions = async (): Promise<SessionFileActions> => {
    const fileProvider = {
      openFile: async () => ({ status: 'unavailable' as const, reason: 'deleted' as const }),
    };
    let actions: SessionFileActions | undefined;
    function Probe() {
      actions = useSessionFileActions({ session, fileProvider });
      return null;
    }
    await act(async () => {
      root?.render(createElement(Provider, null, createElement(Probe)));
    });
    if (!actions) throw new Error('hook did not render');
    return actions;
  };

  it('offers the shell actions once the machine path resolves', async () => {
    const actions = await resolveActions();

    expect(actions.resolveHostPath('src/main.ts')).not.toBeNull();
    expect(actions.localHost).not.toBeNull();
    expect(actions.menuItems.map((item) => item.id)).toEqual([
      'copy-path',
      'open-in-editor',
      'reveal',
    ]);
    // The download is the complement, so it stays away while the shell is reachable.
    expect(actions.download).toBeNull();
  });

  it('offers no shell action, and keeps the download, while the path is unresolved', async () => {
    // Same machine, same desktop app — the path metadata simply has not landed.
    localHomeDir = null;
    const actions = await resolveActions();

    expect(actions.resolveHostPath('src/main.ts')).toBeNull();
    expect(actions.localHost).toBeNull();
    expect(actions.menuItems.map((item) => item.id)).toEqual(['copy-path', 'download']);
    expect(actions.download).not.toBeNull();
  });
});

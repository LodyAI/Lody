// @vitest-environment jsdom

// The remote download reads through the preview API's ONE bounded response, so
// it cannot serve a file past those limits — which is exactly the file whose
// error card sent the user looking for a way out. It must SAY that: a generic
// "could not download" reads as a glitch worth retrying.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider } from 'jotai';

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
import { useSessionFileActions } from '../src/hooks/use-session-file-actions';
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

  it('keeps a deleted file distinct from a size ceiling', async () => {
    await runDownload({ status: 'unavailable', reason: 'deleted' });

    expect(toastError).toHaveBeenCalledWith('That file no longer exists.');
  });
});

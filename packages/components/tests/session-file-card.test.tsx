// @vitest-environment jsdom
import { localProbeResultAtom } from '../src/atoms/local-probe';
import { SessionChatActionContext } from '../src/components/ai-gui/view';
import {
  resolveSessionFileOpenTarget,
  resolveDirectMarkdownFileOpenTarget,
} from '../src/lib/session-file-open-target';
import { Provider, createStore } from 'jotai';
import { authTokenAtom, runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { currentWorkspaceIdAtom } from '../src/atoms';
import { LocalAttachmentCard, WorkspaceSessionFileGroup } from '../src/components/ai-gui/view';
import { SessionFileAttachmentPane } from '../src/components/ai-gui/session-file-attachment';
import * as fileSaver from '../src/lib/download-file';

// The card's second action exists for exactly one gap: an HTML attachment's
// click opens the RENDERED page, so without it the uploaded source bytes have
// no route at all. Every other previewable file downloads from inside the
// attachment preview and must NOT grow a duplicate control.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerNow, type SessionFilePayload } from '@lody/shared';

import { SessionFileCard } from '../src/components/ai-gui/session-file-card';
import { SESSION_FILE_RETENTION_MS } from '../src/lib/session-file-presentation';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const file = (overrides: Partial<SessionFilePayload> = {}): SessionFilePayload => ({
  type: 'file',
  fileId: 'file-1',
  fileName: 'lody-one-flyer.html',
  mimeType: 'text/html',
  sizeBytes: 16_300,
  sha256: 'a'.repeat(64),
  textPreview: true,
  transport: 'r2',
  uploadedAt: getServerNow(),
  ...overrides,
});

describe('SessionFileCard download action', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  const onPreview = vi.fn();
  const onDownload = vi.fn();

  beforeEach(async () => {
    await initI18n('en');
    onPreview.mockClear();
    onDownload.mockClear();
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

  const render = async (props: Partial<Parameters<typeof SessionFileCard>[0]>) => {
    await act(async () => {
      root?.render(
        createElement(SessionFileCard, {
          file: file(),
          onPreview,
          onDownload,
          ...props,
        })
      );
    });
    return container as HTMLDivElement;
  };

  const downloadButton = (view: HTMLElement) =>
    view.querySelector<HTMLButtonElement>('button[aria-label="Download file"]');

  it('offers preview and download side by side on an HTML attachment', async () => {
    const view = await render({});

    const preview = view.querySelector<HTMLButtonElement>(
      'button[aria-label="lody-one-flyer.html"]'
    );
    expect(preview).not.toBeNull();
    expect(downloadButton(view)).not.toBeNull();

    await act(async () => {
      preview?.click();
    });
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onDownload).not.toHaveBeenCalled();

    await act(async () => {
      downloadButton(view)?.click();
    });
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'file-1' }));
    // Downloading the source must not also open the preview it exists to avoid.
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it('keeps a published attachment available independently of source retention', async () => {
    const published = file({ uploadedAt: 0 });
    const view = await render({ file: published, retention: 'publication' });
    const preview = view.querySelector<HTMLButtonElement>(
      'button[aria-label="lody-one-flyer.html"]'
    );
    expect(preview?.disabled).toBe(false);
    await act(async () => {
      preview?.click();
    });
    expect(onPreview).toHaveBeenCalledWith(published);
    expect(view.textContent).not.toContain('expired');
  });

  it('does not duplicate the control on a previewable file whose preview downloads', async () => {
    const view = await render({
      file: file({ fileName: 'README.md', mimeType: 'text/markdown' }),
    });

    expect(downloadButton(view)).toBeNull();
    const preview = view.querySelector<HTMLButtonElement>('button[aria-label="README.md"]');
    await act(async () => {
      preview?.click();
    });
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it('keeps download as the card itself when the file has no preview', async () => {
    const view = await render({
      file: file({ fileName: 'mockups.zip', mimeType: 'application/zip', textPreview: false }),
    });

    expect(downloadButton(view)).toBeNull();
    await act(async () => {
      view.querySelector<HTMLButtonElement>('button[aria-label="mockups.zip"]')?.click();
    });
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('offers no download for bytes the client cannot fetch', async () => {
    const pending = await render({
      file: file({ transport: 'local', machineId: 'machine-abc' }),
    });
    expect(downloadButton(pending)).toBeNull();
    expect(
      pending.querySelector<HTMLButtonElement>('button[aria-label="lody-one-flyer.html"]')?.disabled
    ).toBe(true);

    const expired = await render({
      file: file({ uploadedAt: getServerNow() - SESSION_FILE_RETENTION_MS - 1000 }),
    });
    expect(downloadButton(expired)).toBeNull();
  });

  const statusLine = (view: HTMLElement) =>
    view.querySelector('button[aria-label]')?.querySelector('[title]')?.textContent;
});

it('downloads a remote local attachment only after clicking its card', async () => {
  await initI18n('en');
  const store = createStore();
  store.set(currentWorkspaceIdAtom, 'workspace' as never);
  const finish = Promise.withResolvers<import('@lody/shared').FileDownloadResponse>();
  let requested = false;
  let saved: Uint8Array | undefined;
  const save = vi.spyOn(fileSaver, 'saveBytesAsFile').mockImplementation(async (_name, bytes) => {
    saved = bytes;
    return { saved: true };
  });
  store.set(runtimeAtom, {
    requestFileDownloadChunk: async () => {
      requested = true;
      return finish.promise;
    },
  } as unknown as WorkspaceRuntime);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(
          Provider,
          { store },
          createElement(LocalAttachmentCard, {
            sessionId: 'session' as never,
            attachment: {
              type: 'local_attachment',
              path: '/synthetic/input.txt',
              machineId: 'remote',
              kind: 'file',
              fileName: 'input.txt',
              mimeType: 'text/plain',
              sizeBytes: 5,
            },
          })
        )
      )
    );
    expect(container.textContent).toContain('Download from original computer');
    expect(requested).toBe(false);
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    expect(container.textContent).toContain('Downloading from original computer');
    expect(saved).toBeUndefined();
    await act(async () =>
      finish.resolve({
        status: 'ok',
        path: 'input.txt',
        offset: 0,
        revision: 'a'.repeat(64),
        sizeBytes: 5,
        data: btoa('hello'),
      })
    );
    expect(Array.from(saved ?? [])).toEqual([104, 101, 108, 108, 111]);
    expect(container.textContent).not.toContain('Downloading from original computer');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    save.mockRestore();
  }
});

it.each(['/tmp/image # 中文.png', '/tmp/question?.txt', '/tmp/file:123', '/tmp/literal%20.txt'])(
  'opens a local attachment with its exact canonical path %s',
  async (filePath) => {
    await initI18n('en');
    const store = createStore();
    store.set(currentWorkspaceIdAtom, 'workspace' as never);
    store.set(localProbeResultAtom, { ok: true, machineId: 'local' });
    let opened: string | undefined;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          createElement(
            Provider,
            { store },
            createElement(
              SessionChatActionContext.Provider,
              {
                value: {
                  openLocalFile: (path: string, options?: { pathKind?: 'canonical' }) => {
                    opened = (
                      options?.pathKind === 'canonical'
                        ? resolveSessionFileOpenTarget({ rawPath: path, pathKind: 'canonical' })
                        : resolveDirectMarkdownFileOpenTarget(path)
                    )?.filePath;
                  },
                },
              },
              createElement(LocalAttachmentCard, {
                sessionId: 'session' as never,
                attachment: {
                  type: 'local_attachment',
                  path: filePath,
                  machineId: 'local',
                  kind: 'file',
                  fileName: 'attachment',
                  mimeType: 'text/plain',
                  sizeBytes: 5,
                },
              })
            )
          )
        )
      );
      await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
      expect(opened).toBe(filePath);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  }
);

describe('attachment preview routing', () => {
  const markdown = file({ fileName: 'notes.md', mimeType: 'text/markdown' });
  let container: HTMLDivElement;
  let root: Root;

  const mount = async (element: ReturnType<typeof createElement>) => {
    await initI18n('en');
    const store = createStore();
    store.set(currentWorkspaceIdAtom, 'workspace' as never);
    store.set(authTokenAtom, 'token');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Provider, { store }, element)));
  };

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('# Synthetic notes\n\nbody text', { status: 206 })
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('opens a desktop attachment in the side panel instead of a dialog', async () => {
    const opened: Array<[string, string]> = [];
    await mount(
      createElement(
        SessionChatActionContext.Provider,
        {
          value: {
            openFileAttachment: (target: SessionFilePayload, sessionId: string) => {
              opened.push([target.fileName, sessionId]);
              return true;
            },
          },
        },
        createElement(WorkspaceSessionFileGroup, {
          files: [markdown],
          sessionId: 'session' as never,
        })
      )
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="notes.md"]')?.click()
    );
    expect(opened).toEqual([['notes.md', 'session']]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('keeps the modal preview where the host has no side panel', async () => {
    await mount(
      createElement(WorkspaceSessionFileGroup, {
        files: [markdown],
        sessionId: 'session' as never,
      })
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="notes.md"]')?.click()
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('notes.md');
    expect(dialog?.textContent).toContain('Synthetic notes');
  });

  it('fills a side-panel tab with the fetched text and its file actions, without a close', async () => {
    await mount(
      createElement(SessionFileAttachmentPane, { file: markdown, sessionId: 'session' as never })
    );
    expect(container.textContent).toContain('notes.md');
    expect(container.textContent).toContain('Synthetic notes');
    expect(container.querySelector('button[aria-label="Download"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Close"]')).toBeNull();
  });

  it('shows the load failure with a download fallback in the side-panel tab', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('', { status: 404 }));
    await mount(
      createElement(SessionFileAttachmentPane, { file: markdown, sessionId: 'session' as never })
    );
    expect(container.textContent).toContain('Could not load preview');
    expect(container.querySelectorAll('button[aria-label="Download"]').length).toBe(1);
  });

  it('opens a video attachment in the desktop right sidebar instead of triggering download', async () => {
    const video = file({
      fileId: 'video-1',
      fileName: 'demo.mp4',
      mimeType: 'video/mp4',
      textPreview: false,
      sizeBytes: 1024,
    });
    const opened: Array<[string, string]> = [];
    await mount(
      createElement(
        SessionChatActionContext.Provider,
        {
          value: {
            openFileAttachment: (target: SessionFilePayload, sessionId: string) => {
              opened.push([target.fileName, sessionId]);
              return true;
            },
          },
        },
        createElement(WorkspaceSessionFileGroup, {
          files: [video],
          sessionId: 'session' as never,
        })
      )
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="demo.mp4"]')?.click()
    );
    expect(opened).toEqual([['demo.mp4', 'session']]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('plays, pauses, seeks, and cleans up a video attachment in the side-panel tab', async () => {
    const videoFile = file({
      fileId: 'video-2',
      fileName: 'walkthrough.webm',
      mimeType: 'video/webm',
      textPreview: false,
      sizeBytes: 64,
    });
    const blobs = new Map<string, Blob>();
    let seq = 0;
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      const url = `blob:attachment-video-${++seq}`;
      blobs.set(url, blob as Blob);
      return url;
    });
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      blobs.delete(url);
    });
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(function (this: HTMLMediaElement) {
        Object.defineProperty(this, 'paused', { configurable: true, value: false });
        this.dispatchEvent(new Event('play'));
        return Promise.resolve();
      });
    const pauseSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'pause')
      .mockImplementation(function (this: HTMLMediaElement) {
        Object.defineProperty(this, 'paused', { configurable: true, value: true });
        this.dispatchEvent(new Event('pause'));
      });
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});

    const fetchCalls: Array<{ url: string; auth: string | null }> = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      fetchCalls.push({ url: String(input), auth: headers.get('Authorization') });
      return new Response(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3), {
        status: 200,
        headers: { 'Content-Type': 'video/webm', 'Content-Length': '4' },
      });
    });

    await mount(
      createElement(SessionFileAttachmentPane, {
        file: videoFile,
        sessionId: 'session' as never,
        active: true,
      })
    );

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.auth).toBe('Bearer token');
    expect(fetchCalls[0]?.url).not.toContain('token');
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    const videoEl = container.querySelector('video')!;
    expect(videoEl).not.toBeNull();
    expect(videoEl.controls).toBe(false);
    expect(container.querySelector('button[aria-label="Download"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Copy"]')).toBeNull();

    Object.defineProperty(videoEl, 'duration', { configurable: true, value: 20 });
    await act(async () => {
      videoEl.dispatchEvent(new Event('loadedmetadata'));
    });

    const playButton = container.querySelector<HTMLButtonElement>('button[aria-label="Play"]')!;
    expect(playButton).not.toBeNull();
    await act(async () => playButton.click());
    expect(playSpy).toHaveBeenCalledTimes(1);

    const pauseButton = container.querySelector<HTMLButtonElement>('button[aria-label="Pause"]')!;
    expect(pauseButton).not.toBeNull();

    const seekInput = container.querySelector<HTMLInputElement>('input[aria-label="Seek"]')!;
    expect(seekInput.disabled).toBe(false);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(seekInput, '7.5');
      seekInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(videoEl.currentTime).toBe(7.5);
    expect(container.querySelector('[data-testid="video-player-time"]')?.textContent).toBe(
      '0:07 / 0:20'
    );

    await act(async () => pauseButton.click());
    expect(pauseSpy).toHaveBeenCalled();

    const speedTrigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Playback speed: 1×"]'
    )!;
    expect(speedTrigger).not.toBeNull();
    expect(speedTrigger.textContent).toBe('1×');
    expect(videoEl.playbackRate).toBe(1);
    await act(async () => speedTrigger.click());
    const speedItems = Array.from(document.querySelectorAll('[role="menuitemradio"]'));
    expect(speedItems.map((el) => el.textContent?.trim())).toEqual([
      '0.5×',
      '0.75×',
      '1×',
      '1.25×',
      '1.5×',
      '2×',
    ]);
    const twoX = speedItems.find((el) => el.textContent?.trim() === '2×') as HTMLElement;
    await act(async () => twoX.click());
    expect(videoEl.playbackRate).toBe(2);
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Playback speed: 2×"]')
        ?.textContent
    ).toBe('2×');

    Object.defineProperty(videoEl, 'error', { configurable: true, value: { code: 4 } });
    await act(async () => {
      videoEl.dispatchEvent(new Event('error'));
    });
    expect(container.textContent).toContain('Video unavailable');
    expect(
      container.querySelectorAll('button[aria-label="Download"]').length
    ).toBeGreaterThanOrEqual(1);

    await act(async () => root.unmount());
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(blobs.size).toBe(0);
  });
});

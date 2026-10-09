// @vitest-environment jsdom

import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

import { getVideoMimeTypeForPath } from '../src/lib/video-file-preview';
import { SessionFileBinaryPreview } from '../src/components/sessions/session-file-binary-preview';
import {
  getOfficePreviewKind,
  MAX_OFFICE_PREVIEW_BYTES,
  OfficePreviewTooLargeError,
  readOfficePreviewBytes,
} from '../src/lib/session-file-office-source';

describe('SessionFileBinaryPreview', () => {
  it('opens PDFs in the paged document viewer', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionFileBinaryPreview, {
        path: '/workspace/Report.PDF',
        bytes: Uint8Array.of(1),
      })
    );

    expect(markup).toContain('aria-label="PDF viewer"');
    expect(markup).toContain('aria-label="Previous page"');
    expect(markup).toContain('aria-label="Pages sidebar"');
    expect(markup).toContain('aria-label="Search document"');
    expect(markup).not.toContain('This binary file cannot be previewed.');
  });

  it('keeps other binary files on the existing notice path', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionFileBinaryPreview, {
        path: '/workspace/archive.zip',
        url: 'lody-resource://file/archive',
      })
    );

    expect(markup).toContain('This binary file cannot be previewed.');
  });

  it.each(['docx', 'xlsx', 'pptx'])('routes %s files into the lazy office preview', (extension) => {
    const markup = renderToStaticMarkup(
      createElement(SessionFileBinaryPreview, {
        path: `/workspace/report.${extension}`,
        bytes: Uint8Array.of(1),
      })
    );

    expect(markup).toContain('Loading document…');
    expect(markup).not.toContain('This binary file cannot be previewed.');
  });
});

describe('office preview source', () => {
  it('recognizes supported extensions without promoting legacy or unrelated files', () => {
    expect(getOfficePreviewKind('/workspace/Report.XLSX')).toBe('xlsx');
    expect(getOfficePreviewKind('presentation.pptx?version=1')).toBe('pptx');
    expect(getOfficePreviewKind('archive.zip')).toBeNull();
    expect(getOfficePreviewKind('legacy.doc')).toBeNull();
  });

  it('reads only complete bounded preview bytes', async () => {
    const fetched = await readOfficePreviewBytes({
      url: 'lody-resource://file/workbook',
      signal: new AbortController().signal,
      fetcher: async () => new Response(Uint8Array.of(80, 75, 3, 4)),
    });
    expect(new Uint8Array(fetched)).toEqual(Uint8Array.of(80, 75, 3, 4));

    await expect(
      readOfficePreviewBytes({
        url: 'lody-resource://file/oversized',
        signal: new AbortController().signal,
        fetcher: async () =>
          new Response(Uint8Array.of(1), {
            headers: { 'Content-Length': String(MAX_OFFICE_PREVIEW_BYTES + 1) },
          }),
      })
    ).rejects.toBeInstanceOf(OfficePreviewTooLargeError);
  });

  it('rejects a cancelled read before it opens a resource', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readOfficePreviewBytes({
        url: 'lody-resource://file/cancelled',
        signal: controller.signal,
        fetcher: async () => {
          throw new Error('A cancelled preview must not open a resource.');
        },
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('video preview lifecycle', () => {
  it('recognizes video containers without treating bare names or directories as videos', () => {
    expect(getVideoMimeTypeForPath('clip.WEBM')).toBe('video/webm');
    expect(getVideoMimeTypeForPath('clip.mp4?version=1')).toBe('video/mp4');
    expect(getVideoMimeTypeForPath('webm')).toBeUndefined();
    expect(getVideoMimeTypeForPath('folder.webm/readme')).toBeUndefined();
    expect(getVideoMimeTypeForPath('archive.zip')).toBeUndefined();
  });

  let container: HTMLDivElement;
  let root: Root;
  const blobs = new Map<string, Blob>();
  let sequence = 0;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL(blob: Blob) {
          const url = `blob:video-${++sequence}`;
          blobs.set(url, blob);
          return url;
        }
        static revokeObjectURL(url: string) {
          blobs.delete(url);
        }
      }
    );
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
      function (this: HTMLMediaElement) {
        Object.defineProperty(this, 'paused', { configurable: true, value: true });
      }
    );
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    expect(blobs.size).toBe(0);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses complete WebM bytes and disposes the player when hidden or replaced', async () => {
    const bytes = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3);
    const render = async (path: string, active = true) => {
      await act(async () =>
        root.render(createElement(SessionFileBinaryPreview, { path, bytes, active }))
      );
    };
    await render('clip.WEBM');
    const video = container.querySelector('video')!;
    expect(video).not.toBeNull();
    expect(video.controls).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.autoplay).toBe(false);
    expect(blobs.get(video.src)).toMatchObject({ type: 'video/webm', size: bytes.length });
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    await render('clip.WEBM', false);
    expect(container.querySelector('video')).toBeNull();
    expect(video.paused).toBe(true);
    expect(video.hasAttribute('src')).toBe(false);
    expect(blobs.size).toBe(0);

    await render('clip.WEBM');
    const resumed = container.querySelector('video')!;
    expect(resumed).not.toBe(video);
    expect(resumed.autoplay).toBe(false);
    const oldUrl = resumed.src;
    await render('next.mp4');
    expect(blobs.has(oldUrl)).toBe(false);
    expect(blobs.get(container.querySelector('video')!.src)?.type).toBe('video/mp4');
  });

  it('shows file actions on decode failure and resets the error for a replacement source', async () => {
    let copied = false;
    let shared = false;
    const render = async (url: string) => {
      await act(async () =>
        root.render(
          createElement(SessionFileBinaryPreview, {
            path: 'clip.webm',
            url,
            fileActions: {
              onCopyPath: () => {
                copied = true;
              },
              onShare: () => {
                shared = true;
              },
            },
          })
        )
      );
    };
    await render('blob:authorized-first');
    const failed = container.querySelector('video')!;
    await act(async () => failed.dispatchEvent(new Event('error')));
    expect(container.textContent).toContain('Video unavailable');
    expect(container.querySelector('video')).toBeNull();
    expect(failed.hasAttribute('src')).toBe(false);
    const buttons = Array.from(container.querySelectorAll('button'));
    await act(async () => {
      buttons.find((button) => button.textContent?.includes('Copy file path'))!.click();
      buttons.find((button) => button.textContent?.includes('Share file'))!.click();
    });
    expect(copied && shared).toBe(true);
    await render('blob:authorized-second');
    expect(container.textContent).not.toContain('Video unavailable');
    expect(container.querySelector('video')!.getAttribute('src')).toBe('blob:authorized-second');
    expect(blobs.size).toBe(0);
  });

  it('keeps the media source usable when StrictMode replays effects', async () => {
    await act(async () =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(SessionFileBinaryPreview, { path: 'clip.webm', bytes: Uint8Array.of(1) })
        )
      )
    );
    const video = container.querySelector('video')!;
    expect(video.hasAttribute('src')).toBe(true);
    expect(blobs.has(video.src)).toBe(true);
    expect(blobs.size).toBe(1);
  });

  it('pauses when the app backgrounds and does not resume automatically', async () => {
    await act(async () =>
      root.render(
        createElement(SessionFileBinaryPreview, { path: 'clip.webm', url: 'blob:authorized' })
      )
    );
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(video.paused).toBe(true);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(video.paused).toBe(true);
  });

  it('leaves unavailable bytes on the binary notice and does not load inactive videos', async () => {
    await act(async () =>
      root.render(createElement(SessionFileBinaryPreview, { path: 'clip.webm' }))
    );
    expect(container.textContent).toContain('This binary file cannot be previewed.');
    await act(async () =>
      root.render(
        createElement(SessionFileBinaryPreview, {
          path: 'clip.webm',
          bytes: Uint8Array.of(1),
          active: false,
        })
      )
    );
    expect(container.querySelector('video')).toBeNull();
    expect(blobs.size).toBe(0);
  });
});

// @vitest-environment jsdom

// The card's second action exists for exactly one gap: an HTML attachment's
// click opens the RENDERED page, so without it the uploaded source bytes have
// no route at all. Every other previewable file downloads from inside the
// preview dialog and must NOT grow a duplicate control.

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

  it('recognizes an HTML attachment by extension when the MIME type is generic', async () => {
    const view = await render({
      file: file({ fileName: 'report.htm', mimeType: 'application/octet-stream' }),
    });

    expect(downloadButton(view)).not.toBeNull();
  });

  it('does not duplicate the control on a previewable file whose dialog downloads', async () => {
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

  it('disables the download button while its own download is in flight', async () => {
    const view = await render({ isDownloading: true });

    expect(downloadButton(view)?.disabled).toBe(true);
    await act(async () => {
      downloadButton(view)?.click();
    });
    expect(onDownload).not.toHaveBeenCalled();
    // The primary action still reads as preview, not as a second spinner.
    expect(
      view.querySelector<HTMLButtonElement>('button[aria-label="lody-one-flyer.html"]')?.disabled
    ).toBe(false);
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

  it('offers no download button when the caller wires no download handler', async () => {
    const view = await render({ onDownload: undefined });

    expect(downloadButton(view)).toBeNull();
  });
});

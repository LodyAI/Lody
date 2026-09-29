// @vitest-environment jsdom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

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

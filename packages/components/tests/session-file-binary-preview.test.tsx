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
import Papa from 'papaparse';
import { readXlsxSelectionClipboard } from '../src/components/sessions/session-file-xlsx-clipboard';
import {
  createSpreadsheetClipboard,
  writeSpreadsheetClipboard,
} from '../src/components/sessions/session-file-spreadsheet-clipboard';
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

describe('spreadsheet clipboard', () => {
  it('preserves rectangular values in text and HTML without interpreting cell markup', () => {
    const rows = [
      ['line 1\nline 2', 'tab\there', '"quoted"', ''],
      ['<img src=x>&', '', '0', ''],
    ];
    const data = createSpreadsheetClipboard(rows);
    expect(Papa.parse(data.text, { delimiter: '\t' }).data).toEqual(rows);
    const table = new DOMParser().parseFromString(data.html, 'text/html');
    expect(
      Array.from(table.querySelectorAll('tr'), (row) =>
        Array.from(row.querySelectorAll('td'), (cell) => cell.textContent)
      )
    ).toEqual(rows);
    expect(table.querySelector('img')).toBeNull();
  });

  it('rejects oversized copies rather than silently truncating', () => {
    expect(() => createSpreadsheetClipboard([Array(200_001).fill('')])).toThrow(RangeError);
    expect(() => createSpreadsheetClipboard([['x'.repeat(10 * 1024 * 1024 + 1)]])).toThrow(
      RangeError
    );
  });

  it('reports clipboard permission failures to the caller', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) },
    });
    try {
      await expect(
        writeSpreadsheetClipboard(createSpreadsheetClipboard([['value']]))
      ).rejects.toMatchObject({ name: 'NotAllowedError' });
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});

describe('worker-backed XLSX clipboard', () => {
  const controller = (): Parameters<typeof readXlsxSelectionClipboard>[0] => ({
    activeCell: null,
    activeSheet: {
      workbookSheetIndex: 2,
      rowCount: 3,
      colCount: 3,
      cachedFormulaValues: { B2: '42' },
    } as Parameters<typeof readXlsxSelectionClipboard>[0]['activeSheet'],
    selection: { start: { row: 2, col: 2 }, end: { row: 0, col: 0 } },
    getActiveWorksheet: () => null,
    getCellDisplayValue: () => {
      throw new Error('Worker cells must use batches');
    },
    getRowsBatchAsync: async () => [
      {
        index: 0,
        cells: [
          { col: 0, value: 'R&amp;D' },
          { col: 2, value: '125,000.00' },
        ],
      },
      {
        index: 1,
        cells: [
          { col: 1, value: '#VALUE!', formula: 'A1+1' },
          { col: 2, value: 'line 1\nline 2' },
        ],
      },
      {
        index: 2,
        cells: [
          { col: 0, value: 'Merged' },
          { col: 1, value: 'unused', isMergedSecondary: true },
        ],
      },
    ],
  });

  it('copies formatted and cached formula values with rectangular blanks from a worker', async () => {
    const data = await readXlsxSelectionClipboard(controller());
    expect(Papa.parse(data.text, { delimiter: '\t' }).data).toEqual([
      ['R&D', '', '125,000.00'],
      ['', '42', 'line 1\nline 2'],
      ['Merged', '', ''],
    ]);
    const table = new DOMParser().parseFromString(data.html, 'text/html');
    expect(
      Array.from(table.querySelectorAll('tr'), (row) => row.querySelectorAll('td').length)
    ).toEqual([3, 3, 3]);
  });

  it('rejects too-large selections without fetching rows', async () => {
    const value = controller();
    value.selection = { start: { row: 0, col: 0 }, end: { row: 200_000, col: 0 } };
    value.getRowsBatchAsync = async () => {
      throw new Error('An oversized copy must not fetch rows');
    };
    await expect(readXlsxSelectionClipboard(value)).rejects.toBeInstanceOf(RangeError);
  });

  it('discards a worker result when the preview is closed or replaced', async () => {
    const value = controller();
    const abort = new AbortController();
    value.getRowsBatchAsync = async () => {
      abort.abort();
      return [{ index: 0, cells: [{ col: 0, value: 'stale' }] }];
    };
    await expect(readXlsxSelectionClipboard(value, abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

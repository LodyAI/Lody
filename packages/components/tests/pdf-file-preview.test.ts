import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createLocalPdfRangeTransport, PDF_RANGE_CHUNK_BYTES } from '../src/lib/pdf-file-preview';

describe('local PDF range transport', () => {
  it('opens a PDF whose cross-reference table is beyond the initial range', async () => {
    const data = makePaddedPdf();
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const range = new Headers(init?.headers).get('Range');
      if (!range) throw new Error('Range header was not sent.');
      requests.push(range);
      const match = range.match(/^bytes=(\d+)-(\d+)$/u);
      if (!match) throw new Error('Range header is invalid.');
      const begin = Number(match[1]);
      const end = Math.min(Number(match[2]), data.length - 1);
      return new Response(data.subarray(begin, end + 1), {
        status: 206,
        headers: { 'Content-Range': `bytes ${begin}-${end}/${data.length}` },
      });
    };
    const transport = await createLocalPdfRangeTransport({
      url: 'lody-resource://file/padded-pdf',
      signal: new AbortController().signal,
      fetchImpl,
    });
    const loadingTask = getDocument({
      range: transport,
      disableStream: true,
      disableAutoFetch: true,
      rangeChunkSize: PDF_RANGE_CHUNK_BYTES,
    });

    try {
      const document = await loadingTask.promise;
      expect(document.numPages).toBe(1);
      expect((await document.getPage(1)).pageNumber).toBe(1);
    } finally {
      await loadingTask.destroy();
    }

    expect(requests.length).toBeGreaterThan(1);
    expect(
      requests.every((range) => {
        const [, start, end] = range.match(/^bytes=(\d+)-(\d+)$/u) ?? [];
        return Number(end) - Number(start) + 1 <= PDF_RANGE_CHUNK_BYTES;
      })
    ).toBe(true);
  });
});

function makePaddedPdf(): Uint8Array {
  const header = '%PDF-1.4\n';
  const content = 'BT /F1 20 Tf 72 700 Td (Paged PDF works) Tj ET';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
  ];
  let offset = header.length;
  const offsets = objects.map((object) => {
    const currentOffset = offset;
    offset += object.length;
    return currentOffset;
  });
  const padding = `%${'x'.repeat(PDF_RANGE_CHUNK_BYTES)}\n`;
  const xrefOffset = offset + padding.length;
  const xref = `xref\n0 6\n0000000000 65535 f \n${offsets.map((position) => `${String(position).padStart(10, '0')} 00000 n \n`).join('')}`;
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(`${header}${objects.join('')}${padding}${xref}${trailer}`);
}

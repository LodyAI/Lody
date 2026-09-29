import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createLocalPdfRangeTransport, PDF_RANGE_CHUNK_BYTES } from '../src/lib/pdf-file-preview';

describe('local PDF range transport', () => {
  it('loads bounded initial data and supplies requested ranges', async () => {
    const data = Uint8Array.from({ length: PDF_RANGE_CHUNK_BYTES * 4 }, (_, index) => index % 251);
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
      url: 'lody-resource://file/test-capability',
      signal: new AbortController().signal,
      fetchImpl,
    });
    const response = new Promise<{ readonly begin: number; readonly chunk: Uint8Array }>(
      (resolve) => {
        transport.transportReady((event: { type: string; begin: number; chunk: Uint8Array }) => {
          if (event.type === 'range') resolve(event);
        });
      }
    );

    transport.requestDataRange(PDF_RANGE_CHUNK_BYTES * 2, PDF_RANGE_CHUNK_BYTES * 3);

    expect(transport.length).toBe(data.length);
    expect(transport.initialData).toEqual(data.subarray(0, PDF_RANGE_CHUNK_BYTES));
    expect(await response).toEqual({
      type: 'range',
      begin: PDF_RANGE_CHUNK_BYTES * 2,
      chunk: data.subarray(PDF_RANGE_CHUNK_BYTES * 2, PDF_RANGE_CHUNK_BYTES * 3),
    });
    expect(requests).toEqual([
      `bytes=0-${PDF_RANGE_CHUNK_BYTES - 1}`,
      `bytes=${PDF_RANGE_CHUNK_BYTES * 2}-${PDF_RANGE_CHUNK_BYTES * 3 - 1}`,
    ]);
  });

  it('clamps the initial range to small files and rejects servers that ignore Range', async () => {
    const smallData = Uint8Array.of(37, 80, 68, 70);
    const smallFetch: typeof fetch = async (_input, init) => {
      expect(new Headers(init?.headers).get('Range')).toBe(`bytes=0-${PDF_RANGE_CHUNK_BYTES - 1}`);
      return new Response(smallData, {
        status: 206,
        headers: { 'Content-Range': `bytes 0-${smallData.length - 1}/${smallData.length}` },
      });
    };
    const smallTransport = await createLocalPdfRangeTransport({
      url: 'lody-resource://file/small',
      signal: new AbortController().signal,
      fetchImpl: smallFetch,
    });
    expect(smallTransport.initialData).toEqual(smallData);

    await expect(
      createLocalPdfRangeTransport({
        url: 'lody-resource://file/no-ranges',
        signal: new AbortController().signal,
        fetchImpl: async () => new Response(smallData, { status: 200 }),
      })
    ).rejects.toThrow('did not honor a byte range');
  });

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

import type { PDFDataRangeTransport } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const PDF_RANGE_CHUNK_BYTES = 64 * 1024;

export const isPdfFilePath = (path: string): boolean => path.toLowerCase().endsWith('.pdf');

interface PdfRangeTransportOptions {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

export interface PdfRangeResult {
  readonly bytes: Uint8Array;
  readonly length: number;
}

export async function createLocalPdfRangeTransport({
  url,
  signal,
  fetchImpl = fetch,
}: PdfRangeTransportOptions): Promise<PDFDataRangeTransport> {
  // `pdfjs-dist` is loaded lazily: this module stays on the eager file-viewer
  // path for `isPdfFilePath`, so the transport implementation is imported
  // only when a PDF preview actually runs. The dynamic import resolves to
  // an already-loaded module once the preview bundle is up.
  const { createPdfRangeTransport } = await import('./pdf-range-transport');
  const initial = await readPdfRange(fetchImpl, url, 0, PDF_RANGE_CHUNK_BYTES, signal);
  return createPdfRangeTransport(initial, signal, (begin, end, rangeSignal, knownLength) =>
    readPdfRange(fetchImpl, url, begin, end, rangeSignal, knownLength)
  );
}

export interface PdfRangeReader {
  (begin: number, end: number, signal: AbortSignal, knownLength?: number): Promise<PdfRangeResult>;
}

async function readPdfRange(
  fetchImpl: typeof fetch,
  url: string,
  begin: number,
  requestedEnd: number,
  signal: AbortSignal,
  knownLength?: number
): Promise<PdfRangeResult> {
  if (
    !Number.isSafeInteger(begin) ||
    !Number.isSafeInteger(requestedEnd) ||
    begin < 0 ||
    requestedEnd <= begin ||
    requestedEnd - begin > PDF_RANGE_CHUNK_BYTES
  ) {
    throw new Error('Invalid PDF byte range.');
  }
  if (knownLength !== undefined && begin >= knownLength) {
    throw new Error('PDF byte range starts beyond the end of the file.');
  }

  const end =
    knownLength === undefined ? requestedEnd - 1 : Math.min(requestedEnd, knownLength) - 1;
  const response = await fetchImpl(url, {
    headers: { Range: `bytes=${begin}-${end}` },
    signal,
  });
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    throw new Error('PDF resource did not honor a byte range request.');
  }

  const contentRange = response.headers.get('Content-Range');
  const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/u);
  const responseBegin = match ? Number(match[1]) : NaN;
  const responseEnd = match ? Number(match[2]) : NaN;
  const length = match ? Number(match[3]) : NaN;
  const expectedEnd = Math.min(end, length - 1);
  if (
    !match ||
    responseBegin !== begin ||
    responseEnd !== expectedEnd ||
    !Number.isSafeInteger(length) ||
    length <= responseEnd ||
    (knownLength !== undefined && length !== knownLength)
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error('PDF resource returned an invalid byte range.');
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== responseEnd - responseBegin + 1) {
    throw new Error('PDF resource returned an incomplete byte range.');
  }
  return { bytes, length };
}

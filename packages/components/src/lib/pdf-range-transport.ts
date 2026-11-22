import { PDFDataRangeTransport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PdfRangeReader, PdfRangeResult } from './pdf-file-preview';

// Range transport used by the lazy PDF preview. Lives in its own module so
// `pdf-file-preview.ts` can keep `isPdfFilePath` on the eager file-viewer
// path without statically importing `pdfjs-dist`; this module is reached
// only through the dynamic `import()` in `createLocalPdfRangeTransport`.
export function createPdfRangeTransport(
  initial: PdfRangeResult,
  signal: AbortSignal,
  readRange: PdfRangeReader
): PDFDataRangeTransport {
  return new LocalPdfRangeTransport(initial, signal, readRange);
}

class LocalPdfRangeTransport extends PDFDataRangeTransport {
  private readonly controller = new AbortController();

  constructor(
    initial: PdfRangeResult,
    signal: AbortSignal,
    private readonly readRange: PdfRangeReader
  ) {
    super(initial.length, initial.bytes);
    if (signal.aborted) {
      this.abort();
    } else {
      signal.addEventListener('abort', () => this.abort(), { once: true });
    }
  }

  override requestDataRange(begin: number, end: number): void {
    void this.readRange(begin, end, this.controller.signal, this.length)
      .then(({ bytes }) => this.onDataRange(begin, bytes))
      .catch(() => {
        if (!this.controller.signal.aborted) {
          this.onDataRange(begin, new Uint8Array());
          this.abort();
        }
      });
  }

  override abort(): void {
    this.controller.abort();
  }
}

import { LOCAL_TEXT_PAGE_BYTES } from '@lody/shared/local-file-preview';

/** Bounded, random-access text; deliberately has no whole-document text/save API. */
export type PagedFileSource = {
  readonly sizeBytes: number;
  readonly pageBytes: number;
  readPage(page: number, signal: AbortSignal): Promise<string>;
};

export function createLocalPagedFileSource(url: string, sizeBytes: number): PagedFileSource {
  return {
    sizeBytes,
    pageBytes: LOCAL_TEXT_PAGE_BYTES,
    async readPage(page, signal) {
      if (!Number.isSafeInteger(page) || page < 0 || page * LOCAL_TEXT_PAGE_BYTES >= sizeBytes) {
        throw new Error('Invalid page.');
      }
      const start = page * LOCAL_TEXT_PAGE_BYTES;
      const end = Math.min(sizeBytes, start + LOCAL_TEXT_PAGE_BYTES);
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${Math.min(sizeBytes, end + 3) - 1}` },
        signal,
      });
      if (response.status !== 206)
        throw new Error('File changed or is unavailable. Reopen the preview.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > LOCAL_TEXT_PAGE_BYTES + 3) throw new Error('Invalid preview response.');
      let from = 0;
      // A character belongs to the page containing its leading byte. Lookahead
      // completes it on that page; the next page skips only its continuation bytes.
      while (from < 3 && from < bytes.length && (bytes[from]! & 0xc0) === 0x80) from++;
      let to = end - start;
      while (to < bytes.length && (bytes[to]! & 0xc0) === 0x80) to++;
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: start !== 0 }).decode(
        bytes.subarray(from, to)
      );
    },
  };
}

export const MAX_OFFICE_PREVIEW_BYTES = 25 * 1024 * 1024;

export type OfficePreviewKind = 'docx' | 'xlsx' | 'pptx';

export function getOfficePreviewKind(path: string): OfficePreviewKind | null {
  const extension = path.split(/[?#]/, 1)[0]?.split('.').pop()?.toLowerCase();
  return extension === 'docx' || extension === 'xlsx' || extension === 'pptx' ? extension : null;
}

export class OfficePreviewTooLargeError extends Error {
  constructor() {
    super('Office file exceeds the preview size limit.');
  }
}

export async function readOfficePreviewBytes({
  bytes,
  url,
  signal,
  fetcher = fetch,
}: {
  readonly bytes?: Uint8Array;
  readonly url?: string;
  readonly signal: AbortSignal;
  readonly fetcher?: typeof fetch;
}): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  if (bytes !== undefined) {
    if (bytes.byteLength > MAX_OFFICE_PREVIEW_BYTES) throw new OfficePreviewTooLargeError();
    return Uint8Array.from(bytes).buffer;
  }
  if (!url) throw new Error('Office preview source is missing.');

  const response = await fetcher(url, { signal, cache: 'no-store' });
  if (!response.ok || !response.body) throw new Error('Office preview could not be read.');
  const advertisedSize = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(advertisedSize) && advertisedSize > MAX_OFFICE_PREVIEW_BYTES) {
    await response.body.cancel();
    throw new OfficePreviewTooLargeError();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OFFICE_PREVIEW_BYTES) throw new OfficePreviewTooLargeError();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

import {
  FILE_DOWNLOAD_CHUNK_BYTES,
  FILE_DOWNLOAD_MAX_BYTES,
  FileDownloadResponseSchema,
  type FileDownloadRequest,
  type FileDownloadResponse,
} from '@lody/shared';

/** One in-flight chunk, exact original bytes, no preview/editor cache. */
export async function collectFileDownload(
  request: (
    range: Pick<FileDownloadRequest, 'offset' | 'revision'>
  ) => Promise<FileDownloadResponse>,
  signal?: AbortSignal
): Promise<Uint8Array | null> {
  let bytes: Uint8Array | undefined;
  let revision: string | undefined;
  let offset = 0;
  do {
    signal?.throwIfAborted();
    const result = FileDownloadResponseSchema.parse(await request({ offset, revision }));
    signal?.throwIfAborted();
    if (result.status === 'error') {
      if (
        result.code === 'unsupported_protocol' ||
        result.code === 'paid_plan_required' ||
        result.code === 'too_large'
      )
        return null;
      throw new Error(result.code);
    }
    if (
      result.offset !== offset ||
      result.sizeBytes > FILE_DOWNLOAD_MAX_BYTES ||
      (revision !== undefined &&
        (revision !== result.revision || bytes?.length !== result.sizeBytes))
    )
      throw new Error('Invalid file download range');
    revision = result.revision;
    bytes ??= new Uint8Array(result.sizeBytes);
    const raw = atob(result.data);
    const expected = Math.min(FILE_DOWNLOAD_CHUNK_BYTES, bytes.length - offset);
    if (raw.length !== expected) throw new Error('Incomplete file download range');
    for (let index = 0; index < raw.length; index++) bytes[offset + index] = raw.charCodeAt(index);
    offset += raw.length;
  } while (offset < bytes.length);
  return bytes;
}

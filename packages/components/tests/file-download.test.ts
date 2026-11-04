import { describe, expect, it } from 'vitest';
import { FILE_DOWNLOAD_CHUNK_BYTES, type FileDownloadResponse } from '@lody/shared';
import { collectFileDownload } from '../src/lib/file-download';

const revision = 'a'.repeat(64);
const response = (bytes: Buffer, offset: number): FileDownloadResponse => ({
  status: 'ok',
  path: 'file.bin',
  revision,
  offset,
  sizeBytes: bytes.length,
  data: bytes.subarray(offset, offset + FILE_DOWNLOAD_CHUNK_BYTES).toString('base64'),
});
describe('collectFileDownload', () => {
  it('assembles original bytes across ranges and carries the revision', async () => {
    const original = Buffer.alloc(FILE_DOWNLOAD_CHUNK_BYTES + 31, 0xff);
    const result = await collectFileDownload(async (range) => {
      if (range.offset > 0) expect(range.revision).toBe(revision);
      return response(original, range.offset);
    });
    expect(result).toEqual(new Uint8Array(original));
  });
  it('rejects truncated, inconsistent and changed responses', async () => {
    const original = Buffer.alloc(FILE_DOWNLOAD_CHUNK_BYTES + 1);
    await expect(
      collectFileDownload(async () => ({ ...response(original, 0), data: '' }))
    ).rejects.toThrow('Incomplete');
    await expect(
      collectFileDownload(async ({ offset }) =>
        offset === 0
          ? response(original, 0)
          : { ...response(original, offset), revision: 'b'.repeat(64) }
      )
    ).rejects.toThrow('Invalid');
    await expect(
      collectFileDownload(async () => ({ status: 'error', code: 'file_changed' }))
    ).rejects.toThrow('file_changed');
  });
  it('retains unsupported/unpaid fallback and stops after cancellation', async () => {
    for (const code of ['unsupported_protocol', 'paid_plan_required', 'too_large'] as const) {
      expect(await collectFileDownload(async () => ({ status: 'error', code }))).toBeNull();
    }
    const controller = new AbortController();
    await expect(
      collectFileDownload(async () => {
        controller.abort();
        return response(Buffer.alloc(FILE_DOWNLOAD_CHUNK_BYTES + 1), 0);
      }, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

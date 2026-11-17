import { describe, expect, it } from 'vitest';
import {
  type SessionHistoryParsed,
  type SessionId,
  FILE_DOWNLOAD_CHUNK_BYTES,
  type FileDownloadResponse,
} from '@lody/shared';
import { collectSessionImageGalleryEntries } from '../src/lib/session-image-gallery';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createLocalPdfRangeTransport, PDF_RANGE_CHUNK_BYTES } from '../src/lib/pdf-file-preview';
import { collectFileDownload } from '../src/lib/file-download';

describe('session-image-gallery', () => {
  const sessionId = 'session-1' as SessionId;

  const buildMessage = (
    overrides: Partial<SessionHistoryParsed> & Pick<SessionHistoryParsed, 'id' | 'items'>
  ): SessionHistoryParsed => ({
    id: overrides.id,
    role: overrides.role ?? 'user',
    timestamp: overrides.timestamp ?? '2026-04-03T00:00:00.000Z',
    read: overrides.read ?? true,
    userId: overrides.userId,
    userTurnId: overrides.userTurnId,
    items: overrides.items,
    fileDiff: overrides.fileDiff,
    finished: overrides.finished,
    modelInfo: overrides.modelInfo,
    plan: overrides.plan,
    endedAt: overrides.endedAt,
  });

  describe('collectSessionImageGalleryEntries', () => {
    it('preserves conversation order across image items and image groups', () => {
      const messages: SessionHistoryParsed[] = [
        buildMessage({
          id: 'm-1',
          items: [
            {
              type: 'text',
              text: 'before',
            },
            {
              type: 'image',
              imageId: 'img-1',
              mimeType: 'image/png',
              fileName: 'first.png',
              sizeBytes: 128,
            },
          ],
        }),
        buildMessage({
          id: 'm-2',
          role: 'assistant',
          items: [
            {
              type: 'image_group',
              images: [
                {
                  imageId: 'img-2',
                  mimeType: 'image/jpeg',
                  fileName: 'second.jpg',
                  sizeBytes: 256,
                },
                {
                  imageId: 'img-3',
                  mimeType: 'image/webp',
                  sizeBytes: 512,
                },
              ],
            },
          ],
        }),
      ];

      expect(collectSessionImageGalleryEntries(messages, sessionId)).toEqual([
        {
          key: 'm-1:1:0:img-1',
          sessionId,
          messageId: 'm-1',
          galleryGroupId: 'm-1',
          imageId: 'img-1',
          mimeType: 'image/png',
          fileName: 'first.png',
          sizeBytes: 128,
          width: undefined,
          height: undefined,
          alt: 'first.png',
        },
        {
          key: 'm-2:0:0:img-2',
          sessionId,
          messageId: 'm-2',
          galleryGroupId: 'm-2',
          imageId: 'img-2',
          mimeType: 'image/jpeg',
          fileName: 'second.jpg',
          sizeBytes: 256,
          width: undefined,
          height: undefined,
          alt: 'second.jpg',
        },
        {
          key: 'm-2:0:1:img-3',
          sessionId,
          messageId: 'm-2',
          galleryGroupId: 'm-2',
          imageId: 'img-3',
          mimeType: 'image/webp',
          fileName: undefined,
          sizeBytes: 512,
          width: undefined,
          height: undefined,
          alt: undefined,
        },
      ]);
    });

    it('groups assistant images under their originating user turn', () => {
      const messages: SessionHistoryParsed[] = [
        buildMessage({
          id: 'user-1',
          role: 'user',
          items: [
            {
              type: 'image',
              imageId: 'img-user',
              mimeType: 'image/png',
              sizeBytes: 128,
            },
          ],
        }),
        buildMessage({
          id: 'assistant-1',
          role: 'assistant',
          userTurnId: 'user-1',
          items: [
            {
              type: 'image_group',
              images: [
                {
                  imageId: 'img-assistant-1',
                  mimeType: 'image/jpeg',
                  sizeBytes: 256,
                },
                {
                  imageId: 'img-assistant-2',
                  mimeType: 'image/webp',
                  sizeBytes: 512,
                },
              ],
            },
          ],
        }),
      ];

      expect(collectSessionImageGalleryEntries(messages, sessionId)).toEqual([
        expect.objectContaining({
          key: 'user-1:0:0:img-user',
          galleryGroupId: 'user-1',
        }),
        expect.objectContaining({
          key: 'assistant-1:0:0:img-assistant-1',
          galleryGroupId: 'user-1',
        }),
        expect.objectContaining({
          key: 'assistant-1:0:1:img-assistant-2',
          galleryGroupId: 'user-1',
        }),
      ]);
    });

    it('falls back to the message id when assistant turn linkage is missing', () => {
      const messages: SessionHistoryParsed[] = [
        buildMessage({
          id: 'assistant-legacy',
          role: 'assistant',
          items: [
            {
              type: 'image',
              imageId: 'img-legacy',
              mimeType: 'image/png',
              sizeBytes: 64,
            },
          ],
        }),
      ];

      expect(collectSessionImageGalleryEntries(messages, sessionId)).toEqual([
        expect.objectContaining({
          key: 'assistant-legacy:0:0:img-legacy',
          galleryGroupId: 'assistant-legacy',
        }),
      ]);
    });
  });
});

describe('pdf-file-preview', () => {
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
});

describe('file-download', () => {
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
});

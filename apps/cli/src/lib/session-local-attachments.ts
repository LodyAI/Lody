import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  FILE_DOWNLOAD_CHUNK_BYTES,
  FILE_DOWNLOAD_MAX_BYTES,
  type FileDownloadRequest,
  type FileDownloadResponse,
} from '@lody/shared';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SessionLocalAttachment } from '@lody/shared';
import { SessionLocalAttachmentSchema } from '@lody/shared/message-schemas';

async function regularFile(file: string) {
  if (!path.isAbsolute(file)) throw new Error('Attachment requires an absolute path');
  const canonical = await fs.realpath(file);
  const stat = await fs.stat(canonical);
  if (!stat.isFile()) throw new Error('Attachment is not a regular file');
  return { canonical, size: stat.size };
}
/** Only authenticated local control persists generated attachment bytes. No path registry is kept. */
export async function prepareLocalAttachment(
  input: {
    machineId: string;
    path: string;
    kind: 'file' | 'image';
    fileName: string;
    mimeType: string;
  },
  dataDir = getLodyDataDir()
): Promise<SessionLocalAttachment> {
  const source = await regularFile(input.path);
  if (source.size > 100 * 1024 * 1024)
    throw new Error('Generated attachment exceeds local storage limit');
  const root = path.join(dataDir, 'local-attachments');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const destination = path.join(root, randomUUID() + '.data');
  await publishFile(destination, await fs.readFile(source.canonical));
  const filePath = await fs.realpath(destination);
  return SessionLocalAttachmentSchema.parse({
    type: 'local_attachment',
    machineId: input.machineId,
    path: filePath,
    kind: input.kind,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: source.size,
  });
}

/** Callers establish file-read authority before using a path from conversation content. */
export async function resolveLocalAttachment(
  attachment: SessionLocalAttachment,
  machineId: string
) {
  if (attachment.machineId !== machineId)
    throw new Error('Local attachment belongs to another machine');
  const file = await regularFile(attachment.path);
  return { path: file.canonical, sizeBytes: file.size };
}

/** Explicit downloads reuse the authenticated file RPC and its bounded chunk format. */
export async function downloadLocalAttachment(
  request: FileDownloadRequest,
  machineId: string
): Promise<FileDownloadResponse> {
  if (!request.attachment) return { status: 'error', code: 'invalid_path' };
  try {
    const resolved = await resolveLocalAttachment(request.attachment, machineId);
    const file = await fs.open(resolved.path, 'r');
    try {
      const stat = await file.stat();
      if (stat.size > FILE_DOWNLOAD_MAX_BYTES) return { status: 'error', code: 'too_large' };
      // The existing download protocol uses a metadata revision, not a content hash.
      const revision = createHash('sha256')
        .update(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]))
        .digest('hex');
      if (request.offset > stat.size || (request.revision && request.revision !== revision))
        return { status: 'error', code: 'file_changed' };
      const bytes = Buffer.alloc(Math.min(FILE_DOWNLOAD_CHUNK_BYTES, stat.size - request.offset));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, request.offset);
      return {
        status: 'ok',
        path: request.attachment.fileName,
        revision,
        sizeBytes: stat.size,
        offset: request.offset,
        data: bytes.subarray(0, bytesRead).toString('base64'),
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    return {
      status: 'error',
      code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'file_not_found' : 'transient_io',
    };
  }
}

async function publishFile(destination: string, bytes: string | Uint8Array) {
  const temporary = destination + '.' + randomUUID();
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

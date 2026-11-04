import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SESSION_FILE_MAX_COUNT,
  SESSION_FILE_MAX_SIZE_BYTES,
  SESSION_IMAGE_MAX_SIZE_BYTES,
  SESSION_IMAGE_ALLOWED_MIME_TYPES,
  getServerNow,
  type WorkspaceId,
  type SessionId,
  type MachineId,
} from '@lody/shared';
import { type SessionInputAttachment } from './session-input-content';
import { SessionAttachmentTransfer } from './session-attachment-transfer';
import { resolveContainedUploadPath } from './session-file-attachments';
import { copyIntoSessionFileBlobStore, removeSessionFileBlob } from './session-file-blob-store';

/**
 * The caller owns source paths. Freeze bounded private copies before any transfer;
 * neither uploads nor Operation recovery may reopen mutable user files.
 * No history/meta writes happen here. The caller commits only the complete result.
 */
export async function prepareSessionInputAttachments(args: {
  paths: readonly string[];
  cwd: string;
  containWithin?: string;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  sourceMachineId: MachineId;
  targetMachineId: MachineId;
  relay?: SessionAttachmentTransfer;
}): Promise<SessionInputAttachment[]> {
  if (!args.paths.length) return [];
  if (args.paths.length > SESSION_FILE_MAX_COUNT)
    throw new Error(`At most ${SESSION_FILE_MAX_COUNT} attachments are allowed`);
  if (!args.relay && args.sourceMachineId !== args.targetMachineId) {
    throw new Error('Remote attachments require an available attachment relay');
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-input-'));
  await fs.chmod(dir, 0o700);
  const transfer = args.relay ?? new SessionAttachmentTransfer('');
  const localIds: string[] = [];
  try {
    const files = [];
    for (const [index, input] of args.paths.entries()) {
      if (!input.trim()) throw new Error('Attachment path is empty');
      const absolutePath = args.containWithin
        ? await resolveContainedUploadPath(input, args.containWithin)
        : path.resolve(args.cwd, input);
      const targetDir = path.join(dir, String(index));
      await fs.mkdir(targetDir, { mode: 0o700 });
      const snapshot = path.join(targetDir, path.basename(absolutePath));
      const source = await fs.open(
        absolutePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        const stat = await source.stat();
        if (!stat.isFile() || stat.size <= 0 || stat.size > SESSION_FILE_MAX_SIZE_BYTES) {
          throw new Error(
            `Attachment must be a non-empty regular file up to ${SESSION_FILE_MAX_SIZE_BYTES} bytes: ${input}`
          );
        }
        const target = await fs.open(snapshot, 'wx', 0o600);
        try {
          const buffer = Buffer.alloc(1024 * 1024);
          let offset = 0;
          while (offset < stat.size) {
            const { bytesRead } = await source.read(
              buffer,
              0,
              Math.min(buffer.length, stat.size - offset),
              offset
            );
            if (!bytesRead) throw new Error(`Attachment changed while reading: ${input}`);
            let written = 0;
            while (written < bytesRead) {
              const result = await target.write(
                buffer,
                written,
                bytesRead - written,
                offset + written
              );
              if (!result.bytesWritten) throw new Error('Unable to write attachment snapshot');
              written += result.bytesWritten;
            }
            offset += bytesRead;
          }
          const after = await source.stat();
          if (
            after.size !== stat.size ||
            after.mtimeMs !== stat.mtimeMs ||
            after.ctimeMs !== stat.ctimeMs
          ) {
            throw new Error(`Attachment changed while reading: ${input}`);
          }
        } finally {
          await target.close();
        }
      } finally {
        await source.close();
      }
      files.push(await transfer.validateSessionFileUploadPath(snapshot));
    }
    const blocks: SessionInputAttachment[] = [];
    for (const file of files) {
      try {
        if (args.relay) {
          if (
            file.sizeBytes <= SESSION_IMAGE_MAX_SIZE_BYTES &&
            SESSION_IMAGE_ALLOWED_MIME_TYPES.some((mimeType) => mimeType === file.mimeType)
          ) {
            const image = await transfer.validateSessionImageUploadPath(file.absolutePath);
            const { downloadUrl: _, ...uploaded } = await transfer.uploadSessionImageFile({
              ...args,
              file: image,
            });
            blocks.push({ type: 'image', ...uploaded });
          } else {
            const { downloadUrl: _, ...uploaded } = await transfer.uploadValidatedSessionFile({
              ...args,
              file,
            });
            blocks.push(uploaded);
          }
        } else {
          const fileId = `file-${randomUUID()}`;
          await copyIntoSessionFileBlobStore({ ...args, fileId, sourcePath: file.absolutePath });
          localIds.push(fileId);
          const { absolutePath: _, ...metadata } = file;
          blocks.push({
            type: 'file',
            ...metadata,
            fileId,
            transport: 'local',
            machineId: args.sourceMachineId,
            uploadedAt: getServerNow(),
          });
        }
      } catch (error) {
        throw new Error(
          `Unable to prepare attachment ${file.fileName}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
    return blocks;
  } catch (error) {
    await Promise.all(localIds.map((fileId) => removeSessionFileBlob({ ...args, fileId })));
    throw error;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

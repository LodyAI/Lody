import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildSessionImageApiUrl, getSessionImageDownloadApiPath } from '@lody/shared';
import { LODY_SERVER_URL } from '@/utils/const';
import type { ExportAttachmentRecord } from './types';
import { ensurePathWithinBase } from './path-utils';
import { formatErrorMessage } from '@/utils/format-error';

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function sanitizeFileStem(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'image';
  }
  return trimmed.replace(/[^A-Za-z0-9._-]/g, '_');
}

function resolveOutputPath(
  baseDir: string,
  attachment: ExportAttachmentRecord
): { absolutePath: string; relativePath: string } {
  const currentRelativePath = attachment.relativePath;
  if (currentRelativePath) {
    return {
      absolutePath: ensurePathWithinBase(baseDir, path.join(baseDir, currentRelativePath)),
      relativePath: currentRelativePath,
    };
  }

  const extension =
    MIME_EXTENSION_MAP[attachment.mimeType] || path.extname(attachment.fileName ?? '').trim() || '';
  const fileName = attachment.fileName?.trim()
    ? sanitizeFileStem(attachment.fileName)
    : `${sanitizeFileStem(attachment.imageId)}${extension}`;
  const relativePath = path.posix.join('artifacts', 'attachments', 'files', fileName);
  return {
    absolutePath: ensurePathWithinBase(baseDir, path.join(baseDir, relativePath)),
    relativePath,
  };
}

export async function downloadSessionAttachment(args: {
  workspaceId: string;
  sessionId: string;
  authToken: string;
  sessionDir: string;
  attachment: ExportAttachmentRecord;
}): Promise<{ attachment: ExportAttachmentRecord; warning: string | null }> {
  const serverUrl = LODY_SERVER_URL?.trim();
  if (!serverUrl) {
    return {
      attachment: {
        ...args.attachment,
        relativePath: null,
      },
      warning: 'LODY_SERVER_URL is not configured; skipped image download.',
    };
  }

  const { absolutePath, relativePath } = resolveOutputPath(args.sessionDir, args.attachment);
  const downloadUrl = buildSessionImageApiUrl(
    serverUrl,
    getSessionImageDownloadApiPath(args.workspaceId, args.sessionId, args.attachment.imageId)
  );

  try {
    const response = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${args.authToken}`,
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        attachment: {
          ...args.attachment,
          relativePath: null,
        },
        warning: detail
          ? `Failed to download attachment (${response.status}): ${detail.slice(0, 200)}`
          : `Failed to download attachment (${response.status}).`,
      };
    }

    const bytes = await response.arrayBuffer();
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, Buffer.from(bytes));
    return {
      attachment: {
        ...args.attachment,
        relativePath,
      },
      warning: null,
    };
  } catch (error) {
    return {
      attachment: {
        ...args.attachment,
        relativePath: null,
      },
      warning: formatErrorMessage(error),
    };
  }
}

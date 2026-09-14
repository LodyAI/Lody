import {
  buildPendingUserHistoryEntry,
  inputBlocksToHistoryItems,
  normalizeSessionInputBlocks,
  type SessionInputBlock,
} from '@lody/shared';
import type { PendingFile, PendingImage } from '../atoms/chat-landing-draft';

/** Local recovery data only. Never part of a daemon or cloud request. */
export type SessionAttachmentDraft = {
  id: string;
  kind: 'image' | 'file';
  source: Blob;
  name: string;
  mimeType: string;
  lastModified: number;
  ready?: SessionInputBlock;
  error?: string;
  progress?: number;
};

export function snapshotAttachmentDrafts(
  images: readonly PendingImage[],
  files: readonly PendingFile[]
): SessionAttachmentDraft[] {
  return [
    ...images
      .filter((item) => !item.uploaded)
      .map((item) => ({ ...source(item.file, item.localId), kind: 'image' as const })),
    ...files
      .filter((item) => !item.uploaded)
      .map((item) => ({ ...source(item.file, item.localId), kind: 'file' as const })),
  ];
}
function source(file: File, id: string) {
  return {
    id,
    source: file.slice(),
    name: file.name,
    mimeType: file.type,
    lastModified: file.lastModified,
  };
}

/** An attachment-only draft has no wire items until preparation succeeds. */
export function buildDraftUserHistoryEntry(
  args: Parameters<typeof buildPendingUserHistoryEntry>[0],
  attachments?: readonly SessionAttachmentDraft[]
) {
  const existing = buildPendingUserHistoryEntry(args);
  if (existing || !attachments?.length || !args.userId?.trim()) return existing;
  return {
    userId: args.userId.trim(),
    role: 'user' as const,
    items: inputBlocksToHistoryItems([]),
    timestamp: args.timestamp,
    status: args.status ?? ('pending' as const),
    inputConfig: args.inputConfig,
    read: false,
    fileDiff: [],
    finished: true,
  };
}

export function preparedDraftInput(
  inputConfig: unknown,
  attachments: readonly SessionAttachmentDraft[]
) {
  const config = inputConfig as { inputBlocks?: unknown; prompt?: string };
  if (attachments.some((item) => !item.ready))
    throw new Error('Every attachment must finish before submission');
  const ready = attachments.map((item) => item.ready!);
  const key = (block: SessionInputBlock) =>
    block.type === 'file'
      ? `file:${block.fileId}`
      : block.type === 'image'
        ? `image:${block.imageId}`
        : null;
  const ids = new Set(ready.map(key));
  const original = normalizeSessionInputBlocks(config.inputBlocks, config.prompt ?? '').filter(
    (block) => !key(block) || !ids.has(key(block))
  );
  return [...ready, ...original];
}

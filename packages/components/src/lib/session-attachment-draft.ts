import { getDroppedFileLocalPath } from './dropped-local-path';
import {
  buildHumanMessageAuthor,
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
  /** Released only when a durable ready receipt replaces every source. */
  source?: Blob;
  localSourcePath?: string;
  localImageId?: string;
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
    localSourcePath: getDroppedFileLocalPath(file) ?? undefined,
    name: file.name,
    mimeType: file.type,
    lastModified: file.lastModified,
  };
}

/**
 * The signed-in user's display name for an input they author. Another member's
 * input (a promoted queue row they wrote) never takes this user's name.
 */
export function ownDisplayName(
  currentUser: { id: string; name: string } | null | undefined,
  userId: string | null | undefined
): string | undefined {
  return currentUser && userId && currentUser.id === userId.trim() ? currentUser.name : undefined;
}

/** An attachment-only draft has no wire items until preparation succeeds. */
export function buildDraftUserHistoryEntry(
  args: Parameters<typeof buildPendingUserHistoryEntry>[0],
  attachments?: readonly SessionAttachmentDraft[]
) {
  const existing = buildPendingUserHistoryEntry(args);
  if (existing || !attachments?.length || !args.userId?.trim()) return existing;
  const threadRoots = args.inputConfig?.replyTo?.threadRootId?.trim();
  return {
    userId: args.userId.trim(),
    role: 'user' as const,
    author: buildHumanMessageAuthor(args.userId.trim(), args.userName),
    items: inputBlocksToHistoryItems([]),
    timestamp: args.timestamp,
    status: args.status ?? ('pending' as const),
    inputConfig: args.inputConfig,
    ...(threadRoots ? { threadRoots } : {}),
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
    block.type === 'local_attachment'
      ? `local:${JSON.stringify([block.machineId, block.path])}`
      : block.type === 'file'
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

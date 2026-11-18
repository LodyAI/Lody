import { extractPromptPreviewFromInputBlocks, type SessionInputBlock } from '@lody/shared';
import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import i18next from 'i18next';

export function queueTask(
  blocks: readonly SessionInputBlock[],
  drafts: readonly SessionAttachmentDraft[] = []
): string {
  const text = extractPromptPreviewFromInputBlocks(blocks);
  if (text) return text;

  const files = [
    ...blocks.flatMap((block) =>
      block.type === 'file' || (block.type === 'local_attachment' && block.kind === 'file')
        ? [block.fileName]
        : []
    ),
    ...drafts.filter((draft) => draft.kind === 'file').map((draft) => draft.name),
  ];
  if (files.length) return files.join(', ');
  const imagesOnly =
    blocks.length + drafts.length > 0 &&
    blocks.every(
      (block) =>
        block.type === 'image' || (block.type === 'local_attachment' && block.kind === 'image')
    ) &&
    drafts.every((draft) => draft.kind === 'image');
  return imagesOnly
    ? i18next.t('sessions.messageQueue.imageOnly', '[Image message]')
    : i18next.t('sessions.messageQueue.attachmentOnly', '[Attachment]');
}

import { snapshotAttachmentDrafts } from '@/lib/session-attachment-draft';
import { useCallback, useMemo, type ClipboardEvent } from 'react';
import type { MessageTextSpan } from '@lody/shared';
import {
  SESSION_IMAGE_MAX_COUNT,
  type SessionId,
  type SessionImagePayload,
  type SessionInputBlock,
  type WorkspaceId,
} from '@lody/shared';
import { useAtom } from 'jotai';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { chatLandingPendingImagesAtomFamily, type PendingImage } from '@/atoms/chat-landing-draft';
import { validateSessionImageFile } from '@/lib/session-image-upload';

export type ChatLandingImageDraftItem = {
  id: string;
  name: string;
  previewUrl: string;
  status: 'draft' | 'uploading' | 'uploaded' | 'failed';
  progress: number;
  error?: string;
};

const toImageInputBlock = (image: SessionImagePayload): SessionInputBlock => ({
  type: 'image',
  imageId: image.imageId,
  mimeType: image.mimeType,
  fileName: image.fileName,
  sizeBytes: image.sizeBytes,
  width: image.width,
  height: image.height,
});

const createLocalImageId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export function useChatLandingImageDraft(args: {
  /** Scope shared with the sibling file draft and the reserved session id. */
  draftKey: string;
  workspaceId: WorkspaceId | null;
  authToken: string | null;
  isMobile: boolean;
  projectKind: 'github' | 'local' | null;
  sessionId: SessionId | null;
  ensureSessionId: () => SessionId;
}) {
  const { t } = useTranslation();
  const { draftKey, ensureSessionId, isMobile } = args;
  const [pendingImages, setPendingImages] = useAtom(chatLandingPendingImagesAtomFamily(draftKey));
  const imageCountLimitLabel = t(
    'sessions.imageCountLimit',
    'At most {{count}} images are allowed',
    { count: SESSION_IMAGE_MAX_COUNT }
  );
  const imageSelectionSkippedLabel = t(
    'sessions.imageSelectionSkipped',
    'Some images were not added'
  );

  const showImageSelectionIssues = useCallback(
    (issues: string[]) => {
      if (issues.length === 0) {
        return;
      }

      const uniqueIssues = Array.from(new Set(issues));
      if (uniqueIssues.length === 1) {
        const [issue] = uniqueIssues;
        if (issue) {
          toast.error(issue);
        }
        return;
      }

      toast.error(imageSelectionSkippedLabel, {
        description: uniqueIssues.join(' · '),
      });
    },
    [imageSelectionSkippedLabel]
  );

  const clearPendingImages = useCallback(() => {
    setPendingImages((prev) => {
      for (const image of prev) {
        image.abort?.abort();
        URL.revokeObjectURL(image.previewUrl);
      }
      return [];
    });
  }, [setPendingImages]);

  // No unmount cleanup: the draft outlives the landing route (#242), so a
  // preview URL is revoked only when its image is removed or the whole draft
  // is cleared (send accepted / draft reset), never because the user navigated
  // to another tab.

  const handleAddFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      const nextEntries: PendingImage[] = [];
      const issues: string[] = [];
      let currentCount = pendingImages.length;

      for (const file of files) {
        if (currentCount >= SESSION_IMAGE_MAX_COUNT) {
          issues.push(imageCountLimitLabel);
          continue;
        }

        const validationError = validateSessionImageFile(file);
        if (validationError) {
          issues.push(validationError);
          continue;
        }

        const entry: PendingImage = {
          localId: createLocalImageId(),
          previewUrl: URL.createObjectURL(file),
          file,
          status: 'draft',
          progress: 0,
        };
        nextEntries.push(entry);
        currentCount += 1;
      }

      if (nextEntries.length === 0) {
        showImageSelectionIssues(issues);
        return;
      }

      showImageSelectionIssues(issues);

      ensureSessionId();
      setPendingImages((prev) => [...prev, ...nextEntries]);
    },
    [
      ensureSessionId,
      imageCountLimitLabel,
      pendingImages.length,
      setPendingImages,
      showImageSelectionIssues,
    ]
  );

  const handlePromptPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (isMobile) {
        return;
      }
      const fileItems = Array.from(event.clipboardData.items)
        .filter((item) => item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((item): item is File => item !== null);

      if (fileItems.length === 0) {
        return;
      }

      event.preventDefault();
      handleAddFiles(fileItems);
    },
    [handleAddFiles, isMobile]
  );

  const handleRemoveImage = useCallback(
    (localId: string) => {
      // The landing owns the shared draft session id, so removing the last image
      // cannot orphan file attachments or an in-flight ACP preparation.
      setPendingImages((prev) => {
        const target = prev.find((item) => item.localId === localId);
        if (target) {
          target.abort?.abort();
          URL.revokeObjectURL(target.previewUrl);
        }
        return prev.filter((item) => item.localId !== localId);
      });
    },
    [setPendingImages]
  );

  const handleRetryImage = useCallback(
    (localId: string) => {
      setPendingImages((previous) =>
        previous.map((item) =>
          item.localId === localId ? { ...item, status: 'draft', error: undefined } : item
        )
      );
    },
    [setPendingImages]
  );

  const hasBlockingImages = false;
  const hasUploadedImages = pendingImages.length > 0;

  const imageItems = useMemo<ChatLandingImageDraftItem[]>(
    () =>
      pendingImages.map((image) => ({
        id: image.localId,
        name: image.file.name,
        previewUrl: image.previewUrl,
        status: image.status,
        progress: image.progress,
        error: image.error,
      })),
    [pendingImages]
  );

  const buildInputBlocks = useCallback(
    (
      prompt: string,
      extraBlocks: SessionInputBlock[] = [],
      spans?: MessageTextSpan[]
    ): SessionInputBlock[] => {
      const uploadedImages = pendingImages
        .filter((image): image is PendingImage & { uploaded: SessionImagePayload } => {
          return image.status === 'uploaded' && !!image.uploaded;
        })
        .map((image) => toImageInputBlock(image.uploaded));
      // Images first, then any caller-supplied blocks (e.g. file attachments),
      // then the prompt text — matching the in-session block ordering.
      const leadingBlocks = [...uploadedImages, ...extraBlocks];
      // Emitted untrimmed, spans still anchored to `prompt`. Every caller runs
      // the result through `normalizeSessionInputBlocks`, which owns both the
      // trim and the span re-anchor it forces — and drops the block entirely
      // when nothing survives the trim.
      return [...leadingBlocks, { type: 'text', text: prompt, ...(spans ? { spans } : {}) }];
    },
    [pendingImages]
  );

  return {
    attachments: snapshotAttachmentDrafts(pendingImages, []),
    imageItems,
    hasBlockingImages,
    hasUploadedImages,
    canAddMoreImages: pendingImages.length < SESSION_IMAGE_MAX_COUNT,
    addFiles: handleAddFiles,
    handlePromptPaste,
    handleRemoveImage,
    handleRetryImage,
    clearPendingImages,
    buildInputBlocks,
  };
}

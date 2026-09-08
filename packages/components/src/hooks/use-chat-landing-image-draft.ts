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
import { usePostHog } from '@posthog/react';
import { chatLandingPendingImagesAtomFamily, type PendingImage } from '@/atoms/chat-landing-draft';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { uploadSessionImage, validateSessionImageFile } from '@/lib/session-image-upload';

export type ChatLandingImageDraftItem = {
  id: string;
  name: string;
  previewUrl: string;
  status: 'uploading' | 'uploaded' | 'failed';
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
  const {
    draftKey,
    workspaceId,
    authToken,
    isMobile,
    projectKind,
    sessionId: draftSessionId,
    ensureSessionId,
  } = args;
  const postHog = usePostHog();
  const [pendingImages, setPendingImages] = useAtom(chatLandingPendingImagesAtomFamily(draftKey));
  const imageUploadFailedLabel = t('sessions.imageUploadFailed', 'Image upload failed');
  const imageUploadMissingAuthLabel = t(
    'sessions.imageUploadMissingAuth',
    'Missing workspace or auth token'
  );
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
        URL.revokeObjectURL(image.previewUrl);
      }
      return [];
    });
  }, [setPendingImages]);

  // No unmount cleanup: the draft outlives the landing route (#242), so a
  // preview URL is revoked only when its image is removed or the whole draft
  // is cleared (send accepted / draft reset), never because the user navigated
  // to another tab.

  const updatePendingImage = useCallback(
    (localId: string, updater: (image: PendingImage) => PendingImage) => {
      setPendingImages((prev) =>
        prev.map((image) => (image.localId === localId ? updater(image) : image))
      );
    },
    [setPendingImages]
  );

  const startUpload = useCallback(
    async (localId: string, file: File, sessionId: SessionId) => {
      if (!workspaceId || !authToken) {
        capturePostHogEvent(postHog, 'session/image_upload_failed', {
          channel: 'web',
          entrypoint: 'chat_landing',
          actor: 'user',
          workspace_id: workspaceId ?? null,
          session_id: sessionId,
          image_count: 1,
          total_size_bytes: file.size,
          project_kind: projectKind,
          failure_reason: 'missing_auth',
        });
        updatePendingImage(localId, (image) => ({
          ...image,
          status: 'failed',
          progress: 0,
          error: imageUploadMissingAuthLabel,
        }));
        return;
      }

      updatePendingImage(localId, (image) => ({
        ...image,
        status: 'uploading',
        progress: 0,
        error: undefined,
      }));
      capturePostHogEvent(postHog, 'session/image_upload_requested', {
        channel: 'web',
        entrypoint: 'chat_landing',
        actor: 'user',
        workspace_id: workspaceId,
        session_id: sessionId,
        image_count: 1,
        total_size_bytes: file.size,
        project_kind: projectKind,
      });

      try {
        const uploaded = await uploadSessionImage({
          workspaceId,
          sessionId,
          token: authToken,
          file,
          onProgress: (progress) => {
            updatePendingImage(localId, (image) => ({ ...image, progress }));
          },
        });
        updatePendingImage(localId, (image) => ({
          ...image,
          status: 'uploaded',
          progress: 100,
          uploaded,
          error: undefined,
        }));
        capturePostHogEvent(postHog, 'session/image_upload_succeeded', {
          channel: 'web',
          entrypoint: 'chat_landing',
          actor: 'user',
          workspace_id: workspaceId,
          session_id: sessionId,
          image_count: 1,
          total_size_bytes: file.size,
          project_kind: projectKind,
          mime_type: uploaded.mimeType,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : imageUploadFailedLabel;
        updatePendingImage(localId, (image) => ({
          ...image,
          status: 'failed',
          progress: 0,
          error: errorMessage,
        }));
        capturePostHogEvent(postHog, 'session/image_upload_failed', {
          channel: 'web',
          entrypoint: 'chat_landing',
          actor: 'user',
          workspace_id: workspaceId,
          session_id: sessionId,
          image_count: 1,
          total_size_bytes: file.size,
          project_kind: projectKind,
          failure_reason: 'upload_error',
          error_message: errorMessage,
        });
      }
    },
    [
      authToken,
      imageUploadFailedLabel,
      imageUploadMissingAuthLabel,
      postHog,
      projectKind,
      updatePendingImage,
      workspaceId,
    ]
  );

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
          status: 'uploading',
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

      const sessionId = ensureSessionId();
      setPendingImages((prev) => [...prev, ...nextEntries]);
      for (const entry of nextEntries) {
        void startUpload(entry.localId, entry.file, sessionId);
      }
    },
    [
      ensureSessionId,
      imageCountLimitLabel,
      pendingImages.length,
      setPendingImages,
      showImageSelectionIssues,
      startUpload,
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
          URL.revokeObjectURL(target.previewUrl);
        }
        return prev.filter((item) => item.localId !== localId);
      });
    },
    [setPendingImages]
  );

  const handleRetryImage = useCallback(
    (localId: string) => {
      const target = pendingImages.find((image) => image.localId === localId);
      if (!target) {
        return;
      }
      const uploadSessionId = draftSessionId ?? ensureSessionId();
      void startUpload(localId, target.file, uploadSessionId);
    },
    [draftSessionId, ensureSessionId, pendingImages, startUpload]
  );

  const hasBlockingImages = useMemo(
    () => pendingImages.some((image) => image.status !== 'uploaded'),
    [pendingImages]
  );

  const hasUploadedImages = useMemo(
    () => pendingImages.some((image) => image.status === 'uploaded' && !!image.uploaded),
    [pendingImages]
  );

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

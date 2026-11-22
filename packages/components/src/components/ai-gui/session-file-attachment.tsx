import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { SessionFilePayload, SessionId, WorkspaceId } from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms';
import { authTokenAtom, runtimeAtom } from '@/atoms/runtime';
import { downloadSessionFile, fetchSessionFilePreview } from '@/lib/session-file-download';
import { usePostHog } from '@/lib/posthog-context';
import { capturePostHogEvent, getAnalyticsFileKind } from '@/lib/posthog-analytics';
import { toast } from '@/lib/toast';
import { useLatestRef } from '@/hooks/use-latest-ref';
import {
  SessionFilePreviewDialog,
  SessionFilePreviewPanel,
  type SessionFilePreviewStatus,
} from './session-file-preview-dialog';

/** Workspace credentials an attachment read needs; null until both are known. */
function useSessionFileAccess() {
  const workspaceId = useAtomValue(currentWorkspaceIdAtom) as WorkspaceId | null;
  const token = useAtomValue(authTokenAtom);
  const runtime = useAtomValue(runtimeAtom);
  const attachmentToken =
    runtime?.workspaceId === workspaceId ? runtime?.attachmentToken : undefined;
  return useMemo(
    () => (workspaceId && token ? { workspaceId, token, attachmentToken } : null),
    [attachmentToken, token, workspaceId]
  );
}

/**
 * Downloads attachments of one Session. `sessionId` is the rendering Session;
 * a block copied from another Session carries its own `storageSessionId`.
 */
export function useSessionFileDownload(sessionId: SessionId) {
  const { t } = useTranslation();
  const access = useSessionFileAccess();
  const postHog = usePostHog();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const download = useCallback(
    (file: SessionFilePayload) => {
      if (!access) return;
      capturePostHogEvent(postHog, 'file_preview/downloaded', {
        file_kind: getAnalyticsFileKind(file.fileName),
        source: 'attachment',
      });
      setDownloadingId(file.fileId);
      void downloadSessionFile({
        ...access,
        sessionId: file.storageSessionId ?? sessionId,
        fileId: file.fileId,
        encryption: file.encryption,
        fileName: file.fileName,
        mimeType: file.mimeType,
      })
        .catch(() => {
          toast.error(t('sessions.fileDownloadFailed', { name: file.fileName }));
        })
        .finally(() => setDownloadingId((current) => (current === file.fileId ? null : current)));
    },
    [access, postHog, sessionId, t]
  );
  return { download, downloadingId };
}

/**
 * Fetches the bounded text prefix shown by the preview. A newer file (or an
 * unmount) aborts the older request, so a late response never overwrites the
 * state of the file currently on screen.
 */
export function useSessionFilePreviewStatus(
  file: SessionFilePayload,
  sessionId: SessionId
): SessionFilePreviewStatus {
  const { t } = useTranslation();
  const access = useSessionFileAccess();
  // Credentials are read at fetch time: a token refresh must not reload the
  // preview already on screen, only a different file (or regained access) does.
  const accessRef = useLatestRef(access);
  const hasAccess = access !== null;
  const [status, setStatus] = useState<SessionFilePreviewStatus>({ kind: 'loading' });
  const storageSessionId = file.storageSessionId ?? sessionId;
  const { fileId, encryption, sizeBytes } = file;
  useEffect(() => {
    const current = accessRef.current;
    if (!hasAccess || !current) {
      setStatus({
        kind: 'error',
        message: t('sessions.filePreviewUnavailable', 'Preview unavailable'),
      });
      return undefined;
    }
    const controller = new AbortController();
    setStatus({ kind: 'loading' });
    void fetchSessionFilePreview({
      ...current,
      sessionId: storageSessionId,
      fileId,
      encryption,
      sizeBytes,
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setStatus({ kind: 'loaded', text: result.text, truncated: result.truncated });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // 4xx / network → degrade to a downloadable error state.
        setStatus({
          kind: 'error',
          message: t('sessions.filePreviewFailed', 'Could not load preview'),
        });
      });
    return () => controller.abort();
  }, [accessRef, encryption, fileId, hasAccess, sizeBytes, storageSessionId, t]);
  return status;
}

/** A desktop side-panel tab showing one attachment. */
export function SessionFileAttachmentPane({
  file,
  sessionId,
  className,
}: {
  file: SessionFilePayload;
  /** The Session whose message carried the attachment. */
  sessionId: SessionId;
  className?: string;
}) {
  const status = useSessionFilePreviewStatus(file, sessionId);
  const { download, downloadingId } = useSessionFileDownload(sessionId);
  return (
    <SessionFilePreviewPanel
      variant="pane"
      file={file}
      status={status}
      onDownload={download}
      isDownloading={downloadingId === file.fileId}
      className={className}
    />
  );
}

/** Mobile Drawer, or a Dialog where the host has no side panel to open a tab in. */
export function SessionFileAttachmentPreviewDialog({
  file,
  sessionId,
  onClose,
  onDownload,
  isDownloading,
}: {
  file: SessionFilePayload;
  sessionId: SessionId;
  onClose: () => void;
  onDownload?: (file: SessionFilePayload) => void;
  isDownloading: boolean;
}) {
  const status = useSessionFilePreviewStatus(file, sessionId);
  return (
    <SessionFilePreviewDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      file={file}
      status={status}
      onDownload={onDownload}
      isDownloading={isDownloading}
    />
  );
}

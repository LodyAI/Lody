import { snapshotAttachmentDrafts } from '@/lib/session-attachment-draft';
import { useCallback, useMemo } from 'react';
import {
  SESSION_FILE_MAX_COUNT,
  type MachineId,
  type SessionFilePayload,
  type SessionId,
  type SessionInputBlock,
  type WorkspaceId,
} from '@lody/shared';
import { useAtom } from 'jotai';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { chatLandingPendingFilesAtomFamily, type PendingFile } from '@/atoms/chat-landing-draft';
import { formatFileSize } from '@/lib/session-file-presentation';
import {
  SESSION_FILE_MAX_SIZE_MB,
  validateSessionFile,
  type SessionFileTransferPhase,
} from '@/lib/session-file-upload';

export type ChatLandingFileDraftItem = {
  id: string;
  name: string;
  sizeLabel: string;
  status: SessionFileTransferPhase | 'draft' | 'uploaded' | 'failed';
  progress: number;
  error?: string;
};

const toFileInputBlock = (file: SessionFilePayload): SessionInputBlock => ({
  type: 'file',
  fileId: file.fileId,
  fileName: file.fileName,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
  sha256: file.sha256,
  textPreview: file.textPreview,
  transport: file.transport,
  ...(file.machineId === undefined ? {} : { machineId: file.machineId }),
  uploadedAt: file.uploadedAt,
});

const createLocalFileId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

/**
 * File-attachment draft for the chat-landing composer — the non-image sibling of
 * {@link useChatLandingImageDraft}. Owns its own pending-file state machine, but
 * shares the eventual session id from the landing draft identity via the injected
 * `sessionId` / `ensureSessionId` so images and files uploaded before
 * the session exists are scoped to the same `createSession({ sessionId })`.
 *
 * Mirrors the in-session file path (`session-chat-input-area.tsx`): the desktop
 * local-transport fast path hands bytes straight to the local CLI when the
 * selected machine is this machine's runtime; otherwise the file uploads to the
 * cloud (R2) with sha256 + text-previewability computed once up front and abort
 * support for removal mid-flight.
 */
export function useChatLandingFileDraft(args: {
  /** Scope shared with the sibling image draft and the reserved session id. */
  draftKey: string;
  workspaceId: WorkspaceId | null;
  authToken: string | null;
  /** Selected machine for the eventual session; enables the local fast path. */
  machineId: MachineId | null;
  /** Shared landing identity used by attachments, preparation, and createSession. */
  sessionId: SessionId | null;
  ensureSessionId: () => SessionId;
}) {
  const { t } = useTranslation();
  const { draftKey, ensureSessionId } = args;
  const [pendingFiles, setPendingFiles] = useAtom(chatLandingPendingFilesAtomFamily(draftKey));

  const clearPendingFiles = useCallback(() => {
    setPendingFiles((prev) => {
      for (const entry of prev) {
        entry.abort?.abort();
      }
      return [];
    });
  }, [setPendingFiles]);

  // No unmount cleanup: the draft outlives the landing route (#242). An upload
  // still in flight when the user switches tabs keeps running and settles into
  // the atom, so returning shows the finished attachment rather than an entry
  // aborted on the way out. Aborting stays tied to the user's own actions —
  // removing one file, or clearing the draft (send accepted / draft reset).

  const handleAddFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      const nextEntries: PendingFile[] = [];
      const issues: string[] = [];
      let currentCount = pendingFiles.length;

      for (const file of files) {
        if (currentCount >= SESSION_FILE_MAX_COUNT) {
          issues.push(
            t('sessions.fileCountLimit', 'At most {{count}} files are allowed', {
              count: SESSION_FILE_MAX_COUNT,
            })
          );
          continue;
        }

        const validationError = validateSessionFile(file);
        if (validationError) {
          issues.push(
            validationError === 'empty'
              ? t('sessions.fileEmpty', 'File is empty: {{name}}', { name: file.name })
              : t('sessions.fileTooLarge', 'File must be ≤ {{max}}MB: {{name}}', {
                  max: SESSION_FILE_MAX_SIZE_MB,
                  name: file.name,
                })
          );
          continue;
        }

        nextEntries.push({
          localId: createLocalFileId(),
          file,
          status: 'draft',
          progress: 0,
        });
        currentCount += 1;
      }

      if (issues.length > 0) {
        toast.error(issues[0]!);
      }

      if (nextEntries.length === 0) {
        return;
      }

      ensureSessionId();
      setPendingFiles((prev) => [...prev, ...nextEntries]);
    },
    [ensureSessionId, pendingFiles.length, setPendingFiles, t]
  );

  const handleRemoveFile = useCallback(
    (localId: string) => {
      setPendingFiles((prev) => {
        const target = prev.find((entry) => entry.localId === localId);
        target?.abort?.abort();
        return prev.filter((entry) => entry.localId !== localId);
      });
    },
    [setPendingFiles]
  );

  const handleRetryFile = useCallback(
    (localId: string) => {
      setPendingFiles((previous) =>
        previous.map((item) =>
          item.localId === localId ? { ...item, status: 'draft', error: undefined } : item
        )
      );
    },
    [setPendingFiles]
  );

  const hasBlockingFiles = false;
  const hasUploadedFiles = pendingFiles.length > 0;

  const fileItems = useMemo<ChatLandingFileDraftItem[]>(
    () =>
      pendingFiles.map((entry) => ({
        id: entry.localId,
        name: entry.file.name,
        sizeLabel: formatFileSize(entry.file.size),
        status: entry.status,
        progress: entry.progress,
        error: entry.error,
      })),
    [pendingFiles]
  );

  const buildFileInputBlocks = useCallback(
    (): SessionInputBlock[] =>
      pendingFiles
        .filter((entry): entry is PendingFile & { uploaded: SessionFilePayload } => {
          return entry.status === 'uploaded' && !!entry.uploaded;
        })
        .map((entry) => toFileInputBlock(entry.uploaded)),
    [pendingFiles]
  );

  return {
    attachments: snapshotAttachmentDrafts([], pendingFiles),
    fileItems,
    hasBlockingFiles,
    hasUploadedFiles,
    canAddMoreFiles: pendingFiles.length < SESSION_FILE_MAX_COUNT,
    addFiles: handleAddFiles,
    handleRemoveFile,
    handleRetryFile,
    clearPendingFiles,
    buildFileInputBlocks,
  };
}

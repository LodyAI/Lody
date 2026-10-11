import type { SessionFileErrorActions } from '@/lib/session-file-actions';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { getImageMimeTypeForPath } from '@/lib/image-file-preview';
import { isPdfFilePath } from '@/lib/pdf-file-preview';
import { getOfficePreviewKind } from '@/lib/session-file-office-source';
import { getVideoMimeTypeForPath } from '@/lib/video-file-preview';
import { SessionFileVideoPreview } from './session-file-video-preview';
import { SessionFileImagePreview } from './session-file-image-preview';
import { SessionFileOfficePreview } from './session-file-office-preview';
import { SessionFilePdfPreview } from './session-file-pdf-preview';
import { SessionFileNoticeCard } from './session-file-error-state';

interface SessionFileBinaryPreviewProps {
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly url?: string;
  readonly fileActions?: SessionFileErrorActions;
  readonly active?: boolean;
}

/**
 * Renders a binary Code Collab file. Images, videos, PDFs, and modern Office files open inline;
 * everything else offers local system actions when available. Render-only:
 * binary bytes and resource URLs come from the file-content snapshot.
 */
export const SessionFileBinaryPreview = memo(function SessionFileBinaryPreview({
  path,
  bytes,
  url,
  fileActions,
  active = true,
}: SessionFileBinaryPreviewProps) {
  const { t } = useTranslation();
  const officeKind = getOfficePreviewKind(path);

  if (getVideoMimeTypeForPath(path) && (url || bytes !== undefined)) {
    return (
      <SessionFileVideoPreview
        path={path}
        bytes={bytes}
        url={url}
        active={active}
        fileActions={fileActions}
      />
    );
  }

  if (isPdfFilePath(path) && (url || bytes !== undefined)) {
    return (
      <SessionFilePdfPreview
        key={url ?? `${path}:${bytes?.byteLength ?? 0}`}
        bytes={bytes}
        url={url}
        fileActions={fileActions}
      />
    );
  }

  if (getImageMimeTypeForPath(path) && (url || (bytes && bytes.byteLength > 0))) {
    return <SessionFileImagePreview path={path} bytes={bytes} url={url} />;
  }

  if (officeKind && (url || bytes !== undefined)) {
    return (
      <SessionFileOfficePreview
        key={url ?? `${path}:${bytes?.byteLength ?? 0}`}
        kind={officeKind}
        path={path}
        bytes={bytes}
        url={url}
        active={active}
        fileActions={fileActions}
      />
    );
  }

  return (
    <SessionFileNoticeCard
      presentation={{
        title: t('sessions.fileDiff.binary.title', 'Binary file'),
        description: t(
          'sessions.fileViewer.binary.message',
          'This binary file cannot be previewed.'
        ),
      }}
      fileActions={fileActions}
    />
  );
});

import type { SessionFileErrorActions } from '@/lib/session-file-actions';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { getImageMimeTypeForPath } from '@/lib/image-file-preview';
import { SessionFileImagePreview } from './session-file-image-preview';
import { SessionFileNoticeCard } from './session-file-error-state';

interface SessionFileBinaryPreviewProps {
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly url?: string;
  readonly fileActions?: SessionFileErrorActions;
}

/**
 * Renders a binary Code Collab file. Image types (png/jpeg/gif/webp/…) are
 * previewed inline; everything else offers local system actions when available. Render-only: bytes are provided by the file-content snapshot.
 */
export const SessionFileBinaryPreview = memo(function SessionFileBinaryPreview({
  path,
  bytes,
  url,
  fileActions,
}: SessionFileBinaryPreviewProps) {
  const { t } = useTranslation();

  if (getImageMimeTypeForPath(path) && (url || (bytes && bytes.byteLength > 0))) {
    return <SessionFileImagePreview path={path} bytes={bytes} url={url} />;
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

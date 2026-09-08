import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { getImageMimeTypeForPath } from '@/lib/image-file-preview';
import { SessionFileImagePreview } from './session-file-image-preview';

interface SessionFileBinaryPreviewProps {
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly url?: string;
}

/**
 * Renders a binary Code Collab file. Image types (png/jpeg/gif/webp/…) are
 * previewed inline; everything else falls back to the "can't be diffed yet"
 * notice. Render-only: bytes are provided by the file-content snapshot.
 */
export const SessionFileBinaryPreview = memo(function SessionFileBinaryPreview({
  path,
  bytes,
  url,
}: SessionFileBinaryPreviewProps) {
  const { t } = useTranslation();

  if (getImageMimeTypeForPath(path) && (url || (bytes && bytes.byteLength > 0))) {
    return <SessionFileImagePreview path={path} bytes={bytes} url={url} />;
  }

  return (
    <div className="h-full space-y-2 p-3">
      <div className="text-sm font-medium text-foreground">
        {t('sessions.fileDiff.binary.title', 'Binary file')}
      </div>
      <div className="text-xs text-muted-foreground">
        {t('sessions.fileDiff.binary.message', "This file is binary and can't be diffed yet.")}
      </div>
    </div>
  );
});

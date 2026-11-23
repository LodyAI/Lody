import * as stylex from '@stylexjs/stylex';
import type { SessionFileErrorActions } from '@/lib/session-file-actions';
import { lazy, memo, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@lody/ui/spinner';
import { getImageMimeTypeForPath } from '@/lib/image-file-preview';
import { isPdfFilePath } from '@/lib/pdf-file-preview';
import { getOfficePreviewKind } from '@/lib/session-file-office-source';
import { getVideoMimeTypeForPath } from '@/lib/video-file-preview';
import { SessionFileVideoPreview } from './session-file-video-preview';
import { SessionFileImagePreview } from './session-file-image-preview';
import { SessionFileOfficePreview } from './session-file-office-preview';
import { SessionFileNoticeCard } from './session-file-error-state';
import { DocumentSelectionSurface } from './document-selection-surface';
import type { DocumentSelection } from '@/lib/document-selection';

// `pdfjs-dist` (JS + viewer CSS + worker URL) stays out of the eager
// file-viewer chunk; it loads only when a PDF preview actually mounts,
// matching how `SessionFileOfficePreview` lazy-loads its renderers.
const LazySessionFilePdfPreview = lazy(() =>
  import('./session-file-pdf-preview').then((module) => ({
    default: module.SessionFilePdfPreview,
  }))
);

const styles = stylex.create({
  loading: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

interface SessionFileBinaryPreviewProps {
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly url?: string;
  readonly fileActions?: SessionFileErrorActions;
  readonly active?: boolean;
  readonly onAddSelectionToChat?: (selection: DocumentSelection) => boolean;
}

/**
 * Renders a binary Code Collab file. Images, videos, PDFs, and modern Office files open inline;
 * everything else offers local system actions when available. Render-only:
 * binary bytes and resource URLs come from the file-content snapshot.
 */
export const SessionFileBinaryPreview = memo(function SessionFileBinaryPreview(
  props: SessionFileBinaryPreviewProps
) {
  const { path, bytes, url, active = true, onAddSelectionToChat } = props;
  const selectable =
    isPdfFilePath(path) || getOfficePreviewKind(path) || getImageMimeTypeForPath(path);
  const preview = <BinaryPreviewContent {...props} />;
  return selectable && onAddSelectionToChat ? (
    <DocumentSelectionSurface
      standaloneCapture={Boolean(getImageMimeTypeForPath(path))}
      path={path}
      source={url ?? bytes}
      active={active}
      onAdd={onAddSelectionToChat}
    >
      {preview}
    </DocumentSelectionSurface>
  ) : (
    preview
  );
});

function BinaryPreviewContent({
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
      <Suspense
        fallback={
          <div {...stylex.props(styles.loading)} role="status">
            <Spinner label={null} />
            <span>{t('sessions.fileViewer.pdf.loading', 'Loading PDF…')}</span>
          </div>
        }
      >
        <LazySessionFilePdfPreview
          key={url ?? `${path}:${bytes?.byteLength ?? 0}`}
          bytes={bytes}
          url={url}
          fileActions={fileActions}
        />
      </Suspense>
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
}

import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FloatingFocusManager, useFloating } from '@floating-ui/react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { forcedThemeClassNames } from '@lody/ui/theme';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { selectionImageCanvas, type DocumentSelection } from '@/lib/document-selection';
import {
  resolveImagePreviewPortalContainer,
  type ImagePreviewPortalAnchorRef,
} from '../shared/zoomable-image-viewer';
import { DocumentSelectionEditor } from './document-selection-editor';

const styles = stylex.create({
  lightbox: {
    position: 'fixed',
    inset: 0,
    zIndex: 'var(--z-image-viewer, 95)',
    backgroundColor: 'rgba(0, 0, 0, 0.86)',
    backdropFilter: 'blur(16px)',
    color: colors.label,
  },
  status: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    gap: 12,
  },
});
export function PendingImageMarkupDialog({
  file,
  onClose,
  onAdd,
  portalAnchorRef,
}: {
  readonly file: File;
  readonly onClose: () => void;
  readonly onAdd: (selection: DocumentSelection) => boolean;
  readonly portalAnchorRef?: ImagePreviewPortalAnchorRef;
}) {
  const { t } = useTranslation();
  const [image, setImage] = useState<HTMLCanvasElement>();
  const [error, setError] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const { context, refs } = useFloating({ open: true });
  useEffect(() => {
    const controller = new AbortController();
    setImage(undefined);
    setError(false);
    void selectionImageCanvas(file, controller.signal).then(
      (canvas) => {
        if (!controller.signal.aborted) setImage(canvas);
      },
      () => {
        if (!controller.signal.aborted) setError(true);
      }
    );
    return () => controller.abort();
  }, [file]);
  return createPortal(
    <FloatingFocusManager
      context={context}
      initialFocus={modalRef}
      returnFocus
      restoreFocus
      outsideElementsInert
    >
      <div
        ref={(node) => {
          modalRef.current = node;
          refs.setFloating(node);
        }}
        className={[stylex.props(styles.lightbox).className, ...forcedThemeClassNames('dark')].join(
          ' '
        )}
        role="dialog"
        aria-modal="true"
        aria-label={t('sessions.fileViewer.selection.markupImage', 'Mark up image')}
        tabIndex={-1}
        data-vaul-no-drag=""
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        {image ? (
          <DocumentSelectionEditor
            allowMarkup
            selection={{
              path: file.name,
              location: t('sessions.fileViewer.selection.image', 'Image'),
            }}
            image={image}
            onCancel={onClose}
            onAdd={onAdd}
          />
        ) : error ? (
          <div {...stylex.props(styles.status)}>
            <div role="alert">
              {t(
                'sessions.fileViewer.selection.imageFailed',
                'Could not open this image for markup. Your attachment is unchanged.'
              )}
            </div>
            <Button onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          </div>
        ) : (
          <div {...stylex.props(styles.status)}>
            <Spinner label={t('sessions.fileViewer.selection.preparing', 'Preparing selection…')} />
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel', 'Cancel')}
            </Button>
          </div>
        )}
      </div>
    </FloatingFocusManager>,
    resolveImagePreviewPortalContainer(portalAnchorRef?.current) ?? document.body
  );
}

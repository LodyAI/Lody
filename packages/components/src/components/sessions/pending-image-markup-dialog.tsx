import * as stylex from '@stylexjs/stylex';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@lody/ui/dialog';
import { Spinner } from '@lody/ui/spinner';
import { selectionImageCanvas, type DocumentSelection } from '@/lib/document-selection';
import { DocumentSelectionEditor } from './document-selection-editor';

const styles = stylex.create({
  body: { position: 'relative', maxHeight: '68dvh', overflow: 'auto', minHeight: 0 },
});
export function PendingImageMarkupDialog({
  file,
  onClose,
  onAdd,
}: {
  readonly file: File;
  readonly onClose: () => void;
  readonly onAdd: (selection: DocumentSelection) => boolean;
}) {
  const { t } = useTranslation();
  const [image, setImage] = useState<HTMLCanvasElement>();
  const [error, setError] = useState(false);
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
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Content width="min(92vw, 960px)">
        <Dialog.Title>
          {t('sessions.fileViewer.selection.markupImage', 'Mark up image')}
        </Dialog.Title>
        <div {...stylex.props(styles.body)}>
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
            <div role="alert">
              {t(
                'sessions.fileViewer.selection.imageFailed',
                'Could not open this image for markup. Your attachment is unchanged.'
              )}
            </div>
          ) : (
            <Spinner label={t('sessions.fileViewer.selection.preparing', 'Preparing selection…')} />
          )}
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}

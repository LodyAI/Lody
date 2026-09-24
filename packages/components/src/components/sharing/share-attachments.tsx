import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import type { SessionFilePayload } from '@lody/shared';
import type { SessionImageGalleryEntry } from '@/lib/session-image-gallery';
import { ZoomableImageViewer } from '../shared/zoomable-image-viewer';
import { SessionFileCard } from '../ai-gui/session-file-card';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { shareSurface } from './surface';

const styles = stylex.create({
  unavailable: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.secondaryLabel,
  },
  unavailableAfterCard: { marginTop: space[1] },
  /**
   * A picture in the transcript opens the viewer. It is the picture, not a
   * framed box: no border, the region fill only while it has not arrived.
   */
  image: {
    display: 'block',
    marginBlock: space[2],
    padding: 0,
    borderWidth: 0,
    overflow: 'hidden',
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    cursor: { default: 'zoom-in', ':disabled': 'default' },
  },
  picture: { display: 'block', maxHeight: '320px', maxWidth: '100%', objectFit: 'contain' },
  loading: {
    display: 'block',
    padding: space[4],
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.secondaryLabel,
  },
  /** The text preview is a block under the file card: the region rung, no border. */
  preview: { display: 'flex', flexDirection: 'column', gap: space[2], marginBlock: space[2] },
  previewActions: { display: 'flex', flexWrap: 'wrap', gap: space[1] },
  previewText: {
    maxHeight: '384px',
    margin: 0,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.label,
  },
});

export type ShareAttachmentAccess = {
  read: (attachmentId: string, signal?: AbortSignal) => Promise<Blob>;
};

export function SharedAttachmentUnavailable() {
  const { t } = useTranslation();
  return (
    <p {...stylex.props(styles.unavailable)}>
      {t('sharing.attachmentUnavailable', 'Attachment unavailable or expired')}
    </p>
  );
}

export function SharedImage({
  entry,
  access,
}: {
  entry: SessionImageGalleryEntry;
  access: ShareAttachmentAccess;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let blobUrl: string | undefined;
    setUrl(undefined);
    setFailed(false);
    void access
      .read(entry.imageId, abort.signal)
      .then((blob) => {
        if (abort.signal.aborted) return;
        blobUrl = URL.createObjectURL(blob);
        setUrl(blobUrl);
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => {
      abort.abort();
      if (blobUrl !== undefined) URL.revokeObjectURL(blobUrl);
    };
  }, [access, entry.imageId]);
  const images = useMemo(
    () => [{ key: entry.key, src: url, fileName: entry.fileName }],
    [entry.key, entry.fileName, url]
  );
  if (failed) return <SharedAttachmentUnavailable />;
  return (
    <>
      <button
        type="button"
        disabled={url === undefined}
        onClick={() => setOpen(true)}
        {...stylex.props(styles.image)}
      >
        {url !== undefined ? (
          <img
            src={url}
            alt={entry.alt ?? t('sessions.uploadedImage', 'Uploaded image')}
            {...stylex.props(styles.picture)}
          />
        ) : (
          <span {...stylex.props(styles.loading)}>
            {t('sharing.loadingAttachment', 'Loading attachment…')}
          </span>
        )}
      </button>
      <ZoomableImageViewer open={open} onClose={() => setOpen(false)} images={images} index={0} />
    </>
  );
}

export function SharedFile({
  file,
  access,
}: {
  file: SessionFilePayload;
  access: ShareAttachmentAccess;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    setBusy(false);
    setFailed(false);
    setPreview(null);
    return () => {
      abort.abort();
      if (lifetime.current === abort) lifetime.current = null;
    };
  }, [access, file.fileId]);
  const download = async () => {
    const abort = lifetime.current;
    if (!abort) return;
    setBusy(true);
    setFailed(false);
    try {
      const blob = await access.read(file.fileId, abort.signal);
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.fileName;
      anchor.rel = 'noreferrer';
      anchor.click();
      // Release after the browser has consumed the click.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      if (!abort.signal.aborted) setFailed(true);
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  const showPreview = async () => {
    const abort = lifetime.current;
    if (!abort) return;
    setBusy(true);
    setFailed(false);
    try {
      // Verify the complete immutable object before presenting a bounded text preview.
      const blob = await access.read(file.fileId, abort.signal);
      const body = await blob.slice(0, 65536).text();
      if (abort.signal.aborted) return;
      setPreview(body);
    } catch {
      if (!abort.signal.aborted) setFailed(true);
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  return (
    <div>
      <SessionFileCard
        file={file}
        retention="publication"
        isDownloading={busy}
        onDownload={() => {
          void download();
        }}
        onPreview={
          file.textPreview
            ? () => {
                void showPreview();
              }
            : undefined
        }
      />
      {failed && (
        <p role="status" {...stylex.props(styles.unavailable, styles.unavailableAfterCard)}>
          {t('sharing.attachmentUnavailable', 'Attachment unavailable or expired')}
        </p>
      )}
      {preview !== null && (
        <div {...stylex.props(shareSurface.region, styles.preview)}>
          <div {...stylex.props(styles.previewActions)}>
            <Button
              type="button"
              variant="ghost"
              size="small"
              disabled={busy}
              onClick={() => void download()}
            >
              {t('sessions.fileActions.download', 'Download file')}
            </Button>
            <Button type="button" variant="ghost" size="small" onClick={() => setPreview(null)}>
              {t('sharing.closePreview', 'Close preview')}
            </Button>
          </div>
          <pre {...stylex.props(styles.previewText)}>{preview}</pre>
        </div>
      )}
    </div>
  );
}

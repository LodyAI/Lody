import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionFilePayload } from '@lody/shared';
import type { SessionImageGalleryEntry } from '@/lib/session-image-gallery';
import { ZoomableImageViewer } from '../shared/zoomable-image-viewer';
import { SessionFileCard } from '../ai-gui/session-file-card';

export type ShareAttachmentAccess = {
  read: (
    resource: string,
    signal?: AbortSignal,
    range?: string,
    storageSessionId?: string
  ) => Promise<Response>;
};

export function SharedAttachmentUnavailable() {
  const { t } = useTranslation();
  return (
    <p className="text-sm text-muted-foreground">
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
      .read(`images/${encodeURIComponent(entry.imageId)}`, abort.signal, undefined, entry.sessionId)
      .then((response) => response.blob())
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
  }, [access, entry.imageId, entry.sessionId]);
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
        className="my-2 block overflow-hidden rounded-xl border border-border"
      >
        {url !== undefined ? (
          <img
            src={url}
            alt={entry.alt ?? t('sessions.uploadedImage', 'Uploaded image')}
            className="max-h-80 max-w-full object-contain"
          />
        ) : (
          <span className="block p-4 text-sm text-muted-foreground">
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
  }, [access, file.fileId, file.storageSessionId]);
  const download = async () => {
    const abort = lifetime.current;
    if (!abort) return;
    setBusy(true);
    setFailed(false);
    try {
      const response = await access.read(
        `files/${encodeURIComponent(file.fileId)}`,
        abort.signal,
        undefined,
        file.storageSessionId
      );
      const blob = await response.blob();
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
      const response = await access.read(
        `files/${encodeURIComponent(file.fileId)}/preview`,
        abort.signal,
        'bytes=0-65535',
        file.storageSessionId
      );
      const body = await response.text();
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
        <p role="status" className="mt-1 text-sm text-muted-foreground">
          {t('sharing.attachmentUnavailable', 'Attachment unavailable or expired')}
        </p>
      )}
      {preview !== null && (
        <div className="my-2 rounded-lg border border-border p-3">
          <button
            type="button"
            className="mb-2 mr-4 text-sm text-muted-foreground"
            disabled={busy}
            onClick={() => void download()}
          >
            {t('sessions.fileActions.download', 'Download file')}
          </button>
          <button
            type="button"
            className="mb-2 text-sm text-muted-foreground"
            onClick={() => setPreview(null)}
          >
            {t('sharing.closePreview', 'Close preview')}
          </button>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">{preview}</pre>
        </div>
      )}
    </div>
  );
}

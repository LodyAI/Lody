import { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { Image as ImageIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SessionId, SessionInputBlock, WorkspaceId } from '@lody/shared';
import { Tooltip } from '@lody/ui/tooltip';
import { currentWorkspaceIdAtom } from '@/atoms';
import { authTokenAtom } from '@/atoms/runtime';
import { getSessionImageBlobUrl } from '@/lib/session-image-cache';
import { cn } from '@/lib/utils';
import { ZoomableImageViewer } from '@/components/shared/zoomable-image-viewer';

export type QueuedImageBlock = Extract<SessionInputBlock, { type: 'image' }>;

export function QueuedImagePreview({
  sessionId,
  image,
  size = 20,
  className,
}: {
  sessionId: SessionId;
  image: QueuedImageBlock;
  size?: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom) as WorkspaceId | null;
  const authToken = useAtomValue(authTokenAtom);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [originalUrl, setOriginalUrl] = useState<string | undefined>(undefined);
  const label = image.fileName || t('sessions.uploadedImage', 'Uploaded image');

  // The full-size image loads only once the preview opens (the row itself
  // needs just the thumbnail); the viewer shows its loading state until then.
  useEffect(() => {
    if (!previewOpen || originalUrl || !workspaceId || !authToken) return undefined;
    let active = true;
    void getSessionImageBlobUrl({
      workspaceId,
      sessionId,
      imageId: image.imageId,
      token: authToken,
      variant: 'original',
    })
      .then((url) => {
        if (active) setOriginalUrl(url);
      })
      .catch(() => {
        // Keep the thumbnail as the preview rather than an endless spinner.
        if (active && thumbnailUrl) setOriginalUrl(thumbnailUrl);
      });
    return () => {
      active = false;
    };
  }, [authToken, image.imageId, originalUrl, previewOpen, sessionId, thumbnailUrl, workspaceId]);

  const previewImages = useMemo(
    () => [{ key: image.imageId, src: originalUrl, fileName: image.fileName }],
    [image.fileName, image.imageId, originalUrl]
  );

  useEffect(() => {
    let active = true;
    setThumbnailUrl(null);
    setLoadFailed(false);

    if (!workspaceId || !authToken) {
      setLoadFailed(true);
      return () => {
        active = false;
      };
    }

    void getSessionImageBlobUrl({
      workspaceId,
      sessionId,
      imageId: image.imageId,
      token: authToken,
      variant: 'thumbnail',
      thumbnailWidth: size * 2,
      thumbnailHeight: size * 2,
      thumbnailFit: 'cover',
      thumbnailQuality: 80,
    })
      .then((url) => {
        if (active) {
          setThumbnailUrl(url);
        }
      })
      .catch(() => {
        if (active) {
          setLoadFailed(true);
        }
      });

    return () => {
      active = false;
    };
  }, [authToken, image.imageId, sessionId, workspaceId, size]);

  return (
    <>
      <Tooltip.Root>
        <Tooltip.Trigger delay={300} render={<button
            type="button"
            disabled={loadFailed}
            onClick={(event) => {
              // The row is draggable and editable; opening the preview is all
              // this click should do.
              event.stopPropagation();
              setPreviewOpen(true);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            className={cn(
              'flex shrink-0 items-center justify-center overflow-hidden rounded',
              'border border-border/40 bg-background/60',
              'cursor-zoom-in disabled:cursor-default',
              'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40',
              className
            )}
            style={{ width: size, height: size }}
            aria-label={t('sessions.messageQueue.previewImage', 'Preview {{name}}', {
              name: label,
            })}
          >
            {thumbnailUrl ? (
              <img src={thumbnailUrl} alt={label} className="h-full w-full object-cover" />
            ) : loadFailed ? (
              <ImageIcon
                className="text-muted-foreground"
                style={{ width: size * 0.5, height: size * 0.5 }}
              />
            ) : (
              <div className="h-full w-full animate-pulse bg-muted/70" />
            )}
          </button>}/>
        <Tooltip.Content side="top">{label}</Tooltip.Content>
      </Tooltip.Root>
      <ZoomableImageViewer
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        images={previewImages}
        index={0}
      />
    </>
  );
}

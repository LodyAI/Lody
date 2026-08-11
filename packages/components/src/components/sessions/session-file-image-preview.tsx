import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getImageMimeTypeForPath } from '@/lib/image-file-preview';
import { ZoomableImageViewer } from '@/components/shared/zoomable-image-viewer';

interface SessionFileImagePreviewProps {
  readonly path: string;
  /** Raw bytes for binary images (png/jpeg/gif/webp/…). */
  readonly bytes?: Uint8Array;
  /** Source text for SVG files (which are classified as text, not binary). */
  readonly svgText?: string;
}

/**
 * Inline image preview backed by an object URL. Returns null when the path is
 * not a previewable image or no source is available, so callers can fall back
 * to other rendering (e.g. a binary notice or the code viewer).
 *
 * Uses <img src=blob:> rather than inlining SVG markup: it keeps the same code
 * path for raster and vector images and sandboxes SVGs (no script/external
 * resource execution).
 *
 * Tapping the fitted image opens the shared `ZoomableImageViewer`, the SAME
 * full-screen surface chat image blocks use, so pinch-to-zoom, double-tap,
 * drag-to-pan, and the top-right close button behave identically in both. The
 * inline surface deliberately stays a plain fitted <img>: `react-photo-view`
 * has no inline mode, and a hand-rolled inline zoom would be a second gesture
 * implementation fighting the mobile drawer/edge-back gestures.
 */
export const SessionFileImagePreview = memo(function SessionFileImagePreview({
  path,
  bytes,
  svgText,
}: SessionFileImagePreviewProps) {
  const { t } = useTranslation();
  const mimeType = getImageMimeTypeForPath(path);
  const [objectUrl, setObjectUrl] = useState<string | undefined>(undefined);
  const [viewerOpen, setViewerOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mimeType) {
      setObjectUrl(undefined);
      return undefined;
    }
    let blob: Blob | undefined;
    if (svgText !== undefined) {
      blob = new Blob([svgText], { type: 'image/svg+xml' });
    } else if (bytes && bytes.byteLength > 0) {
      // Copy into a fresh ArrayBuffer-backed Uint8Array so Blob typing is happy
      // even if `bytes` is a view over a shared/transferable buffer.
      blob = new Blob([Uint8Array.from(bytes)], { type: mimeType });
    }
    if (!blob) {
      setObjectUrl(undefined);
      return undefined;
    }
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    // The open viewer holds the previous object URL; close it before the URL is
    // revoked so it can never show a dead blob.
    setViewerOpen(false);
    return () => URL.revokeObjectURL(url);
  }, [bytes, svgText, mimeType]);

  const images = useMemo(
    () => (objectUrl ? [{ key: path, src: objectUrl, fileName: path }] : []),
    [objectUrl, path]
  );
  const handleClose = useCallback(() => setViewerOpen(false), []);

  if (!mimeType || !objectUrl) return null;
  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 items-center justify-center overflow-auto p-3"
    >
      <button
        type="button"
        className="flex h-full w-full cursor-zoom-in items-center justify-center"
        onClick={() => setViewerOpen(true)}
        aria-label={t('sessions.imagePreview.zoom', 'Open image in full screen')}
      >
        <img src={objectUrl} alt={path} className="max-h-full max-w-full object-contain" />
      </button>
      <ZoomableImageViewer
        open={viewerOpen}
        onClose={handleClose}
        images={images}
        index={0}
        portalAnchorRef={containerRef}
      />
    </div>
  );
});

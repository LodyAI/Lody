import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { PhotoSlider } from 'react-photo-view';
import { toast } from 'sonner';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  isMacOSElectronRenderer,
  isWindowsElectronRenderer,
  useElectronFullscreen,
} from '@/lib/electron';
import {
  getImagePreviewExportBridge,
  runImagePreviewContextMenu,
  type ImagePreviewExportOutcome,
} from '@/lib/image-preview-export';
import { cn } from '@/lib/utils';
import 'react-photo-view/dist/react-photo-view.css';
import './zoomable-image-viewer.css';

/**
 * The single full-screen image viewer for the whole app: pinch-to-zoom,
 * double-tap zoom, wheel zoom, drag-to-pan, and the top-right close button all
 * come from `react-photo-view`'s `PhotoSlider`. Chat image blocks and the Code
 * Collab file preview both mount THIS component, so the gestures stay identical
 * between them — do not hand-roll a second zoom surface for a new caller.
 *
 * `react-photo-view@1.2.7` is patched in root `patches/` to hard-clamp the
 * minimum pinch scale at `1`. Do not replace that with an outer
 * `overlayRender`/React state clamp; that fights PhotoView's touch state.
 *
 * On a desktop-shaped surface the same viewer presents as a LIGHTBOX rather
 * than a full-bleed takeover (`zoomable-image-viewer.css`): the photo keeps an
 * inset from the window edges, the mask is translucent so the app behind still
 * reads as present, and the top bar clears the native window controls. Touch
 * surfaces keep the edge-to-edge presentation, where a viewer that fills the
 * screen is the expected one.
 */

/** Mask alpha on desktop; mobile keeps the library's opaque black. */
const DESKTOP_MASK_OPACITY = 0.86;

export type ZoomableImageViewerItem = {
  readonly key: string;
  /** Undefined while the full-size source is still loading. */
  readonly src: string | undefined;
  /** Source name, used as the save-dialog default. */
  readonly fileName?: string | undefined;
};

export type ImagePreviewPortalAnchorRef = { readonly current: HTMLElement | null };

/**
 * Inside mobile Vaul drawers, do not let the viewer default its portal to
 * `document.body`: Radix/Vaul treats body portals as outside the drawer, so
 * touch/scroll can be blocked or fall through. Resolve the real
 * `[data-vaul-drawer]` instead (the `data-vaul-no-drag` wrapper is only a
 * `display: contents` fallback). Returns undefined outside a drawer, where the
 * library's own body portal is correct.
 */
export const resolveImagePreviewPortalContainer = (
  anchor: HTMLElement | null | undefined
): HTMLElement | undefined => {
  if (typeof document === 'undefined') {
    return undefined;
  }

  return (
    anchor?.closest<HTMLElement>('[data-vaul-drawer]') ??
    anchor?.closest<HTMLElement>('[data-vaul-no-drag]') ??
    undefined
  );
};

/**
 * Mark the mounted portal root `data-vaul-no-drag` so Vaul does not take over
 * the viewer's pan/pinch gestures and drag the drawer toward dismissal.
 */
export function useImagePreviewPortalNoDrag(
  active: boolean,
  portalContainer: HTMLElement | undefined
) {
  useLayoutEffect(() => {
    if (!active || !portalContainer) {
      return undefined;
    }

    const portal = portalContainer.querySelector<HTMLElement>(
      ':scope > .lody-photo-slider.PhotoView-Portal'
    );
    if (!portal) {
      return undefined;
    }

    portal.setAttribute('data-vaul-no-drag', '');
    return () => {
      portal.removeAttribute('data-vaul-no-drag');
    };
  }, [active, portalContainer]);
}

export type ZoomableImageViewerProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Keep this array referentially stable (memoize it) — a fresh identity every
   *  render makes the slider re-mount its photos mid-gesture. */
  readonly images: ZoomableImageViewerItem[];
  readonly index: number;
  readonly onIndexChange?: (index: number) => void;
  /**
   * An element inside the surface that opened the viewer. Used only to find the
   * enclosing Vaul drawer; pass the scroll root or the preview container.
   */
  readonly portalAnchorRef?: ImagePreviewPortalAnchorRef;
};

export function ZoomableImageViewer({
  open,
  onClose,
  images,
  index,
  onIndexChange,
  portalAnchorRef,
}: ZoomableImageViewerProps) {
  const portalContainer = resolveImagePreviewPortalContainer(portalAnchorRef?.current);
  useImagePreviewPortalNoDrag(open, portalContainer);

  if (!open || index < 0 || index >= images.length) {
    return null;
  }

  return (
    <OpenZoomableImageViewer
      onClose={onClose}
      images={images}
      index={index}
      {...(onIndexChange ? { onIndexChange } : {})}
      {...(portalContainer ? { portalContainer } : {})}
    />
  );
}

/** The photo react-photo-view renders, via our `photoClassName`. */
const PHOTO_SELECTOR = 'img.lody-photo-slider-image';

/**
 * Right-click on the previewed photo → the desktop app's native Copy / Save
 * menu. Electron renders no context menu of its own, so without this a
 * right-click in the viewer does nothing at all; on web the browser's own menu
 * already offers both, which is why this installs only when the preload bridge
 * is there.
 *
 * The listener sits on `document` rather than on the photo: react-photo-view
 * owns that element and re-creates it per slide, and while the viewer is open
 * it is the only thing on screen the selector can match.
 */
function useImagePreviewContextMenu(images: ZoomableImageViewerItem[]) {
  const { t } = useTranslation();
  // Sliding to another photo must not re-install the listener.
  const imagesRef = useRef(images);
  imagesRef.current = images;

  useEffect(() => {
    if (!getImagePreviewExportBridge()) {
      return undefined;
    }

    const reportOutcome = (outcome: ImagePreviewExportOutcome) => {
      switch (outcome.kind) {
        case 'copied':
          toast.success(t('sessions.imagePreview.copied', 'Image copied'));
          return;
        case 'saved':
          toast.success(t('sessions.imagePreview.saved', 'Image saved'));
          return;
        case 'copy-failed':
          toast.error(t('sessions.imagePreview.copyFailed', 'Could not copy the image'), {
            description: outcome.error,
          });
          return;
        case 'save-failed':
          toast.error(t('sessions.imagePreview.saveFailed', 'Could not save the image'), {
            description: outcome.error,
          });
          return;
        default:
          // Dismissing the menu and canceling the save dialog are both choices,
          // not failures.
          return;
      }
    };

    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const photo = target.closest<HTMLImageElement>(PHOTO_SELECTOR);
      const src = photo?.currentSrc || photo?.src;
      if (!src) {
        return;
      }

      event.preventDefault();
      const item = imagesRef.current.find((candidate) => candidate.src === src);
      void runImagePreviewContextMenu({
        src,
        fileName: item?.fileName,
        items: [
          { action: 'copy', label: t('sessions.imagePreview.copy', 'Copy Image') },
          { action: 'save', label: t('sessions.imagePreview.save', 'Save Image As…') },
        ],
      }).then(reportOutcome);
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [t]);
}

/**
 * Split out so a CLOSED viewer costs nothing: a conversation mounts one of
 * these per image block, and the surface hooks below install viewport and
 * Electron listeners that idle blocks have no use for.
 */
function OpenZoomableImageViewer({
  onClose,
  images,
  index,
  onIndexChange,
  portalContainer,
}: {
  readonly onClose: () => void;
  readonly images: ZoomableImageViewerItem[];
  readonly index: number;
  readonly onIndexChange?: (index: number) => void;
  readonly portalContainer?: HTMLElement;
}) {
  const isMobile = useIsMobile();
  const isElectronFullscreen = useElectronFullscreen();
  useImagePreviewContextMenu(images);

  // Native window controls are drawn ABOVE web content, so the top bar has to
  // leave room for them or the counter lands behind the macOS traffic lights /
  // the Windows caption buttons. Both hide themselves in native fullscreen.
  const reservesWindowControls = !isElectronFullscreen;
  const sliderClassName = cn(
    'lody-photo-slider',
    !isMobile && 'lody-photo-slider--desktop',
    // A single image has nothing to count; "1 / 1" is only noise.
    images.length < 2 && 'lody-photo-slider--single',
    reservesWindowControls && isMacOSElectronRenderer() && 'lody-photo-slider--mac-controls',
    reservesWindowControls && isWindowsElectronRenderer() && 'lody-photo-slider--win-controls'
  );

  return (
    <PhotoSlider
      className={sliderClassName}
      images={images}
      visible
      onClose={onClose}
      index={index}
      {...(onIndexChange ? { onIndexChange } : {})}
      maskClosable
      photoClosable
      {...(isMobile ? {} : { maskOpacity: DESKTOP_MASK_OPACITY })}
      photoClassName="lody-photo-slider-image"
      photoWrapClassName="lody-photo-slider-photo-wrap"
      {...(portalContainer ? { portalContainer } : {})}
    />
  );
}

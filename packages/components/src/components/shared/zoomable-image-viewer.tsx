import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { FloatingFocusManager, useFloating } from '@floating-ui/react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { forcedThemeClassNames } from '@lody/ui/theme';
import { space } from '@lody/ui/tokens/scales.stylex';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PhotoSlider } from 'react-photo-view';
import { toast } from '@/lib/toast';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  isMacOSElectronRenderer,
  isWindowsElectronRenderer,
  useElectronFullscreen,
} from '@/lib/electron';
import {
  canCopyImagePreview,
  canShareImagePreview,
  prepareImagePreviewFile,
  runTouchImagePreviewAction,
  getImagePreviewExportBridge,
  runImagePreviewContextMenu,
  type ImagePreviewExportOutcome,
} from '@/lib/image-preview-export';
import { cn } from '@/lib/utils';
import 'react-photo-view/dist/react-photo-view.css';
import './zoomable-image-viewer.css';

/**
 * The single full-screen image viewer for the whole app: pinch-to-zoom,
 * double-tap zoom, wheel zoom and drag-to-pan come from `react-photo-view`'s
 * `PhotoSlider`; Lody owns the modal focus boundary and named buttons. Chat image blocks and the Code
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

const styles = stylex.create({
  modal: { position: 'fixed', inset: 0, zIndex: 'var(--z-image-viewer, 95)' },
  controls: {
    position: 'fixed',
    inset: 0,
    zIndex: 'calc(var(--z-image-viewer, 95) + 1)',
    pointerEvents: 'none',
  },
  toolbar: { pointerEvents: 'auto' },
  menuLayer: { position: 'relative', zIndex: 'calc(var(--z-image-viewer, 95) + 2)' },
  menuDismiss: { position: 'fixed', inset: 0 },
  close: { marginInlineStart: 'auto', paddingInline: space[2] },
  previous: {
    position: 'absolute',
    top: '50%',
    left: 'var(--safe-area-left, env(safe-area-inset-left, 0px))',
    padding: space[2],
    pointerEvents: 'auto',
    transform: 'translateY(-50%)',
  },
  next: {
    position: 'absolute',
    top: '50%',
    right: 'var(--safe-area-right, env(safe-area-inset-right, 0px))',
    padding: space[2],
    pointerEvents: 'auto',
    transform: 'translateY(-50%)',
  },
});

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

type TouchImageMenuTarget = {
  item: ZoomableImageViewerItem & { src: string };
  anchor: { getBoundingClientRect: () => DOMRect };
};

/** Observe touch without capturing it or cancelling PhotoSlider's pan/pinch events. */
function useImagePreviewLongPress(
  container: HTMLElement | null,
  item: ZoomableImageViewerItem | undefined
) {
  const [menu, setMenu] = useState<TouchImageMenuTarget | null>(null);
  const key = item?.key;
  const src = item?.src;
  const fileName = item?.fileName;
  useEffect(() => {
    if (!container || !src || key === undefined) return undefined;
    let timer: number | undefined;
    let start: { id: number; x: number; y: number } | undefined;
    let fired = false;
    let touch = false;
    const pointers = new Set<number>();
    const cancel = () => {
      window.clearTimeout(timer);
      timer = undefined;
      start = undefined;
    };
    const down = (event: PointerEvent) => {
      touch = event.pointerType === 'touch';
      if (!touch) return;
      // A removed touch target may not deliver its final event to this document.
      if (event.isPrimary) pointers.clear();
      pointers.add(event.pointerId);
      cancel();
      fired = false;
      if (pointers.size !== 1 || !event.isPrimary || !(event.target instanceof Element)) return;
      const photo = event.target.closest<HTMLImageElement>(PHOTO_SELECTOR);
      if (!photo || !container.contains(photo) || (photo.currentSrc || photo.src) !== src) return;
      start = { id: event.pointerId, x: event.clientX, y: event.clientY };
      const { x, y } = start;
      timer = window.setTimeout(() => {
        timer = undefined;
        fired = true;
        setMenu({
          item: { key, src, fileName },
          anchor: {
            getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
          },
        });
      }, 500);
    };
    const move = (event: PointerEvent) => {
      if (
        start?.id === event.pointerId &&
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10
      )
        cancel();
    };
    const up = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      cancel();
    };
    const contextMenu = (event: MouseEvent) => {
      if (touch && event.target instanceof Element && event.target.closest(PHOTO_SELECTOR)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const click = (event: MouseEvent) => {
      if (!fired || !(event.target instanceof Element) || !event.target.closest(PHOTO_SELECTOR))
        return;
      fired = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const deactivate = () => {
      cancel();
      pointers.clear();
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    container.addEventListener('contextmenu', contextMenu, true);
    container.addEventListener('click', click, true);
    window.addEventListener('blur', deactivate);
    document.addEventListener('visibilitychange', deactivate);
    return () => {
      cancel();
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      container.removeEventListener('contextmenu', contextMenu, true);
      container.removeEventListener('click', click, true);
      window.removeEventListener('blur', deactivate);
      document.removeEventListener('visibilitychange', deactivate);
    };
  }, [container, key, src, fileName]);
  // A replacement/removal/slide change must never retarget an already-open menu.
  const currentMenu = menu?.item.key === item?.key && menu?.item.src === item?.src ? menu : null;
  useEffect(() => setMenu(null), [item?.key, item?.src, item?.fileName]);
  return { menu: currentMenu, closeMenu: () => setMenu(null) };
}

function TouchImageMenu({
  target,
  close,
  finalFocus,
}: {
  target: TouchImageMenuTarget;
  close: () => void;
  finalFocus: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void prepareImagePreviewFile(target.item.src, target.item.fileName, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setFile(value);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      }
    );
    return () => controller.abort();
  }, [target]);
  const run = (action: 'copy' | 'save' | 'share') => {
    if (!file) return;
    // Invoke before closing/awaiting so browser clipboard/share retain activation.
    const result = runTouchImagePreviewAction(action, target.item.src, file);
    close();
    void result.then((outcome) => {
      if (outcome.kind === 'copied') toast.success(t('sessions.imagePreview.copied'));
      else if (outcome.kind === 'saved') toast.success(t('sessions.imagePreview.saved'));
      else if (outcome.kind === 'download-started')
        toast.success(t('sessions.imagePreview.downloadStarted'));
      else if (outcome.kind.endsWith('-failed')) {
        toast.error(t(`sessions.imagePreview.${action}Failed`), {
          description: 'error' in outcome ? outcome.error : undefined,
        });
      }
    });
  };
  return (
    <div ref={setContainer} {...stylex.props(styles.menuLayer)}>
      {/* Shield the entire dismiss gesture from PhotoSlider's touchend close path. */}
      <div
        aria-hidden="true"
        data-image-menu-dismiss=""
        {...stylex.props(styles.menuDismiss)}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
      />
      {container && (
        <Menu.Root
          open
          onOpenChange={(open) => {
            if (!open) close();
          }}
          modal={false}
        >
          <Menu.Content
            container={container}
            anchor={target.anchor}
            positionMethod="fixed"
            finalFocus={finalFocus}
          >
            {!file && (
              <Menu.Group>
                <Menu.GroupLabel>
                  {t(failed ? 'sessions.imageLoadFailed' : 'common.loading')}
                </Menu.GroupLabel>
              </Menu.Group>
            )}
            <Menu.Item disabled={!file || !canCopyImagePreview()} onClick={() => run('copy')}>
              {t(
                canCopyImagePreview()
                  ? 'sessions.imagePreview.copy'
                  : 'sessions.imagePreview.copyUnavailable'
              )}
            </Menu.Item>
            <Menu.Item disabled={!file} onClick={() => run('save')}>
              {t('sessions.imagePreview.saveImage')}
            </Menu.Item>
            <Menu.Item disabled={!file || !canShareImagePreview(file)} onClick={() => run('share')}>
              {t(
                file && !canShareImagePreview(file)
                  ? 'sessions.imagePreview.shareUnavailable'
                  : 'sessions.imagePreview.share'
              )}
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item onClick={close}>{t('common.cancel')}</Menu.Item>
          </Menu.Content>
        </Menu.Root>
      )}
    </div>
  );
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
  const { t } = useTranslation();
  const closeRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  const { context, refs, elements } = useFloating({ open: true });
  const loops = images.length > 3;
  const move = (offset: number) =>
    onIndexChange?.(
      loops
        ? (index + offset + images.length) % images.length
        : Math.max(0, Math.min(images.length - 1, index + offset))
    );
  const isMobile = useIsMobile();
  const isElectronFullscreen = useElectronFullscreen();
  useImagePreviewContextMenu(images);
  const { menu, closeMenu } = useImagePreviewLongPress(elements.floating, images[index]);

  // Native window controls are drawn ABOVE web content, so the top bar clears
  // them horizontally and centers its own controls on their line (the y=23
  // traffic-light row on macOS, the 36px caption strip on Windows — see the
  // `--mac-controls`/`--win-controls` rules in the CSS). Both hide themselves
  // in native fullscreen.
  const reservesWindowControls = !isElectronFullscreen;
  const sliderClassName = cn(
    'lody-photo-slider',
    !isMobile && 'lody-photo-slider--desktop',
    // A single image has nothing to count; "1 / 1" is only noise.
    images.length < 2 && 'lody-photo-slider--single',
    reservesWindowControls && isMacOSElectronRenderer() && 'lody-photo-slider--mac-controls',
    reservesWindowControls && isWindowsElectronRenderer() && 'lody-photo-slider--win-controls'
  );

  // Keep PhotoSlider's portal inside the focus boundary, including while loading.
  useLayoutEffect(() => {
    const photoPortal = elements.floating?.querySelector('.PhotoView-Portal');
    photoPortal?.removeAttribute('role');
    photoPortal?.setAttribute('data-vaul-no-drag', '');
  }, [elements.floating]);

  return createPortal(
    <FloatingFocusManager
      context={context}
      initialFocus={closeRef}
      returnFocus={openerRef}
      restoreFocus
      outsideElementsInert
    >
      <div
        ref={refs.setFloating}
        {...stylex.props(styles.modal)}
        role="dialog"
        aria-modal="true"
        aria-label={t('sessions.imagePreview')}
        data-state="open"
        data-vaul-no-drag=""
        tabIndex={-1}
        onKeyDown={(event) => {
          if (menu) {
            if (event.key === 'Escape') closeMenu();
            event.stopPropagation();
            return;
          }
          // Do not also run PhotoSlider's window listener or background shortcuts.
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            event.stopPropagation();
            move(event.key === 'ArrowRight' ? 1 : -1);
          }
        }}
      >
        {elements.floating && (
          <PhotoSlider
            className={sliderClassName}
            images={images}
            visible
            onClose={onClose}
            index={index}
            bannerVisible={false}
            {...(onIndexChange ? { onIndexChange } : {})}
            maskClosable
            // The photo itself is the pan/zoom surface. Letting a tap close it makes
            // a second click after opening race with the source thumbnail and can
            // reopen the viewer; the toolbar and backdrop remain explicit exits.
            photoClosable={false}
            // A vertical drag should pan the image, not turn into PhotoView's
            // pull-to-dismiss animation. That animation is what makes a zoomed
            // desktop image appear to float away from the pointer.
            pullClosable={false}
            {...(isMobile ? {} : { maskOpacity: DESKTOP_MASK_OPACITY })}
            photoClassName="lody-photo-slider-image"
            photoWrapClassName="lody-photo-slider-photo-wrap"
            portalContainer={elements.floating}
          />
        )}
        {menu && <TouchImageMenu target={menu} close={closeMenu} finalFocus={closeRef} />}
        <div
          className={cn(
            sliderClassName,
            stylex.props(styles.controls).className,
            ...forcedThemeClassNames('dark')
          )}
        >
          <div
            className={cn('PhotoView-Slider__BannerWrap', stylex.props(styles.toolbar).className)}
          >
            <span className="PhotoView-Slider__Counter" aria-live="polite">
              {index + 1} / {images.length}
            </span>
            <div {...stylex.props(styles.close)}>
              <Button
                ref={closeRef}
                icon
                variant="ghost"
                aria-label={t('sessions.imagePreview.close', 'Close image preview')}
                onClick={onClose}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          </div>
          {images.length > 1 && (
            <>
              <div {...stylex.props(styles.previous)}>
                <Button
                  icon
                  variant="ghost"
                  aria-label={t('sessions.previousImage')}
                  disabled={(!loops && index === 0) || !onIndexChange}
                  onClick={() => move(-1)}
                >
                  <ChevronLeft aria-hidden="true" />
                </Button>
              </div>
              <div {...stylex.props(styles.next)}>
                <Button
                  icon
                  variant="ghost"
                  aria-label={t('sessions.nextImage')}
                  disabled={(!loops && index === images.length - 1) || !onIndexChange}
                  onClick={() => move(1)}
                >
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </FloatingFocusManager>,
    portalContainer ?? document.body
  );
}

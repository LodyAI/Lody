import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Maximize, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';

/**
 * The full-screen viewer for a rendered Mermaid diagram.
 *
 * Streamdown ships its own Mermaid full-screen overlay; `markdown-renderer.tsx`
 * turns it off (`controls.mermaid.fullscreen: false`) and mounts this instead.
 * The bundled one positions its only exit at a raw `top-4 right-4`, which on a
 * phone lands inside the status-bar inset, and its content layer covers the
 * whole backdrop while swallowing clicks — so on touch there is no reachable
 * way out at all. Three rules keep that from recurring here:
 *
 * 1. Controls sit in a bar padded by the `--safe-area-*` variables (the same
 *    ones `tailwind/index.css` maps to `env(safe-area-inset-*)`), never at a
 *    fixed offset from the viewport edge.
 * 2. There is always more than one exit: the close button, a click anywhere
 *    off the diagram, and Escape.
 * 3. The stacking order comes from the app's z-index scale, so the viewer
 *    lands above dialogs and popovers rather than under them.
 */

export const MERMAID_DIAGRAM_MIN_ZOOM = 0.25;
export const MERMAID_DIAGRAM_MAX_ZOOM = 4;
/**
 * A diagram narrower than the viewport is scaled up to fill it, but only this
 * far: past ~3x a small flowchart is all stroke and no information.
 */
const MERMAID_DIAGRAM_MAX_INITIAL_ZOOM = 3;
const MERMAID_DIAGRAM_ZOOM_STEP = 1.25;

/**
 * `size="icon"` is 36px square. The viewer's controls sit at the top edge of a
 * phone screen, where the shared size is under the 44px touch-target floor
 * (iOS HIG / WCAG 2.5.5) that this whole fix is about.
 */
const CONTROL_CLASS_NAME = 'h-11 w-11 shrink-0 text-muted-foreground';

/**
 * Inline rather than a utility class because an inline `padding-left` would
 * otherwise override a `px-*` class outright and drop the gutter it replaces;
 * each value carries its own gutter instead.
 */
const SAFE_AREA_TOP = 'var(--safe-area-top, env(safe-area-inset-top, 0px))';
const SAFE_AREA_RIGHT = 'calc(0.25rem + var(--safe-area-right, env(safe-area-inset-right, 0px)))';
const SAFE_AREA_BOTTOM = 'var(--safe-area-bottom, env(safe-area-inset-bottom, 0px))';
const SAFE_AREA_LEFT = 'calc(0.25rem + var(--safe-area-left, env(safe-area-inset-left, 0px)))';

export type MermaidDiagramSelection = {
  /**
   * A DETACHED clone of the diagram in the message. Cloning the live node keeps
   * the viewer out of the business of re-parsing generated markup, and leaves
   * the copy in the conversation untouched by the viewer's zoom.
   */
  readonly svg: SVGSVGElement;
  /** Rendered CSS size of the original, measured when the viewer was opened. */
  readonly naturalWidth: number;
  readonly naturalHeight: number;
};

const clampZoom = (zoom: number): number =>
  Math.min(MERMAID_DIAGRAM_MAX_ZOOM, Math.max(MERMAID_DIAGRAM_MIN_ZOOM, zoom));

/** Falls back to the window while the scroll surface is still unmeasured. */
const measureViewport = (surface: HTMLElement | null) => ({
  containerWidth: surface && surface.clientWidth > 0 ? surface.clientWidth : window.innerWidth,
  containerHeight: surface && surface.clientHeight > 0 ? surface.clientHeight : window.innerHeight,
});

/**
 * Opening zoom for a diagram of `natural*` size inside a `container*` viewport.
 *
 * Scaling to fit is wrong on a phone: the sequence diagrams agents emit are
 * several times wider than the screen, and fitting one turns readable labels
 * into a grey texture — which is what makes the current overlay useless even
 * before its close button is unreachable. So a diagram wider or taller than the
 * viewport opens at its natural size and is panned, and only a diagram that
 * already fits is scaled up to use the space.
 */
export function computeInitialDiagramZoom({
  containerWidth,
  containerHeight,
  naturalWidth,
  naturalHeight,
}: {
  containerWidth: number;
  containerHeight: number;
  naturalWidth: number;
  naturalHeight: number;
}): number {
  if (
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    !Number.isFinite(containerWidth / naturalWidth) ||
    !Number.isFinite(containerHeight / naturalHeight)
  ) {
    return 1;
  }

  const fit = Math.min(containerWidth / naturalWidth, containerHeight / naturalHeight);
  if (fit <= 1) {
    return 1;
  }
  return Math.min(fit, MERMAID_DIAGRAM_MAX_INITIAL_ZOOM);
}

export function MermaidDiagramViewer({
  selection,
  onClose,
}: {
  readonly selection: MermaidDiagramSelection | null;
  readonly onClose: () => void;
}) {
  if (!selection || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <OpenMermaidDiagramViewer selection={selection} onClose={onClose} />,
    document.body
  );
}

function OpenMermaidDiagramViewer({
  selection,
  onClose,
}: {
  readonly selection: MermaidDiagramSelection;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [zoom, setZoom] = useState<number | null>(null);

  // The diagram is a live node, not markup: hand it to the DOM directly rather
  // than re-serializing it through `dangerouslySetInnerHTML`.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }
    host.replaceChildren(selection.svg);
    return () => {
      host.replaceChildren();
    };
  }, [selection]);

  // Measured after layout so the opening zoom sees the real viewport rather
  // than the pre-paint zeros.
  useLayoutEffect(() => {
    setZoom(
      computeInitialDiagramZoom({
        ...measureViewport(scrollRef.current),
        naturalWidth: selection.naturalWidth,
        naturalHeight: selection.naturalHeight,
      })
    );
  }, [selection]);

  useLayoutEffect(() => {
    if (zoom === null) {
      return;
    }
    const svg = selection.svg;
    svg.style.display = 'block';
    svg.style.maxWidth = 'none';
    svg.style.maxHeight = 'none';
    if (selection.naturalWidth > 0 && selection.naturalHeight > 0) {
      svg.style.width = `${selection.naturalWidth * zoom}px`;
      svg.style.height = `${selection.naturalHeight * zoom}px`;
    }
  }, [selection, zoom]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      // Capture phase and immediate stop: the viewer is the topmost layer, so
      // Escape must dismiss it alone. A dialog the diagram was opened from
      // listens on `document` too, and would otherwise close underneath it.
      event.stopImmediatePropagation();
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onClose]);

  // The conversation behind must not scroll under the viewer; a phone otherwise
  // scrolls the page when a pan reaches the end of the diagram.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Anywhere off the diagram closes. Checking containment (rather than
  // `event.target === event.currentTarget`) keeps the padding around the
  // diagram live, which on a wide phone is most of the screen.
  const handleSurfaceClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (target instanceof Node && hostRef.current?.contains(target)) {
        return;
      }
      onClose();
    },
    [onClose]
  );

  const zoomBy = useCallback((factor: number) => {
    setZoom((current) => clampZoom((current ?? 1) * factor));
  }, []);

  const resetZoom = useCallback(() => {
    setZoom(
      computeInitialDiagramZoom({
        ...measureViewport(scrollRef.current),
        naturalWidth: selection.naturalWidth,
        naturalHeight: selection.naturalHeight,
      })
    );
  }, [selection]);

  const zoomLabel = zoom === null ? '' : `${Math.round(zoom * 100)}%`;
  const zoomInLabel = t('sessions.diagramViewer.zoomIn', 'Zoom in');
  const zoomOutLabel = t('sessions.diagramViewer.zoomOut', 'Zoom out');
  const resetZoomLabel = t('sessions.diagramViewer.resetZoom', 'Reset zoom');
  const closeLabel = t('sessions.diagramViewer.close', 'Close diagram');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('sessions.diagramViewer.title', 'Diagram')}
      data-testid="mermaid-diagram-viewer"
      className="fixed inset-0 flex flex-col bg-background/95 backdrop-blur-xs"
      // The app's own scale, not a bare `z-50`: a diagram opened from a message
      // inside a dialog has to land above that dialog.
      style={{ zIndex: 'var(--z-image-viewer, 95)' }}
    >
      <div
        className="flex shrink-0 items-center justify-end gap-1"
        style={{
          paddingTop: SAFE_AREA_TOP,
          paddingLeft: SAFE_AREA_LEFT,
          paddingRight: SAFE_AREA_RIGHT,
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={CONTROL_CLASS_NAME}
          onClick={() => zoomBy(1 / MERMAID_DIAGRAM_ZOOM_STEP)}
          disabled={zoom !== null && zoom <= MERMAID_DIAGRAM_MIN_ZOOM}
          title={zoomOutLabel}
          aria-label={zoomOutLabel}
        >
          <ZoomOut className="h-5 w-5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(CONTROL_CLASS_NAME, 'w-auto min-w-11 px-2 font-mono text-xs tabular-nums')}
          onClick={resetZoom}
          title={resetZoomLabel}
          aria-label={resetZoomLabel}
        >
          {zoomLabel || <Maximize className="h-5 w-5" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={CONTROL_CLASS_NAME}
          onClick={() => zoomBy(MERMAID_DIAGRAM_ZOOM_STEP)}
          disabled={zoom !== null && zoom >= MERMAID_DIAGRAM_MAX_ZOOM}
          title={zoomInLabel}
          aria-label={zoomInLabel}
        >
          <ZoomIn className="h-5 w-5" />
        </Button>
        <Button
          ref={closeRef}
          type="button"
          variant="ghost"
          size="icon"
          data-testid="mermaid-diagram-viewer-close"
          className={CONTROL_CLASS_NAME}
          onClick={onClose}
          title={closeLabel}
          aria-label={closeLabel}
        >
          <X className="h-5 w-5" />
        </Button>
      </div>
      <div
        ref={scrollRef}
        data-testid="mermaid-diagram-viewer-surface"
        className="scrollbar-pro min-h-0 flex-1 overflow-auto overscroll-contain"
        style={{
          paddingBottom: SAFE_AREA_BOTTOM,
          paddingLeft: SAFE_AREA_LEFT,
          paddingRight: SAFE_AREA_RIGHT,
        }}
        onClick={handleSurfaceClick}
      >
        <div className="flex min-h-full min-w-full items-center justify-center p-4">
          <div ref={hostRef} className="shrink-0" />
        </div>
      </div>
    </div>
  );
}

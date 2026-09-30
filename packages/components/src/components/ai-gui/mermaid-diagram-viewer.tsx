import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Maximize, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { cn } from '@/lib/utils';

/**
 * The full-screen viewer for a rendered Mermaid diagram.
 *
 * It replaced an earlier bundled overlay whose only exit sat at a raw
 * `top-4 right-4`, which on a phone lands inside the status-bar inset, and
 * whose content layer covered the whole backdrop while swallowing clicks — so
 * on touch there was no reachable way out at all. Three rules keep that from
 * recurring here:
 *
 * 1. Controls sit in a bar padded by the `--safe-area-*` variables (the same
 *    ones `tailwind/index.css` maps to `env(safe-area-inset-*)`), never at a
 *    fixed offset from the viewport edge.
 * 2. There is always more than one exit: the close button, a click anywhere
 *    off the diagram, and Escape.
 * 3. The stacking order comes from the app's z-index scale, so the viewer
 *    lands above dialogs and popovers rather than under them.
 *
 * The viewer is also the only place a diagram behaves like a canvas. A diagram
 * sitting in a message never takes the wheel (see `markdown-renderer.tsx`);
 * here, where the user asked for the diagram and nothing else is on screen, a
 * trackpad pinch zooms around the pointer, a held button drags the diagram, and
 * touch owns one-finger panning plus two-finger pinch. Plain wheel scrolling
 * still belongs to the surface, so the browser keeps its normal scroll physics.
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
 * A trackpad pinch reaches the page as a ctrl-modified wheel event carrying a
 * few pixels per frame, while one notch of a mouse wheel carries around a
 * hundred. Bounding the delta keeps a single step of either device to a
 * comparable jump instead of throwing the diagram to a zoom limit.
 */
const MERMAID_DIAGRAM_PINCH_MAX_DELTA = 25;
const MERMAID_DIAGRAM_PINCH_SENSITIVITY = 0.01;

/** A drag this short is a click that wobbled, not a pan. */
const MERMAID_DIAGRAM_PAN_SLOP_PX = 3;

/** A touch move this short is noise, not a pinch or a pan. */
const MERMAID_DIAGRAM_TOUCH_SLOP_PX = 2;

type MermaidDiagramTouchPoint = {
  readonly clientX: number;
  readonly clientY: number;
  readonly onDiagram: boolean;
};

type MermaidDiagramTouchGesture = {
  readonly centerX: number;
  readonly centerY: number;
  readonly distance: number;
};

function measureTouchGesture(
  points: ReadonlyMap<number, MermaidDiagramTouchPoint>
): MermaidDiagramTouchGesture | null {
  const [first, second] = [...points.values()];
  if (!first || !second) {
    return null;
  }
  return {
    centerX: (first.clientX + second.clientX) / 2,
    centerY: (first.clientY + second.clientY) / 2,
    distance: Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
  };
}

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

const clampRatio = (ratio: number): number => Math.min(1, Math.max(0, ratio));

/**
 * The zoom multiplier for one pinch (or ctrl-wheel) step. Exponential rather
 * than additive so the gesture feels the same at every zoom level and so
 * pinching apart exactly undoes pinching together by the same amount.
 */
export function computePinchZoomFactor(deltaY: number): number {
  const bounded = Math.max(
    -MERMAID_DIAGRAM_PINCH_MAX_DELTA,
    Math.min(MERMAID_DIAGRAM_PINCH_MAX_DELTA, deltaY)
  );
  return Math.exp(-bounded * MERMAID_DIAGRAM_PINCH_SENSITIVITY);
}

/**
 * The point of the diagram the pointer sat over when a zoom started, kept as a
 * fraction of the diagram's box plus the viewport coordinate it has to return
 * to once the new size is laid out.
 */
export type MermaidDiagramZoomAnchor = {
  readonly clientX: number;
  readonly clientY: number;
  readonly ratioX: number;
  readonly ratioY: number;
};

/**
 * How far the scroll surface has to move for the anchored point of the resized
 * diagram to sit back under the pointer. Measured from the diagram's own box
 * rather than from scroll offsets, because the surface centres a diagram that
 * fits and that offset is not proportional to the zoom.
 */
export function computeAnchoredScrollCorrection({
  anchor,
  diagramLeft,
  diagramTop,
  diagramWidth,
  diagramHeight,
}: {
  anchor: MermaidDiagramZoomAnchor;
  diagramLeft: number;
  diagramTop: number;
  diagramWidth: number;
  diagramHeight: number;
}): { left: number; top: number } {
  return {
    left: diagramLeft + anchor.ratioX * diagramWidth - anchor.clientX,
    top: diagramTop + anchor.ratioY * diagramHeight - anchor.clientY,
  };
}

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
  // Set by a pinch and consumed by the layout effect that applies the new size,
  // which is the first moment the resized diagram can be measured.
  const zoomAnchorRef = useRef<MermaidDiagramZoomAnchor | null>(null);
  const panRef = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    lastX: number;
    lastY: number;
  } | null>(null);
  const touchPointsRef = useRef(new Map<number, MermaidDiagramTouchPoint>());
  const touchPanRef = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    lastX: number;
    lastY: number;
  } | null>(null);
  const touchPinchRef = useRef<MermaidDiagramTouchGesture | null>(null);
  // A pan that ends off the diagram would otherwise read as a click on the
  // backdrop, which closes the viewer.
  const pannedRef = useRef(false);
  // Pointer capture retargets the following `click` to the capturing element,
  // so a press on the diagram arrives at the surface with the surface as its
  // target. Where the press STARTED is the only reliable question to ask.
  const pressedOnDiagramRef = useRef(false);

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

    // A pinch has to keep the point it started on under the fingers, so the
    // surface is scrolled by whatever the resize moved that point. Reading the
    // box here flushes the layout the assignments above just invalidated.
    const anchor = zoomAnchorRef.current;
    zoomAnchorRef.current = null;
    const surface = scrollRef.current;
    const host = hostRef.current;
    if (!anchor || !surface || !host) {
      return;
    }
    const rect = host.getBoundingClientRect();
    const correction = computeAnchoredScrollCorrection({
      anchor,
      diagramLeft: rect.left,
      diagramTop: rect.top,
      diagramWidth: rect.width,
      diagramHeight: rect.height,
    });
    surface.scrollLeft += correction.left;
    surface.scrollTop += correction.top;
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
      const panned = pannedRef.current;
      const pressedOnDiagram = pressedOnDiagramRef.current;
      pannedRef.current = false;
      pressedOnDiagramRef.current = false;
      // A press that began on the diagram is never a click on the backdrop,
      // however the click was retargeted and however far it travelled.
      if (pressedOnDiagram) {
        return;
      }
      const target = event.target;
      if (target instanceof Node && hostRef.current?.contains(target)) {
        return;
      }
      if (panned) {
        return;
      }
      onClose();
    },
    [onClose]
  );

  const zoomAtPoint = useCallback((clientX: number, clientY: number, factor: number) => {
    const host = hostRef.current;
    const rect = host?.getBoundingClientRect();
    zoomAnchorRef.current =
      rect && rect.width > 0 && rect.height > 0
        ? {
            clientX,
            clientY,
            ratioX: clampRatio((clientX - rect.left) / rect.width),
            ratioY: clampRatio((clientY - rect.top) / rect.height),
          }
        : null;
    setZoom((current) => clampZoom((current ?? 1) * factor));
  }, []);

  // A trackpad pinch arrives as a ctrl-modified wheel event, and Chromium zooms
  // the whole window with it unless the default is taken. An unmodified wheel is
  // left alone: it is the surface's own scrolling, which is how the diagram pans.
  useEffect(() => {
    const surface = scrollRef.current;
    if (!surface) {
      return undefined;
    }
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      zoomAtPoint(event.clientX, event.clientY, computePinchZoomFactor(event.deltaY));
    };
    surface.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      surface.removeEventListener('wheel', handleWheel);
    };
  }, [zoomAtPoint]);

  // A mouse/pen drag and a touch gesture share the same scroll surface, but a
  // touch needs two live points before the browser can tell a pan from a pinch.
  // The surface opts into `touch-action: none` below, so these handlers own the
  // touch movement and keep the diagram under the fingers instead of letting a
  // browser page zoom or a parent drawer consume it.
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const surface = scrollRef.current;
    const target = event.target;
    const onDiagram = target instanceof Node && Boolean(hostRef.current?.contains(target));

    if (event.pointerType === 'touch') {
      if (touchPointsRef.current.size === 0) {
        // Whatever the last gesture left behind, this one starts as a click.
        pannedRef.current = false;
        pressedOnDiagramRef.current = onDiagram;
      } else {
        // A second finger may land on a child node with a different target;
        // the gesture still belongs to the diagram if either finger began on it.
        pressedOnDiagramRef.current ||= onDiagram;
      }
      touchPointsRef.current.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
        onDiagram,
      });
      surface?.setPointerCapture?.(event.pointerId);

      const gesture = measureTouchGesture(touchPointsRef.current);
      if (gesture) {
        touchPanRef.current = null;
        touchPinchRef.current = gesture;
      } else if (onDiagram) {
        touchPanRef.current = {
          pointerId: event.pointerId,
          originX: event.clientX,
          originY: event.clientY,
          lastX: event.clientX,
          lastY: event.clientY,
        };
      }
      return;
    }

    // A mouse or pen press starts a fresh gesture and cannot inherit a stale
    // touch pointer if a platform drops its final pointerup during a handoff.
    touchPointsRef.current.clear();
    touchPanRef.current = null;
    touchPinchRef.current = null;
    pannedRef.current = false;
    pressedOnDiagramRef.current = onDiagram;
    panRef.current = null;
    if (!surface || event.button !== 0 || !onDiagram) {
      return;
    }
    // Otherwise the drag paints a text selection across the diagram's labels.
    event.preventDefault();
    panRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
    };
    surface.setPointerCapture?.(event.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const surface = scrollRef.current;
      if (event.pointerType === 'touch') {
        const point = touchPointsRef.current.get(event.pointerId);
        if (!point || !surface) {
          return;
        }
        touchPointsRef.current.set(event.pointerId, {
          ...point,
          clientX: event.clientX,
          clientY: event.clientY,
        });

        const pinch = touchPinchRef.current;
        const gesture = measureTouchGesture(touchPointsRef.current);
        if (pinch && gesture) {
          const centerDeltaX = gesture.centerX - pinch.centerX;
          const centerDeltaY = gesture.centerY - pinch.centerY;
          const distanceChanged = Math.abs(gesture.distance - pinch.distance);
          if (
            Math.abs(centerDeltaX) >= MERMAID_DIAGRAM_TOUCH_SLOP_PX ||
            Math.abs(centerDeltaY) >= MERMAID_DIAGRAM_TOUCH_SLOP_PX ||
            distanceChanged >= MERMAID_DIAGRAM_TOUCH_SLOP_PX
          ) {
            pannedRef.current = true;
          }
          if (Math.abs(centerDeltaX) >= MERMAID_DIAGRAM_TOUCH_SLOP_PX) {
            surface.scrollLeft -= centerDeltaX;
          }
          if (Math.abs(centerDeltaY) >= MERMAID_DIAGRAM_TOUCH_SLOP_PX) {
            surface.scrollTop -= centerDeltaY;
          }
          if (pinch.distance > 0 && gesture.distance > 0 && distanceChanged >= 0.5) {
            zoomAtPoint(gesture.centerX, gesture.centerY, gesture.distance / pinch.distance);
          }
          touchPinchRef.current = gesture;
          event.preventDefault();
          return;
        }

        const pan = touchPanRef.current;
        if (!pan || pan.pointerId !== event.pointerId || !point.onDiagram) {
          return;
        }
        const deltaX = event.clientX - pan.lastX;
        const deltaY = event.clientY - pan.lastY;
        if (
          Math.abs(event.clientX - pan.originX) >= MERMAID_DIAGRAM_PAN_SLOP_PX ||
          Math.abs(event.clientY - pan.originY) >= MERMAID_DIAGRAM_PAN_SLOP_PX
        ) {
          pannedRef.current = true;
        }
        surface.scrollLeft -= deltaX;
        surface.scrollTop -= deltaY;
        pan.lastX = event.clientX;
        pan.lastY = event.clientY;
        event.preventDefault();
        return;
      }

      const pan = panRef.current;
      if (!pan || !surface || pan.pointerId !== event.pointerId) {
        return;
      }
      // Measured from where the drag started, so a slow pan of many small moves
      // still counts as one.
      if (
        Math.abs(event.clientX - pan.originX) >= MERMAID_DIAGRAM_PAN_SLOP_PX ||
        Math.abs(event.clientY - pan.originY) >= MERMAID_DIAGRAM_PAN_SLOP_PX
      ) {
        pannedRef.current = true;
      }
      surface.scrollLeft -= event.clientX - pan.lastX;
      surface.scrollTop -= event.clientY - pan.lastY;
      pan.lastX = event.clientX;
      pan.lastY = event.clientY;
    },
    [zoomAtPoint]
  );

  const handlePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const surface = scrollRef.current;
    if (event.pointerType === 'touch') {
      touchPointsRef.current.delete(event.pointerId);
      surface?.releasePointerCapture?.(event.pointerId);
      if (touchPointsRef.current.size === 0) {
        touchPanRef.current = null;
        touchPinchRef.current = null;
      } else {
        const remainingEntry = [...touchPointsRef.current.entries()][0];
        const remainingId = remainingEntry?.[0];
        const remaining = remainingEntry?.[1];
        touchPinchRef.current = null;
        touchPanRef.current =
          remainingId !== undefined && remaining?.onDiagram
            ? {
                pointerId: remainingId,
                originX: remaining.clientX,
                originY: remaining.clientY,
                lastX: remaining.clientX,
                lastY: remaining.clientY,
              }
            : null;
      }
      return;
    }

    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) {
      return;
    }
    panRef.current = null;
    surface?.releasePointerCapture?.(event.pointerId);
  }, []);

  const zoomBy = useCallback((factor: number) => {
    zoomAnchorRef.current = null;
    setZoom((current) => clampZoom((current ?? 1) * factor));
  }, []);

  const resetZoom = useCallback(() => {
    zoomAnchorRef.current = null;
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
          icon
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
          icon
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
          icon
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
          icon
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
          // The viewer owns touch panning and pinch zoom. Without this, the
          // browser turns the second finger into page zoom before pointer
          // events can keep the diagram anchored.
          touchAction: 'none',
        }}
        onClick={handleSurfaceClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <div
          className="grid min-h-full min-w-full box-border p-4"
          // `safe center` keeps a diagram centred while it fits and falls back
          // to the start edge as soon as it overflows, so both ends remain
          // reachable through the scroll surface.
          style={{ placeItems: 'safe center' }}
        >
          <div ref={hostRef} className="shrink-0 cursor-grab active:cursor-grabbing" />
        </div>
      </div>
    </div>
  );
}

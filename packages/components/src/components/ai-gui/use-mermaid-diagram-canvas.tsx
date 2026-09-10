import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MermaidDiagramSelection } from './mermaid-diagram-viewer';
import {
  applyCanvasTransform,
  computeCanvasPinchFactor,
  measureCanvasView,
  panCanvasTransform,
  zoomCanvasTransform,
  MERMAID_CANVAS_IDENTITY,
  MERMAID_CANVAS_KEY_PAN_STEP_PX,
  MERMAID_CANVAS_KEY_ZOOM_STEP,
  type MermaidCanvasTransform,
} from './mermaid-inline-canvas';

/**
 * Diagram interaction for `markdown-renderer.tsx`.
 *
 * Streamdown owns the diagram markup, so everything here is applied to nodes it
 * rendered: the click target and its `role`/`tabindex` by observer, the canvas
 * transform on the `<svg>`, and the full-screen button by portal into the
 * block's own action bar.
 *
 * A diagram in a message is a still preview. Clicking one with a pointer that
 * can pinch ACTIVATES it: that one diagram becomes a canvas until Escape, a
 * click elsewhere, or the full-screen viewer takes over. Touch never activates —
 * inline pinch would mean taking `touch-action` from the browser and
 * reimplementing inertial panning — so a tap opens the viewer instead, where the
 * control bar's buttons zoom.
 */

/** Streamdown's wrapper around one rendered diagram, inside a `mermaid-block`. */
export const MERMAID_DIAGRAM_SELECTOR = '[data-streamdown="mermaid"]';
const MERMAID_BLOCK_SELECTOR = '[data-streamdown="mermaid-block"]';
const MERMAID_BLOCK_ACTIONS_SELECTOR = '[data-streamdown="mermaid-block-actions"]';

/** Marks the activated diagram for tests and for anything styling it. */
const CANVAS_STATE_ATTRIBUTE = 'data-lody-canvas';

/**
 * The ring is the only sign that a click did anything, so it is written inline
 * with `important` rather than through a stylesheet: the diagram is Streamdown's
 * element, sitting under utilities in a cascade layer, and an ordinary rule of
 * ours does not reliably outrank what is already on it. The element carries no
 * React-managed `style`, so nothing overwrites these.
 */
const CANVAS_ACTIVE_STYLE = [
  ['outline', '2px solid hsl(var(--ring))'],
  ['outline-offset', '2px'],
  ['border-radius', 'var(--radius-md)'],
] as const;
const BLOCK_ID_ATTRIBUTE = 'data-lody-diagram-id';

/** A drag this short is a click that wobbled, not a pan. */
const CANVAS_PAN_SLOP_PX = 3;

export type MermaidDiagramBlock = {
  readonly id: string;
  readonly diagram: HTMLElement;
  readonly actions: HTMLElement;
};

type ActiveCanvas = {
  readonly diagram: HTMLElement;
  readonly svg: SVGSVGElement;
  transform: MermaidCanvasTransform;
};

let nextBlockId = 0;

const sameBlocks = (
  a: readonly MermaidDiagramBlock[],
  b: readonly MermaidDiagramBlock[]
): boolean =>
  a.length === b.length &&
  a.every(
    (block, index) =>
      block.diagram === b[index]?.diagram &&
      block.actions === b[index]?.actions &&
      block.id === b[index]?.id
  );

export function useMermaidDiagramCanvas({
  containerRef,
  enabled,
  canvasLabel,
}: {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  /** False for markdown with no fenced diagram: no observer, no listeners. */
  readonly enabled: boolean;
  readonly canvasLabel: string;
}) {
  const [blocks, setBlocks] = useState<readonly MermaidDiagramBlock[]>([]);
  const [activeDiagram, setActiveDiagram] = useState<HTMLElement | null>(null);
  const [selection, setSelection] = useState<MermaidDiagramSelection | null>(null);
  // Written before the state commit so the listeners below, which are not
  // re-registered per activation, always read the current canvas.
  const canvasRef = useRef<ActiveCanvas | null>(null);
  const panRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  const pannedRef = useRef(false);
  // A `click` does not say which device produced it in every engine, so the
  // pointer that started it is remembered instead.
  const pointerTypeRef = useRef<string>('mouse');

  const deactivate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    applyCanvasTransform(canvas.svg, MERMAID_CANVAS_IDENTITY);
    for (const [property] of CANVAS_ACTIVE_STYLE) {
      canvas.diagram.style.removeProperty(property);
    }
    canvas.diagram.removeAttribute(CANVAS_STATE_ATTRIBUTE);
    canvasRef.current = null;
    panRef.current = null;
    setActiveDiagram(null);
  }, []);

  const activate = useCallback(
    (diagram: HTMLElement) => {
      if (canvasRef.current?.diagram === diagram) {
        return;
      }
      const svg = diagram.querySelector('svg');
      if (!svg) {
        return;
      }
      deactivate();
      diagram.setAttribute(CANVAS_STATE_ATTRIBUTE, 'active');
      for (const [property, value] of CANVAS_ACTIVE_STYLE) {
        diagram.style.setProperty(property, value, 'important');
      }
      canvasRef.current = { diagram, svg, transform: MERMAID_CANVAS_IDENTITY };
      setActiveDiagram(diagram);
    },
    [deactivate]
  );

  const updateTransform = useCallback(
    (next: (canvas: ActiveCanvas) => MermaidCanvasTransform | null) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const transform = next(canvas);
      if (!transform) {
        return;
      }
      canvas.transform = transform;
      applyCanvasTransform(canvas.svg, transform);
    },
    []
  );

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      updateTransform((canvas) => {
        const view = measureCanvasView(canvas.diagram, canvas.svg);
        return view
          ? zoomCanvasTransform(canvas.transform, { clientX, clientY, factor }, view)
          : null;
      });
    },
    [updateTransform]
  );

  const panBy = useCallback(
    (deltaX: number, deltaY: number) => {
      updateTransform((canvas) => {
        const view = measureCanvasView(canvas.diagram, canvas.svg);
        return view ? panCanvasTransform(canvas.transform, { deltaX, deltaY }, view) : null;
      });
    },
    [updateTransform]
  );

  const openDiagram = useCallback(
    (diagram: Element) => {
      const svg = diagram.querySelector('svg');
      if (!svg) {
        return;
      }
      // The rendered size of the copy in the message is the diagram's natural
      // size, so an activated canvas is reset before it is measured.
      deactivate();
      const rect = svg.getBoundingClientRect();
      setSelection({
        svg: svg.cloneNode(true) as SVGSVGElement,
        naturalWidth: rect.width,
        naturalHeight: rect.height,
      });
    },
    [deactivate]
  );

  const closeDiagram = useCallback(() => setSelection(null), []);

  // Streamdown renders a diagram only after its lazily imported runtime
  // resolves — long after this component commits — so the click target, the
  // block ids, and the action-bar hosts are all applied by observer.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) {
      return undefined;
    }

    const marked = new Map<
      HTMLElement,
      { role: string | null; tabIndex: string | null; ariaLabel: string | null }
    >();
    const restoreMarked = () => {
      for (const [diagram, attributes] of marked) {
        for (const [name, value] of [
          ['role', attributes.role],
          ['tabindex', attributes.tabIndex],
          ['aria-label', attributes.ariaLabel],
        ] as const) {
          if (value == null) {
            diagram.removeAttribute(name);
          } else {
            diagram.setAttribute(name, value);
          }
        }
      }
      marked.clear();
    };

    if (!enabled) {
      restoreMarked();
      setBlocks((current) => (current.length === 0 ? current : []));
      return undefined;
    }

    const scan = () => {
      restoreMarked();
      const found: MermaidDiagramBlock[] = [];
      root.querySelectorAll<HTMLElement>(MERMAID_BLOCK_SELECTOR).forEach((block) => {
        const diagram = block.querySelector<HTMLElement>(MERMAID_DIAGRAM_SELECTOR);
        const actions = block.querySelector<HTMLElement>(MERMAID_BLOCK_ACTIONS_SELECTOR);
        if (!diagram) {
          return;
        }
        marked.set(diagram, {
          role: diagram.getAttribute('role'),
          tabIndex: diagram.getAttribute('tabindex'),
          ariaLabel: diagram.getAttribute('aria-label'),
        });
        diagram.setAttribute('role', 'button');
        diagram.setAttribute('tabindex', '0');
        diagram.setAttribute('aria-label', canvasLabel);
        if (!actions) {
          return;
        }
        let id = block.getAttribute(BLOCK_ID_ATTRIBUTE);
        if (!id) {
          nextBlockId += 1;
          id = `mermaid-block-${nextBlockId}`;
          block.setAttribute(BLOCK_ID_ATTRIBUTE, id);
        }
        found.push({ id, diagram, actions });
      });
      // The portalled button below is itself a child-list mutation, so an
      // unconditional update would re-enter this observer forever.
      setBlocks((current) => (sameBlocks(current, found) ? current : found));
      if (canvasRef.current && !root.contains(canvasRef.current.diagram)) {
        deactivate();
      }
    };

    scan();
    const observer = new MutationObserver(scan);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      restoreMarked();
    };
  }, [canvasLabel, containerRef, deactivate, enabled]);

  // Streamdown's pan/zoom canvas listens for `wheel` non-passively and calls
  // `preventDefault()` on every one of them, so a page scroll that merely passes
  // under a diagram is swallowed and becomes a zoom instead. Turning
  // `controls.mermaid.panZoom` off only hides that canvas's buttons — the
  // listener stays, and it sits on Streamdown's own element, so the gesture has
  // to be taken from it in the capture phase above.
  //
  // Only a pinch over the ACTIVE diagram is consumed here. Everything else is
  // handed back: the interceptor never calls `preventDefault()`, because the
  // browser's own scrolling is the behaviour being restored. `stopPropagation()`
  // alone would also hide the gesture from the conversation's wheel listeners
  // further up (releasing stick-to-bottom, abandoning an outline jump), so an
  // uncancelable copy is re-dispatched from the markdown root, whose path
  // excludes the canvas.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !enabled) {
      return undefined;
    }

    const handleWheel = (event: WheelEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const diagram = target.closest(MERMAID_DIAGRAM_SELECTOR);
      if (!diagram) {
        return;
      }
      event.stopPropagation();

      if (canvasRef.current?.diagram === diagram && (event.ctrlKey || event.metaKey)) {
        // A trackpad pinch, which Chromium would otherwise spend on zooming the
        // whole window.
        event.preventDefault();
        zoomAt(event.clientX, event.clientY, computeCanvasPinchFactor(event.deltaY));
        return;
      }

      root.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: false,
          composed: true,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaZ: event.deltaZ,
          deltaMode: event.deltaMode,
          clientX: event.clientX,
          clientY: event.clientY,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        })
      );
    };

    root.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    return () => {
      root.removeEventListener('wheel', handleWheel, { capture: true });
    };
  }, [containerRef, enabled, zoomAt]);

  // Which device is asking decides what a click means, so the pointer is
  // recorded before the click arrives. Capture phase: Streamdown's canvas calls
  // `setPointerCapture` on its own element for a drag it can no longer perform.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !enabled) {
      return undefined;
    }
    const rememberPointer = (event: PointerEvent) => {
      pointerTypeRef.current = event.pointerType || 'mouse';
    };
    root.addEventListener('pointerdown', rememberPointer, { capture: true, passive: true });
    return () => {
      root.removeEventListener('pointerdown', rememberPointer, { capture: true });
    };
  }, [containerRef, enabled]);

  // Dragging an activated diagram pans it. Bound to the diagram itself rather
  // than the container, so an inactive one keeps every gesture it had.
  useEffect(() => {
    const diagram = activeDiagram;
    if (!diagram) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      pannedRef.current = false;
      if (event.pointerType === 'touch' || event.button !== 0) {
        return;
      }
      // Otherwise the drag paints a text selection across the diagram's labels.
      event.preventDefault();
      panRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
      diagram.setPointerCapture?.(event.pointerId);
    };

    const handlePointerMove = (event: PointerEvent) => {
      const pan = panRef.current;
      if (!pan || pan.pointerId !== event.pointerId) {
        return;
      }
      const deltaX = event.clientX - pan.lastX;
      const deltaY = event.clientY - pan.lastY;
      if (Math.abs(deltaX) >= CANVAS_PAN_SLOP_PX || Math.abs(deltaY) >= CANVAS_PAN_SLOP_PX) {
        pannedRef.current = true;
      }
      pan.lastX = event.clientX;
      pan.lastY = event.clientY;
      panBy(deltaX, deltaY);
    };

    const handlePointerEnd = (event: PointerEvent) => {
      const pan = panRef.current;
      if (!pan || pan.pointerId !== event.pointerId) {
        return;
      }
      panRef.current = null;
      diagram.releasePointerCapture?.(event.pointerId);
    };

    diagram.addEventListener('pointerdown', handlePointerDown);
    diagram.addEventListener('pointermove', handlePointerMove);
    diagram.addEventListener('pointerup', handlePointerEnd);
    diagram.addEventListener('pointercancel', handlePointerEnd);
    return () => {
      diagram.removeEventListener('pointerdown', handlePointerDown);
      diagram.removeEventListener('pointermove', handlePointerMove);
      diagram.removeEventListener('pointerup', handlePointerEnd);
      diagram.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [activeDiagram, panBy]);

  // A canvas the reader has moved on from stops being one: any press outside it
  // releases it, and so does Escape. Both listen on the document, because the
  // next click is rarely inside this message.
  useEffect(() => {
    if (!activeDiagram) {
      return undefined;
    }

    const handlePointerDown = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && activeDiagram.contains(target)) {
        return;
      }
      deactivate();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        deactivate();
        activeDiagram.focus?.();
        return;
      }
      // Pinch and drag have no keyboard equivalent, so the activated canvas
      // carries its own. Only while it is activated, so ordinary scrolling and
      // typing keep every key.
      if (document.activeElement !== activeDiagram) {
        return;
      }
      const frame = activeDiagram.getBoundingClientRect();
      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          event.preventDefault();
          const step = MERMAID_CANVAS_KEY_PAN_STEP_PX;
          panBy(
            event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0,
            event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0
          );
          return;
        }
        case '+':
        case '=':
        case '-':
        case '_': {
          event.preventDefault();
          const zoomIn = event.key === '+' || event.key === '=';
          zoomAt(
            frame.left + frame.width / 2,
            frame.top + frame.height / 2,
            zoomIn ? MERMAID_CANVAS_KEY_ZOOM_STEP : 1 / MERMAID_CANVAS_KEY_ZOOM_STEP
          );
          return;
        }
        default:
          return;
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeDiagram, deactivate, panBy, zoomAt]);

  useEffect(() => deactivate, [deactivate]);

  const handleContainerClick = useCallback(
    (event: { target: EventTarget | null }) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      const diagram = event.target.closest<HTMLElement>(MERMAID_DIAGRAM_SELECTOR);
      if (!diagram) {
        deactivate();
        return;
      }
      // Releasing a text selection over a diagram label is not a request to
      // activate it, and neither is letting go of a pan.
      if (window.getSelection()?.toString() || pannedRef.current) {
        pannedRef.current = false;
        return;
      }
      if (pointerTypeRef.current === 'touch') {
        openDiagram(diagram);
        return;
      }
      activate(diagram);
    },
    [activate, deactivate, openDiagram]
  );

  const handleContainerKeyDown = useCallback(
    (event: { key: string; target: EventTarget | null; preventDefault: () => void }) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      if (!(event.target instanceof Element)) {
        return;
      }
      const diagram = event.target.closest<HTMLElement>(MERMAID_DIAGRAM_SELECTOR);
      if (!diagram) {
        return;
      }
      event.preventDefault();
      if (canvasRef.current?.diagram === diagram) {
        deactivate();
        return;
      }
      activate(diagram);
    },
    [activate, deactivate]
  );

  return {
    blocks,
    activeDiagram,
    selection,
    closeDiagram,
    openDiagram,
    handleContainerClick,
    handleContainerKeyDown,
  };
}

/**
 * Sits in Streamdown's own action bar beside copy and download, which is
 * always visible rather than revealed on hover. It replaces the bundled
 * full-screen control, whose overlay a touch user cannot leave.
 */
export function MermaidFullscreenButton({
  label,
  onOpen,
}: {
  readonly label: string;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="mermaid-fullscreen-button"
      className={cn(
        'cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground'
      )}
      title={label}
      aria-label={label}
      onClick={onOpen}
    >
      <Maximize2 size={14} />
    </button>
  );
}

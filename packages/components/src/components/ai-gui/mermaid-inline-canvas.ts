/**
 * The geometry of an activated Mermaid diagram in a message.
 *
 * A diagram is a still preview until the reader clicks it. Activation turns
 * that one diagram into a canvas: a trackpad pinch zooms around the pointer and
 * a drag pans, both by transforming the rendered `<svg>` inside the frame
 * Streamdown already clips. An unmodified wheel is never taken, so the page
 * scrolls whether or not a diagram happens to be active — the reader cannot get
 * stuck in a canvas they forgot they opened.
 *
 * The transform goes on the `<svg>`, not on Streamdown's own pan/zoom canvas:
 * that canvas stays pinned at `transform: none` (see `markdown-renderer.tsx`),
 * so its handlers cannot fight ours, and Streamdown never writes to the `<svg>`
 * it injected as raw markup.
 */

export type MermaidCanvasTransform = {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
};

export type MermaidCanvasRect = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

/**
 * What the reader can see right now, in viewport coordinates: the frame that
 * clips the diagram, and the diagram as it is currently drawn — transform
 * included. Everything below works from these two rectangles rather than from
 * Streamdown's layout, which centres the diagram in a frame far wider than it
 * and cannot be reconstructed from a transform.
 */
export type MermaidCanvasView = {
  readonly frame: MermaidCanvasRect;
  readonly content: MermaidCanvasRect;
};

export const MERMAID_CANVAS_IDENTITY: MermaidCanvasTransform = { scale: 1, x: 0, y: 0 };

export const MERMAID_CANVAS_MIN_SCALE = 0.25;
export const MERMAID_CANVAS_MAX_SCALE = 4;

/** One press of a zoom key, and one notch of a keyboard-driven pan. */
export const MERMAID_CANVAS_KEY_ZOOM_STEP = 1.25;
export const MERMAID_CANVAS_KEY_PAN_STEP_PX = 48;

/**
 * A trackpad pinch reaches the page as a ctrl-modified wheel carrying a few
 * pixels per frame, while one notch of a mouse wheel carries around a hundred.
 * Bounding the delta keeps one step of either device to a comparable jump.
 */
const MERMAID_CANVAS_PINCH_MAX_DELTA = 25;
const MERMAID_CANVAS_PINCH_SENSITIVITY = 0.01;

/**
 * The zoom multiplier for one pinch step. Exponential so the gesture feels the
 * same at every scale, and so pinching back by the same amount undoes it.
 */
export function computeCanvasPinchFactor(deltaY: number): number {
  const bounded = Math.max(
    -MERMAID_CANVAS_PINCH_MAX_DELTA,
    Math.min(MERMAID_CANVAS_PINCH_MAX_DELTA, deltaY)
  );
  return Math.exp(-bounded * MERMAID_CANVAS_PINCH_SENSITIVITY);
}

const clampScale = (scale: number): number =>
  Math.min(MERMAID_CANVAS_MAX_SCALE, Math.max(MERMAID_CANVAS_MIN_SCALE, scale));

/**
 * Where an axis of the diagram is allowed to end up: an axis smaller than the
 * frame is centred, and a larger one may only travel as far as its own edges,
 * so a reader can never push the diagram out of the message and lose it.
 */
export function clampCanvasAxis(
  start: number,
  size: number,
  frameStart: number,
  frameSize: number
): number {
  if (!(size > 0) || !(frameSize > 0)) {
    return start;
  }
  if (size <= frameSize) {
    return frameStart + (frameSize - size) / 2;
  }
  return Math.min(frameStart, Math.max(frameStart + frameSize - size, start));
}

/**
 * Both gestures move the diagram in viewport space and then express that move
 * as a change to the translation, which is why neither needs to know where the
 * untransformed diagram sits: the layout offset cancels out.
 */
const withVisualPosition = (
  transform: MermaidCanvasTransform,
  view: MermaidCanvasView,
  scale: number,
  left: number,
  top: number,
  width: number,
  height: number
): MermaidCanvasTransform => ({
  scale,
  x:
    transform.x +
    (clampCanvasAxis(left, width, view.frame.left, view.frame.width) - view.content.left),
  y:
    transform.y +
    (clampCanvasAxis(top, height, view.frame.top, view.frame.height) - view.content.top),
});

/** Scales by `factor` while the diagram point under the pointer stays under it. */
export function zoomCanvasTransform(
  transform: MermaidCanvasTransform,
  { clientX, clientY, factor }: { clientX: number; clientY: number; factor: number },
  view: MermaidCanvasView
): MermaidCanvasTransform {
  const scale = clampScale(transform.scale * factor);
  const ratio = scale / transform.scale;
  return withVisualPosition(
    transform,
    view,
    scale,
    clientX - (clientX - view.content.left) * ratio,
    clientY - (clientY - view.content.top) * ratio,
    view.content.width * ratio,
    view.content.height * ratio
  );
}

export function panCanvasTransform(
  transform: MermaidCanvasTransform,
  { deltaX, deltaY }: { deltaX: number; deltaY: number },
  view: MermaidCanvasView
): MermaidCanvasTransform {
  return withVisualPosition(
    transform,
    view,
    transform.scale,
    view.content.left + deltaX,
    view.content.top + deltaY,
    view.content.width,
    view.content.height
  );
}

export const isIdentityCanvasTransform = (transform: MermaidCanvasTransform): boolean =>
  transform.scale === 1 && transform.x === 0 && transform.y === 0;

/** Reads both rectangles as the browser currently draws them. */
export function measureCanvasView(
  frame: HTMLElement,
  svg: SVGSVGElement
): MermaidCanvasView | null {
  const frameRect = frame.getBoundingClientRect();
  const contentRect = svg.getBoundingClientRect();
  if (!(frameRect.width > 0) || !(contentRect.width > 0) || !(contentRect.height > 0)) {
    return null;
  }
  return {
    frame: {
      left: frameRect.left,
      top: frameRect.top,
      width: frameRect.width,
      height: frameRect.height,
    },
    content: {
      left: contentRect.left,
      top: contentRect.top,
      width: contentRect.width,
      height: contentRect.height,
    },
  };
}

export function applyCanvasTransform(svg: SVGSVGElement, transform: MermaidCanvasTransform): void {
  if (isIdentityCanvasTransform(transform)) {
    svg.style.removeProperty('transform');
    svg.style.removeProperty('transform-origin');
    svg.style.removeProperty('will-change');
    return;
  }
  svg.style.transformOrigin = '0 0';
  svg.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
  svg.style.willChange = 'transform';
}

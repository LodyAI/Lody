import { useLayoutEffect, useRef, type ComponentPropsWithoutRef, type CSSProperties } from 'react';

import { cn } from '@/lib/utils';

import {
  seaHeightsOverLoop,
  tileSeaPoint,
  WORKING_GRID_LOOP_MS,
  WORKING_GRID_SWEEP,
} from './working-grid-sea';

/** How tile brightness follows the sea: fully, slightly, or not at all. */
export type WorkingGridBrightness = 'wave' | 'soft' | 'steady';
/** Where a tile scales from, or `none` to keep every tile full size. */
export type WorkingGridScale = 'center' | 'bottom' | 'none';

export type WorkingGridProps = Omit<ComponentPropsWithoutRef<'span'>, 'children'> & {
  /** Edge length of the whole 3×3 grid, px. */
  size?: number;
  /** Tile corner radius as a fraction of the tile edge (0.5 = circle). */
  cornerRadius?: number;
  /**
   * Superellipse exponent n for continuous-curvature tiles (4 ≈ iOS squircle).
   * Overrides `cornerRadius`. Needs CSS `corner-shape` (Chromium 139+); other
   * engines fall back to a circle.
   */
  superellipse?: number;
  brightness?: WorkingGridBrightness;
  scale?: WorkingGridScale;
  /** Largest a tile gets, on a crest, as a fraction of its cell (0–1). */
  maxScale?: number;
  /** Smallest a tile gets, in a trough, as a fraction of its cell (0–1). */
  minScale?: number;
  /** Gap between tiles as a fraction of the tile edge. */
  gap?: number;
  /**
   * Strength of the occasional bands that sweep across all marks (0 = tiles only
   * bob on their own).
   */
  sweep?: number;
  /**
   * Row pitch of the surrounding list, px. Stitches the sea across rows so a
   * crest passes continuously from one row's mark to the next. `null` samples
   * real page distance.
   */
  rowPitch?: number | null;
};

// Opacity in the deepest trough for each brightness mode.
const BRIGHTNESS_FLOOR: Record<WorkingGridBrightness, number> = {
  wave: 0.16,
  soft: 0.5,
  steady: 1,
};
const STEADY_OPACITY = 0.82;
// 10 samples a second: the fastest bob (1.8s) gets 18 per cycle, so linear
// interpolation between keyframes stays visually smooth.
const SAMPLES = WORKING_GRID_LOOP_MS / 100;

const lerp = (from: number, to: number, k: number) => from + (to - from) * k;

/**
 * One tile's loop: its sea height sampled over the whole loop and mapped to
 * scale and opacity. The tile box is already drawn at `maxScale`, so the scale
 * runs from `minScale / maxScale` to 1.
 */
function tileKeyframes(
  heights: number[],
  scale: WorkingGridScale,
  brightness: WorkingGridBrightness,
  minScale: number,
  maxScale: number
): Keyframe[] | null {
  const animateScale = scale !== 'none';
  const animateOpacity = brightness !== 'steady';
  if (!animateScale && !animateOpacity) return null;
  const low = Math.min(Math.max(minScale / maxScale, 0), 1);
  const floor = BRIGHTNESS_FLOOR[brightness];
  return heights.map((height, index) => ({
    offset: index / (heights.length - 1),
    ...(animateScale ? { transform: `scale(${lerp(low, 1, height).toFixed(4)})` } : {}),
    ...(animateOpacity ? { opacity: Number(lerp(floor, 1, height).toFixed(4)) } : {}),
  }));
}

/** Sum of scroll offsets of every scrolling ancestor, so positions are content-relative. */
function scrollOffset(el: Element): [number, number] {
  let x = window.scrollX;
  let y = window.scrollY;
  for (let node = el.parentElement; node; node = node.parentElement) {
    x += node.scrollLeft;
    y += node.scrollTop;
  }
  return [x, y];
}

/**
 * "Working" mark: a 3×3 grid of tiles rising and sinking with one sea shared by
 * the whole page. Each tile bobs on its own, so a single tile looks random; now
 * and then a band sweeps across every mark on the page, so a column of marks
 * reads as one rhythm when seen together.
 *
 * Colour comes from `currentColor`; pass a text colour class.
 *
 * On mount each tile's motion over the sea's loop is baked into one Web
 * Animation touching only `transform` and `opacity`, with its start time pinned
 * to the document timeline's origin. The compositor plays it: no per-frame
 * script, React state or repaint while an agent works, and marks mounted at
 * different moments stay on the same sea. The animated elements are HTML, never
 * SVG, for the compositor reason documented in `spinner.tsx`.
 */
export function WorkingGrid({
  size = 14,
  cornerRadius = 0.3,
  superellipse,
  brightness = 'wave',
  scale = 'center',
  maxScale = 0.8,
  minScale = 0.3,
  gap = 0.35,
  sweep = WORKING_GRID_SWEEP,
  rowPitch = 28,
  className,
  style,
  ...props
}: WorkingGridProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const cell = size / (3 + 2 * gap);
  const pitch = cell * (1 + gap);
  // Tiles are drawn at maxScale inside their cell, centred (or bottom-aligned when
  // scaling from the bottom), so the grid's footprint and spacing stay fixed.
  const tile = cell * Math.min(Math.max(maxScale, 0), 1);
  const inset = (cell - tile) / 2;
  const insetTop = scale === 'bottom' ? cell - tile : inset;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof root.animate !== 'function') return undefined;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;

    const rect = root.getBoundingClientRect();
    const [scrollX, scrollY] = scrollOffset(root);
    const placement = { left: rect.left + scrollX, top: rect.top + scrollY, size, rowPitch };
    const animations: Animation[] = [];
    for (const outer of root.querySelectorAll<HTMLElement>('[data-working-grid-tile]')) {
      const face = outer.firstElementChild;
      if (!(face instanceof HTMLElement)) continue;
      const [x, y] = tileSeaPoint(placement, Number(outer.dataset.col), Number(outer.dataset.row));
      const keyframes = tileKeyframes(
        seaHeightsOverLoop(x, y, sweep, SAMPLES),
        scale,
        brightness,
        minScale,
        maxScale
      );
      if (!keyframes) break;
      const animation = face.animate(keyframes, {
        duration: WORKING_GRID_LOOP_MS,
        iterations: Infinity,
      });
      animation.startTime = 0;
      animations.push(animation);
    }
    return () => animations.forEach((animation) => animation.cancel());
  }, [size, brightness, scale, minScale, maxScale, gap, sweep, rowPitch]);

  const shape: CSSProperties =
    superellipse != null
      ? ({
          borderRadius: '50%',
          cornerShape: `superellipse(${Math.log2(superellipse)})`,
        } as CSSProperties)
      : { borderRadius: `${cornerRadius * 100}%` };
  const origin = scale === 'bottom' ? '50% 100%' : '50% 50%';

  return (
    <span
      ref={rootRef}
      data-working-grid=""
      aria-hidden="true"
      className={cn('relative inline-block shrink-0', className)}
      style={{ width: size, height: size, ...style }}
      {...props}
    >
      {[0, 1, 2].map((row) =>
        [0, 1, 2].map((col) => (
          <span
            key={`${row}-${col}`}
            data-working-grid-tile=""
            data-row={row}
            data-col={col}
            className="absolute block"
            style={{
              left: col * pitch + inset,
              top: row * pitch + insetTop,
              width: tile,
              height: tile,
            }}
          >
            <span
              className="block size-full bg-current"
              style={{
                ...shape,
                transformOrigin: origin,
                opacity: brightness === 'steady' ? STEADY_OPACITY : undefined,
              }}
            />
          </span>
        ))
      )}
    </span>
  );
}

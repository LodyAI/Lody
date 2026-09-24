import { useLayoutEffect, useRef, type ComponentPropsWithoutRef, type CSSProperties } from 'react';

import { cn } from '@/lib/utils';

import {
  crestDelayMs,
  tileSeaPoint,
  wavePhase,
  workingGridWaves,
  type WorkingGridDirection,
} from './working-grid-sea';

export type { WorkingGridDirection } from './working-grid-sea';

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
  /** Smallest tile size in a double trough, as a fraction of the tile (0–1). */
  minScale?: number;
  /** Gap between tiles as a fraction of the tile edge. */
  gap?: number;
  /** Multiplier on both wavelengths; larger reads as broader, slower swells. */
  wavelength?: number;
  direction?: WorkingGridDirection;
  /**
   * Row pitch of the surrounding list, px. Stitches the sea across rows so a
   * crest passes continuously from one row's mark to the next. `null` samples
   * real page distance.
   */
  rowPitch?: number | null;
};

// Lowest opacity in a double trough for each brightness mode.
const BRIGHTNESS_FLOOR: Record<WorkingGridBrightness, number> = {
  wave: 0.16,
  soft: 0.5,
  steady: 1,
};
const STEADY_OPACITY = 0.82;
// easeInOutSine: a half period of a sine between two keyframes.
const SINE = 'cubic-bezier(0.37, 0, 0.63, 1)';

/**
 * Keyframes for one wave layer: crest → trough → crest. Each tile nests two
 * layers, one per wave, whose scales and opacities multiply; the per-layer
 * range is the square root of the whole range so a double trough lands exactly
 * on `minScale` and the brightness floor.
 */
function layerKeyframes(
  scale: WorkingGridScale,
  brightness: WorkingGridBrightness,
  minScale: number
): Keyframe[] | null {
  const animateScale = scale !== 'none';
  const animateOpacity = brightness !== 'steady';
  if (!animateScale && !animateOpacity) return null;
  const low = Math.sqrt(Math.min(Math.max(minScale, 0), 1));
  const dim = Math.sqrt(BRIGHTNESS_FLOOR[brightness]);
  const frame = (atCrest: boolean): Keyframe => ({
    ...(animateScale ? { transform: `scale(${atCrest ? 1 : low})` } : {}),
    ...(animateOpacity ? { opacity: atCrest ? 1 : dim } : {}),
  });
  return [
    { ...frame(true), easing: SINE },
    { ...frame(false), offset: 0.5, easing: SINE },
    frame(true),
  ];
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
 * "Working" mark: a 3×3 grid of tiles rising and sinking with two waves that
 * cross the whole page. Every mounted grid samples the same sea at its own
 * position, so marks in neighbouring rows move as one body of water.
 *
 * Colour comes from `currentColor`; pass a text colour class.
 *
 * Every tile animates only `transform` and `opacity` through the Web Animations
 * API with its start time pinned to the document timeline's origin, so the
 * compositor runs it: no per-frame script, React state or repaint while an agent
 * works. The animated elements are HTML, never SVG, for the compositor reason
 * documented in `spinner.tsx`.
 */
export function WorkingGrid({
  size = 14,
  cornerRadius = 0.2,
  superellipse,
  brightness = 'wave',
  scale = 'center',
  minScale = 0.3,
  gap = 0.35,
  wavelength = 1.5,
  direction = 'across',
  rowPitch = 28,
  className,
  style,
  ...props
}: WorkingGridProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const tile = size / (3 + 2 * gap);
  const pitch = tile * (1 + gap);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof root.animate !== 'function') return undefined;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const keyframes = layerKeyframes(scale, brightness, minScale);
    if (!keyframes) return undefined;

    const rect = root.getBoundingClientRect();
    const [scrollX, scrollY] = scrollOffset(root);
    const placement = { left: rect.left + scrollX, top: rect.top + scrollY, size, rowPitch };
    const waves = workingGridWaves(direction);
    const animations: Animation[] = [];
    for (const outer of root.querySelectorAll<HTMLElement>('[data-working-grid-tile]')) {
      const [x, y] = tileSeaPoint(placement, Number(outer.dataset.col), Number(outer.dataset.row));
      const inner = outer.firstElementChild;
      if (!(inner instanceof HTMLElement)) continue;
      const layers = [outer, inner] as const;
      layers.forEach((layer, index) => {
        const wave = waves[index];
        const animation = layer.animate(keyframes, {
          duration: wave.periodMs,
          iterations: Infinity,
          delay: crestDelayMs(wavePhase(wave, x, y, wavelength), wave.periodMs),
        });
        animation.startTime = 0;
        animations.push(animation);
      });
    }
    return () => animations.forEach((animation) => animation.cancel());
  }, [size, brightness, scale, minScale, gap, wavelength, direction, rowPitch]);

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
              left: col * pitch,
              top: row * pitch,
              width: tile,
              height: tile,
              transformOrigin: origin,
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

import { useLayoutEffect, useRef, type ComponentPropsWithoutRef, type CSSProperties } from 'react';

import { cn } from '@/lib/utils';
import { useResolvedTheme } from '@/theme-provider';

import { trackWorkingGridAnimation } from './working-grid-reading';
import {
  crestDelayMs,
  tileSeaPoint,
  wavePhase,
  WORKING_GRID_RHYTHM,
  workingGridWaves,
  type WorkingGridDirection,
  type WorkingGridWave,
} from './working-grid-sea';

export type { WorkingGridDirection } from './working-grid-sea';
export { setWorkingGridReadingPause } from './working-grid-reading';

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
  scale?: WorkingGridScale;
  /** Largest a tile gets, at a double crest, as a fraction of its cell (0–1). */
  maxScale?: number;
  /**
   * Smallest tile size in a double trough, as a fraction of its cell. At 0 a tile
   * shrinks to nothing at the bottom of a trough; below 0 (down to about -0.4) the
   * part of each trough under zero holds the tile empty for a while.
   */
  minScale?: number;
  /**
   * Opacity range of a tile. A narrow range keeps the mark from flickering in
   * peripheral vision; equal values hold brightness steady.
   */
  minOpacity?: number;
  maxOpacity?: number;
  /**
   * Share of the opacity range carried by the rhythm: one long wave dimming whole
   * marks in turn down the list. The rest textures the tiles inside a mark.
   */
  rhythm?: number;
  /**
   * `1`: one wave of one period and shape. Every tile — and every mark down a
   * list — plays the same motion, each a little behind the one before, so marks
   * differ yet read as delayed copies of each other. `2`: two crossing waves plus
   * the rhythm, which vary more but can shrink every tile of a mark at once.
   */
  waves?: 1 | 2;
  /**
   * With one wave: strength (0–1) of a second, smaller wave in another direction
   * and period, layered on top so the main wave's rhythm gains interference. The
   * combined trough still lands on minScale / minOpacity.
   */
  ripple?: number;
  /** Playback speed; 1 is the original 1.9s/2.7s waves, lower is calmer. */
  speed?: number;
  /** Gap between tiles as a fraction of the tile edge. */
  gap?: number;
  /** Multiplier on both tile wavelengths; larger reads as broader, slower swells. */
  wavelength?: number;
  direction?: WorkingGridDirection;
  /**
   * Row pitch of the surrounding list, px. Stitches the sea across rows so a
   * crest passes continuously from one row's mark to the next. `null` samples
   * real page distance.
   */
  rowPitch?: number | null;
  /**
   * Compensate in light themes (default on). Low opacity fades a tile towards the
   * background, which on a light page means towards white, so dim small tiles
   * vanish; and dark shapes on light ground look smaller than light shapes on
   * dark ground (irradiation). Light themes therefore raise the opacity floor,
   * the size floor, and the tile size a little.
   */
  lightCompensation?: boolean;
};

// Light-theme compensation: how far the opacity and size floors move towards 1,
// and how much larger tiles are drawn.
const LIGHT_OPACITY_LIFT = 0.35;
const LIGHT_SCALE_LIFT = 0.2;
const LIGHT_SIZE_BOOST = 1.08;

// easeInOutSine: a half period of a sine between two keyframes.
const SINE = 'cubic-bezier(0.37, 0, 0.63, 1)';
const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

/**
 * Crest → trough → crest loop: scale from 1 to `scaleLow`, opacity from
 * `opacityHigh` to `opacityLow`. A `null` low leaves that property alone.
 */
function loopKeyframes(
  scaleLow: number | null,
  opacityLow: number | null,
  opacityHigh = 1
): Keyframe[] | null {
  if (scaleLow == null && opacityLow == null) return null;
  const frame = (atCrest: boolean): Keyframe => ({
    ...(scaleLow != null ? { transform: `scale(${atCrest ? 1 : scaleLow})` } : {}),
    ...(opacityLow != null ? { opacity: atCrest ? opacityHigh : opacityLow } : {}),
  });
  return [
    { ...frame(true), easing: SINE },
    { ...frame(false), offset: 0.5, easing: SINE },
    frame(true),
  ];
}

// Samples per loop when a tile can vanish: clamping at zero is not a sine, so the
// curve is baked as keyframes with linear interpolation between them.
const VANISH_SAMPLES = 24;
// While tiles can vanish, the outer layer's trough scale: enough swell to keep
// texture, never enough to empty a tile by itself.
const VANISH_OUTER_LOW = 0.7;

/**
 * One tile layer's loop when tiles may vanish: its scale runs from 1 at the crest
 * to `scaleLow` (≤ 0) at the trough and is held at 0 wherever that goes negative.
 * Opacity follows the same crest-first sine between 1 and `opacityLow`.
 */
function vanishingKeyframes(scaleLow: number, opacityLow: number | null): Keyframe[] {
  return Array.from({ length: VANISH_SAMPLES + 1 }, (_, k) => {
    const progress = k / VANISH_SAMPLES;
    // Crest-first, matching crestDelayMs: 1 at progress 0, 0 at progress 0.5.
    const height = 0.5 + 0.5 * Math.cos(2 * Math.PI * progress);
    const scaleAt = Math.max(0, scaleLow + (1 - scaleLow) * height);
    return {
      offset: progress,
      transform: `scale(${scaleAt.toFixed(4)})`,
      ...(opacityLow != null ? { opacity: opacityLow + (1 - opacityLow) * height } : {}),
    };
  });
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
 * "Working" mark: a 3×3 grid of tiles rising and sinking with a sea shared by the
 * whole page. Two short waves texture the tiles of each mark; one long rhythm
 * wave dims and brightens whole marks in turn, so a column of marks reads as one
 * calm pulse travelling down the list.
 *
 * Colour comes from `currentColor`; pass a text colour class.
 *
 * Built to stay in the periphery while someone reads: a narrow opacity range,
 * slow waves, and every mark frozen while the user scrolls, types or clicks
 * outside `[data-working-grid-region]` (see `working-grid-reading.ts`).
 *
 * Every animation touches only `transform` and `opacity` through the Web
 * Animations API on the shared clock, so the compositor runs it: no per-frame
 * script, React state or repaint while an agent works. Each tile nests two
 * layers, one per short wave, whose scales and opacities multiply; the mark
 * itself carries the rhythm. The animated elements are HTML, never SVG, for the
 * compositor reason documented in `spinner.tsx`.
 */
export function WorkingGrid({
  size = 12,
  cornerRadius = 0.4,
  superellipse,
  scale = 'center',
  maxScale: maxScaleProp = 0.9,
  minScale: minScaleProp = 0.3,
  minOpacity: minOpacityProp = 0.25,
  maxOpacity = 1,
  rhythm = 0.3,
  speed = 1,
  waves = 1,
  ripple = 0.3,
  gap = 0.18,
  wavelength = 1.2,
  direction = 'across',
  rowPitch = 28,
  lightCompensation = true,
  className,
  style,
  ...props
}: WorkingGridProps) {
  const compensate = useResolvedTheme() === 'light' && lightCompensation;
  const minOpacity = compensate
    ? minOpacityProp + (1 - minOpacityProp) * LIGHT_OPACITY_LIFT
    : minOpacityProp;
  // A negative floor (vanishing tiles) is a deliberate choice; leave it alone.
  const minScale =
    compensate && minScaleProp > 0
      ? minScaleProp + (1 - minScaleProp) * LIGHT_SCALE_LIFT
      : minScaleProp;
  const maxScale = compensate ? Math.min(1, maxScaleProp * LIGHT_SIZE_BOOST) : maxScaleProp;
  const rootRef = useRef<HTMLSpanElement>(null);
  const cell = size / (3 + 2 * gap);
  const pitch = cell * (1 + gap);
  // Tiles are drawn at maxScale inside their cell, centred (or bottom-aligned when
  // scaling from the bottom), so the grid's footprint and spacing stay fixed.
  const tile = cell * clamp01(maxScale);
  const inset = (cell - tile) / 2;
  const insetTop = scale === 'bottom' ? cell - tile : inset;
  // Opacity range split between the mark-wide rhythm and the two tile layers so
  // the deepest combined trough lands exactly on minOpacity.
  const opacityRatio = maxOpacity > 0 ? clamp01(minOpacity / maxOpacity) : 1;
  const rhythmShare = clamp01(rhythm);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof root.animate !== 'function') return undefined;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;

    const rect = root.getBoundingClientRect();
    const [scrollX, scrollY] = scrollOffset(root);
    const placement = { left: rect.left + scrollX, top: rect.top + scrollY, size, rowPitch };
    const tempo = speed > 0 ? speed : 1;
    const stops: (() => void)[] = [];
    const animations: Animation[] = [];
    const play = (
      element: HTMLElement,
      keyframes: Keyframe[],
      wave: WorkingGridWave,
      phase: number
    ) => {
      const duration = wave.periodMs / tempo;
      const animation = element.animate(keyframes, {
        duration,
        iterations: Infinity,
        delay: crestDelayMs(phase, duration),
      });
      stops.push(trackWorkingGridAnimation(animation));
      animations.push(animation);
    };

    const relativeMin = minScale / clamp01(maxScale);
    const vanishing = scale !== 'none' && relativeMin <= 0;

    if (waves === 1) {
      // The main wave carries most of the range on the outer layer; an optional
      // small ripple (another direction and period) on the inner layer adds
      // interference. The ripple's trough is divided out of the main wave's so
      // their product still bottoms out at minScale / minOpacity.
      const share = clamp01(ripple);
      const rippleScaleLow = scale === 'none' ? null : 1 - share;
      const rippleOpacityLow = opacityRatio < 1 ? 1 - share * (1 - opacityRatio) : null;
      const mainOpacityLow =
        rippleOpacityLow == null ? null : clamp01(opacityRatio / rippleOpacityLow);
      const mainFrames = vanishing
        ? vanishingKeyframes(relativeMin, mainOpacityLow)
        : loopKeyframes(
            rippleScaleLow == null ? null : clamp01(relativeMin / rippleScaleLow),
            mainOpacityLow
          );
      const rippleFrames =
        share > 0 && !vanishing ? loopKeyframes(rippleScaleLow, rippleOpacityLow) : null;
      if (mainFrames) {
        const [main, small] = workingGridWaves(direction);
        for (const outer of root.querySelectorAll<HTMLElement>('[data-working-grid-tile]')) {
          const [x, y] = tileSeaPoint(
            placement,
            Number(outer.dataset.col),
            Number(outer.dataset.row)
          );
          play(outer, mainFrames, main, wavePhase(main, x, y, wavelength));
          const inner = outer.firstElementChild;
          if (rippleFrames && inner instanceof HTMLElement) {
            play(inner, rippleFrames, small, wavePhase(small, x, y, wavelength));
          }
        }
      }
      return () => {
        stops.forEach((stop) => stop());
        animations.forEach((animation) => animation.cancel());
      };
    }

    // The rhythm: the whole mark's opacity, from the long wave at the mark's centre,
    // between maxOpacity and its share of the trough.
    const rhythmLow = opacityRatio ** rhythmShare;
    const rhythmFrames = loopKeyframes(
      null,
      rhythmLow < 1 ? maxOpacity * rhythmLow : null,
      maxOpacity
    );
    if (rhythmFrames) {
      const [x, y] = tileSeaPoint(placement, 1, 1);
      play(root, rhythmFrames, WORKING_GRID_RHYTHM, wavePhase(WORKING_GRID_RHYTHM, x, y, 1));
    }

    // The texture: two stacked layers per tile, one per short wave.
    const tileOpacityLow = opacityRatio < 1 ? Math.sqrt(opacityRatio ** (1 - rhythmShare)) : null;
    const opacityLow = tileOpacityLow === 1 ? null : tileOpacityLow;
    // Above zero the two layers split the range (their product bottoms out at
    // minScale). At or below zero only the inner layer empties the tile; the outer
    // one keeps a gentle positive swell. Letting either layer empty it left ≤ 2 of
    // nine tiles showing ~11% of the time, so whole marks read as idle.
    const outerFrames = vanishing
      ? loopKeyframes(VANISH_OUTER_LOW, opacityLow)
      : loopKeyframes(scale === 'none' ? null : Math.sqrt(clamp01(relativeMin)), opacityLow);
    const innerFrames = vanishing ? vanishingKeyframes(relativeMin, opacityLow) : outerFrames;
    if (outerFrames && innerFrames) {
      const crossing = workingGridWaves(direction);
      for (const outer of root.querySelectorAll<HTMLElement>('[data-working-grid-tile]')) {
        const inner = outer.firstElementChild;
        if (!(inner instanceof HTMLElement)) continue;
        const [x, y] = tileSeaPoint(
          placement,
          Number(outer.dataset.col),
          Number(outer.dataset.row)
        );
        [outer, inner].forEach((layer, index) => {
          const wave = crossing[index];
          play(
            layer,
            index === 0 ? outerFrames : innerFrames,
            wave,
            wavePhase(wave, x, y, wavelength)
          );
        });
      }
    }

    return () => {
      stops.forEach((stop) => stop());
      animations.forEach((animation) => animation.cancel());
    };
  }, [
    size,
    scale,
    minScale,
    maxScale,
    maxOpacity,
    opacityRatio,
    rhythmShare,
    speed,
    waves,
    ripple,
    gap,
    wavelength,
    direction,
    rowPitch,
  ]);

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
      // Tiles animate opacity between 1 and their trough; the mark's own opacity
      // sets the ceiling, so the brightest tile reaches maxOpacity.
      style={{ width: size, height: size, opacity: maxOpacity, ...style }}
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
              transformOrigin: origin,
            }}
          >
            <span
              className="block size-full bg-current"
              style={{ ...shape, transformOrigin: origin }}
            />
          </span>
        ))
      )}
    </span>
  );
}

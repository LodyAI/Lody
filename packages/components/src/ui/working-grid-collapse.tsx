import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from 'react';

import { cn } from '@/lib/utils';

export type WorkingGridCollapseProps = Omit<ComponentPropsWithoutRef<'span'>, 'children'> & {
  /** Box the animation plays in, px; the grid and dot are centred inside it. */
  size?: number;
  /** Edge of the 3×3 grid it starts from, px (match {@link WorkingGrid}). */
  gridSize?: number;
  /** Diameter of the dot it ends as, px (the unread dot is 8px). */
  dotSize?: number;
  /** Throw a few sparks outwards as the dot lands. */
  splash?: boolean;
  /** Called once the dot has settled. */
  onDone?: () => void;
};

const TILES = [0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => [row, col] as const));
const SPARKS = 6;
// Timeline, ms.
const GATHER_MS = 300;
const DOT_START_MS = 240;
const DOT_MS = 340;
const SPARK_START_MS = 280;
const SPARK_MS = 320;
const EASE_IN = 'cubic-bezier(0.5, 0, 0.75, 0)';
const EASE_OUT = 'cubic-bezier(0.2, 0.7, 0.3, 1)';

/**
 * One-shot "done" transition from the working grid to the unread dot: the nine
 * tiles spin and gather into the centre, the dot pops out past its size and
 * settles with a small bounce, and a few sparks fly off.
 *
 * Like {@link WorkingGrid} it animates only `transform` and `opacity` with the
 * Web Animations API, so it runs on the compositor; `onDone` fires from the
 * animation's own `finished` promise, not a timer. With reduced motion (or no
 * Web Animations) it shows the dot at once.
 */
export function WorkingGridCollapse({
  size = 14,
  gridSize = 12,
  dotSize = 8,
  splash = true,
  onDone,
  className,
  style,
  ...props
}: WorkingGridCollapseProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const onDoneRef = useRef(onDone);
  useLayoutEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const gap = 0.18;
  const cell = gridSize / (3 + 2 * gap);
  const pitch = cell * (1 + gap);
  const tile = cell * 0.9;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const grid = root.querySelector<HTMLElement>('[data-collapse-grid]');
    const dot = root.querySelector<HTMLElement>('[data-collapse-dot]');
    if (!grid || !dot) return undefined;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (typeof root.animate !== 'function' || reduced) {
      // No motion: go straight to the dot.
      grid.style.visibility = 'hidden';
      onDoneRef.current?.();
      return undefined;
    }
    const animations: Animation[] = [];

    // 1. The grid spins a quarter turn and more while its tiles fall inwards.
    animations.push(
      grid.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(135deg)' }], {
        duration: GATHER_MS,
        easing: EASE_IN,
        fill: 'forwards',
      })
    );
    for (const el of root.querySelectorAll<HTMLElement>('[data-collapse-tile]')) {
      const dx = (Number(el.dataset.col) - 1) * pitch;
      const dy = (Number(el.dataset.row) - 1) * pitch;
      animations.push(
        el.animate(
          [
            { transform: 'translate(0, 0) scale(1)', opacity: 1 },
            { transform: `translate(${-dx}px, ${-dy}px) scale(0.55)`, opacity: 1, offset: 0.8 },
            { transform: `translate(${-dx}px, ${-dy}px) scale(0.4)`, opacity: 0 },
          ],
          { duration: GATHER_MS, easing: EASE_IN, fill: 'forwards' }
        )
      );
    }

    // 2. The dot pops past its size and settles with a bounce.
    const settle = dot.animate(
      [
        { transform: 'scale(0.35)', opacity: 0 },
        { transform: 'scale(1.3)', opacity: 1, offset: 0.35 },
        { transform: 'scale(0.9)', opacity: 1, offset: 0.62 },
        { transform: 'scale(1.04)', opacity: 1, offset: 0.82 },
        { transform: 'scale(1)', opacity: 1 },
      ],
      { duration: DOT_MS, delay: DOT_START_MS, easing: EASE_OUT, fill: 'both' }
    );
    animations.push(settle);

    // 3. Sparks fly off radially and fade.
    root.querySelectorAll<HTMLElement>('[data-collapse-spark]').forEach((spark, index) => {
      const angle = ((index + 0.25) / SPARKS) * Math.PI * 2;
      const reach = size / 2 + 1;
      const x = Math.cos(angle) * reach;
      const y = Math.sin(angle) * reach;
      animations.push(
        spark.animate(
          [
            { transform: 'translate(0, 0) scale(1)', opacity: 0 },
            {
              transform: `translate(${x * 0.35}px, ${y * 0.35}px) scale(1)`,
              opacity: 1,
              offset: 0.2,
            },
            { transform: `translate(${x}px, ${y}px) scale(0.3)`, opacity: 0 },
          ],
          { duration: SPARK_MS, delay: SPARK_START_MS, easing: EASE_OUT, fill: 'both' }
        )
      );
    });

    let cancelled = false;
    settle.finished.then(
      () => {
        if (!cancelled) onDoneRef.current?.();
      },
      () => {}
    );
    return () => {
      cancelled = true;
      animations.forEach((animation) => animation.cancel());
    };
  }, [pitch, size]);

  const inset = (size - gridSize) / 2;
  return (
    <span
      ref={rootRef}
      data-working-grid-collapse=""
      aria-hidden="true"
      className={cn('relative inline-block shrink-0', className)}
      style={{ width: size, height: size, ...style }}
      {...props}
    >
      <span
        data-collapse-grid=""
        className="absolute block"
        style={{ left: inset, top: inset, width: gridSize, height: gridSize }}
      >
        {TILES.map(([row, col]) => (
          <span
            key={`${row}-${col}`}
            data-collapse-tile=""
            data-row={row}
            data-col={col}
            className="absolute block rounded-[40%] bg-current"
            style={{
              left: col * pitch + (cell - tile) / 2,
              top: row * pitch + (cell - tile) / 2,
              width: tile,
              height: tile,
            }}
          />
        ))}
      </span>
      {splash &&
        Array.from({ length: SPARKS }, (_, index) => (
          <span
            key={index}
            data-collapse-spark=""
            className="absolute block rounded-full bg-current"
            style={{ left: size / 2 - 1, top: size / 2 - 1, width: 2, height: 2, opacity: 0 }}
          />
        ))}
      <span
        data-collapse-dot=""
        className="absolute block rounded-full bg-current"
        style={{
          left: (size - dotSize) / 2,
          top: (size - dotSize) / 2,
          width: dotSize,
          height: dotSize,
        }}
      />
    </span>
  );
}

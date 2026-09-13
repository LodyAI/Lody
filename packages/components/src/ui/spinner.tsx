import { Loader2, type LucideIcon } from 'lucide-react';
import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '@/lib/utils';

export type SpinnerProps = Omit<ComponentPropsWithoutRef<'span'>, 'children'> & {
  /** Glyph to rotate. Defaults to Lucide's `Loader2` arc. */
  icon?: LucideIcon;
  /**
   * `false` renders the glyph at rest. Lets a refresh button keep one element
   * and only spin it while its request is in flight.
   *
   * Defaults to TRUE, because a bare `<Spinner />` is a loading indicator and
   * that is what almost every call site means. The cost is that `undefined`
   * is indistinguishable from omitted: a wrapper component that forwards its
   * own optional `spinning`/`loading` prop spins in every state where that
   * prop is absent. Such a wrapper must default the prop itself — the status
   * panels in `local-projects/` and `files/` shipped a permanently spinning
   * "No machines available" and "Files unavailable" icon that way.
   */
  spinning?: boolean;
  strokeWidth?: number | string;
};

/**
 * The only way to put `animate-spin` on an icon.
 *
 * The rotation runs on an HTML wrapper, never on the `<svg>` itself. Chromium
 * refuses to run a transform animation on the compositor when its target is an
 * SVG element whose effective zoom is not 1 (crbug.com/1186312), and Blink folds
 * the device scale factor into that zoom, so on every Retina / DPR≠1 display an
 * `<svg class="animate-spin">` falls back to the main thread: a style recalc,
 * pre-paint and layerize per vsync for as long as the spinner is mounted. Two
 * such sidebar spinners measured 40–50% renderer CPU at 120 Hz with the app
 * idle. The same animation on a block-level HTML element composites, so the
 * wrapper carries it.
 *
 * Sizing, spacing and colour classes go on the wrapper, and the glyph fills it,
 * so the wrapper's box is the glyph's box and the rotation stays centred on the
 * glyph. Putting a margin on the glyph instead would grow the wrapper
 * asymmetrically and turn the spin into an orbit; see the `span.animate-spin`
 * rule in `tailwind/index.css`.
 */
export function Spinner({
  icon: Icon = Loader2,
  spinning = true,
  strokeWidth,
  className,
  ...props
}: SpinnerProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        spinning && 'animate-spin will-change-transform',
        className
      )}
      {...props}
    >
      <Icon className="size-full" strokeWidth={strokeWidth} aria-hidden="true" />
    </span>
  );
}

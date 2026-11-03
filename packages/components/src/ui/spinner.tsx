import { Loader2, type LucideIcon } from 'lucide-react';
import type { ComponentPropsWithoutRef } from 'react';

import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';

const spin = stylex.keyframes({ to: { transform: 'rotate(360deg)' } });

const styles = stylex.create({
  root: { display: 'inline-flex', flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  spinning: {
    willChange: 'transform',
    transformBox: 'border-box',
    transformOrigin: '50% 50%',
    animationName: spin,
    animationDuration: '1s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
  glyph: { width: '100%', height: '100%' },
});

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
  xstyle?: stylex.StyleXStyles;
};

/** Rotates the HTML wrapper so glyphs remain composited on Retina displays.
 * Caller sizing and spacing belong to that wrapper; the glyph fills its box.
 */
export function Spinner({
  icon: Icon = Loader2,
  spinning = true,
  strokeWidth,
  className,
  xstyle,
  style,
  ...props
}: SpinnerProps) {
  const sx = stylex.props(styles.root, spinning && styles.spinning, xstyle);
  return (
    <span
      data-slot="icon-spinner"
      data-spinning={spinning}
      className={clsx(sx.className, className)}
      {...props}
      style={sx.style ? { ...sx.style, ...style } : style}
    >
      <Icon {...stylex.props(styles.glyph)} strokeWidth={strokeWidth} aria-hidden="true" />
    </span>
  );
}

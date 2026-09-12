import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ComponentProps } from 'react';
import { appendClassName } from '../internal/class-name';
import { feedbackSurface as surface } from './surface';

export type SpinnerSize = 'small' | 'medium' | 'large';

export interface SpinnerProps extends Omit<ComponentProps<'svg'>, 'className'> {
  size?: SpinnerSize;
  /**
   * What a screen reader is told while it turns. A spinner beside a label that
   * already says "Saving…" states nothing, and passing `null` says so.
   */
  label?: string | null;
  className?: string;
}

const SIZES = {
  small: surface.spinnerSmall,
  medium: surface.spinnerMedium,
  large: surface.spinnerLarge,
} as const;

/**
 * The mark that says work is under way with no idea how long it will take.
 *
 * It is called a Spinner rather than a Loading, because it is the mark and not
 * the state: where it goes, whether the surface around it is dimmed and what it
 * is waiting for are the surface's decisions, and a component called `Loading`
 * that centres itself in a box has already made two of them.
 *
 * It is drawn in `currentColor`, so a ghost button's label and a page's
 * secondary text each get a mark that belongs to them, and the ring behind the
 * arc is that same ink kept back — one declaration rather than a token per
 * context. It keeps turning under reduced motion: it is the only thing saying
 * the work has not stopped, and a still spinner says it has.
 */
export const Spinner = forwardRef<SVGSVGElement, SpinnerProps>(function Spinner(
  { size = 'medium', label = 'Loading', className, ...rest },
  ref
) {
  const sx = stylex.props(surface.spinner, SIZES[size]);
  return (
    <svg
      ref={ref}
      viewBox="0 0 16 16"
      fill="none"
      role={label == null ? 'presentation' : 'status'}
      aria-label={label ?? undefined}
      aria-hidden={label == null ? 'true' : undefined}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
});

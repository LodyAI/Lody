import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * A single-value slider on the native range input rather than a library: the
 * platform already gives it keyboard stepping, Home/End, the correct ARIA role
 * and value, and a touch target that behaves the way the OS expects. Only the
 * track and thumb are ours.
 *
 * Two rules in `tailwind/index.css` have to be worked around by hand, and both
 * are why this is a primitive instead of an inline input:
 *
 * - The "Pro focus style" paints `box-shadow: inset 0 0 0 1px` on ANY focused
 *   input through a zero-specificity `:where(…)` selector, which on a range
 *   input draws a rectangle around the whole control. `focus-visible:shadow-none`
 *   turns it off so the focus ring can live on the thumb, where it belongs.
 * - The global `*:focus-visible` reset forces `--tw-ring-shadow` to none with
 *   `!important`, and custom properties inherit into pseudo-elements, so Tailwind
 *   `ring-*` utilities are dead on the thumb too. The thumb's focus ring is an
 *   explicit `box-shadow` instead.
 *
 * Every pseudo-element class is written out in full. Tailwind scans source text
 * for literal candidates, so a class assembled from a template literal is never
 * generated, and a variant prefix binds only to the class immediately after it.
 */
export interface SliderProps extends Omit<
  React.ComponentPropsWithoutRef<'input'>,
  'type' | 'value' | 'onChange'
> {
  value: number;
  onValueChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
}

export const Slider = React.forwardRef<HTMLInputElement, SliderProps>(function Slider(
  { value, onValueChange, min, max, step = 1, className, style, disabled, ...props },
  ref
) {
  // Percent of the track behind the thumb. Guard the degenerate range so a
  // zero-width slider paints an empty track instead of `NaN%`.
  const span = max - min;
  const fill = span > 0 ? ((value - min) / span) * 100 : 0;

  return (
    <input
      ref={ref}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(Number(event.target.value))}
      style={{ ...style, '--lody-slider-fill': `${fill}%` } as React.CSSProperties}
      className={cn(
        'h-5 w-full cursor-pointer appearance-none bg-transparent',
        'focus-visible:shadow-none disabled:cursor-not-allowed disabled:opacity-60',
        '[&::-webkit-slider-runnable-track]:h-1',
        '[&::-webkit-slider-runnable-track]:rounded-full',
        '[&::-webkit-slider-runnable-track]:[background:linear-gradient(to_right,hsl(var(--primary))_var(--lody-slider-fill),hsl(var(--muted))_var(--lody-slider-fill))]',
        '[&::-moz-range-track]:h-1',
        '[&::-moz-range-track]:rounded-full',
        '[&::-moz-range-track]:[background:linear-gradient(to_right,hsl(var(--primary))_var(--lody-slider-fill),hsl(var(--muted))_var(--lody-slider-fill))]',
        // -mt centres a 16px thumb on a 4px webkit track; Firefox centres its own.
        '[&::-webkit-slider-thumb]:-mt-1.5',
        '[&::-webkit-slider-thumb]:size-4',
        '[&::-webkit-slider-thumb]:appearance-none',
        '[&::-webkit-slider-thumb]:rounded-full',
        '[&::-webkit-slider-thumb]:border',
        '[&::-webkit-slider-thumb]:border-border',
        '[&::-webkit-slider-thumb]:bg-background',
        '[&::-webkit-slider-thumb]:shadow-sm',
        '[&::-moz-range-thumb]:size-4',
        '[&::-moz-range-thumb]:appearance-none',
        '[&::-moz-range-thumb]:rounded-full',
        '[&::-moz-range-thumb]:border',
        '[&::-moz-range-thumb]:border-border',
        '[&::-moz-range-thumb]:bg-background',
        '[&::-moz-range-thumb]:shadow-sm',
        'hover:[&::-webkit-slider-thumb]:border-primary/60',
        'hover:[&::-moz-range-thumb]:border-primary/60',
        'focus-visible:[&::-webkit-slider-thumb]:[box-shadow:0_0_0_3px_hsl(var(--primary)/0.3)]',
        'focus-visible:[&::-moz-range-thumb]:[box-shadow:0_0_0_3px_hsl(var(--primary)/0.3)]',
        className
      )}
      {...props}
    />
  );
});

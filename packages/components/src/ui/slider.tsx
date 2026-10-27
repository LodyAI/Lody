import * as React from 'react';

import { cn } from '@/lib/utils';
import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../style/theme-colors.stylex';
import { themeRadius, themeShadow, themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  input: {
    height: themeSpace[5],
    width: '100%',
    appearance: 'none',
    backgroundColor: 'transparent',
    cursor: { default: 'pointer', ':disabled': 'not-allowed' },
    opacity: { default: null, ':disabled': 0.6 },
    '::-webkit-slider-runnable-track': {
      height: themeSpace[1],
      borderRadius: themeRadius.full,
      backgroundImage:
        'linear-gradient(to right, hsl(var(--primary)) var(--lody-slider-fill), hsl(var(--muted)) var(--lody-slider-fill))',
    },
    '::-moz-range-track': {
      height: themeSpace[1],
      borderRadius: themeRadius.full,
      backgroundImage:
        'linear-gradient(to right, hsl(var(--primary)) var(--lody-slider-fill), hsl(var(--muted)) var(--lody-slider-fill))',
    },
    '::-webkit-slider-thumb': {
      marginTop: `calc(${themeSpace[1.5]} * -1)`,
      width: themeSpace[4],
      height: themeSpace[4],
      appearance: 'none',
      borderRadius: themeRadius.full,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: themeColors.border,
      backgroundColor: themeColors.background,
      boxShadow: themeShadow.sm,
    },
    '::-moz-range-thumb': {
      width: themeSpace[4],
      height: themeSpace[4],
      appearance: 'none',
      borderRadius: themeRadius.full,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: themeColors.border,
      backgroundColor: themeColors.background,
      boxShadow: themeShadow.sm,
    },
    '@media (hover: hover)': {
      ':hover': {
        '::-webkit-slider-thumb': { borderColor: 'hsl(var(--primary) / 0.6)' },
        '::-moz-range-thumb': { borderColor: 'hsl(var(--primary) / 0.6)' },
      },
    },
    ':focus-visible': {
      boxShadow: 'none',
      '::-webkit-slider-thumb': { boxShadow: '0 0 0 3px hsl(var(--primary) / 0.3)' },
      '::-moz-range-thumb': { boxShadow: '0 0 0 3px hsl(var(--primary) / 0.3)' },
    },
  },
});

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
 *   input draws a rectangle around the whole control. Neutralizing the input's
 *   focus shadow keeps the focus ring on the thumb.
 * - The global `*:focus-visible` reset forces `--tw-ring-shadow` to none with
 *   `!important`, and custom properties inherit into pseudo-elements, so Tailwind
 *   `ring-*` utilities are dead on the thumb too. The thumb's focus ring is an
 *   explicit `box-shadow` instead.
 *
 * WebKit and Mozilla track/thumb selectors stay separate. The inline fill
 * variable follows the controlled value; caller styles merge before that variable.
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
      className={cn(stylex.props(styles.input).className, className)}
      {...props}
    />
  );
});

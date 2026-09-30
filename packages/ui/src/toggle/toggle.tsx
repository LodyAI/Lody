import { Toggle as BaseToggle } from '@base-ui/react/toggle';
import * as stylex from '@stylexjs/stylex';
import { forwardRef } from 'react';
import { appendClassName } from '../internal/class-name';
import { useToggleSet, type ToggleShape, type ToggleSize } from './set';
import { toggleSurface as surface } from './surface';

export type { ToggleShape, ToggleSize } from './set';

type BaseProps = BaseToggle.Props;

export interface ToggleProps extends Omit<BaseProps, 'className'> {
  /**
   * How tall it is, and what it lines up with. Defaults to medium, or to
   * whatever the set around it was told.
   */
  size?: ToggleSize;
  /** A pill is for a filter a person scans a row of; the default is a control. */
  shape?: ToggleShape;
  /** Square at the size's height, holding one 16px glyph. */
  icon?: boolean;
  className?: string;
}

const SIZES = {
  mini: surface.mini,
  small: surface.small,
  medium: surface.medium,
  large: surface.large,
} as const;

const ICON_SIZES = {
  mini: surface.iconMini,
  small: surface.iconSmall,
  medium: surface.iconMedium,
  large: surface.iconLarge,
} as const;

/**
 * A control that stays pressed.
 *
 * It is not a Switch, and what separates them is what each is for rather than
 * how each looks. A Switch stores a value in a form: it takes a name, answers
 * to a `Field.Root`, can be invalid, and is read as a setting. A Toggle says
 * that an option is on **right now** — bold, wrapped lines, this filter — so it
 * has no name, no validity and no message under it, and what it changes has
 * usually already happened by the time a person looks away from it.
 *
 * Off it is a ghost Button, because that is what it is: a control with no fill,
 * about the thing it acts on rather than the thing. On it sinks into the well,
 * which is this ladder's way of saying something has gone down and stayed —
 * and the reason it is not ink: ink is what a control that *already* sits in a
 * well becomes when it is on, and this one rests on nothing at all.
 *
 * It renders a real `<button>` carrying `aria-pressed`, so the keyboard reaches
 * it and a screen reader is told both what it is and whether it is on.
 */
export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { size, shape, icon = false, className, children, ...rest },
  ref
) {
  const set = useToggleSet();
  const resolvedSize = size ?? set?.size ?? 'medium';
  const resolvedShape = shape ?? set?.shape ?? 'default';
  const glyph = stylex.props(surface.glyph);
  return (
    <BaseToggle
      ref={ref}
      data-size={resolvedSize}
      {...rest}
      className={(state) =>
        appendClassName(
          stylex.props(
            surface.base,
            SIZES[resolvedSize],
            icon && ICON_SIZES[resolvedSize],
            resolvedShape === 'pill' && surface.pill,
            state.pressed ? surface.pressed : surface.rest
          ).className,
          className
        )
      }
    >
      {icon ? (
        <span className={glyph.className} style={glyph.style}>
          {children}
        </span>
      ) : (
        children
      )}
    </BaseToggle>
  );
});
